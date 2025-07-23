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

// Initialize database tables
db.serialize(() => {
    // Existing prices table
    db.run(`CREATE TABLE IF NOT EXISTS prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metal TEXT UNIQUE NOT NULL,
        price REAL NOT NULL,
        change_24h REAL,
        change_percent REAL,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // New signals table
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

    // Users table for notification management
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_token TEXT UNIQUE,
        platform TEXT,
        subscribed BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// API Configuration
const POLYGON_API_KEY = 'i4wKSoyGcr94hGIydnBO3SjpOO1YKD1O'; // Replace with your API key
const metals = {
    'XAU': 'C:XAUUSD', // Gold
    'XAG': 'C:XAGUSD', // Silver
    'XPT': 'C:XPTUSD', // Platinum
    'XPD': 'C:XPDUSD'  // Palladium
};

// Cache for prices
let priceCache = {};
let lastApiCall = {};

// Helper functions
function logWithTimestamp(message) {
    const now = new Date();
    const timestamp = now.toLocaleTimeString();
    console.log(`${message} (${timestamp})`);
}

async function fetchMetalPrice(metalSymbol) {
    try {
        const ticker = metals[metalSymbol];
        if (!ticker) {
            throw new Error(`Unsupported metal symbol: ${metalSymbol}`);
        }

        logWithTimestamp(`📡 Fetching price for ${metalSymbol}`);
        
        const response = await axios.get(`https://api.polygon.io/v2/aggs/ticker/${ticker}/prev`, {
            params: {
                adjusted: 'true',
                apikey: POLYGON_API_KEY
            }
        });

        if (response.data && response.data.results && response.data.results.length > 0) {
            const result = response.data.results[0];
            return {
                price: result.c, // Close price
                change: result.c - result.o, // Change from open
                changePercent: ((result.c - result.o) / result.o) * 100
            };
        } else {
            throw new Error('No price data available');
        }
    } catch (error) {
        console.error(`❌ Error fetching ${metalSymbol} price:`, error.message);
        throw error;
    }
}

// Signal API Endpoints

// Get all signals
app.get('/api/signals', (req, res) => {
    const { active, limit = 50, offset = 0 } = req.query;
    
    let query = 'SELECT * FROM signals';
    let params = [];
    
    if (active !== undefined) {
        query += ' WHERE active = ?';
        params.push(active === 'true' ? 1 : 0);
    }
    
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('❌ Error fetching signals:', err);
            return res.status(500).json({ error: 'Failed to fetch signals' });
        }
        
        // Convert boolean fields
        const signals = rows.map(row => ({
            ...row,
            target1_hit: Boolean(row.target1_hit),
            target2_hit: Boolean(row.target2_hit),
            target3_hit: Boolean(row.target3_hit),
            active: Boolean(row.active),
            send_notifications: Boolean(row.send_notifications)
        }));
        
        res.json({
            success: true,
            signals,
            count: signals.length
        });
    });
});

// Get signal by ID
app.get('/api/signals/:id', (req, res) => {
    const { id } = req.params;
    
    db.get('SELECT * FROM signals WHERE id = ?', [id], (err, row) => {
        if (err) {
            console.error('❌ Error fetching signal:', err);
            return res.status(500).json({ error: 'Failed to fetch signal' });
        }
        
        if (!row) {
            return res.status(404).json({ error: 'Signal not found' });
        }
        
        // Convert boolean fields
        const signal = {
            ...row,
            target1_hit: Boolean(row.target1_hit),
            target2_hit: Boolean(row.target2_hit),
            target3_hit: Boolean(row.target3_hit),
            active: Boolean(row.active),
            send_notifications: Boolean(row.send_notifications)
        };
        
        res.json({
            success: true,
            signal
        });
    });
});

