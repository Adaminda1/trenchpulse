const WebSocket = require('ws');
const { sendTelegramAlert } = require('../managers/trademanager');
const {
  getDevRecord,
  registerToken,
  getReputationEmoji
} = require('../data/devreputation');

const PUMP_WS = 'wss://pumpportal.fun/api/data';

const FILTERS = {
  MIN_SOL_AMOUNT: 1,
  MIN_MARKET_CAP_SOL: 30,
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
  constructor() {
    this.ws = null;
    this.isRunning = false;
    this.seenTokens = new Set();
    this.reconnectDelay = 5000;
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
    // Block names that are purely numbers
    if (/^\d+$/.test(name)) return false;
    // Block names with too many special characters
    const specialChars = name.replace(/[a-zA-Z0-9\s]/g, '').length;
    if (specialChars > 3) return false;
    return true;
  }

  async handleNewToken(data) {
    try {
      const address = data.mint;
      if (!address || this.seenTokens.has(address)) return;
      this.seenTokens.add(address);

      const name = data.name || 'Unknown';
      const symbol = data.symbol || '???';
      const devWallet = data.traderPublicKey || 'unknown';
      const solAmount = parseFloat(data.solAmount || 0);
      const marketCapSol = parseFloat(data.marketCapSol || 0);

      // Block suspicious keywords
      if (this.containsBlockedKeyword(name) ||
          this.containsBlockedKeyword(symbol)) {
        console.log('PumpScanner blocked keyword: ' + name);
        return;
      }

      // Validate name quality
      if (!this.isValidName(name)) {
        console.log('PumpScanner blocked invalid name: ' + name);
        return;
      }

      // Minimum initial buy — serious launchers spend real SOL
      if (solAmount < FILTERS.MIN_SOL_AMOUNT) {
        console.log('PumpScanner blocked low buy: ' + solAmount + ' SOL');
        return;
      }

      // Minimum market cap — filters zero conviction launches
      if (marketCapSol < FILTERS.MIN_MARKET_CAP_SOL) {
        console.log('PumpScanner blocked low mcap: ' + marketCapSol + ' SOL');
        return;
      }

      // Require image — no image = spam launch
      if (FILTERS.REQUIRE_IMAGE && !data.image) {
        console.log('PumpScanner blocked: no image');
        return;
      }

      // Dev reputation check
      const devRecord = getDevRecord(devWallet);
      const devReputation = devRecord?.reputation || 'NEW';

      // Block blacklisted devs immediately
      if (devReputation === 'BLACKLISTED') {
        console.log('PumpScanner blocked blacklisted dev: ' +
          devWallet.slice(0, 8));
        return;
      }

      // Register token for outcome tracking
      if (devWallet !== 'unknown') {
        registerToken(devWallet, address, name);
      }

      const devLabel = getReputationEmoji(devReputation);
      const devStats = devRecord
        ? 'Launches: ' + devRecord.totalLaunched +
          ' | Success Rate: ' + devRecord.successRate + '%' +
          ' | Rugs: ' + devRecord.rugCount
        : 'First time seen';

      // Conviction rating based on initial buy
      let conviction = 'LOW';
      if (solAmount >= 10) conviction = 'HIGH';
      else if (solAmount >= 3) conviction = 'MEDIUM';

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

    } catch (error) {
      console.error('PumpScanner token error:', error.message);
    }
  }

  connect() {
    try {
      console.log('Connecting to Pump.fun WebSocket...');
      this.ws = new WebSocket(PUMP_WS);

      this.ws.on('open', () => {
        console.log('Pump.fun WebSocket connected');
        this.ws.send(JSON.stringify({
          method: 'subscribeNewToken'
        }));
        console.log('Subscribed to new token launches');
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

      this.ws.on('close', () => {
        console.log('Pump.fun disconnected — reconnecting in 5s...');
        if (this.isRunning) {
          setTimeout(() => this.connect(), this.reconnectDelay);
        }
      });

      this.ws.on('error', (error) => {
        console.error('PumpScanner WebSocket error:', error.message);
      });

    } catch (error) {
      console.error('PumpScanner connect error:', error.message);
      if (this.isRunning) {
        setTimeout(() => this.connect(), this.reconnectDelay);
      }
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('PumpScanner started');
    this.connect();
  }

  stop() {
    this.isRunning = false;
    if (this.ws) this.ws.close();
    console.log('PumpScanner stopped');
  }
}

module.exports = { PumpScanner };