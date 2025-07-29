const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const compression = require('compression'); // Add this dependency

const app = express();
const PORT = process.env.PORT || 3000;

// ========== MIDDLEWARE ==========
app.use(compression()); // Enable gzip compression
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Request timeout middleware
app.use((req, res, next) => {
    // Set timeout for requests (30 seconds)
    req.setTimeout(30000, () => {
        res.status(408).json({ error: 'Request timeout' });
    });
    next();
});

// ========== CACHING SYSTEM ==========
const cache = new Map();
const CACHE_DURATION = {
    prices: 10 * 1000, // 10 seconds for prices
    signals: 5 * 1000,  // 5 seconds for signals
    statistics: 30 * 1000, // 30 seconds for statistics
    history: 60 * 1000  // 1 minute for history
};

function getCacheKey(req) {
    return `${req.method}:${req.path}:${JSON.stringify(req.query)}`;
}

function getFromCache(key) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < cached.duration) {
        return cached.data;
    }
    return null;
}

function setCache(key, data, duration) {
    // Limit cache size to prevent memory issues
    if (cache.size > 100) {
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
    }
    
    cache.set(key, {
        data,
        timestamp: Date.now(),
        duration
    });
}

// Cache middleware
function cacheMiddleware(duration) {
    return (req, res, next) => {
        const cacheKey = getCacheKey(req);
        const cached = getFromCache(cacheKey);
        
        if (cached) {
            return res.json(cached);
        }
        
        // Override res.json to cache the response
        const originalJson = res.json;
        res.json = function(data) {
            if (res.statusCode === 200) {
                setCache(cacheKey, data, duration);
            }
            originalJson.call(this, data);
        };
        
        next();
    };
}

// ========== DATABASE SETUP ==========
const dbPath = path.join(__dirname, 'gold_tracker.db');
const db = new sqlite3.Database(dbPath);

// Configure SQLite for better performance
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA synchronous = NORMAL');
db.run('PRAGMA cache_size = 10000');
db.run('PRAGMA temp_store = memory');

// ========== GOLDAPI CONFIGURATION ==========
const GOLDAPI_KEY = 'goldapi-75sa519mditl5es-io';
const GOLDAPI_BASE_URL = 'https://www.goldapi.io/api';
const metals = {
    'XAU': 'XAU/USD',
    'XAG': 'XAG/USD',
    'XPT': 'XPT/USD',
    'XPD': 'XPD/USD'
};

// Configure axios with timeouts and retries
const axiosConfig = {
    timeout: 10000, // 10 second timeout
    headers: {
        'x-access-token': GOLDAPI_KEY,
        'Content-Type': 'application/json'
    }
};

// Helper functions
function logWithTimestamp(message) {
    const now = new Date();
    const timestamp = now.toLocaleTimeString();
    console.log(`${message} (${timestamp})`);
}

// Optimized price fetching with retries
async function fetchMetalPrice(metalSymbol, retries = 2) {
    const endpoint = metals[metalSymbol];
    if (!endpoint) throw new Error(`Unsupported metal symbol: ${metalSymbol}`);

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await axios.get(`${GOLDAPI_BASE_URL}/${endpoint}`, axiosConfig);
            const data = response.data;
            
            if (data.error) {
                throw new Error(`GoldAPI Error: ${data.error}`);
            }

            const askPrice = data.ask || data.price;
            const bidPrice = data.bid || data.price;
            const estimatedPrice = (askPrice + bidPrice) / 2;
            const previousClose = data.prev_close_price || estimatedPrice;
            const change = estimatedPrice - previousClose;
            const changePercent = ((change / previousClose) * 100);

            return {
                price: Math.round(estimatedPrice * 100) / 100, // Round to 2 decimal places
                ask: Math.round(askPrice * 100) / 100,
                bid: Math.round(bidPrice * 100) / 100,
                change: Math.round(change * 100) / 100,
                changePercent: Math.round(changePercent * 100) / 100,
                timestamp: data.timestamp || Date.now(),
                high_24h: data.high_24h ? Math.round(data.high_24h * 100) / 100 : null,
                low_24h: data.low_24h ? Math.round(data.low_24h * 100) / 100 : null,
                open_price: data.open_price ? Math.round(data.open_price * 100) / 100 : null,
                prev_close_price: data.prev_close_price ? Math.round(data.prev_close_price * 100) / 100 : null
            };
        } catch (error) {
            if (attempt === retries) {
                logWithTimestamp(`❌ Failed to fetch ${metalSymbol} after ${retries + 1} attempts: ${error.message}`);
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); // Exponential backoff
        }
    }
}

