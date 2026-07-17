const axios = require('axios');
const { sendTelegramAlert } = require('../managers/trademanager');

class Scanner {
  constructor() {
    this.isRunning = false;
    this.scanInterval = 60000;
    this.seenTokens = new Set();
    console.log('Scanner initialized');
  }

  async scanNewTokens() {
    try {
      console.log('Scanning for new tokens...');
      const response = await axios.get(
        'https://api.dexscreener.com/token-profiles/latest/v1',
        { timeout: 10000 }
      );
      const tokens = response.data;
      if (!tokens || !Array.isArray(tokens)) return;

      for (const token of tokens.slice(0, 10)) {
        const address = token.tokenAddress;
        if (!address || this.seenTokens.has(address)) continue;
        this.seenTokens.add(address);
        if (token.chainId !== 'solana') continue;

        const message = 'NEW TOKEN DETECTED\n\n' +
          'Chain: ' + token.chainId + '\n' +
          'Name: ' + (token.description || 'Unknown') + '\n' +
          'Address: ' + address + '\n' +
          'URL: ' + (token.url || 'N/A') + '\n\n' +
          'TrenchPulse Scanner';

        await sendTelegramAlert(message);
        console.log('Alert sent for: ' + address);
      }
    } catch (error) {
      console.error('Scanner error:', error.message);
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('Scanner started');
    this.scanNewTokens();
    setInterval(() => this.scanNewTokens(), this.scanInterval);
  }

  stop() {
    this.isRunning = false;
    console.log('Scanner stopped');
  }
}

module.exports = { Scanner };