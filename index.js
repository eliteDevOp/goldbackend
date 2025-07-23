const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database setup
const dbPath = path.join(__dirname, 'gold_tracker.db');
const db = new sqlite3.Database(dbPath);

// API Configuration
const POLYGON_API_KEY = 'i4wKSoyGcr94hGIydnBO3SjpOO1YKD1O'; // Replace with your actual key
const metals = {
    'XAU': 'C:XAUUSD',
    'XAG': 'C:XAGUSD',
    'XPT': 'C:XPTUSD',
    'XPD': 'C:XPDUSD'
};

// Helper functions
function logWithTimestamp(message) {
    const now = new Date();
    const timestamp = now.toLocaleTimeString();
    console.log(`${message} (${timestamp})`);
}

async function fetchMetalPrice(metalSymbol) {
    const ticker = metals[metalSymbol];
    if (!ticker) throw new Error(`Unsupported metal symbol: ${metalSymbol}`);

    logWithTimestamp(`📡 Fetching price for ${metalSymbol}`);
    const response = await axios.get(`https://api.polygon.io/v2/aggs/ticker/${ticker}/prev`, {
        params: { adjusted: 'true', apikey: POLYGON_API_KEY }
    });

    const result = response.data?.results?.[0];
    if (!result) throw new Error('No price data available');

    return {
        price: result.c,
        change: result.c - result.o,
        changePercent: ((result.c - result.o) / result.o) * 100
    };
}

async function updateAllMetalPrices() {
    for (const symbol in metals) {
        try {
            const { price, change, changePercent } = await fetchMetalPrice(symbol);
            db.run(`
                INSERT INTO prices (metal, price, change_24h, change_percent, last_updated)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(metal) DO UPDATE SET 
                    price = excluded.price,
                    change_24h = excluded.change_24h,
                    change_percent = excluded.change_percent,
                    last_updated = CURRENT_TIMESTAMP
            `, [symbol, price, change, changePercent], (err) => {
                if (err) console.error(`❌ Failed to update ${symbol}:`, err.message);
                else logWithTimestamp(`✅ Updated ${symbol} price: $${price.toFixed(2)}`);
            });
        } catch (err) {
            console.error(`❌ Error updating ${symbol}:`, err.message);
        }
    }
}

// Initialize database tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metal TEXT UNIQUE NOT NULL,
        price REAL NOT NULL,
        change_24h REAL,
        change_percent REAL,
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
});

// Call once on startup and every 5 minutes
updateAllMetalPrices();
setInterval(updateAllMetalPrices, 1 * 60 * 1000);

// ========== ROUTES ==========

// Get all metal prices
app.get('/api/prices', (req, res) => {
    db.all('SELECT * FROM prices ORDER BY last_updated DESC', [], (err, rows) => {
        if (err) {
            console.error('❌ Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        const prices = rows.reduce((acc, row) => {
            acc[row.metal] = {
                price: row.price,
                change_24h: row.change_24h,
                change_percent: row.change_percent,
                last_updated: row.last_updated
            };
            return acc;
        }, {});

        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            prices
        });
    });
});

// Get live metal price from API
app.get('/api/metals/:symbol/price', async (req, res) => {
    try {
        const { symbol } = req.params;
        if (!metals[symbol]) return res.status(400).json({ error: 'Invalid symbol' });

        const data = await fetchMetalPrice(symbol);
        res.json({
            success: true,
            symbol,
            ...data,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        database: 'connected'
    });
});

// ========== START SERVER ==========
app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Enhanced Gold Tracker API Server Started');
    console.log(`🌐 Server running on http://0.0.0.0:${PORT}`);
    console.log('📡 Available endpoints:');
    console.log('   📊 Prices:');
    console.log('      GET  /api/prices - Get all metal prices');
    console.log('      GET  /api/metals/{symbol}/price - Get specific metal price');
    console.log('   🔧 System:');
    console.log('      GET  /api/health - Health check');
});

// ========== SHUTDOWN ==========
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    db.close((err) => {
        if (err) console.error('❌ Error closing database:', err.message);
        else console.log('💾 Database connection closed');
        process.exit(0);
    });
});