// Create new signal
app.post('/api/signals', async (req, res) => {
    try {
        const {
            symbol,
            trade_type,
            entry_price,
            target1,
            target2,
            target3,
            stoploss,
            send_notifications = true
        } = req.body;

        // Validation
        if (!symbol || !trade_type || !entry_price || !stoploss) {
            return res.status(400).json({
                error: 'Missing required fields: symbol, trade_type, entry_price, stoploss'
            });
        }

        if (!['BUY', 'SELL'].includes(trade_type.toUpperCase())) {
            return res.status(400).json({
                error: 'trade_type must be either BUY or SELL'
            });
        }

        if (!metals[symbol]) {
            return res.status(400).json({
                error: 'Invalid symbol. Supported symbols: XAU, XAG, XPT, XPD'
            });
        }

        // Get current price
        let current_price = entry_price;
        try {
            const priceData = await fetchMetalPrice(symbol);
            current_price = priceData.price;
        } catch (error) {
            console.warn('⚠️ Could not fetch current price, using entry price');
        }

        // Calculate percentage change
        const percentage_change = ((current_price - entry_price) / entry_price) * 100;

        const query = `
            INSERT INTO signals (
                symbol, trade_type, entry_price, current_price, percentage_change,
                target1, target2, target3, stoploss, send_notifications
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const params = [
            symbol,
            trade_type.toUpperCase(),
            entry_price,
            current_price,
            percentage_change,
            target1 || null,
            target2 || null,
            target3 || null,
            stoploss,
            send_notifications ? 1 : 0
        ];

        db.run(query, params, function(err) {
            if (err) {
                console.error('❌ Error creating signal:', err);
                return res.status(500).json({ error: 'Failed to create signal' });
            }

            logWithTimestamp(`✅ New signal created: ${symbol} ${trade_type} at ${entry_price}`);

            // Send notification if enabled
            if (send_notifications) {
                sendSignalNotification({
                    id: this.lastID,
                    symbol,
                    trade_type,
                    entry_price,
                    current_price
                });
            }

            res.status(201).json({
                success: true,
                signal_id: this.lastID,
                message: 'Signal created successfully'
            });
        });

    } catch (error) {
        console.error('❌ Error in signal creation:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update signal
app.put('/api/signals/:id', (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    
    // Build dynamic update query
    const allowedFields = [
        'target1_hit', 'target2_hit', 'target3_hit', 'active', 
        'current_price', 'percentage_change'
    ];
    
    const updateFields = [];
    const params = [];
    
    Object.keys(updates).forEach(key => {
        if (allowedFields.includes(key)) {
            updateFields.push(`${key} = ?`);
            params.push(updates[key]);
        }
    });
    
    if (updateFields.length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
    }
    
    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);
    
    const query = `UPDATE signals SET ${updateFields.join(', ')} WHERE id = ?`;
    
    db.run(query, params, function(err) {
        if (err) {
            console.error('❌ Error updating signal:', err);
            return res.status(500).json({ error: 'Failed to update signal' });
        }
        
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Signal not found' });
        }
        
        res.json({
            success: true,
            message: 'Signal updated successfully'
        });
    });
});

// Delete signal
app.delete('/api/signals/:id', (req, res) => {
    const { id } = req.params;
    
    db.run('DELETE FROM signals WHERE id = ?', [id], function(err) {
        if (err) {
            console.error('❌ Error deleting signal:', err);
            return res.status(500).json({ error: 'Failed to delete signal' });
        }
        
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Signal not found' });
        }
        
        res.json({
            success: true,
            message: 'Signal deleted successfully'
        });
    });
});

// Get current metal price
app.get('/api/metals/:symbol/price', async (req, res) => {
    try {
        const { symbol } = req.params;
        
        if (!metals[symbol]) {
            return res.status(400).json({
                error: 'Invalid symbol. Supported symbols: XAU, XAG, XPT, XPD'
            });
        }
        
        const priceData = await fetchMetalPrice(symbol);
        
        res.json({
            success: true,
            symbol,
            ...priceData,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        res.status(500).json({
            error: 'Failed to fetch price',
            message: error.message
        });
    }
});

// User management endpoints
app.post('/api/users/register', (req, res) => {
    const { device_token, platform = 'android' } = req.body;
    
    if (!device_token) {
        return res.status(400).json({ error: 'device_token is required' });
    }
    
    const query = `
        INSERT OR REPLACE INTO users (device_token, platform, subscribed)
        VALUES (?, ?, 1)
    `;
    
    db.run(query, [device_token, platform], function(err) {
        if (err) {
            console.error('❌ Error registering user:', err);
            return res.status(500).json({ error: 'Failed to register user' });
        }
        
        res.json({
            success: true,
            message: 'User registered successfully'
        });
    });
});

// Notification helper function
function sendSignalNotification(signal) {
    // Get all subscribed users
    db.all('SELECT device_token FROM users WHERE subscribed = 1', [], (err, users) => {
        if (err) {
            console.error('❌ Error fetching users for notification:', err);
            return;
        }
        
        if (users.length === 0) {
            console.log('📱 No users to notify');
            return;
        }
        
        const notificationPayload = {
            title: `New ${signal.symbol} Signal`,
            body: `${signal.trade_type} signal at $${signal.entry_price}`,
            data: {
                signal_id: signal.id,
                symbol: signal.symbol,
                trade_type: signal.trade_type,
                entry_price: signal.entry_price
            }
        };
        
        // Here you would integrate with your notification service (FCM, etc.)
        console.log(`📱 Would send notification to ${users.length} users:`, notificationPayload);
        
        // Example FCM integration (you'll need to implement this):
        // sendFCMNotification(users.map(u => u.device_token), notificationPayload);
    });
}

// Existing price endpoints (keeping your original functionality)
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

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        database: 'connected'
    });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Enhanced Gold Tracker API Server Started');
    console.log(`🌐 Server running on http://0.0.0.0:${PORT}`);
    console.log('📡 Available endpoints:');
    console.log('   📊 Prices:');
    console.log('      GET  /api/prices - Get all metal prices');
    console.log('      GET  /api/metals/{symbol}/price - Get specific metal price');
    console.log('   📈 Signals:');
    console.log('      GET  /api/signals - Get all signals');
    console.log('      GET  /api/signals/{id} - Get specific signal');
    console.log('      POST /api/signals - Create new signal');
    console.log('      PUT  /api/signals/{id} - Update signal');
    console.log('      DELETE /api/signals/{id} - Delete signal');
    console.log('   👥 Users:');
    console.log('      POST /api/users/register - Register device for notifications');
    console.log('   🔧 System:');
    console.log('      GET  /api/health - Health check');
    console.log('💾 Database: SQLite with signals table initialized');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    db.close((err) => {
        if (err) {
            console.error('❌ Error closing database:', err);
        } else {
            console.log('💾 Database connection closed');
        }
        process.exit(0);
    });
});