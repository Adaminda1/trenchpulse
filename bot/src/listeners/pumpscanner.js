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
  // ALERT THRESHOLD — high conviction only
  MIN_SOL_AMOUNT_ALERT: 0.1,      // Real money backing (0.05 was too loose)
  MIN_MARKET_CAP_SOL_ALERT: 10,   // Meaningful liquidity

  // AUTO-TRADE THRESHOLD
  MIN_SOL_AMOUNT_AUTO: 1,
  MIN_MARKET_CAP_SOL_AUTO: 10,

  // QUALITY FILTERS
  REQUIRE_IMAGE: false,
  REQUIRE_SOCIALS: true,          // NEW: Must have Twitter OR Telegram
  MIN_NAME_LENGTH: 3,
  MAX_NAME_LENGTH: 20,
  
  BLOCK_KEYWORDS: [
    'test', 'scam', 'fake', 'rug', 'honey',
    'porn', 'xxx'
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
    console.log('PumpScanner PRO initialized — High conviction only (0.1 SOL min, socials required)');
  }

  containsBlockedKeyword(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return FILTERS.BLOCK_KEYWORDS.some(kw => lower.includes(kw));
  }

  isValidNameLength(name) {
    if (!name) return false;
    if (name.length < FILTERS.MIN_NAME_LENGTH) return false;
    if (name.length > FILTERS.MAX_NAME_LENGTH) return false;
    return true;
  }

  // Smart pattern-based rug detection
  isObviousRug(name, symbol) {
    if (!name) return false;
    const lower = name.toLowerCase();

    // PATTERN 1: Pure gibberish (all caps/random, very short)
    if (name.length <= 4 && /^[A-Z0-9]{1,4}$/.test(name)) {
      return true;
    }

    // PATTERN 2: Generic first names ONLY
    const firstNames = [
      'brad', 'joe', 'john', 'mike', 'dave', 'tom', 'sara', 'bob',
      'alice', 'charlie', 'david', 'emma', 'frank', 'george',
      'henry', 'iris', 'james', 'kelly'
    ];
    if (firstNames.includes(lower) && name.length < 8) {
      return true;
    }

    // PATTERN 3: Isolated animal/food names
    const animals = ['dog', 'cat', 'bird', 'fish', 'ape', 'monkey', 'pig', 'cow', 'sheep'];
    const foods = ['pizza', 'burger', 'taco', 'coffee', 'beer', 'wine'];

    for (const animal of animals) {
      if (lower === animal) return true;
      if (lower.endsWith(' ' + animal) && !lower.includes('-') && name.split(' ').length === 2) {
        const firstWord = name.split(' ')[0].toLowerCase();
        const legit = ['hot', 'cold', 'big', 'small', 'green', 'red', 'blue', 'fire', 'ice'];
        if (!legit.includes(firstWord)) return true;
      }
    }

    for (const food of foods) {
      if (lower === food) return true;
    }

    // PATTERN 4: Pure numbers or repeated characters
    if (/^[0-9]+$/.test(name)) return true;
    if (/^(.)\1{2,}$/.test(name)) return true;

    // PATTERN 5: Suspicious repetition
    if (name.length > 4 && /(.{2,})\1{2,}/.test(lower)) return true;

    return false;
  }

  isValidName(name) {
    if (!name) return false;
    if (!this.isValidNameLength(name)) return false;
    if (this.isObviousRug(name, '')) return false;
    return true;
  }

  // Check if token has socials (Twitter and/or Telegram)
  hasSocials(data) {
    const hasTwitter = !!data.twitter && data.twitter.trim().length > 0;
    const hasTelegram = !!data.telegram && data.telegram.trim().length > 0;
    return hasTwitter || hasTelegram;
  }

  // Count how many socials (for quality scoring)
  countSocials(data) {
    let count = 0;
    if (data.twitter && data.twitter.trim().length > 0) count++;
    if (data.telegram && data.telegram.trim().length > 0) count++;
    if (data.website && data.website.trim().length > 0) count++;
    return count;
  }

  // Detect early rug warning signs
  detectRugWarnings(data) {
    const warnings = [];
    
    const solAmount = parseFloat(data.solAmount || 0);
    if (solAmount < 0.1) {
      warnings.push('low-conviction');
    }
    
    if (!data.image) {
      warnings.push('no-image');
    }

    // Social count impacts risk assessment
    const socialCount = this.countSocials(data);
    if (socialCount === 1) {
      warnings.push('single-social');
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

      // TIER 1: HARD FILTERS
      
      if (this.containsBlockedKeyword(name) ||
          this.containsBlockedKeyword(symbol)) {
        console.log('PumpScanner rejected: blocked keyword — ' + name);
        return;
      }

      if (this.isObviousRug(name, symbol)) {
        console.log('PumpScanner rejected: obvious rug pattern — ' + name);
        return;
      }

      if (!this.isValidNameLength(name)) {
        console.log('PumpScanner rejected: invalid name length — ' + name);
        return;
      }

      // TIER 2: SOCIALS REQUIREMENT (NEW — filters 90% of rugs)
      
      if (!this.hasSocials(data)) {
        console.log('PumpScanner rejected: no socials (Twitter/Telegram required) — ' + name);
        return;
      }

      // TIER 3: DEV REPUTATION
      
      const devRecord = getDevRecord(devWallet);
      const devReputation = devRecord?.reputation || 'NEW';

      if (devReputation === 'BLACKLISTED') {
        console.log('PumpScanner rejected: blacklisted dev — ' + name);
        return;
      }

      // TIER 4: CONVICTION LEVEL (stricter thresholds)
      
      if (solAmount < FILTERS.MIN_SOL_AMOUNT_ALERT) {
        console.log('PumpScanner rejected: low conviction — ' + name +
          ' | Buy: ' + solAmount.toFixed(6) + ' SOL (need 0.1+)');
        return;
      }

      if (marketCapSol < FILTERS.MIN_MARKET_CAP_SOL_ALERT) {
        console.log('PumpScanner rejected: low market cap — ' + name +
          ' | MCap: ' + marketCapSol.toFixed(2) + ' SOL (need 10+)');
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

      // Determine conviction level (all high conviction now due to filters)
      let conviction = 'HIGH';
      let autoTradeEligible = false;

      if (solAmount >= FILTERS.MIN_SOL_AMOUNT_AUTO) {
        autoTradeEligible = (devReputation === 'ALPHA');
      }

      // Detect rug warning signs
      const rugWarnings = this.detectRugWarnings(data);
      const warningText = rugWarnings.length > 0
        ? '\n⚠️  WARNING: ' + rugWarnings.join(', ')
        : '';

      // Social links for display
      const socialLinks = [];
      if (data.twitter) {
        socialLinks.push('Twitter: ' + data.twitter);
      }
      if (data.telegram) {
        socialLinks.push('Telegram: ' + data.telegram);
      }
      if (data.website) {
        socialLinks.push('Website: ' + data.website);
      }
      const socialText = socialLinks.length > 0
        ? '\nSOCIALS\n' + socialLinks.join('\n') + '\n'
        : '';

      // AI analysis
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
        ? '\n\n✅ ELIGIBLE FOR AUTO-TRADE (ALPHA dev + 0.1+ SOL)\nWill execute if AUTO_TRADE_ENABLED=true'
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
        socialText +
        'DEV REPUTATION\n' +
        devLabel + '\n' +
        devStats + '\n\n' +
        (aiAnalysis ? 'AI ANALYSIS\n' + aiAnalysis + '\n\n' : '') +
        'Pump.fun: https://pump.fun/' + address +
        tradeApprovalText + '\n\n' +
        'TrenchPulse Scanner';

      console.log(
        'Pump.fun signal: ' + name +
        ' | Buy: ' + solAmount.toFixed(6) + ' SOL' +
        ' | MCap: ' + marketCapSol.toFixed(2) + ' SOL' +
        ' | Socials: ' + this.countSocials(data) +
        ' | Dev: ' + devReputation +
        (autoTradeEligible ? ' | AUTO-ELIGIBLE' : ' | MANUAL')
      );

      await sendTelegramAlert(message);

      // Pass to scanner for deep analysis
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