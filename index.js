const https = require('https');
const http = require('http');
const url = require('url');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class DatabasePreciousMetalsTracker {
    constructor(apiKey, dbPath = './precious_metals.db') {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.polygon.io';
        this.dbPath = dbPath;
        this.db = null;
        this.refreshInterval = 30000; // Start with 30 seconds (more reasonable)
        this.maxRefreshInterval = 300000; // Max 5 minutes
        this.minRefreshInterval = 30000; // Min 30 seconds
        this.intervalId = null;
        this.consecutiveNoUpdates = 0;
        this.lastApiCheck = null;
        this.consecutiveErrors = 0;
        this.maxConsecutiveErrors = 5;
        
        // Precious metals symbols for forex pairs
        this.symbols = {
            'C:XAUUSD': 'Gold',
            'C:XAGUSD': 'Silver',
            'C:XPTUSD': 'Platinum', 
            'C:XPDUSD': 'Palladium'
        };
        
        // Cache for current prices (in-memory for fast access)
        this.priceCache = {};
        
        console.log('🚀 Starting Database-Backed Precious Metals Tracker...');
        console.log('💾 Using SQLite database for persistent storage');
        console.log('📡 Smart API polling - only updates on price changes');
        console.log('💎 Tracking: Gold, Silver, Platinum, Palladium\n');
        
        this.initializeDatabase();
    }
    
    // Initialize SQLite database
    initializeDatabase() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    console.error('❌ Error opening database:', err.message);
                    reject(err);
                    return;
                }
                
                console.log('📊 Connected to SQLite database');
                this.createTables().then(() => {
                    this.loadCacheFromDatabase().then(() => {
                        console.log('💾 Price cache loaded from database');
                        this.start();
                        resolve();
                    });
                }).catch(reject);
            });
        });
    }
    
    // Create necessary tables
    createTables() {
        return new Promise((resolve, reject) => {
            const createPricesTable = `
                CREATE TABLE IF NOT EXISTS prices (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    symbol TEXT NOT NULL,
                    metal_name TEXT NOT NULL,
                    bid REAL,
                    ask REAL,
                    mid_price REAL,
                    spread REAL,
                    prev_close REAL,
                    daily_change REAL,
                    daily_change_percent REAL,
                    day_high REAL,
                    day_low REAL,
                    volume INTEGER,
                    quote_timestamp INTEGER,
                    prev_close_timestamp INTEGER,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `;
            
            const createMetadataTable = `
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `;
            
            this.db.run(createPricesTable, (err) => {
                if (err) {
                    console.error('❌ Error creating prices table:', err.message);
                    reject(err);
                    return;
                }
                
                this.db.run(createMetadataTable, (err) => {
                    if (err) {
                        console.error('❌ Error creating metadata table:', err.message);
                        reject(err);
                        return;
                    }
                    
                    console.log('✅ Database tables initialized');
                    resolve();
                });
            });
        });
    }
    
    // Load current prices from database into cache
    loadCacheFromDatabase() {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT * FROM prices 
                WHERE symbol IN (?, ?, ?, ?)
                ORDER BY updated_at DESC
            `;
            
            this.db.all(query, Object.keys(this.symbols), (err, rows) => {
                if (err) {
                    console.error('❌ Error loading cache from database:', err.message);
                    reject(err);
                    return;
                }
                
                // Load latest price for each symbol
                const latestPrices = {};
                rows.forEach(row => {
                    if (!latestPrices[row.symbol]) {
                        latestPrices[row.symbol] = row;
                    }
                });
                
                // Populate cache
                Object.keys(this.symbols).forEach(symbol => {
                    if (latestPrices[symbol]) {
                        this.priceCache[symbol] = this.formatPriceData(latestPrices[symbol]);
                    }
                });
                
                console.log(`💾 Loaded ${Object.keys(this.priceCache).length} prices from database`);
                resolve();
            });
        });
    }
    
    // Format database row to price data structure
    formatPriceData(row) {
        return {
            name: row.metal_name,
            symbol: row.symbol,
            quote: row.bid && row.ask ? {
                bid: row.bid,
                ask: row.ask,
                timestamp: row.quote_timestamp
            } : null,
            prevClose: row.prev_close ? {
                c: row.prev_close,
                o: row.prev_close - (row.daily_change || 0),
                h: row.day_high,
                l: row.day_low,
                v: row.volume,
                t: row.prev_close_timestamp
            } : null,
            midPrice: row.mid_price,
            spread: row.spread,
            dailyChange: row.daily_change,
            dailyChangePercent: row.daily_change_percent,
            lastUpdated: new Date(row.updated_at),
            fromDatabase: true
        };
    }
    
    // Make HTTP request to Polygon.io API with better error handling
    makeRequest(endpoint) {
        return new Promise((resolve, reject) => {
            const requestUrl = `${this.baseUrl}${endpoint}`;
            const urlWithKey = `${requestUrl}${requestUrl.includes('?') ? '&' : '?'}apikey=${this.apiKey}`;
            
            const options = {
                timeout: 15000, // Increased timeout to 15 seconds
                headers: {
                    'User-Agent': 'PreciousMetalsTracker/1.0',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            };
            
            const req = https.get(urlWithKey, options, (response) => {
                let data = '';
                
                response.on('data', (chunk) => {
                    data += chunk;
                });
                
                response.on('end', () => {
                    try {
                        // Log the first few characters for debugging
                        console.log(`📡 API Response Preview: ${data.substring(0, 100)}...`);
                        
                        // Check if response is HTML (error page)
                        if (data.trim().startsWith('<') || data.trim().startsWith('<!')) {
                            console.log('❌ Received HTML response - likely rate limited or API error');
                            reject(new Error('Received HTML response instead of JSON (likely rate limited or API error)'));
                            return;
                        }
                        
                        // Check if response is empty
                        if (!data.trim()) {
                            console.log('❌ Empty response from API');
                            reject(new Error('Empty response from API'));
                            return;
                        }
                        
                        // Check for common error patterns
                        if (data.includes('Too Many Requests') || data.includes('Rate limit')) {
                            console.log('❌ Rate limit detected');
                            reject(new Error('API rate limit exceeded'));
                            return;
                        }
                        
                        // Try to parse JSON
                        let jsonData;
                        try {
                            jsonData = JSON.parse(data);
                        } catch (parseError) {
                            console.log('❌ JSON parse error:', parseError.message);
                            console.log('❌ Raw response:', data.substring(0, 500));
                            reject(new Error(`JSON Parse Error: ${parseError.message}`));
                            return;
                        }
                        
                        // Check API response status
                        if (response.statusCode !== 200) {
                            console.log(`❌ HTTP ${response.statusCode}:`, jsonData.error || 'Unknown error');
                            reject(new Error(`HTTP ${response.statusCode}: ${jsonData.error || 'Unknown error'}`));
                            return;
                        }
                        
                        if (jsonData.status === 'OK') {
                            resolve(jsonData);
                        } else if (jsonData.status === 'ERROR') {
                            console.log('❌ API Error:', jsonData.error || 'Unknown error');
                            reject(new Error(`API Error: ${jsonData.error || 'Unknown error'}`));
                        } else {
                            console.log('❌ Unexpected API status:', jsonData.status);
                            reject(new Error(`Unexpected API status: ${jsonData.status}`));
                        }
                    } catch (error) {
                        console.log('❌ Error processing response:', error.message);
                        reject(new Error(`Response processing error: ${error.message}`));
                    }
                });
            });
            
            req.on('error', (error) => {
                console.log('❌ Request error:', error.message);
                reject(new Error(`Request Error: ${error.message}`));
            });
            
            req.on('timeout', () => {
                console.log('❌ Request timeout');
                req.destroy();
                reject(new Error('Request timeout'));
            });
        });
    }
    
    // Get real-time quotes for a single symbol - DISABLED to avoid null values
    async getRealTimeQuote(symbol) {
        console.log(`⏭️ Skipping real-time quote for ${symbol} (disabled to avoid null values)`);
        return null; // Always return null to skip bid/ask/spread
    }
    
    // Get previous day's closing data
    async getPreviousClose(symbol) {
        try {
            const endpoint = `/v2/aggs/ticker/${symbol}/prev`;
            console.log(`📡 Fetching previous close for ${symbol}`);
            const data = await this.makeRequest(endpoint);
            return data.results && data.results.length > 0 ? data.results[0] : null;
        } catch (error) {
            console.error(`❌ Error fetching previous close for ${symbol}:`, error.message);
            return null;
        }
    }
    
    // Save price data to database
    savePriceToDatabase(symbol, quote, prevClose) {
        return new Promise((resolve, reject) => {
            const metalName = this.symbols[symbol];
            const midPrice = quote && quote.bid && quote.ask ? (quote.bid + quote.ask) / 2 : null;
            const spread = quote && quote.bid && quote.ask ? quote.ask - quote.bid : null;
            const dailyChange = prevClose && prevClose.c && prevClose.o ? prevClose.c - prevClose.o : null;
            const dailyChangePercent = prevClose && prevClose.c && prevClose.o ? 
                ((prevClose.c - prevClose.o) / prevClose.o) * 100 : null;
            
            const insertQuery = `
                INSERT INTO prices (
                    symbol, metal_name, bid, ask, mid_price, spread,
                    prev_close, daily_change, daily_change_percent,
                    day_high, day_low, volume, quote_timestamp, prev_close_timestamp
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            
            const params = [
                symbol,
                metalName,
                quote?.bid || null,
                quote?.ask || null,
                midPrice,
                spread,
                prevClose?.c || null,
                dailyChange,
                dailyChangePercent,
                prevClose?.h || null,
                prevClose?.l || null,
                prevClose?.v || null,
                quote?.timestamp || null,
                prevClose?.t || null
            ];
            
            this.db.run(insertQuery, params, function(err) {
                if (err) {
                    console.error('❌ Error saving to database:', err.message);
                    reject(err);
                    return;
                }
                
                console.log(`💾 Saved ${metalName} price to database (ID: ${this.lastID})`);
                resolve(this.lastID);
            });
        });
    }
    
    // Check if price has changed significantly
    hasPriceChanged(symbol, newQuote, newPrevClose) {
        const cached = this.priceCache[symbol];
        
        if (!cached) return true; // No cached data, consider it changed
        
        // Check quote changes (should be rare since we're not fetching quotes)
        if (newQuote && cached.quote) {
            const bidChanged = Math.abs((newQuote.bid || 0) - (cached.quote.bid || 0)) > 0.01;
            const askChanged = Math.abs((newQuote.ask || 0) - (cached.quote.ask || 0)) > 0.01;
            if (bidChanged || askChanged) return true;
        }
        
        // Check previous close changes
        if (newPrevClose && cached.prevClose) {
            const closeChanged = Math.abs((newPrevClose.c || 0) - (cached.prevClose.c || 0)) > 0.01;
            if (closeChanged) return true;
        }
        
        // Check if we have new data where we had none before
        if ((newQuote && !cached.quote) || (newPrevClose && !cached.prevClose)) {
            return true;
        }
        
        return false;
    }
    
    // Update price cache
    updatePriceCache(symbol, quote, prevClose) {
        const metalName = this.symbols[symbol];
        const midPrice = quote && quote.bid && quote.ask ? (quote.bid + quote.ask) / 2 : null;
        const spread = quote && quote.bid && quote.ask ? quote.ask - quote.bid : null;
        const dailyChange = prevClose && prevClose.c && prevClose.o ? prevClose.c - prevClose.o : null;
        const dailyChangePercent = prevClose && prevClose.c && prevClose.o ? 
            ((prevClose.c - prevClose.o) / prevClose.o) * 100 : null;
        
        this.priceCache[symbol] = {
            name: metalName,
            symbol: symbol,
            quote: quote,
            prevClose: prevClose,
            midPrice: midPrice,
            spread: spread,
            dailyChange: dailyChange,
            dailyChangePercent: dailyChangePercent,
            lastUpdated: new Date(),
            fromDatabase: false
        };
    }
    
    // Smart price checking with database storage
    async checkAndUpdatePrices() {
        console.log(`🔍 Checking API for price updates... (${new Date().toLocaleTimeString()})`);
        
        let totalUpdates = 0;
        let apiCallsMade = 0;
        let errors = 0;
        
        for (const symbol of Object.keys(this.symbols)) {
            const metalName = this.symbols[symbol];
            
            try {
                // Add delay between API calls to avoid rate limiting
                if (apiCallsMade > 0) {
                    await new Promise(resolve => setTimeout(resolve, 2000)); // Increased delay to 2 seconds
                }
                
                // Skip real-time quotes to avoid null values and API errors
                const quote = null;
                
                // Only fetch previous close data
                const prevClose = await this.getPreviousClose(symbol);
                apiCallsMade++;
                
                // Check if we got any data
                if (!prevClose) {
                    console.log(`⚠️ No previous close data received for ${metalName}`);
                    errors++;
                    continue;
                }
                
                // Check if price has changed
                const hasChanged = this.hasPriceChanged(symbol, quote, prevClose);
                
                if (hasChanged) {
                    // Save to database
                    await this.savePriceToDatabase(symbol, quote, prevClose);
                    
                    // Update cache
                    this.updatePriceCache(symbol, quote, prevClose);
                    
                    totalUpdates++;
                    console.log(`📈 ${metalName} price updated and saved to database`);
                } else {
                    console.log(`➡️ ${metalName} price unchanged`);
                }
                
            } catch (error) {
                console.error(`❌ Error processing ${metalName}:`, error.message);
                errors++;
            }
        }
        
        console.log(`📊 API calls: ${apiCallsMade} | Updates: ${totalUpdates}/${Object.keys(this.symbols).length} | Errors: ${errors}`);
        
        // Handle consecutive errors
        if (errors >= Object.keys(this.symbols).length) {
            this.consecutiveErrors++;
            console.warn(`⚠️ All symbols failed (${this.consecutiveErrors}/${this.maxConsecutiveErrors})`);
            
            if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
                console.error('❌ Too many consecutive errors, increasing polling interval');
                this.refreshInterval = Math.min(this.maxRefreshInterval, this.refreshInterval * 2);
                this.restartInterval();
            }
        } else {
            this.consecutiveErrors = 0;
        }
        
        // Adjust polling frequency based on updates
        this.adjustPollingFrequency(totalUpdates > 0);
        
        return totalUpdates;
    }
    
    // Adjust polling frequency based on activity
    adjustPollingFrequency(hasUpdates) {
        if (hasUpdates) {
            this.consecutiveNoUpdates = 0;
            // Increase frequency when there are updates (but not too aggressively)
            this.refreshInterval = Math.max(this.minRefreshInterval, this.refreshInterval * 0.95);
        } else {
            this.consecutiveNoUpdates++;
            // Decrease frequency when no updates
            if (this.consecutiveNoUpdates >= 2) {
                this.refreshInterval = Math.min(this.maxRefreshInterval, this.refreshInterval * 1.2);
            }
        }
        
        // Restart interval with new timing
        this.restartInterval();
    }
    
    // Restart the polling interval
    restartInterval() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }
        
        this.intervalId = setInterval(() => {
            this.checkAndUpdatePrices();
        }, this.refreshInterval);
    }
    
    // Start the tracking system
    start() {
        console.log('🚀 Starting database-backed price tracking...');
        
        // Start periodic API checking
        this.checkAndUpdatePrices();
        
        console.log(`🔄 Started smart polling with ${this.refreshInterval/1000}s interval`);
    }
    
    // Stop the tracking system
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        
        if (this.db) {
            this.db.close((err) => {
                if (err) {
                    console.error('❌ Error closing database:', err.message);
                } else {
                    console.log('💾 Database connection closed');
                }
            });
        }
        
        console.log('🛑 Stopped price tracking');
    }
    
    // Get all current prices for API - with null handling and cleaned response
    getAllCurrentPrices() {
        const formattedPrices = {};
        
        Object.keys(this.symbols).forEach(symbol => {
            const data = this.priceCache[symbol];
            if (data) {
                const priceData = {
                    name: data.name,
                    symbol: data.symbol,
                    // Use previous close as current price
                    currentPrice: data.prevClose?.c || null,
                    previousClose: data.prevClose?.c || null,
                    dailyChange: data.dailyChange || null,
                    dailyChangePercent: data.dailyChangePercent || null,
                    dayHigh: data.prevClose?.h || null,
                    dayLow: data.prevClose?.l || null,
                    volume: data.prevClose?.v || null,
                    lastUpdated: data.lastUpdated,
                    fromDatabase: data.fromDatabase,
                    status: 'historical' // Since we're not fetching live quotes
                };
                
                // Remove null values from the response
                Object.keys(priceData).forEach(key => {
                    if (priceData[key] === null) {
                        delete priceData[key];
                    }
                });
                
                formattedPrices[data.name.toLowerCase()] = priceData;
            }
        });
        
        return formattedPrices;
    }
    
    // Get specific metal price
    getMetalPrice(metalName) {
        const prices = this.getAllCurrentPrices();
        return prices[metalName.toLowerCase()] || null;
    }
    
    // Force refresh from API
    async forceRefresh() {
        console.log('🔄 Manual refresh triggered...');
        return await this.checkAndUpdatePrices();
    }
    
    // Get API status
    getAPIStatus() {
        return {
            connected: this.db !== null,
            lastCheck: this.lastApiCheck,
            refreshInterval: this.refreshInterval,
            consecutiveErrors: this.consecutiveErrors,
            cachedPrices: Object.keys(this.priceCache).length
        };
    }
}

