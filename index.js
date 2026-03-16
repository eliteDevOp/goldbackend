const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression({ level: 6, threshold: 1024 }));
app.use(cors({ origin: true, credentials: false, maxAge: 86400 }));
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
    req.setTimeout(15000, () => {
        if (!res.headersSent) res.status(408).json({ error: 'Request timeout' });
    });
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Connection': 'keep-alive' });
    next();
});

const dbPath = path.join(__dirname, 'gold_tracker.db');
const db = new sqlite3.Database(dbPath);

db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA synchronous = NORMAL');
db.run('PRAGMA cache_size = 20000');
db.run('PRAGMA temp_store = memory');
db.run('PRAGMA mmap_size = 268435456');
db.run('PRAGMA optimize');

function executeQuery(query, params = []) {
    return new Promise((resolve, reject) => {
        const isSelect = query.trim().toUpperCase().startsWith('SELECT');
        const method = isSelect ? 'all' : 'run';
        db[method](query, params, function(err, result) {
            if (err) reject(err);
            else resolve(isSelect ? result : { changes: this.changes, lastID: this.lastID });
        });
    });
}

const GOLDAPI_BASE_URL = 'https://api.gold-api.com/price';
const metals = { 'XAU': 'XAU', 'XAG': 'XAG', 'XPT': 'XPT', 'XPD': 'XPD' };

const goldApi = axios.create({
    timeout: 6000,
    headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip, deflate', 'Connection': 'keep-alive' },
    maxRedirects: 2,
    validateStatus: status => status < 500
});

let circuitBreakerState = 'CLOSED';
let failureCount = 0;
let lastFailureTime = 0;
const FAILURE_THRESHOLD = 3;
const RECOVERY_TIMEOUT = 30000;

async function fetchMetalPrice(metalSymbol, retries = 1) {
    if (!metals[metalSymbol]) throw new Error(`Unsupported metal symbol: ${metalSymbol}`);
    if (circuitBreakerState === 'OPEN') {
        if (Date.now() - lastFailureTime > RECOVERY_TIMEOUT) circuitBreakerState = 'HALF_OPEN';
        else throw new Error('Circuit breaker is OPEN - API unavailable');
    }
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await goldApi.get(`${GOLDAPI_BASE_URL}/${metalSymbol}`);
            const data = response.data;
            if (circuitBreakerState === 'HALF_OPEN') { circuitBreakerState = 'CLOSED'; failureCount = 0; }
            if (!data || !data.price) throw new Error(`Invalid response for ${metalSymbol}`);
            return { price: Math.round(data.price * 100) / 100, timestamp: data.updatedAt ? new Date(data.updatedAt).getTime() : Date.now() };
        } catch (error) {
            failureCount++;
            if (failureCount >= FAILURE_THRESHOLD) { circuitBreakerState = 'OPEN'; lastFailureTime = Date.now(); }
            if (attempt === retries) throw error;
            await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
    }
}

async function getPrice24hAgo(metalSymbol) {
    try {
        const rows = await executeQuery(`
            SELECT price, recorded_at FROM price_history 
            WHERE metal = ? AND recorded_at <= datetime('now', '-23 hours')
            ORDER BY recorded_at DESC LIMIT 1
        `, [metalSymbol]);
        if (rows.length > 0) return rows[0].price;
        const oldestRows = await executeQuery(`
            SELECT price FROM price_history WHERE metal = ? ORDER BY recorded_at ASC LIMIT 1
        `, [metalSymbol]);
        return oldestRows.length > 0 ? oldestRows[0].price : null;
    } catch (err) {
        console.log(`❌ Error getting 24h price for ${metalSymbol}: ${err.message}`);
        return null;
    }
}

async function savePriceHistory(metalSymbol, price) {
    try {
        const recentRows = await executeQuery(`
            SELECT id FROM price_history WHERE metal = ? AND recorded_at >= datetime('now', '-55 minutes')
            ORDER BY recorded_at DESC LIMIT 1
        `, [metalSymbol]);
        if (recentRows.length === 0) {
            await executeQuery(`INSERT INTO price_history (metal, price, recorded_at) VALUES (?, ?, datetime('now'))`, [metalSymbol, price]);
            console.log(`📊 Saved hourly snapshot: ${metalSymbol} = $${price}`);
        }
    } catch (err) {
        console.log(`❌ Error saving price history: ${err.message}`);
    }
}