// Optimized price update with batch operations
async function updateAllMetalPrices() {
    logWithTimestamp('🔄 Starting optimized price update...');
    
    const updatePromises = Object.keys(metals).map(async (symbol) => {
        try {
            const priceData = await fetchMetalPrice(symbol);
            
            return new Promise((resolve, reject) => {
                db.run(`
                    INSERT OR REPLACE INTO prices (
                        metal, price, ask_price, bid_price, change_24h, change_percent, 
                        high_24h, low_24h, open_price, prev_close_price, last_updated
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                `, [
                    symbol, priceData.price, priceData.ask, priceData.bid, 
                    priceData.change, priceData.changePercent, priceData.high_24h,
                    priceData.low_24h, priceData.open_price, priceData.prev_close_price
                ], (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(symbol);
                    }
                });
            });
        } catch (error) {
            logWithTimestamp(`❌ Error updating ${symbol}: ${error.message}`);
            return null;
        }
    });

    try {
        await Promise.allSettled(updatePromises);
        // Clear price cache after update
        const keysToDelete = [];
        for (const [key] of cache.entries()) {
            if (key.includes('/api/prices')) {
                keysToDelete.push(key);
            }
        }
        keysToDelete.forEach(key => cache.delete(key));
        
        logWithTimestamp('✅ Batch price update completed');
    } catch (error) {
        logWithTimestamp(`❌ Batch update error: ${error.message}`);
    }
}