// REST API Server
class PreciousMetalsAPI {
    constructor(tracker, port = 3000) {
        this.tracker = tracker;
        this.port = port;
        this.server = null;
    }
    
    // Handle CORS
    setCORSHeaders(res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    
    // Send JSON response
    sendJSON(res, data, statusCode = 200) {
        this.setCORSHeaders(res);
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data, null, 2));
    }
    
    // Handle API requests
    async handleRequest(req, res) {
        this.setCORSHeaders(res);
        
        // Handle preflight OPTIONS requests
        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }
        
        const parsedUrl = url.parse(req.url, true);
        const path = parsedUrl.pathname;
        const method = req.method;
        
        console.log(`📡 API Request: ${method} ${path}`);
        
        try {
            // Route handling
            if (path === '/api/prices' && method === 'GET') {
                // Get all current prices
                const prices = this.tracker.getAllCurrentPrices();
                this.sendJSON(res, {
                    success: true,
                    data: prices,
                    timestamp: new Date().toISOString(),
                    count: Object.keys(prices).length,
                    apiStatus: this.tracker.getAPIStatus()
                });
                
            } else if (path.startsWith('/api/prices/') && method === 'GET') {
                // Get specific metal price
                const metalName = path.split('/')[3];
                const price = this.tracker.getMetalPrice(metalName);
                
                if (price) {
                    this.sendJSON(res, {
                        success: true,
                        data: price,
                        timestamp: new Date().toISOString()
                    });
                } else {
                    this.sendJSON(res, {
                        success: false,
                        error: `Metal '${metalName}' not found`,
                        availableMetals: ['gold', 'silver', 'platinum', 'palladium']
                    }, 404);
                }
                
            } else if (path === '/api/refresh' && method === 'POST') {
                // Force refresh prices
                const updates = await this.tracker.forceRefresh();
                this.sendJSON(res, {
                    success: true,
                    message: 'Prices refreshed',
                    updates: updates,
                    timestamp: new Date().toISOString()
                });
                
            } else if (path === '/api/status' && method === 'GET') {
                // Get API status
                this.sendJSON(res, {
                    success: true,
                    status: this.tracker.getAPIStatus(),
                    timestamp: new Date().toISOString()
                });
                
            } else if (path === '/api/health' && method === 'GET') {
                // Health check
                this.sendJSON(res, {
                    success: true,
                    status: 'healthy',
                    uptime: process.uptime(),
                    timestamp: new Date().toISOString()
                });
                
            } else {
                // 404 Not Found
                this.sendJSON(res, {
                    success: false,
                    error: 'Endpoint not found',
                    availableEndpoints: [
                        'GET /api/prices',
                        'GET /api/prices/{metal}',
                        'POST /api/refresh',
                        'GET /api/status',
                        'GET /api/health'
                    ]
                }, 404);
            }
            
        } catch (error) {
            console.error('❌ API Error:', error.message);
            this.sendJSON(res, {
                success: false,
                error: 'Internal server error',
                message: error.message
            }, 500);
        }
    }
    
    // Start the API server
    start() {
        this.server = http.createServer((req, res) => {
            this.handleRequest(req, res);
        });
        
        this.server.listen(this.port, () => {
            console.log(`🌐 REST API Server running on http://localhost:${this.port}`);
            console.log(`📡 Available endpoints:`);
            console.log(`   GET  /api/prices - Get all metal prices`);
            console.log(`   GET  /api/prices/{metal} - Get specific metal price`);
            console.log(`   POST /api/refresh - Force refresh prices`);
            console.log(`   GET  /api/status - Get API status`);
            console.log(`   GET  /api/health - Health check`);
        });
    }
    
    // Stop the API server
    stop() {
        if (this.server) {
            this.server.close(() => {
                console.log('🌐 REST API Server stopped');
            });
        }
    }
}

// Main execution
const API_KEY = 'i4wKSoyGcr94hGIydnBO3SjpOO1YKD1O';

if (!API_KEY || API_KEY === 'your_actual_api_key_here') {
    console.error('❌ Please set your Polygon.io API key in the API_KEY variable');
    console.error('💡 Get your API key from: https://polygon.io/dashboard');
    process.exit(1);
}

// Create tracker and API server
const tracker = new DatabasePreciousMetalsTracker(API_KEY);
const api = new PreciousMetalsAPI(tracker, 3000);

// Start API server after a short delay to ensure tracker is initialized
setTimeout(() => {
    api.start();
}, 3000);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down gracefully...');
    api.stop();
    tracker.stop();
    setTimeout(() => {
        console.log('✅ Shutdown complete');
        process.exit(0);
    }, 2000);
});

process.on('SIGTERM', () => {
    console.log('\n👋 Shutting down gracefully...');
    api.stop();
    tracker.stop();
    setTimeout(() => {
        console.log('✅ Shutdown complete');
        process.exit(0);
    }, 2000);
});

// Export for use in other modules
module.exports = { DatabasePreciousMetalsTracker, PreciousMetalsAPI };