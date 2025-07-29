const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== ENHANCED MIDDLEWARE ==========
app.use(compression({ 
    level: 6, // Balanced compression
    threshold: 1024 // Only compress responses > 1KB
}));

// Enhanced CORS for global access
app.use(cors({
    origin: true,
    credentials: false,
    maxAge: 86400 // Cache preflight for 24 hours
}));

app.use(express.json({ limit: '1mb' })); // Reduced from 10mb

// Aggressive timeout for global users
app.use((req, res, next) => {
    req.setTimeout(8000, () => { // Reduced from 30s to 8s
        res.status(408).json({ 
            error: 'Request timeout',
            cached: true // Indicate this might be cached data
        });
    });
    
    // Set response headers for better caching
    res.set({
        'Cache-Control': 'public, max-age=10, stale-while-revalidate=30',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY'
    });
    
    next();
});

// ========== ENHANCED CACHING SYSTEM ==========
const cache = new Map();
const CACHE_DURATION = {
    prices: 8 * 1000,      // 8 seconds (faster refresh)
    signals: 3 * 1000,     // 3 seconds
    statistics: 20 * 1000, // 20 seconds
    history: 60 * 1000,    // 1 minute
    health: 5 * 1000       // 5 seconds for health
};

// Persistent cache for fallback data
const persistentCache = new Map();

function getCacheKey(req) {
    const baseKey = `${req.method}:${req.path}`;
    const queryKey = Object.keys(req.query).length > 0 ? `:${JSON.stringify(req.query)}` : '';
    return baseKey + queryKey;
}

function getFromCache(key) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < cached.duration) {
        return cached.data;
    }
    return null;
}

function setCache(key, data, duration) {
    // Aggressive cache management
    if (cache.size > 50) { // Reduced from 100
        const oldKeys = Array.from(cache.keys()).slice(0, 25);
        oldKeys.forEach(k => cache.delete(k));
    }
    
    cache.set(key, {
        data,
        timestamp: Date.now(),
        duration
    });
    
    // Store in persistent cache for fallback
    persistentCache.set(key, {
        data,
        timestamp: Date.now()
    });
}

// Enhanced cache middleware with fallback
function cacheMiddleware(duration) {
    return (req, res, next) => {
        const cacheKey = getCacheKey(req);
        const cached = getFromCache(cacheKey);
        
        if (cached) {
            res.set('X-Cache', 'HIT');
            return res.json(cached);
        }
        
        const originalJson = res.json;
        const originalSend = res.send;
        
        res.json = function(data) {
            if (res.statusCode === 200) {
                setCache(cacheKey, data, duration);
                res.set('X-Cache', 'MISS');
            }
            originalJson.call(this, data);
        };
        
        // Timeout fallback
        const timeoutId = setTimeout(() => {
            const fallback = persistentCache.get(cacheKey);
            if (fallback && !res.headersSent) {
                res.set('X-Cache', 'STALE');
                res.set('X-Data-Age', Math.floor((Date.now() - fallback.timestamp) / 1000));
                return res.json({
                    ...fallback.data,
                    _stale: true,
                    _age: Math.floor((Date.now() - fallback.timestamp) / 1000)
                });
            }
        }, 6000); // 6-second fallback
        
        res.on('finish', () => clearTimeout(timeoutId));
        next();
    };
}

// ========== DATABASE SETUP ==========
const dbPath = path.join(__dirname, 'gold_tracker.db');
const db = new sqlite3.Database(dbPath);

// Enhanced SQLite performance
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA synchronous = NORMAL');
db.run('PRAGMA cache_size = 20000'); // Increased cache
db.run('PRAGMA temp_store = memory');
db.run('PRAGMA mmap_size = 268435456'); // 256MB memory map
db.run('PRAGMA optimize');

// Connection pooling simulation
let dbBusy = false;
const dbQueue = [];

function executeQuery(query, params = []) {
    return new Promise((resolve, reject) => {
        const task = { query, params, resolve, reject };
        
        if (dbBusy) {
            dbQueue.push(task);
            return;
        }
        
        executeTask(task);
    });
}

