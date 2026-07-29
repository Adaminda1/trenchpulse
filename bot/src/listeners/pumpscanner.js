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
  // ALERT THRESHOLD — low conviction, manual review required
  MIN_SOL_AMOUNT_ALERT: 0.05,
  MIN_MARKET_CAP_SOL_ALERT: 5,

  // AUTO-TRADE THRESHOLD — high conviction, must be real dev backing
  // Only ALPHA devs with 1+ SOL backing get auto-executed
  MIN_SOL_AMOUNT_AUTO: 1,
  MIN_MARKET_CAP_SOL_AUTO: 10,

  // QUALITY FILTERS — applied to all (alert + auto)
  REQUIRE_IMAGE: false,           // Images come later, don't require at launch
  MIN_NAME_LENGTH: 3,
  MAX_NAME_LENGTH: 20,
  REQUIRE_SOCIALS: false,
  BLOCK_KEYWORDS: [
    'test', 'scam', 'fake', 'rug', 'honey',
    'elon', 'trump', 'biden', 'safe', 'moon',
    'doge', 'shib', 'pepe', 'wojak', 'cum',
    'porn', 'xxx', 'baby', 'mini', 'copy',
    'clone', 'based', 'grift', 'pump', 'dump'
  ]
};

class PumpScanner {
  constructor(scanner) {
    this.scanner = scanner;
    this.ws = null;
    this.isRunning = false;
    this.seenTokens = new Set();
    this.seenTokensTimestamp = new Map();
    this.reconnectDelay = 5000;
    this.maxReconnectDelay = 60000;
    this.heartbeatInterval = null;
    this.connectionTimeout = null;
    console.log('PumpScanner initialized — Dual-tier filtering (0.05 SOL alert / 1 SOL auto)');
  }

  containsBlockedKeyword(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return FILTERS.BLOCK_KEYWORDS.some(kw => lower.includes(kw));
  }

  isValidName(name) {
    if (!name) return false;
    if (name.length < FILTERS.MIN_NAME_LENGTH) return false;
    if (name.length > FILTERS.MAX_NAME_LENGTH) return false;
    // Reject pure numbers or mostly emoji/special chars
    if (/^\d+$/.test(name)) return false;
    const specialChars = name.replace(/[a-zA-Z0-9\s]/g, '').length;
    if (specialChars > 3) return false;
    return true;
  }

  // Detect potential rug patterns early
  detectRugWarnings(data) {
    const warnings = [];
    
    // Dev wallet concentration risk
    const solAmount = parseFloat(data.solAmount || 0);
    if (solAmount < 0.05) {
      warnings.push('micro-buy');
    }
    
    // No image = higher rug risk (but allow it)
    if (!data.image) {
      warnings.push('no-image');
    }
    
    // Generic names are rug bait
    if (data.name && (data.name.length > 15 || data.name.length < 3)) {
      warnings.push('suspicious-name-length');
    }
    
    return warnings;
  }

