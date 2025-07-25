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

// GoldAPI Configuration
const GOLDAPI_KEY = 'goldapi-75sa519mditl5es-io';
const GOLDAPI_BASE_URL = 'https://www.goldapi.io/api';
const metals = {
    'XAU': 'XAU/USD', // Gold
    'XAG': 'XAG/USD', // Silver
    'XPT': 'XPT/USD', // Platinum
    'XPD': 'XPD/USD'  // Palladium
};

// Helper functions
function logWithTimestamp(message) {
    const now = new Date();
    const timestamp = now.toLocaleTimeString();
    console.log(`${message} (${timestamp})`);
}

async function fetchMetalPrice(metalSymbol) {
    const endpoint = metals[metalSymbol];
    if (!endpoint) throw new Error(`Unsupported metal symbol: ${metalSymbol}`);

    logWithTimestamp(`📡 Fetching price for ${metalSymbol} from GoldAPI`);
    
    try {
        const response = await axios.get(`${GOLDAPI_BASE_URL}/${endpoint}`, {
            headers: {
                'x-access-token': GOLDAPI_KEY,
                'Content-Type': 'application/json'
            }
        });

        const data = response.data;
        
        if (data.error) {
            throw new Error(`GoldAPI Error: ${data.error}`);
        }

        // Calculate estimated current price using ask and bid
        const askPrice = data.ask || data.price;
        const bidPrice = data.bid || data.price;
        const estimatedPrice = (askPrice + bidPrice) / 2;
        
        // Calculate change from previous close (if available)
        const previousClose = data.prev_close_price || estimatedPrice;
        const change = estimatedPrice - previousClose;
        const changePercent = ((change / previousClose) * 100);

        logWithTimestamp(`✅ ${metalSymbol} - Ask: $${askPrice}, Bid: $${bidPrice}, Estimated: $${estimatedPrice.toFixed(2)}`);

        return {
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
    } catch (error) {
        if (error.response) {
            logWithTimestamp(`❌ GoldAPI HTTP Error ${error.response.status}: ${error.response.data?.error || error.message}`);
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

async function updateAllMetalPrices() {
    logWithTimestamp('🔄 Starting price update cycle...');
    
    for (const symbol in metals) {
        try {
            const priceData = await fetchMetalPrice(symbol);
            
            // Check if price has changed before updating
            db.get('SELECT price FROM prices WHERE metal = ?', [symbol], (err, row) => {
                if (err) {
                    console.error(`❌ Error checking existing price for ${symbol}:`, err.message);
                    return;
                }

                const hasChanged = !row || Math.abs(row.price - priceData.price) > 0.01; // Only update if price changed by more than $0.01
                
                if (hasChanged) {
                    db.run(`
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
                        symbol, 
                        priceData.price, 
                        priceData.ask, 
                        priceData.bid, 
                        priceData.change, 
                        priceData.changePercent,
                        priceData.high_24h,
                        priceData.low_24h,
                        priceData.open_price,
                        priceData.prev_close_price
                    ], (err) => {
                        if (err) {
                            console.error(`❌ Failed to update ${symbol}:`, err.message);
                        } else {
                            logWithTimestamp(`✅ Updated ${symbol} price: $${priceData.price.toFixed(2)} (Ask: $${priceData.ask}, Bid: $${priceData.bid})`);
                        }
                    });
                } else {
                    logWithTimestamp(`📊 ${symbol} price unchanged: $${priceData.price.toFixed(2)}`);
                }
            });

            // Add small delay between API calls to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
            
        } catch (err) {
            console.error(`❌ Error updating ${symbol}:`, err.message);
        }
    }
    
    logWithTimestamp('✅ Price update cycle completed');
}

// Initialize database tables
db.serialize(() => {
    // Create or update prices table to include GoldAPI fields
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

    // Add missing columns to existing prices table (for database migration)
    const columnsToAdd = [
        'ask_price REAL',
        'bid_price REAL', 
        'high_24h REAL',
        'low_24h REAL',
        'open_price REAL',
        'prev_close_price REAL'
    ];

    columnsToAdd.forEach(column => {
        const columnName = column.split(' ')[0];
        db.run(`ALTER TABLE prices ADD COLUMN ${column}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error(`❌ Error adding column ${columnName}:`, err.message);
            } else if (!err) {
                logWithTimestamp(`✅ Added column ${columnName} to prices table`);
            }
        });
    });

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

    // Initialize statistics if not exists
    db.get('SELECT COUNT(*) as count FROM trade_statistics', [], (err, row) => {
        if (!err && row.count === 0) {
            db.run(`INSERT INTO trade_statistics (total_trades, win_trades, lose_trades, total_profit, win_rate) 
                    VALUES (0, 0, 0, 0.0, 0.0)`);
            logWithTimestamp('✅ Initialized trade statistics');
        }
    });
});

// Start price updates - Initial call and then every 15 seconds
logWithTimestamp('🚀 Starting GoldAPI price monitoring...');
updateAllMetalPrices();
setInterval(updateAllMetalPrices, 15 * 1000); // 15 seconds interval

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
    });
});