function executeTask(task) {
    dbBusy = true;
    const { query, params, resolve, reject } = task;
    
    const isSelect = query.trim().toUpperCase().startsWith('SELECT');
    const method = isSelect ? 'all' : 'run';
    
    db[method](query, params, function(err, result) {
        dbBusy = false;
        
        if (err) {
            reject(err);
        } else {
            resolve(isSelect ? result : { changes: this.changes, lastID: this.lastID });
        }
        
        // Process next in queue
        if (dbQueue.length > 0) {
            const nextTask = dbQueue.shift();
            executeTask(nextTask);
        }
    });
}

// ========== GOLDAPI CONFIGURATION ==========
const GOLDAPI_KEY = 'goldapi-75sa519mditl5es-io';
const GOLDAPI_BASE_URL = 'https://www.goldapi.io/api';
const metals = {
    'XAU': 'XAU/USD',
    'XAG': 'XAG/USD',
    'XPT': 'XPT/USD',
    'XPD': 'XPD/USD'
};

// Aggressive axios configuration for global users
const axiosConfig = {
    timeout: 4000, // Reduced from 10s to 4s
    headers: {
        'x-access-token': GOLDAPI_KEY,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive'
    },
    maxRedirects: 2,
    validateStatus: status => status < 500 // Accept 4xx as valid
};

// Create axios instance with interceptors
const goldApi = axios.create(axiosConfig);

// Request interceptor for logging
goldApi.interceptors.request.use(config => {
    config.metadata = { startTime: Date.now() };
    return config;
});

// Response interceptor for monitoring
goldApi.interceptors.response.use(
    response => {
        const duration = Date.now() - response.config.metadata.startTime;
        console.log(`✅ GoldAPI call: ${duration}ms`);
        return response;
    },
    error => {
        const duration = Date.now() - error.config.metadata.startTime;
        console.log(`❌ GoldAPI failed: ${duration}ms - ${error.message}`);
        return Promise.reject(error);
    }
);

// Enhanced price fetching with circuit breaker
let circuitBreakerState = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
let failureCount = 0;
let lastFailureTime = 0;
const FAILURE_THRESHOLD = 3;
const RECOVERY_TIMEOUT = 30000; // 30 seconds

async function fetchMetalPrice(metalSymbol, retries = 1) {
    const endpoint = metals[metalSymbol];
    if (!endpoint) throw new Error(`Unsupported metal symbol: ${metalSymbol}`);

    // Circuit breaker check
    if (circuitBreakerState === 'OPEN') {
        if (Date.now() - lastFailureTime > RECOVERY_TIMEOUT) {
            circuitBreakerState = 'HALF_OPEN';
        } else {
            throw new Error('Circuit breaker is OPEN - API unavailable');
        }
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await goldApi.get(`${GOLDAPI_BASE_URL}/${endpoint}`);
            const data = response.data;
            
            // Reset circuit breaker on success
            if (circuitBreakerState === 'HALF_OPEN') {
                circuitBreakerState = 'CLOSED';
                failureCount = 0;
            }
            
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
                price: Math.round(estimatedPrice * 100) / 100,
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
            failureCount++;
            
            if (failureCount >= FAILURE_THRESHOLD) {
                circuitBreakerState = 'OPEN';
                lastFailureTime = Date.now();
            }
            
            if (attempt === retries) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
    }
}

// Batch update with better error handling
async function updateAllMetalPrices() {
    const startTime = Date.now();
    console.log('🔄 Starting price update...');
    
    try {
        const updatePromises = Object.keys(metals).map(async (symbol) => {
            try {
                const priceData = await fetchMetalPrice(symbol);
                
                await executeQuery(`
                    INSERT OR REPLACE INTO prices (
                        metal, price, ask_price, bid_price, change_24h, change_percent, 
                        high_24h, low_24h, open_price, prev_close_price, last_updated
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                `, [
                    symbol, priceData.price, priceData.ask, priceData.bid, 
                    priceData.change, priceData.changePercent, priceData.high_24h,
                    priceData.low_24h, priceData.open_price, priceData.prev_close_price
                ]);
                
                return symbol;
            } catch (error) {
                console.log(`❌ Error updating ${symbol}: ${error.message}`);
                return null;
            }
        });

        await Promise.allSettled(updatePromises);
        
        // Clear only price-related cache
        const keysToDelete = [];
        for (const [key] of cache.entries()) {
            if (key.includes('/api/prices')) {
                keysToDelete.push(key);
            }
        }
        keysToDelete.forEach(key => cache.delete(key));
        
        const duration = Date.now() - startTime;
        console.log(`✅ Price update completed in ${duration}ms`);
        
    } catch (error) {
        console.log(`❌ Batch update error: ${error.message}`);
    }
}