  cleanupSeenTokens() {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000;
    
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
      this.seenTokensTimestamp.set(address, Date.now());
      
      if (this.seenTokens.size % 100 === 0) {
        this.cleanupSeenTokens();
      }

      const name = data.name || 'Unknown';
      const symbol = data.symbol || '???';
      const devWallet = data.traderPublicKey || 'unknown';
      const solAmount = parseFloat(data.solAmount || 0);
      const marketCapSol = parseFloat(data.marketCapSol || 0);

      // TIER 1: HARD FILTERS (apply to all)
      
      if (this.containsBlockedKeyword(name) ||
          this.containsBlockedKeyword(symbol)) {
        console.log('PumpScanner rejected: blocked keyword — ' + name);
        return;
      }

      if (!this.isValidName(name)) {
        console.log('PumpScanner rejected: invalid name — ' + name);
        return;
      }

      // TIER 2: DEV REPUTATION CHECK
      
      const devRecord = getDevRecord(devWallet);
      const devReputation = devRecord?.reputation || 'NEW';

      if (devReputation === 'BLACKLISTED') {
        console.log('PumpScanner rejected: blacklisted dev — ' + name);
        return;
      }

      // TIER 3: CONVICTION LEVEL (dual thresholds)

      // Below MIN_ALERT = skip entirely (test launch)
      if (solAmount < FILTERS.MIN_SOL_AMOUNT_ALERT) {
        console.log('PumpScanner skipped (micro): ' + name +
          ' | Buy: ' + solAmount.toFixed(6) + ' SOL');
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

      // Determine conviction level
      let conviction = 'LOW';
      let autoTradeEligible = false;

      if (solAmount >= FILTERS.MIN_SOL_AMOUNT_AUTO) {
        conviction = 'HIGH';
        // Only auto-trade if HIGH conviction + ALPHA dev
        autoTradeEligible = (devReputation === 'ALPHA');
      } else if (solAmount >= FILTERS.MIN_SOL_AMOUNT_ALERT) {
        conviction = 'MEDIUM';
        autoTradeEligible = false; // Requires manual approval
      }

      // Detect early rug warning signs
      const rugWarnings = this.detectRugWarnings(data);
      const warningText = rugWarnings.length > 0
        ? '\n⚠️  RUG RISK: ' + rugWarnings.join(', ')
        : '';

      // AI analysis with timeout protection
      let aiAnalysis = null;
      try {
        aiAnalysis = await analyzeToken({
          name,
          symbol,
          solAmount: solAmount.toFixed(6),
          marketCapSol: marketCapSol.toFixed(2),
          conviction,
          devReputation,
          devStats
        }, 'pump');
      } catch (error) {
        console.error('PumpScanner AI analysis error:', error.message);
      }

      const tradeApprovalText = autoTradeEligible
        ? '\n\n✅ ELIGIBLE FOR AUTO-TRADE (ALPHA dev + 1+ SOL)\nWill execute if AUTO_TRADE_ENABLED=true'
        : '\n\n⚠️  MANUAL APPROVAL REQUIRED\nReply: BUY ' + address.slice(0, 8) + ' or SKIP ' + address.slice(0, 8);

      const message =
        'PUMP.FUN EARLY LAUNCH\n' +
        '========================\n\n' +
        'Token: ' + name + ' (' + symbol + ')\n' +
        'Chain: Solana\n' +
        'Address: ' + address + '\n\n' +
        'LAUNCH DATA\n' +
        'Initial Buy: ' + solAmount.toFixed(6) + ' SOL\n' +
        'Market Cap: ' + marketCapSol.toFixed(2) + ' SOL\n' +
        'Conviction: ' + conviction + warningText + '\n\n' +
        'DEV REPUTATION\n' +
        devLabel + '\n' +
        devStats + '\n\n' +
        (aiAnalysis ? 'AI ANALYSIS\n' + aiAnalysis + '\n\n' : '') +
        'Pump.fun: https://pump.fun/' + address +
        tradeApprovalText + '\n\n' +
        'TrenchPulse Early Scanner\n' +
        'DYOR - Manual review recommended';

      console.log(
        'Pump.fun signal: ' + name +
        ' | Buy: ' + solAmount.toFixed(6) + ' SOL' +
        ' | MCap: ' + marketCapSol.toFixed(2) + ' SOL' +
        ' | Dev: ' + devReputation +
        ' | Conviction: ' + conviction +
        (autoTradeEligible ? ' | AUTO-ELIGIBLE' : ' | MANUAL')
      );

      await sendTelegramAlert(message);

      // Pass to scanner for deep analysis after 2 minutes
      // (only if meets minimum market cap for deeper look)
      if (this.scanner && marketCapSol >= FILTERS.MIN_MARKET_CAP_SOL_ALERT) {
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
    }, 30000);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

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

      this.connectionTimeout = setTimeout(() => {
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          console.error('Pump.fun connection timeout after 10s');
          this.ws.close();
        }
      }, 10000);

      this.ws.on('open', () => {
        console.log('Pump.fun WebSocket connected ✓');
        this.clearConnectionTimeout();
        this.startHeartbeat();
        
        try {
          this.ws.send(JSON.stringify({
            method: 'subscribeNewToken'
          }));
          console.log('Subscribed to new token launches');
        } catch (error) {
          console.error('Failed to send subscription:', error.message);
        }
        
        this.reconnectDelay = 5000;
      });

      this.ws.on('message', async (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.txType === 'create') {
            await this.handleNewToken(parsed);
          }
        } catch (error) {
          // Ignore parse errors silently
        }
      });

      this.ws.on('pong', () => {
        console.log('Pump.fun WebSocket pong received');
      });

      this.ws.on('close', () => {
        console.log('Pump.fun disconnected — will reconnect in ' +
          (this.reconnectDelay / 1000) + 's...');
        this.clearConnectionTimeout();
        this.stopHeartbeat();
        
        if (this.isRunning) {
          setTimeout(() => this.connect(), this.reconnectDelay);
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
    this.reconnectDelay = 5000;
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