const WebSocket = require('ws');
const { sendTelegramAlert } = require('../managers/trademanager');
const {
  getDevRecord,
  registerToken,
  getReputationBoost,
  getReputationEmoji
} = require('../data/devreputation');

const PUMP_WS = 'wss://pumpportal.fun/api/data';

const FILTERS = {
  MIN_SOL_AMOUNT: 0.1,
  BLOCK_KEYWORDS: [
    'test', 'scam', 'fake', 'rug', 'honey'
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

  async handleNewToken(data) {
    try {
      const address = data.mint;
      if (!address || this.seenTokens.has(address)) return;
      this.seenTokens.add(address);

      const name = data.name || 'Unknown';
      const symbol = data.symbol || '???';
      const devWallet = data.traderPublicKey || 'unknown';

      // Block suspicious names
      if (this.containsBlockedKeyword(name)) {
        console.log('PumpScanner blocked: ' + name);
        return;
      }

      // Check dev reputation
      const devRecord = getDevRecord(devWallet);
      const devReputation = devRecord?.reputation || 'NEW';

      // Block blacklisted devs
      if (devReputation === 'BLACKLISTED') {
        console.log('PumpScanner blocked blacklisted dev: ' + devWallet.slice(0, 8));
        return;
      }

      // Register token for tracking
      if (devWallet !== 'unknown') {
        registerToken(devWallet, address, name);
      }

      const devLabel = getReputationEmoji(devReputation);
      const devStats = devRecord
        ? 'Launches: ' + devRecord.totalLaunched +
          ' | Success Rate: ' + devRecord.successRate + '%' +
          ' | Rugs: ' + devRecord.rugCount
        : 'First time seen';

      const solAmount = data.solAmount || 0;
      const marketCapSol = data.marketCapSol || 0;

      const message =
        'PUMP.FUN EARLY LAUNCH\n' +
        '========================\n\n' +
        'Token: ' + name + ' (' + symbol + ')\n' +
        'Chain: Solana\n' +
        'Address: ' + address + '\n\n' +
        'LAUNCH DATA\n' +
        'Initial Buy: ' + solAmount.toFixed(4) + ' SOL\n' +
        'Market Cap: ' + marketCapSol.toFixed(2) + ' SOL\n\n' +
        'DEV REPUTATION\n' +
        devLabel + '\n' +
        devStats + '\n\n' +
        'Pump.fun: https://pump.fun/' + address + '\n\n' +
        'TrenchPulse Early Scanner\n' +
        'Caught at launch - DYOR';

      console.log('Pump.fun launch: ' + name + ' (' + symbol + ') Dev: ' + devReputation);
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

        // Subscribe to new token launches
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
          // Ignore parse errors
        }
      });

      this.ws.on('close', () => {
        console.log('Pump.fun WebSocket disconnected — reconnecting in 5s...');
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
    if (this.ws) {
      this.ws.close();
    }
    console.log('PumpScanner stopped');
  }
}

module.exports = { PumpScanner };