// ========== DATABASE INITIALIZATION ==========
db.serialize(() => {
    // Create tables with optimized indexes
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

    // Optimized indexes
    db.run('CREATE INDEX IF NOT EXISTS idx_signals_active_created ON signals(active, created_at DESC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_signals_symbol_active ON signals(symbol, active)');

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

    db.run('CREATE INDEX IF NOT EXISTS idx_trade_history_created_symbol ON trade_history(created_at DESC, symbol)');

    // Initialize statistics if not exists
    db.get('SELECT COUNT(*) as count FROM trade_statistics', [], (err, row) => {
        if (!err && row.count === 0) {
            db.run(`INSERT INTO trade_statistics (total_trades, win_trades, lose_trades, total_profit, win_rate) 
                    VALUES (0, 0, 0, 0.0, 0.0)`);
        }
    });
});

// Start price updates with better scheduling
console.log('🚀 Starting price monitoring...');
updateAllMetalPrices();
setInterval(updateAllMetalPrices, 10 * 1000); // Every 10 seconds

// ========== OPTIMIZED ROUTES ==========

// Ultra-lightweight price endpoint
app.get('/api/prices/ultra-light', cacheMiddleware(CACHE_DURATION.prices), async (req, res) => {
    try {
        const rows = await executeQuery('SELECT metal, price, change_percent FROM prices ORDER BY metal');
        
        const prices = {};
        rows.forEach(row => {
            prices[row.metal] = [row.price, row.change_percent]; // Array format for minimal payload
        });

        res.json({
            t: Date.now(),
            d: prices
        });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Enhanced light price endpoint
app.get('/api/prices/light', cacheMiddleware(CACHE_DURATION.prices), async (req, res) => {
    try {
        const rows = await executeQuery(`
            SELECT metal, price, change_percent, last_updated 
            FROM prices 
            ORDER BY metal
        `);

        const lightPrices = {};
        rows.forEach(row => {
            lightPrices[row.metal] = {
                p: row.price,
                c: row.change_percent,
                u: row.last_updated
            };
        });

        res.json({
            s: true,
            t: Date.now(),
            d: lightPrices,
            cb: circuitBreakerState // Circuit breaker status
        });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Full price endpoint with enhanced caching
app.get('/api/prices', cacheMiddleware(CACHE_DURATION.prices), async (req, res) => {
    try {
        const rows = await executeQuery('SELECT * FROM prices ORDER BY metal');

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
            source: 'GoldAPI.io',
            circuit_breaker: circuitBreakerState
        });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Optimized signals with better pagination
app.get('/api/signals', cacheMiddleware(CACHE_DURATION.signals), async (req, res) => {
    try {
        const { page = 1, limit = 20, active_only = 'false' } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        
        let query = 'SELECT * FROM signals';
        let countQuery = 'SELECT COUNT(*) as total FROM signals';
        
        if (active_only === 'true') {
            query += ' WHERE active = 1';
            countQuery += ' WHERE active = 1';
        }
        
        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

        const [countResult, rows] = await Promise.all([
            executeQuery(countQuery),
            executeQuery(query, [parseInt(limit), offset])
        ]);

        res.json({
            success: true,
            signals: rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: countResult[0].total,
                pages: Math.ceil(countResult[0].total / parseInt(limit))
            },
            timestamp: Date.now()
        });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Optimized single metal price with fallback
app.get('/api/metals/:symbol/price', cacheMiddleware(CACHE_DURATION.prices), async (req, res) => {
    try {
        const { symbol } = req.params;
        if (!metals[symbol]) {
            return res.status(400).json({ 
                error: 'Invalid symbol', 
                supported: Object.keys(metals) 
            });
        }

        // Try database first
        const rows = await executeQuery('SELECT * FROM prices WHERE metal = ?', [symbol]);
        const row = rows[0];

        if (row && (Date.now() - new Date(row.last_updated).getTime()) < 20000) {
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
        }

        // Try to fetch fresh data
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
            // Fallback to any cached data
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
                    warning: 'Live data unavailable'
                });
            }
            throw fetchError;
        }
    } catch (err) {
        res.status(500).json({ 
            error: err.message,
            timestamp: Date.now()
        });
    }
});

// Enhanced statistics endpoint
app.get('/api/statistics', cacheMiddleware(CACHE_DURATION.statistics), async (req, res) => {
    try {
        const rows = await executeQuery(`
            SELECT total_trades, win_trades, lose_trades, total_profit, win_rate, last_updated 
            FROM trade_statistics 
            ORDER BY last_updated DESC 
            LIMIT 1
        `);

        const stats = rows[0] || {
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
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Optimized trade history
app.get('/api/statistics/history', cacheMiddleware(CACHE_DURATION.history), async (req, res) => {
    try {
        const { limit = 20, offset = 0, symbol } = req.query;
        
        let query = `
            SELECT id, symbol, trade_type, entry_price, exit_price, 
                   percentage_change, result, pips, created_at 
            FROM trade_history
        `;
        let countQuery = 'SELECT COUNT(*) as total FROM trade_history';
        let params = [];
        
        if (symbol) {
            query += ' WHERE symbol = ?';
            countQuery += ' WHERE symbol = ?';
            params.push(symbol);
        }
        
        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        
        const [countResult, rows] = await Promise.all([
            executeQuery(countQuery, symbol ? [symbol] : []),
            executeQuery(query, [...params, parseInt(limit), parseInt(offset)])
        ]);

        res.json({
            success: true,
            history: rows,
            count: rows.length,
            total: countResult[0].total,
            timestamp: Date.now()
        });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Enhanced health check
app.get('/api/health', cacheMiddleware(CACHE_DURATION.health), (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: Date.now(),
        cache_size: cache.size,
        persistent_cache_size: persistentCache.size,
        circuit_breaker: circuitBreakerState,
        uptime: Math.floor(process.uptime()),
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
        }
    });
});

// Enhanced signal creation
app.post('/api/signals', async (req, res) => {
    try {
        const {
            symbol, trade_type, entry_price, target1, target2, target3, stoploss, send_notifications
        } = req.body;

        if (!symbol || !trade_type || !entry_price || !stoploss) {
            return res.status(400).json({
                error: 'Missing required fields'
            });
        }

        const result = await executeQuery(`
            INSERT INTO signals (
                symbol, trade_type, entry_price, target1, target2, target3, 
                stoploss, send_notifications, current_price, percentage_change
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            symbol, trade_type, entry_price, target1 || null, target2 || null, 
            target3 || null, stoploss, send_notifications !== false, entry_price, 0.0
        ]);

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
            signal_id: result.lastID,
            timestamp: Date.now()
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add signal' });
    }
});

// Enhanced signal update
app.put('/api/signals/:id', async (req, res) => {
    try {
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

        const result = await executeQuery(`UPDATE signals SET ${setClause.join(', ')} WHERE id = ?`, values);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Signal not found' });
        }

        // Clear cache
        cache.clear();

        res.json({
            success: true,
            changes: result.changes,
            timestamp: Date.now()
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update signal' });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    
    // Try to send cached data if available
    const cacheKey = getCacheKey(req);
    const fallback = persistentCache.get(cacheKey);
    
    if (fallback && !res.headersSent) {
        res.set('X-Cache', 'ERROR_FALLBACK');
        return res.json({
            ...fallback.data,
            _error_fallback: true,
            _age: Math.floor((Date.now() - fallback.timestamp) / 1000)
        });
    }
    
    if (!res.headersSent) {
        res.status(500).json({ 
            error: 'Internal server error',
            timestamp: Date.now()
        });
    }
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
    console.log('🚀 Enhanced Gold Tracker API Server Started');
    console.log(`🌐 Server: http://0.0.0.0:${PORT}`);
    console.log('⚡ Global Optimizations:');
    console.log('   🔄 Circuit breaker pattern');
    console.log('   📦 Enhanced compression');
    console.log('   ⚡ Aggressive caching');
    console.log('   🗄️ Connection pooling');
    console.log('   📱 Ultra-light endpoints');
    console.log('   🛡️ Fallback mechanisms');
    console.log('   ⏱️ Reduced timeouts');
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