// ========== DATABASE INITIALIZATION ==========
db.serialize(() => {
    // Create tables with proper indexes
    db.run(`CREATE TABLE IF NOT EXISTS prices (
        metal TEXT PRIMARY KEY,
        price REAL NOT NULL,
        ask_price REAL,
        bid_price REAL,
        change_24h REAL,
        change_percent REAL,
        high_24h REAL,
        low_24h REAL,
        open_price REAL,
        prev_close_price REAL,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        trade_type TEXT NOT NULL,
        entry_price REAL NOT NULL,
        current_price REAL,
        percentage_change REAL DEFAULT 0.0,
        target1 REAL,
        target2 REAL,
        target3 REAL,
        target1_hit BOOLEAN DEFAULT 0,
        target2_hit BOOLEAN DEFAULT 0,
        target3_hit BOOLEAN DEFAULT 0,
        stoploss REAL NOT NULL,
        active BOOLEAN DEFAULT 1,
        send_notifications BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Create indexes for better query performance
    db.run('CREATE INDEX IF NOT EXISTS idx_signals_active ON signals(active)');
    db.run('CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol)');
    db.run('CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC)');

    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_token TEXT UNIQUE,
        platform TEXT,
        subscribed BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS trade_statistics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        total_trades INTEGER DEFAULT 0,
        win_trades INTEGER DEFAULT 0,
        lose_trades INTEGER DEFAULT 0,
        total_profit REAL DEFAULT 0.0,
        win_rate REAL DEFAULT 0.0,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS trade_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER,
        symbol TEXT NOT NULL,
        trade_type TEXT NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL NOT NULL,
        price_change REAL NOT NULL,
        percentage_change REAL NOT NULL,
        result TEXT NOT NULL,
        pips REAL NOT NULL,
        closed_by TEXT DEFAULT 'admin',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run('CREATE INDEX IF NOT EXISTS idx_trade_history_created ON trade_history(created_at DESC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_trade_history_symbol ON trade_history(symbol)');

    // Initialize statistics
    db.get('SELECT COUNT(*) as count FROM trade_statistics', [], (err, row) => {
        if (!err && row.count === 0) {
            db.run(`INSERT INTO trade_statistics (total_trades, win_trades, lose_trades, total_profit, win_rate) 
                    VALUES (0, 0, 0, 0.0, 0.0)`);
        }
    });
});

// Start optimized price updates
logWithTimestamp('🚀 Starting optimized price monitoring...');
updateAllMetalPrices();
setInterval(updateAllMetalPrices, 15 * 1000);

// ========== OPTIMIZED ROUTES ==========

// Lightweight price endpoint with minimal data
app.get('/api/prices/light', cacheMiddleware(CACHE_DURATION.prices), (req, res) => {
    db.all(`
        SELECT metal, price, change_percent, last_updated 
        FROM prices 
        ORDER BY metal
    `, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        const lightPrices = {};
        rows.forEach(row => {
            lightPrices[row.metal] = {
                p: row.price, // Short property names to reduce payload
                c: row.change_percent,
                u: row.last_updated
            };
        });

        res.json({
            s: true, // success
            t: Date.now(), // timestamp
            d: lightPrices // data
        });
    });
});

// Full price endpoint with caching
app.get('/api/prices', cacheMiddleware(CACHE_DURATION.prices), (req, res) => {
    db.all('SELECT * FROM prices ORDER BY metal', [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        const prices = {};
        rows.forEach(row => {
            prices[row.metal] = {
                price: row.price,
                ask_price: row.ask_price,
                bid_price: row.bid_price,
                change_24h: row.change_24h,
                change_percent: row.change_percent,
                high_24h: row.high_24h,
                low_24h: row.low_24h,
                open_price: row.open_price,
                prev_close_price: row.prev_close_price,
                last_updated: row.last_updated
            };
        });

        res.json({
            success: true,
            timestamp: Date.now(),
            prices,
            source: 'GoldAPI.io'
        });
    });
});

// Optimized signals endpoint with pagination
app.get('/api/signals', cacheMiddleware(CACHE_DURATION.signals), (req, res) => {
    const { page = 1, limit = 20, active_only = 'false' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let query = 'SELECT * FROM signals';
    let countQuery = 'SELECT COUNT(*) as total FROM signals';
    const params = [];
    
    if (active_only === 'true') {
        query += ' WHERE active = 1';
        countQuery += ' WHERE active = 1';
    }
    
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    db.get(countQuery, [], (err, countRow) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        db.all(query, params, (err, rows) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            res.json({
                success: true,
                signals: rows,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: countRow.total,
                    pages: Math.ceil(countRow.total / parseInt(limit))
                },
                timestamp: Date.now()
            });
        });
    });
});

// Optimized single metal price
app.get('/api/metals/:symbol/price', cacheMiddleware(CACHE_DURATION.prices), async (req, res) => {
    try {
        const { symbol } = req.params;
        if (!metals[symbol]) {
            return res.status(400).json({ 
                error: 'Invalid symbol', 
                supported: Object.keys(metals) 
            });
        }

        // Try database first (faster)
        db.get('SELECT * FROM prices WHERE metal = ?', [symbol], async (err, row) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            if (row && (Date.now() - new Date(row.last_updated).getTime()) < 30000) {
                // Data is less than 30 seconds old, return it
                return res.json({
                    success: true,
                    symbol,
                    price: row.price,
                    ask: row.ask_price,
                    bid: row.bid_price,
                    change: row.change_24h,
                    changePercent: row.change_percent,
                    timestamp: Date.now(),
                    source: 'cached'
                });
            } else {
                // Fetch fresh data
                try {
                    const data = await fetchMetalPrice(symbol);
                    res.json({
                        success: true,
                        symbol,
                        ...data,
                        timestamp: Date.now(),
                        source: 'live'
                    });
                } catch (fetchError) {
                    // Fallback to cached data even if old
                    if (row) {
                        return res.json({
                            success: true,
                            symbol,
                            price: row.price,
                            ask: row.ask_price,
                            bid: row.bid_price,
                            change: row.change_24h,
                            changePercent: row.change_percent,
                            timestamp: Date.now(),
                            source: 'fallback',
                            warning: 'Live data unavailable, showing cached data'
                        });
                    }
                    throw fetchError;
                }
            }
        });
    } catch (err) {
        res.status(500).json({ 
            error: err.message,
            timestamp: Date.now()
        });
    }
});

// Optimized statistics endpoint
app.get('/api/statistics', cacheMiddleware(CACHE_DURATION.statistics), (req, res) => {
    db.get(`
        SELECT total_trades, win_trades, lose_trades, total_profit, win_rate, last_updated 
        FROM trade_statistics 
        ORDER BY last_updated DESC 
        LIMIT 1
    `, [], (err, row) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        const stats = row || {
            total_trades: 0,
            win_trades: 0,
            lose_trades: 0,
            total_profit: 0.0,
            win_rate: 0.0,
            last_updated: new Date().toISOString()
        };

        res.json({
            success: true,
            statistics: stats,
            timestamp: Date.now()
        });
    });
});

// Optimized trade history with pagination
app.get('/api/statistics/history', cacheMiddleware(CACHE_DURATION.history), (req, res) => {
    const { limit = 20, offset = 0, symbol } = req.query;
    
    let query = `
        SELECT id, symbol, trade_type, entry_price, exit_price, 
               percentage_change, result, pips, created_at 
        FROM trade_history
    `;
    let countQuery = 'SELECT COUNT(*) as total FROM trade_history';
    const params = [];
    
    if (symbol) {
        query += ' WHERE symbol = ?';
        countQuery += ' WHERE symbol = ?';
        params.push(symbol);
    }
    
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    
    db.get(countQuery, symbol ? [symbol] : [], (err, countRow) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        db.all(query, [...params, parseInt(limit), parseInt(offset)], (err, rows) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            res.json({
                success: true,
                history: rows,
                count: rows.length,
                total: countRow.total,
                timestamp: Date.now()
            });
        });
    });
});

// Health check with quick response
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: Date.now(),
        cache_size: cache.size,
        uptime: process.uptime()
    });
});

// Add new signal (optimized)
app.post('/api/signals', (req, res) => {
    const {
        symbol, trade_type, entry_price, target1, target2, target3, stoploss, send_notifications
    } = req.body;

    if (!symbol || !trade_type || !entry_price || !stoploss) {
        return res.status(400).json({
            error: 'Missing required fields'
        });
    }

    db.run(`
        INSERT INTO signals (
            symbol, trade_type, entry_price, target1, target2, target3, 
            stoploss, send_notifications, current_price, percentage_change
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        symbol, trade_type, entry_price, target1 || null, target2 || null, 
        target3 || null, stoploss, send_notifications !== false, entry_price, 0.0
    ], function(err) {
        if (err) {
            return res.status(500).json({ error: 'Failed to add signal' });
        }

        // Clear signals cache
        const keysToDelete = [];
        for (const [key] of cache.entries()) {
            if (key.includes('/api/signals')) {
                keysToDelete.push(key);
            }
        }
        keysToDelete.forEach(key => cache.delete(key));

        res.json({
            success: true,
            signal_id: this.lastID,
            timestamp: Date.now()
        });
    });
});

