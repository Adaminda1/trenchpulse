const WebSocket = require('ws');
const { sendTelegramAlert } = require('../managers/trademanager');
const { analyzeToken } = require('../services/aianalysis');
const {
  getDevRecord,
  registerToken,
  getReputationEmoji
} = require('../data/devreputation');

const PUMP_WS = 'wss://pumpportal.fun/api/data';

const FILTERS = {
  MIN_SOL_AMOUNT: 1,
  MIN_MARKET_CAP_SOL: 10,
  REQUIRE_IMAGE: true,
  MIN_NAME_LENGTH: 3,
  BLOCK_KEYWORDS: [
    'test', 'scam', 'fake', 'rug', 'honey',
    'elon', 'trump', 'biden', 'safe', 'moon',
    'doge', 'shib', 'pepe', 'wojak', 'cum',
    'porn', 'xxx', 'baby', 'mini', 'copy'
  ]
};

class PumpScanner {
  constructor(scanner) {
    this.scanner = scanner;
    this.ws = null;
    this.isRunning = false;
    this.seenTokens = new Set();
    this.seenTokensTimestamp = new Map(); // Track when tokens were seen for cleanup
    this.reconnectDelay = 5000; // Start at 5s
    this.maxReconnectDelay = 60000; // Cap at 60s
    this.heartbeatInterval = null;
    this.connectionTimeout = null;
    console.log('PumpScanner initialized');
  }

  containsBlockedKeyword(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return FILTERS.BLOCK_KEYWORDS.some(kw => lower.includes(kw));
  }

  isValidName(name) {
    if (!name) return false;
    if (name.length < FILTERS.MIN_NAME_LENGTH) return false;
    if (/^\d+$/.test(name)) return false;
    const specialChars = name.replace(/[a-zA-Z0-9\s]/g, '').length;
    if (specialChars > 3) return false;
    return true;
  }

  // FIX: Clean up old seen tokens after 24 hours to prevent memory leak
  cleanupSeenTokens() {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    for (const [address, timestamp] of this.seenTokensTimestamp) {
      if (now - timestamp > maxAge) {
        this.seenTokens.delete(address);
        this.seenTokensTimestamp.delete(address);
      }
    }
  }

  async handleNewToken(data) {
    try {
      const address = data.mint;
      if (!address || this.seenTokens.has(address)) return;
      this.seenTokens.add(address);
      this.seenTokensTimestamp.set(address, Date.now()); // Track when seen
      
      // Clean up old tokens every 100 new tokens
      if (this.seenTokens.size % 100 === 0) {
        this.cleanupSeenTokens();
      }

      const name = data.name || 'Unknown';
      const symbol = data.symbol || '???';
      const devWallet = data.traderPublicKey || 'unknown';
      const solAmount = parseFloat(data.solAmount || 0);
      const marketCapSol = parseFloat(data.marketCapSol || 0);

      // Keyword filter
      if (this.containsBlockedKeyword(name) ||
          this.containsBlockedKeyword(symbol)) {
        console.log('PumpScanner blocked keyword: ' + name);
        return;
      }

      // Name quality filter
      if (!this.isValidName(name)) {
        console.log('PumpScanner blocked invalid name: ' + name);
        return;
      }

      // Minimum 1 SOL — dev must back with real money
      if (solAmount < FILTERS.MIN_SOL_AMOUNT) {
        console.log('PumpScanner blocked low buy: ' +
          solAmount + ' SOL');
        return;
      }

      // Minimum market cap filter
      if (marketCapSol < FILTERS.MIN_MARKET_CAP_SOL) {
        console.log('PumpScanner blocked low mcap: ' +
          marketCapSol + ' SOL');
        return;
      }

      // Image required
      if (FILTERS.REQUIRE_IMAGE && !data.image) {
        console.log('PumpScanner blocked: no image');
        return;
      }

      // Dev reputation check
      const devRecord = getDevRecord(devWallet);
      const devReputation = devRecord?.reputation || 'NEW';

      if (devReputation === 'BLACKLISTED') {
        console.log('PumpScanner blocked blacklisted dev: ' +
          devWallet.slice(0, 8));
        return;
      }

      // Register for outcome tracking
      if (devWallet !== 'unknown') {
        registerToken(devWallet, address, name);
      }

      const devLabel = getReputationEmoji(devReputation);
      const devStats = devRecord
        ? 'Launches: ' + devRecord.totalLaunched +
          ' | Success Rate: ' + devRecord.successRate + '%' +
          ' | Rugs: ' + devRecord.rugCount
        : 'First time seen';

      // Conviction rating
      let conviction = 'LOW';
      if (solAmount >= 10) conviction = 'HIGH';
      else if (solAmount >= 3) conviction = 'MEDIUM';

      // AI analysis with timeout protection
      let aiAnalysis = null;
      try {
        aiAnalysis = await analyzeToken({
          name,
          symbol,
          solAmount: solAmount.toFixed(4),
          marketCapSol: marketCapSol.toFixed(2),
          conviction,
          devReputation,
          devStats
        }, 'pump');
      } catch (error) {
        console.error('PumpScanner AI analysis error:', error.message);
        // Continue without AI analysis
      }

      const message =
        'PUMP.FUN EARLY LAUNCH\n' +
        '========================\n\n' +
        'Token: ' + name + ' (' + symbol + ')\n' +
        'Chain: Solana\n' +
        'Address: ' + address + '\n\n' +
        'LAUNCH DATA\n' +
        'Initial Buy: ' + solAmount.toFixed(4) + ' SOL\n' +
        'Market Cap: ' + marketCapSol.toFixed(2) + ' SOL\n' +
        'Conviction: ' + conviction + '\n\n' +
        'DEV REPUTATION\n' +
        devLabel + '\n' +
        devStats + '\n\n' +
        (aiAnalysis ? 'AI ANALYSIS\n' + aiAnalysis + '\n\n' : '') +
        'Pump.fun: https://pump.fun/' + address + '\n\n' +
        'TrenchPulse Early Scanner\n' +
        'DYOR - Caught at launch';

      console.log(
        'Pump.fun signal: ' + name +
        ' | Buy: ' + solAmount.toFixed(2) + ' SOL' +
        ' | MCap: ' + marketCapSol.toFixed(0) + ' SOL' +
        ' | Dev: ' + devReputation +
        ' | Conviction: ' + conviction
      );

      await sendTelegramAlert(message);

      // Pass to scanner for deep analysis after 2 minutes
      if (this.scanner) {
        setTimeout(async () => {
          await this.scanner.analyzeAndAlert({
            address,
            name,
            symbol,
            devWallet,
            links: data.twitter
              ? [{ type: 'twitter', url: data.twitter }]
              : data.telegram
              ? [{ type: 'telegram', url: data.telegram }]
              : []
          });
        }, 120000);
      }

    } catch (error) {
      console.error('PumpScanner token error:', error.message);
    }
  }

