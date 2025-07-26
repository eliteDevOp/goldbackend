const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== MIDDLEWARE OPTIMIZATIONS ==========

// Compression middleware
app.use(compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
    }
}));

// Security middleware
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Optimized CORS
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? process.env.ALLOWED_ORIGINS?.split(',') || true
        : true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400
}));

// JSON parsing with limits
app.use(express.json({ 
    limit: '10mb',
    strict: true
}));

// Request timeout middleware
app.use((req, res, next) => {
    const timeout = setTimeout(() => {
        if (!res.headersSent) {
            res.status(408).json({ 
                error: 'Request timeout',
                message: 'The request took too long to process'
            });
        }
    }, 30000);

    res.on('finish', () => clearTimeout(timeout));
    next();
});

// Response time tracking
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        if (duration > 5000) {
            console.log(`🐌 Slow request: ${req.method} ${req.path} took ${duration}ms`);
        }
    });
    next();
});

// ========== DATABASE OPTIMIZATIONS ==========

const dbPath = path.join(__dirname, 'gold_tracker.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error('❌ Error opening database:', err.message);
    } else {
        console.log('✅ Connected to SQLite database');
        
        // Optimize SQLite settings
        db.run('PRAGMA journal_mode = WAL;');
        db.run('PRAGMA synchronous = NORMAL;');
        db.run('PRAGMA cache_size = 10000;');
        db.run('PRAGMA temp_store = MEMORY;');
        db.run('PRAGMA mmap_size = 268435456;');
    }
});

db.configure('busyTimeout', 30000);