async function cleanupOldHistory() {
    try {
        await executeQuery(`DELETE FROM price_history WHERE recorded_at < datetime('now', '-7 days')`);
        console.log('🧹 Cleaned up old price history');
    } catch (err) {
        console.log(`❌ Error cleaning history: ${err.message}`);
    }
}

async function updateAllMetalPrices() {
    const startTime = Date.now();
    console.log('🔄 Starting price update...');
    try {
        const updatePromises = Object.keys(metals).map(async (symbol) => {
            try {
                const priceData = await fetchMetalPrice(symbol);
                const currentPrice = priceData.price;
                await savePriceHistory(symbol, currentPrice);
                const price24hAgo = await getPrice24hAgo(symbol);
                let change24h = 0;
                let changePercent = 0;
                if (price24hAgo && price24hAgo > 0) {
                    change24h = Math.round((currentPrice - price24hAgo) * 100) / 100;
                    changePercent = Math.round(((currentPrice - price24hAgo) / price24hAgo) * 10000) / 100;
                    console.log(`📈 ${symbol}: $${currentPrice} | 24h ago: $${price24hAgo} | Change: ${change24h >= 0 ? '+' : ''}${change24h} (${changePercent >= 0 ? '+' : ''}${changePercent}%)`);
                } else {
                    console.log(`📈 ${symbol}: $${currentPrice} | Building 24h history...`);
                }
                await executeQuery(`
                    INSERT OR REPLACE INTO prices (
                        metal, price, ask_price, bid_price, change_24h, change_percent,
                        high_24h, low_24h, open_price, prev_close_price, last_updated
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                `, [symbol, currentPrice, currentPrice, currentPrice, change24h, changePercent, null, null, null, price24hAgo || currentPrice]);
                return symbol;
            } catch (error) {
                console.log(`❌ Error updating ${symbol}: ${error.message}`);
                return null;
            }
        });
        await Promise.allSettled(updatePromises);
        const now = new Date();
        if (now.getHours() === 0 && now.getMinutes() < 1) await cleanupOldHistory();
        console.log(`✅ Price update completed in ${Date.now() - startTime}ms`);
    } catch (error) {
        console.log(`❌ Batch update error: ${error.message}`);
    }
}

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS prices (
        metal TEXT PRIMARY KEY, price REAL NOT NULL, ask_price REAL, bid_price REAL,
        change_24h REAL DEFAULT 0, change_percent REAL DEFAULT 0,
        high_24h REAL, low_24h REAL, open_price REAL, prev_close_price REAL,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metal TEXT NOT NULL, price REAL NOT NULL,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run('CREATE INDEX IF NOT EXISTS idx_price_history_metal_time ON price_history(metal, recorded_at DESC)');

    db.run(`CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, trade_type TEXT NOT NULL,
        entry_price REAL NOT NULL, current_price REAL, percentage_change REAL DEFAULT 0.0,
        target1 REAL, target2 REAL, target3 REAL,
        target1_hit BOOLEAN DEFAULT 0, target2_hit BOOLEAN DEFAULT 0, target3_hit BOOLEAN DEFAULT 0,
        stoploss REAL NOT NULL, active BOOLEAN DEFAULT 1, send_notifications BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run('CREATE INDEX IF NOT EXISTS idx_signals_active_created ON signals(active, created_at DESC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_signals_symbol_active ON signals(symbol, active)');
    db.run('CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC)');

    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, device_token TEXT UNIQUE, platform TEXT,
        subscribed BOOLEAN DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS trade_statistics (
        id INTEGER PRIMARY KEY AUTOINCREMENT, total_trades INTEGER DEFAULT 0,
        win_trades INTEGER DEFAULT 0, lose_trades INTEGER DEFAULT 0,
        total_profit REAL DEFAULT 0.0, win_rate REAL DEFAULT 0.0,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS trade_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, signal_id INTEGER, symbol TEXT NOT NULL,
        trade_type TEXT NOT NULL, entry_price REAL NOT NULL, exit_price REAL NOT NULL,
        price_change REAL NOT NULL, percentage_change REAL NOT NULL, result TEXT NOT NULL,
        pips REAL NOT NULL, closed_by TEXT DEFAULT 'admin',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run('CREATE INDEX IF NOT EXISTS idx_trade_history_created_symbol ON trade_history(created_at DESC, symbol)');

    db.get('SELECT COUNT(*) as count FROM trade_statistics', [], (err, row) => {
        if (!err && row.count === 0) {
            db.run(`INSERT INTO trade_statistics (total_trades, win_trades, lose_trades, total_profit, win_rate) VALUES (0, 0, 0, 0.0, 0.0)`);
        }
    });
});

console.log('🚀 Starting price monitoring...');
updateAllMetalPrices();
setInterval(updateAllMetalPrices, 60 * 1000);

app.get('/api/prices', async (req, res) => {
    try {
        const startTime = Date.now();
        const rows = await executeQuery('SELECT * FROM prices ORDER BY metal');
        const prices = {};
        rows.forEach(row => {
            prices[row.metal] = {
                price: row.price, ask_price: row.ask_price, bid_price: row.bid_price,
                change_24h: row.change_24h || 0, change_percent: row.change_percent || 0,
                high_24h: row.high_24h, low_24h: row.low_24h,
                open_price: row.open_price, prev_close_price: row.prev_close_price,
                last_updated: row.last_updated
            };
        });
        res.set('X-Response-Time', `${Date.now() - startTime}ms`);
        res.json({ success: true, timestamp: Date.now(), prices, source: 'gold-api.com', circuit_breaker: circuitBreakerState });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/prices/:symbol/history', async (req, res) => {
    try {
        const { symbol } = req.params;
        const { hours = 24 } = req.query;
        if (!metals[symbol]) return res.status(400).json({ error: 'Invalid symbol', supported: Object.keys(metals) });
        const rows = await executeQuery(`
            SELECT price, recorded_at FROM price_history 
            WHERE metal = ? AND recorded_at >= datetime('now', '-${parseInt(hours)} hours')
            ORDER BY recorded_at ASC
        `, [symbol]);
        res.json({ success: true, symbol, history: rows, count: rows.length, timestamp: Date.now() });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/signals', async (req, res) => {
    try {
        const startTime = Date.now();
        const { active_only = 'false' } = req.query;
        let query = `SELECT id, symbol, trade_type, entry_price, current_price, percentage_change,
                   target1, target2, target3, target1_hit, target2_hit, target3_hit,
                   stoploss, active, created_at, updated_at FROM signals`;
        if (active_only === 'true') query += ' WHERE active = 1';
        query += ' ORDER BY created_at DESC LIMIT 100';
        const rows = await executeQuery(query);
        res.set('X-Response-Time', `${Date.now() - startTime}ms`);
        res.json({ success: true, signals: rows, count: rows.length, timestamp: Date.now() });
    } catch (err) {
        res.status(500).json({ error: 'Database error', timestamp: Date.now() });
    }
});

app.get('/api/signals/:id', async (req, res) => {
    try {
        const rows = await executeQuery('SELECT * FROM signals WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Signal not found' });
        res.json({ success: true, signal: rows[0], timestamp: Date.now() });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/metals/:symbol/price', async (req, res) => {
    try {
        const { symbol } = req.params;
        if (!metals[symbol]) return res.status(400).json({ error: 'Invalid symbol', supported: Object.keys(metals) });
        const rows = await executeQuery('SELECT * FROM prices WHERE metal = ?', [symbol]);
        const row = rows[0];
        if (row) {
            res.json({ success: true, symbol, price: row.price, ask: row.ask_price, bid: row.bid_price,
                change: row.change_24h || 0, changePercent: row.change_percent || 0,
                timestamp: Date.now(), last_updated: row.last_updated });
        } else {
            try {
                const data = await fetchMetalPrice(symbol);
                res.json({ success: true, symbol, ...data, timestamp: Date.now(), source: 'live' });
            } catch (fetchError) {
                res.status(500).json({ error: fetchError.message, timestamp: Date.now() });
            }
        }
    } catch (err) {
        res.status(500).json({ error: err.message, timestamp: Date.now() });
    }
});

app.get('/api/statistics', async (req, res) => {
    try {
        const rows = await executeQuery(`SELECT total_trades, win_trades, lose_trades, total_profit, win_rate, last_updated FROM trade_statistics ORDER BY last_updated DESC LIMIT 1`);
        const stats = rows[0] || { total_trades: 0, win_trades: 0, lose_trades: 0, total_profit: 0.0, win_rate: 0.0, last_updated: new Date().toISOString() };
        res.json({ success: true, statistics: stats, timestamp: Date.now() });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/statistics/history', async (req, res) => {
    try {
        const { limit = 50, symbol } = req.query;
        let query = `SELECT id, symbol, trade_type, entry_price, exit_price, percentage_change, result, pips, created_at FROM trade_history`;
        let params = [];
        if (symbol) { query += ' WHERE symbol = ?'; params.push(symbol); }
        query += ' ORDER BY created_at DESC LIMIT ?';
        params.push(parseInt(limit));
        const rows = await executeQuery(query, params);
        res.json({ success: true, history: rows, count: rows.length, timestamp: Date.now() });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: Date.now(), circuit_breaker: circuitBreakerState,
        uptime: Math.floor(process.uptime()),
        memory: { used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) }
    });
});

app.post('/api/signals', async (req, res) => {
    try {
        const { symbol, trade_type, entry_price, target1, target2, target3, stoploss, send_notifications } = req.body;
        if (!symbol || !trade_type || !entry_price || !stoploss) return res.status(400).json({ error: 'Missing required fields' });
        const result = await executeQuery(`
            INSERT INTO signals (symbol, trade_type, entry_price, target1, target2, target3, stoploss, send_notifications, current_price, percentage_change)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [symbol, trade_type, entry_price, target1 || null, target2 || null, target3 || null, stoploss, send_notifications !== false, entry_price, 0.0]);
        res.json({ success: true, signal_id: result.lastID, timestamp: Date.now() });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add signal' });
    }
});