// Get live metal price from GoldAPI
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

// Health check with GoldAPI status
app.get('/api/health', async (req, res) => {
    let goldApiStatus = 'unknown';
    
    try {
        // Test GoldAPI connectivity
        await axios.get(`${GOLDAPI_BASE_URL}/XAU/USD`, {
            headers: {
                'x-access-token': GOLDAPI_KEY,
                'Content-Type': 'application/json'
            },
            timeout: 5000
        });
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

// ========== SIGNALS ROUTES ==========

// Get all signals
app.get('/api/signals', (req, res) => {
    db.all(`
        SELECT * FROM signals 
        ORDER BY created_at DESC
    `, [], (err, rows) => {
        if (err) {
            console.error('❌ Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        logWithTimestamp(`📋 Retrieved ${rows.length} signals`);
        res.json({
            success: true,
            signals: rows,
            count: rows.length,
            timestamp: new Date().toISOString()
        });
    });
});

// Add a new signal
app.post('/api/signals', (req, res) => {
    const {
        symbol,
        trade_type,
        entry_price,
        target1,
        target2,
        target3,
        stoploss,
        send_notifications
    } = req.body;

    // Validation
    if (!symbol || !trade_type || !entry_price || !stoploss) {
        return res.status(400).json({
            error: 'Missing required fields: symbol, trade_type, entry_price, stoploss'
        });
    }

    logWithTimestamp(`📤 Adding new signal: ${symbol} ${trade_type} at ${entry_price}`);

    db.run(`
        INSERT INTO signals (
            symbol, trade_type, entry_price, target1, target2, target3, 
            stoploss, send_notifications, current_price, percentage_change
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        symbol,
        trade_type,
        entry_price,
        target1 || null,
        target2 || null,
        target3 || null,
        stoploss,
        send_notifications !== false,
        entry_price,
        0.0
    ], function(err) {
        if (err) {
            console.error('❌ Error adding signal:', err);
            return res.status(500).json({ error: 'Failed to add signal' });
        }

        logWithTimestamp(`✅ Signal added successfully with ID: ${this.lastID}`);
        res.json({
            success: true,
            message: 'Signal added successfully',
            signal_id: this.lastID,
            timestamp: new Date().toISOString()
        });
    });
});

// Update a signal
app.put('/api/signals/:id', (req, res) => {
    const signalId = req.params.id;
    const {
        target1_hit,
        target2_hit,
        target3_hit,
        active,
        current_price,
        percentage_change
    } = req.body;

    logWithTimestamp(`📝 Updating signal ${signalId}`);

    db.run(`
        UPDATE signals SET
            target1_hit = COALESCE(?, target1_hit),
            target2_hit = COALESCE(?, target2_hit),
            target3_hit = COALESCE(?, target3_hit),
            active = COALESCE(?, active),
            current_price = COALESCE(?, current_price),
            percentage_change = COALESCE(?, percentage_change),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [
        target1_hit,
        target2_hit,
        target3_hit,
        active,
        current_price,
        percentage_change,
        signalId
    ], function(err) {
        if (err) {
            console.error('❌ Error updating signal:', err);
            return res.status(500).json({ error: 'Failed to update signal' });
        }

        if (this.changes === 0) {
            return res.status(404).json({ error: 'Signal not found' });
        }

        logWithTimestamp(`✅ Signal ${signalId} updated successfully`);
        res.json({
            success: true,
            message: 'Signal updated successfully',
            changes: this.changes,
            timestamp: new Date().toISOString()
        });
    });
});

// Delete a signal
app.delete('/api/signals/:id', (req, res) => {
    const signalId = req.params.id;

    logWithTimestamp(`🗑️ Deleting signal ${signalId}`);

    db.run('DELETE FROM signals WHERE id = ?', [signalId], function(err) {
        if (err) {
            console.error('❌ Error deleting signal:', err);
            return res.status(500).json({ error: 'Failed to delete signal' });
        }

        if (this.changes === 0) {
            return res.status(404).json({ error: 'Signal not found' });
        }

        logWithTimestamp(`✅ Signal ${signalId} deleted successfully`);
        res.json({
            success: true,
            message: 'Signal deleted successfully',
            changes: this.changes,
            timestamp: new Date().toISOString()
        });
    });
});

// Get a specific signal
app.get('/api/signals/:id', (req, res) => {
    const signalId = req.params.id;

    db.get('SELECT * FROM signals WHERE id = ?', [signalId], (err, row) => {
        if (err) {
            console.error('❌ Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        if (!row) {
            return res.status(404).json({ error: 'Signal not found' });
        }

        res.json({
            success: true,
            signal: row,
            timestamp: new Date().toISOString()
        });
    });
});

// ========== STATISTICS ROUTES ==========

// Get trade statistics
app.get('/api/statistics', (req, res) => {
    db.get('SELECT * FROM trade_statistics ORDER BY last_updated DESC LIMIT 1', [], (err, row) => {
        if (err) {
            console.error('❌ Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }

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

        logWithTimestamp(`📊 Retrieved trade statistics`);
        res.json({
            success: true,
            statistics: row,
            timestamp: new Date().toISOString()
        });
    });
});

// Add trade result and update statistics
app.post('/api/statistics/trade', (req, res) => {
    const {
        signal_id,
        symbol,
        trade_type,
        entry_price,
        exit_price,
        price_change,
        percentage_change,
        result,
        pips,
        closed_by = 'admin'
    } = req.body;

    // Validation
    if (!symbol || !trade_type || !entry_price || !exit_price || !result || pips === undefined) {
        return res.status(400).json({
            error: 'Missing required fields: symbol, trade_type, entry_price, exit_price, result, pips'
        });
    }

    if (!['profit', 'loss'].includes(result)) {
        return res.status(400).json({ error: 'Result must be either "profit" or "loss"' });
    }

    logWithTimestamp(`📈 Adding trade result: ${symbol} ${result} ${pips} pips`);

    // Start transaction
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        // Insert trade history record
        db.run(`
            INSERT INTO trade_history (
                signal_id, symbol, trade_type, entry_price, exit_price, 
                price_change, percentage_change, result, pips, closed_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            signal_id,
            symbol,
            trade_type,
            entry_price,
            exit_price,
            price_change,
            percentage_change,
            result,
            pips,
            closed_by
        ], function(err) {
            if (err) {
                console.error('❌ Error adding trade history:', err);
                db.run('ROLLBACK');
                return res.status(500).json({ error: 'Failed to add trade history' });
            }

            const tradeHistoryId = this.lastID;

            // Get current statistics
            db.get('SELECT * FROM trade_statistics ORDER BY last_updated DESC LIMIT 1', [], (err, stats) => {
                if (err) {
                    console.error('❌ Error getting statistics:', err);
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: 'Failed to get current statistics' });
                }

                // Calculate new statistics
                const currentStats = stats || {
                    total_trades: 0,
                    win_trades: 0,
                    lose_trades: 0,
                    total_profit: 0.0
                };

                const newTotalTrades = currentStats.total_trades + 1;
                const newWinTrades = currentStats.win_trades + (result === 'profit' ? 1 : 0);
                const newLoseTrades = currentStats.lose_trades + (result === 'loss' ? 1 : 0);
                const newTotalProfit = currentStats.total_profit + (result === 'profit' ? pips : -pips);
                const newWinRate = newTotalTrades > 0 ? (newWinTrades / newTotalTrades) * 100 : 0;

                // Update statistics
                db.run(`
                    INSERT OR REPLACE INTO trade_statistics (
                        id, total_trades, win_trades, lose_trades, total_profit, win_rate, last_updated
                    ) VALUES (
                        COALESCE((SELECT id FROM trade_statistics ORDER BY last_updated DESC LIMIT 1), 1),
                        ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
                    )
                `, [
                    newTotalTrades,
                    newWinTrades,
                    newLoseTrades,
                    newTotalProfit,
                    newWinRate
                ], function(err) {
                    if (err) {
                        console.error('❌ Error updating statistics:', err);
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: 'Failed to update statistics' });
                    }

                    // Commit transaction
                    db.run('COMMIT', (err) => {
                        if (err) {
                            console.error('❌ Error committing transaction:', err);
                            return res.status(500).json({ error: 'Failed to commit changes' });
                        }

                        logWithTimestamp(`✅ Trade result added and statistics updated`);
                        res.json({
                            success: true,
                            message: 'Trade result added and statistics updated successfully',
                            trade_history_id: tradeHistoryId,
                            statistics: {
                                total_trades: newTotalTrades,
                                win_trades: newWinTrades,
                                lose_trades: newLoseTrades,
                                total_profit: newTotalProfit,
                                win_rate: newWinRate
                            },
                            timestamp: new Date().toISOString()
                        });
                    });
                });
            });
        });
    });
});

// Get trade history
app.get('/api/statistics/history', (req, res) => {
    const { limit = 50, offset = 0 } = req.query;

    db.all(`
        SELECT * FROM trade_history 
        ORDER BY created_at DESC 
        LIMIT ? OFFSET ?
    `, [parseInt(limit), parseInt(offset)], (err, rows) => {
        if (err) {
            console.error('❌ Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        // Get total count
        db.get('SELECT COUNT(*) as total FROM trade_history', [], (err, countRow) => {
            if (err) {
                console.error('❌ Database error:', err);
                return res.status(500).json({ error: 'Database error' });
            }

            logWithTimestamp(`📋 Retrieved ${rows.length} trade history records`);
            res.json({
                success: true,
                history: rows,
                count: rows.length,
                total: countRow.total,
                timestamp: new Date().toISOString()
            });
        });
    });
});

// ========== START SERVER ==========
app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Enhanced Gold Tracker API Server with GoldAPI.io Started');
    console.log(`🌐 Server running on http://0.0.0.0:${PORT}`);
    console.log('🔑 Using GoldAPI.io for real-time precious metals prices');
    console.log('⏰ Price updates every 15 seconds');
    console.log('📡 Available endpoints:');
    console.log('   📊 Prices:');
    console.log('      GET  /api/prices - Get all metal prices');
    console.log('      GET  /api/metals/{symbol}/price - Get specific metal price');
    console.log('   📈 Signals:');
    console.log('      GET  /api/signals - Get all signals');
    console.log('      POST /api/signals - Add new signal');
    console.log('      PUT  /api/signals/{id} - Update signal');
    console.log('      DELETE /api/signals/{id} - Delete signal');
    console.log('      GET  /api/signals/{id} - Get specific signal');
    console.log('   📊 Statistics:');
    console.log('      GET  /api/statistics - Get trade statistics');
    console.log('      POST /api/statistics/trade - Add trade result');
    console.log('      GET  /api/statistics/history - Get trade history');
    console.log('   🔧 System:');
    console.log('      GET  /api/health - Health check');
    console.log(`📋 Supported metals: ${Object.keys(metals).join(', ')}`);
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