// Promisified database functions
function dbGet(query, params = []) {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbAll(query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function dbRun(query, params = []) {
    return new Promise((resolve, reject) => {
        db.run(query, params, function(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

// ========== API CLIENT OPTIMIZATIONS ==========

const GOLDAPI_KEY = 'goldapi-75sa519mditl5es-io';
const GOLDAPI_BASE_URL = 'https://www.goldapi.io/api';
const metals = {
    'XAU': 'XAU/USD',
    'XAG': 'XAG/USD',
    'XPT': 'XPT/USD',
    'XPD': 'XPD/USD'
};

// Optimized axios client with connection pooling
const goldApiClient = axios.create({
    baseURL: GOLDAPI_BASE_URL,
    timeout: 10000,
    headers: {
        'x-access-token': GOLDAPI_KEY,
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    },
    httpAgent: new http.Agent({
        keepAlive: true,
        maxSockets: 10,
        maxFreeSockets: 2,
        timeout: 60000,
        freeSocketTimeout: 30000
    }),
    httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: 10,
        maxFreeSockets: 2,
        timeout: 60000,
        freeSocketTimeout: 30000
    })
});

// Price caching
const priceCache = new Map();
const CACHE_DURATION = 10000; // 10 seconds

// Response caching middleware
const responseCache = new Map();
function cacheMiddleware(duration = 30000) {
    return (req, res, next) => {
        if (req.method !== 'GET') return next();
        
        const key = `${req.originalUrl}`;
        const cached = responseCache.get(key);
        
        if (cached && Date.now() - cached.timestamp < duration) {
            return res.json(cached.data);
        }
        
        const originalJson = res.json;
        res.json = function(data) {
            responseCache.set(key, {
                data: data,
                timestamp: Date.now()
            });
            return originalJson.call(this, data);
        };
        
        next();
    };
}

// ========== HELPER FUNCTIONS ==========

function logWithTimestamp(message) {
    const now = new Date();
    const timestamp = now.toLocaleTimeString();
    console.log(`${message} (${timestamp})`);
}

async function fetchMetalPrice(metalSymbol, useCache = true) {
    const endpoint = metals[metalSymbol];
    if (!endpoint) throw new Error(`Unsupported metal symbol: ${metalSymbol}`);

    // Check cache first
    if (useCache) {
        const cached = priceCache.get(metalSymbol);
        if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
            logWithTimestamp(`📦 Using cached price for ${metalSymbol}`);
            return cached.data;
        }
    }

    logWithTimestamp(`📡 Fetching price for ${metalSymbol} from GoldAPI`);
    
    try {
        const response = await goldApiClient.get(`/${endpoint}`);
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

        const priceData = {
            price: estimatedPrice,
            ask: askPrice,
            bid: bidPrice,
            change: change,
            changePercent: changePercent,
            timestamp: data.timestamp || new Date().getTime(),
            high_24h: data.high_24h,
            low_24h: data.low_24h,
            open_price: data.open_price,
            prev_close_price: data.prev_close_price
        };

        // Cache the result
        if (useCache) {
            priceCache.set(metalSymbol, {
                data: priceData,
                timestamp: Date.now()
            });
        }

        logWithTimestamp(`✅ ${metalSymbol} - Price: $${estimatedPrice.toFixed(2)}`);
        return priceData;

    } catch (error) {
        if (error.code === 'ECONNABORTED') {
            logWithTimestamp(`⏰ Timeout fetching ${metalSymbol} price`);
            throw new Error(`Timeout: Unable to fetch ${metalSymbol} price`);
        }
        
        if (error.response) {
            logWithTimestamp(`❌ GoldAPI HTTP Error ${error.response.status}`);
            throw new Error(`GoldAPI Error: ${error.response.data?.error || error.message}`);
        } else if (error.request) {
            logWithTimestamp(`❌ Network Error: ${error.message}`);
            throw new Error(`Network Error: Unable to reach GoldAPI`);
        } else {
            logWithTimestamp(`❌ Error: ${error.message}`);
            throw error;
        }
    }
}

// Optimized batch price update with parallel processing
async function updateAllMetalPrices() {
    logWithTimestamp('🔄 Starting price update cycle...');
    
    const updatePromises = Object.keys(metals).map(async (symbol) => {
        try {
            const priceData = await fetchMetalPrice(symbol);
            
            // Check if price has changed
            const existingPrice = await dbGet('SELECT price FROM prices WHERE metal = ?', [symbol]);
            const hasChanged = !existingPrice || Math.abs(existingPrice.price - priceData.price) > 0.01;
            
            if (hasChanged) {
                await dbRun(`
                    INSERT INTO prices (
                        metal, price, ask_price, bid_price, change_24h, change_percent, 
                        high_24h, low_24h, open_price, prev_close_price, last_updated
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(metal) DO UPDATE SET 
                        price = excluded.price,
                        ask_price = excluded.ask_price,
                        bid_price = excluded.bid_price,
                        change_24h = excluded.change_24h,
                        change_percent = excluded.change_percent,
                        high_24h = excluded.high_24h,
                        low_24h = excluded.low_24h,
                        open_price = excluded.open_price,
                        prev_close_price = excluded.prev_close_price,
                        last_updated = CURRENT_TIMESTAMP
                `, [
                    symbol, priceData.price, priceData.ask, priceData.bid, 
                    priceData.change, priceData.changePercent, priceData.high_24h,
                    priceData.low_24h, priceData.open_price, priceData.prev_close_price
                ]);
                
                logWithTimestamp(`✅ Updated ${symbol}: $${priceData.price.toFixed(2)}`);
                
                // Clear response cache when prices update
                responseCache.clear();
            } else {
                logWithTimestamp(`📊 ${symbol} unchanged: $${priceData.price.toFixed(2)}`);
            }
            
            return { symbol, success: true };
        } catch (err) {
            console.error(`❌ Error updating ${symbol}:`, err.message);
            return { symbol, success: false, error: err.message };
        }
    });
    
    const results = await Promise.allSettled(updatePromises);
    const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    
    logWithTimestamp(`✅ Update completed: ${successful}/${Object.keys(metals).length} successful`);
}

// ========== DATABASE INITIALIZATION ==========

db.serialize(() => {
    // Create tables
    db.run(`CREATE TABLE IF NOT EXISTS prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metal TEXT UNIQUE NOT NULL,
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

    // Create indexes for better performance
    db.run('CREATE INDEX IF NOT EXISTS idx_prices_metal ON prices(metal);');
    db.run('CREATE INDEX IF NOT EXISTS idx_prices_updated ON prices(last_updated);');
    db.run('CREATE INDEX IF NOT EXISTS idx_signals_active ON signals(active);');
    db.run('CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at);');
    db.run('CREATE INDEX IF NOT EXISTS idx_trade_history_created ON trade_history(created_at);');

    // Initialize statistics
    db.get('SELECT COUNT(*) as count FROM trade_statistics', [], (err, row) => {
        if (!err && row.count === 0) {
            db.run('INSERT INTO trade_statistics (total_trades, win_trades, lose_trades, total_profit, win_rate) VALUES (0, 0, 0, 0.0, 0.0)');
            logWithTimestamp('✅ Initialized trade statistics');
        }
    });
});

// ========== ROUTES ==========

// Get all metal prices with caching
app.get('/api/prices', cacheMiddleware(15000), async (req, res) => {
    try {
        const rows = await dbAll('SELECT * FROM prices ORDER BY last_updated DESC');
        
        const prices = rows.reduce((acc, row) => {
            acc[row.metal] = {
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
            return acc;
        }, {});

        logWithTimestamp(`📊 Served price data for ${rows.length} metals`);
        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            prices,
            source: 'GoldAPI.io'
        });
    } catch (err) {
        console.error('❌ Database error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get live metal price
app.get('/api/metals/:symbol/price', async (req, res) => {
    try {
        const { symbol } = req.params;
        if (!metals[symbol]) {
            return res.status(400).json({ 
                error: 'Invalid symbol', 
                supported_symbols: Object.keys(metals) 
            });
        }

        const data = await fetchMetalPrice(symbol);
        res.json({
            success: true,
            symbol,
            ...data,
            timestamp: new Date().toISOString(),
            source: 'GoldAPI.io'
        });
    } catch (err) {
        res.status(500).json({ 
            error: err.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Health check
app.get('/api/health', async (req, res) => {
    let goldApiStatus = 'unknown';
    
    try {
        await goldApiClient.get('/XAU/USD', { timeout: 5000 });
        goldApiStatus = 'connected';
    } catch (error) {
        goldApiStatus = 'error';
    }

    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        database: 'connected',
        goldapi: goldApiStatus,
        update_interval: '15 seconds',
        supported_metals: Object.keys(metals)
    });
});

// Get all signals with caching
app.get('/api/signals', cacheMiddleware(10000), async (req, res) => {
    try {
        const rows = await dbAll('SELECT * FROM signals ORDER BY created_at DESC');
        
        logWithTimestamp(`📋 Retrieved ${rows.length} signals`);
        res.json({
            success: true,
            signals: rows,
            count: rows.length,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('❌ Database error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Add new signal
app.post('/api/signals', async (req, res) => {
    const {
        symbol, trade_type, entry_price, target1, target2, target3,
        stoploss, send_notifications
    } = req.body;

    if (!symbol || !trade_type || !entry_price || !stoploss) {
        return res.status(400).json({
            error: 'Missing required fields: symbol, trade_type, entry_price, stoploss'
        });
    }

    try {
        logWithTimestamp(`📤 Adding new signal: ${symbol} ${trade_type} at ${entry_price}`);

        const result = await dbRun(`
            INSERT INTO signals (
                symbol, trade_type, entry_price, target1, target2, target3, 
                stoploss, send_notifications, current_price, percentage_change
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            symbol, trade_type, entry_price, target1 || null, target2 || null,
            target3 || null, stoploss, send_notifications !== false, entry_price, 0.0
        ]);

        // Clear cache
        responseCache.delete('/api/signals');

        logWithTimestamp(`✅ Signal added successfully with ID: ${result.lastID}`);
        res.json({
            success: true,
            message: 'Signal added successfully',
            signal_id: result.lastID,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('❌ Error adding signal:', err);
        res.status(500).json({ error: 'Failed to add signal' });
    }
});

// Update signal
app.put('/api/signals/:id', async (req, res) => {
    const signalId = req.params.id;
    const {
        target1_hit, target2_hit, target3_hit, active,
        current_price, percentage_change
    } = req.body;

    try {
        logWithTimestamp(`📝 Updating signal ${signalId}`);

        const result = await dbRun(`
            UPDATE signals SET
                target1_hit = COALESCE(?, target1_hit),
                target2_hit = COALESCE(?, target2_hit),
                target3_hit = COALESCE(?, target3_hit),
                active = COALESCE(?, active),
                current_price = COALESCE(?, current_price),
                percentage_change = COALESCE(?, percentage_change),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [target1_hit, target2_hit, target3_hit, active, current_price, percentage_change, signalId]);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Signal not found' });
        }

        // Clear cache
        responseCache.delete('/api/signals');

        logWithTimestamp(`✅ Signal ${signalId} updated successfully`);
        res.json({
            success: true,
            message: 'Signal updated successfully',
            changes: result.changes,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('❌ Error updating signal:', err);
        res.status(500).json({ error: 'Failed to update signal' });
    }
});

// Delete signal
app.delete('/api/signals/:id', async (req, res) => {
    const signalId = req.params.id;

    try {
        logWithTimestamp(`🗑️ Deleting signal ${signalId}`);

        const result = await dbRun('DELETE FROM signals WHERE id = ?', [signalId]);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Signal not found' });
        }

        // Clear cache
        responseCache.delete('/api/signals');

        logWithTimestamp(`✅ Signal ${signalId} deleted successfully`);
        res.json({
            success: true,
            message: 'Signal deleted successfully',
            changes: result.changes,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('❌ Error deleting signal:', err);
        res.status(500).json({ error: 'Failed to delete signal' });
    }
});

// Get specific signal
app.get('/api/signals/:id', async (req, res) => {
    const signalId = req.params.id;

    try {
        const row = await dbGet('SELECT * FROM signals WHERE id = ?', [signalId]);

        if (!row) {
            return res.status(404).json({ error: 'Signal not found' });
        }

        res.json({
            success: true,
            signal: row,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('❌ Database error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get trade statistics with caching
app.get('/api/statistics', cacheMiddleware(30000), async (req, res) => {
    try {
        const row = await dbGet('SELECT * FROM trade_statistics ORDER BY last_updated DESC LIMIT 1');

        if (!row) {
            const defaultStats = {
                total_trades: 0,
                win_trades: 0,
                lose_trades: 0,
                total_profit: 0.0,
                win_rate: 0.0,
                last_updated: new Date().toISOString()
            };
            return res.json({
                success: true,
                statistics: defaultStats,
                timestamp: new Date().toISOString()
            });
        }

        logWithTimestamp('📊 Retrieved trade statistics');
        res.json({
            success: true,
            statistics: row,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('❌ Database error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Add trade result
app.post('/api/statistics/trade', async (req, res) => {
    const {
        signal_id, symbol, trade_type, entry_price, exit_price,
        price_change, percentage_change, result, pips, closed_by = 'admin'
    } = req.body;

    if (!symbol || !trade_type || !entry_price || !exit_price || !result || pips === undefined) {
        return res.status(400).json({
            error: 'Missing required fields: symbol, trade_type, entry_price, exit_price, result, pips'
        });
    }

    if (!['profit', 'loss'].includes(result)) {
        return res.status(400).json({ error: 'Result must be either "profit" or "loss"' });
    }

    try {
        logWithTimestamp(`📈 Adding trade result: ${symbol} ${result} ${pips} pips`);

        // Start transaction
        await dbRun('BEGIN TRANSACTION');

        // Insert trade history
        const tradeResult = await dbRun(`
            INSERT INTO trade_history (
                signal_id, symbol, trade_type, entry_price, exit_price, 
                price_change, percentage_change, result, pips, closed_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [signal_id, symbol, trade_type, entry_price, exit_price, price_change, percentage_change, result, pips, closed_by]);

        // Get current statistics
        const stats = await dbGet('SELECT * FROM trade_statistics ORDER BY last_updated DESC LIMIT 1');
        const currentStats = stats || {
            total_trades: 0,
            win_trades: 0,
            lose_trades: 0,
            total_profit: 0.0
        };

        // Calculate new statistics
        const newTotalTrades = currentStats.total_trades + 1;
        const newWinTrades = currentStats.win_trades + (result === 'profit' ? 1 : 0);
        const newLoseTrades = currentStats.lose_trades + (result === 'loss' ? 1 : 0);
        const newTotalProfit = currentStats.total_profit + (result === 'profit' ? pips : -pips);
        const newWinRate = newTotalTrades > 0 ? (newWinTrades / newTotalTrades) * 100 : 0;

        // Update statistics
        await dbRun(`
            INSERT OR REPLACE INTO trade_statistics (
                id, total_trades, win_trades, lose_trades, total_profit, win_rate, last_updated
            ) VALUES (
                COALESCE((SELECT id FROM trade_statistics ORDER BY last_updated DESC LIMIT 1), 1),
                ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
            )
        `, [newTotalTrades, newWinTrades, newLoseTrades, newTotalProfit, newWinRate]);

        // Commit transaction
        await dbRun('COMMIT');

        // Clear cache
        responseCache.delete('/api/statistics');
        responseCache.delete('/api/statistics/history');

        logWithTimestamp('✅ Trade result added and statistics updated');
        res.json({
            success: true,
            message: 'Trade result added and statistics updated successfully',
            trade_history_id: tradeResult.lastID,
            statistics: {
                total_trades: newTotalTrades,
                win_trades: newWinTrades,
                lose_trades: newLoseTrades,
                total_profit: newTotalProfit,
                win_rate: newWinRate
            },
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        await dbRun('ROLLBACK');
        console.error('❌ Error adding trade result:', err);
        res.status(500).json({ error: 'Failed to add trade result' });
    }
});

// Get trade history with caching
app.get('/api/statistics/history', cacheMiddleware(60000), async (req, res) => {
    const { limit = 50, offset = 0 } = req.query;

    try {
        const rows = await dbAll(`
            SELECT * FROM trade_history 
            ORDER BY created_at DESC 
            LIMIT ? OFFSET ?
        `, [parseInt(limit), parseInt(offset)]);

        const countRow = await dbGet('SELECT COUNT(*) as total FROM trade_history');

        logWithTimestamp(`📋 Retrieved ${rows.length} trade history records`);
        res.json({
            success: true,
            history: rows,
            count: rows.length,
            total: countRow.total,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('❌ Database error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// ========== PRICE MONITORING ==========

logWithTimestamp('🚀 Starting optimized GoldAPI price monitoring...');
updateAllMetalPrices();
setInterval(updateAllMetalPrices, 15 * 1000);

// ========== START SERVER ==========

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Optimized Gold Tracker API Server Started');
    console.log(`🌐 Server running on http://0.0.0.0:${PORT}`);
    console.log('🔧 Optimizations enabled:');
    console.log('   ✅ Response compression');
    console.log('   ✅ Connection pooling');
    console.log('   ✅ Request caching');
    console.log('   ✅ Database indexing');
    console.log('   ✅ Parallel processing');
    console.log('   ✅ Request timeouts');
    console.log('🔑 Using GoldAPI.io for real-time precious metals prices');
    console.log('⏰ Price updates every 15 seconds');
    console.log(`📋 Supported metals: ${Object.keys(metals).join(', ')}`);
});

// Server timeout configuration
server.timeout = 30000; // 30 seconds
server.keepAliveTimeout = 5000; // 5 seconds
server.headersTimeout = 60000; // 60 seconds

// ========== SHUTDOWN HANDLING ==========

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    
    server.close(() => {
        console.log('🌐 HTTP server closed');
        
        db.close((err) => {
            if (err) console.error('❌ Error closing database:', err.message);
            else console.log('💾 Database connection closed');
            process.exit(0);
        });
    });
});

process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    
    server.close(() => {
        console.log('🌐 HTTP server closed');
        
        db.close((err) => {
            if (err) console.error('❌ Error closing database:', err.message);
            else console.log('💾 Database connection closed');
            process.exit(0);
        });
    });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});