// Update signal (optimized)
app.put('/api/signals/:id', (req, res) => {
    const signalId = req.params.id;
    const updates = req.body;
    
    const allowedFields = ['target1_hit', 'target2_hit', 'target3_hit', 'active', 'current_price', 'percentage_change'];
    const setClause = [];
    const values = [];
    
    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            setClause.push(`${field} = ?`);
            values.push(updates[field]);
        }
    }
    
    if (setClause.length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
    }
    
    setClause.push('updated_at = CURRENT_TIMESTAMP');
    values.push(signalId);

    db.run(`UPDATE signals SET ${setClause.join(', ')} WHERE id = ?`, values, function(err) {
        if (err) {
            return res.status(500).json({ error: 'Failed to update signal' });
        }

        if (this.changes === 0) {
            return res.status(404).json({ error: 'Signal not found' });
        }

        // Clear cache
        cache.clear();

        res.json({
            success: true,
            changes: this.changes,
            timestamp: Date.now()
        });
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        timestamp: Date.now()
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Endpoint not found',
        timestamp: Date.now()
    });
});

// ========== START SERVER ==========
app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Optimized Gold Tracker API Server Started');
    console.log(`🌐 Server: http://0.0.0.0:${PORT}`);
    console.log('⚡ Optimizations enabled:');
    console.log('   📦 GZIP compression');
    console.log('   ⚡ Response caching');
    console.log('   🔍 Database indexing');
    console.log('   📱 Lightweight endpoints');
    console.log('   📄 Request pagination');
    console.log('   ⏱️ Connection timeouts');
    console.log('   🔄 Retry mechanisms');
    console.log('\n📡 New optimized endpoints:');
    console.log('   GET  /api/prices/light - Minimal price data');
    console.log('   GET  /api/signals?page=1&limit=20 - Paginated signals');
    console.log('   GET  /api/statistics/history?limit=20 - Paginated history');
});

// ========== GRACEFUL SHUTDOWN ==========
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    cache.clear();
    db.close((err) => {
        if (err) console.error('❌ Error closing database:', err.message);
        else console.log('💾 Database connection closed');
        process.exit(0);
    });
});