  // FIX: Start heartbeat to keep connection alive
  startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
          console.log('Pump.fun WebSocket ping sent');
        } catch (error) {
          console.error('Ping error:', error.message);
        }
      }
    }, 30000); // Ping every 30 seconds
  }

  // FIX: Stop heartbeat when disconnecting
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // FIX: Clear connection timeout
  clearConnectionTimeout() {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
  }

  connect() {
    try {
      console.log('Connecting to Pump.fun WebSocket... (reconnect delay: ' +
        (this.reconnectDelay / 1000) + 's)');
      this.ws = new WebSocket(PUMP_WS);

      // FIX: Add connection timeout (10 seconds to connect or fail)
      this.connectionTimeout = setTimeout(() => {
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          console.error('Pump.fun connection timeout after 10s');
          this.ws.close();
        }
      }, 10000);

      this.ws.on('open', () => {
        console.log('Pump.fun WebSocket connected ✓');
        this.clearConnectionTimeout();
        
        // FIX: Start heartbeat immediately after connection
        this.startHeartbeat();
        
        // Send subscription
        try {
          this.ws.send(JSON.stringify({
            method: 'subscribeNewToken'
          }));
          console.log('Subscribed to new token launches');
        } catch (error) {
          console.error('Failed to send subscription:', error.message);
        }
        
        // FIX: Reset reconnect delay on successful connection
        this.reconnectDelay = 5000;
      });

      this.ws.on('message', async (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.txType === 'create') {
            await this.handleNewToken(parsed);
          }
        } catch (error) {
          // Ignore parse errors silently — not all messages are token launches
        }
      });

      // FIX: Handle WebSocket pong response
      this.ws.on('pong', () => {
        console.log('Pump.fun WebSocket pong received');
      });

      this.ws.on('close', () => {
        console.log('Pump.fun disconnected — will reconnect in ' +
          (this.reconnectDelay / 1000) + 's...');
        this.clearConnectionTimeout();
        this.stopHeartbeat();
        
        // FIX: Exponential backoff on reconnect
        if (this.isRunning) {
          setTimeout(() => this.connect(), this.reconnectDelay);
          // Increase delay for next attempt (up to 60s max)
          this.reconnectDelay = Math.min(
            this.reconnectDelay * 1.5,
            this.maxReconnectDelay
          );
        }
      });

      this.ws.on('error', (error) => {
        console.error('PumpScanner WebSocket error:', error.message);
        this.clearConnectionTimeout();
        this.stopHeartbeat();
      });

    } catch (error) {
      console.error('PumpScanner connect error:', error.message);
      this.clearConnectionTimeout();
      this.stopHeartbeat();
      
      if (this.isRunning) {
        console.log('Retrying connection in ' +
          (this.reconnectDelay / 1000) + 's...');
        setTimeout(() => this.connect(), this.reconnectDelay);
      }
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.reconnectDelay = 5000; // Reset to 5s on fresh start
    console.log('PumpScanner started');
    this.connect();
  }

  stop() {
    this.isRunning = false;
    this.clearConnectionTimeout();
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
    }
    console.log('PumpScanner stopped');
  }
}

module.exports = { PumpScanner };