app.put('/api/signals/:id', async (req, res) => {
    try {
        const signalId = req.params.id;
        const updates = req.body;
        const allowedFields = ['target1_hit', 'target2_hit', 'target3_hit', 'active', 'current_price', 'percentage_change'];
        const setClause = [];
        const values = [];
        for (const field of allowedFields) {
            if (updates[field] !== undefined) { setClause.push(`${field} = ?`); values.push(updates[field]); }
        }
        if (setClause.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
        setClause.push('updated_at = CURRENT_TIMESTAMP');
        values.push(signalId);
        const result = await executeQuery(`UPDATE signals SET ${setClause.join(', ')} WHERE id = ?`, values);
        if (result.changes === 0) return res.status(404).json({ error: 'Signal not found' });
        res.json({ success: true, changes: result.changes, timestamp: Date.now() });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update signal' });
    }
});

app.use((err, req, res, next) => {
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error', timestamp: Date.now() });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found', timestamp: Date.now() });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Gold Tracker API Server Started');
    console.log(`🌐 Server: http://0.0.0.0:${PORT}`);
    console.log('📊 24h price change tracking: ENABLED');
    console.log('⏱️  Price update interval: 60 seconds');
    console.log('🕐 Price history saved: every hour');
    console.log('\n📡 Available endpoints:');
    console.log('   GET  /api/prices - All metal prices with 24h change');
    console.log('   GET  /api/prices/:symbol/history - Price history');
    console.log('   GET  /api/signals - All signals');
    console.log('   GET  /api/metals/:symbol/price - Single metal');
    console.log('   GET  /api/statistics - Trade statistics');
    console.log('   GET  /api/health - Health check');
    console.log('   POST /api/signals - Create signal');
    console.log('   PUT  /api/signals/:id - Update signal');
});

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    db.close((err) => {
        if (err) console.error('❌ Error closing database:', err.message);
        else console.log('💾 Database connection closed');
        process.exit(0);
    });
});