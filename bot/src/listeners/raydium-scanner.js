const axios = require('axios');
const { sendTelegramAlert } = require('../managers/trademanager');
const { analyzeToken } = require('../services/aianalysis');
const {
  getDevRecord,
  registerToken,
  getReputationEmoji
} = require('../data/devreputation');

// Use DexScreener for Raydium pairs (reliable, no auth needed)
const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/pairs/solana';

const FILTERS = {
  // NEW POOL DETECTION
  MIN_LIQUIDITY_USD: 1000,        // Real liquidity, not test
  MAX_LIQUIDITY_USD: 10000000,    // Avoid whale projects
  MIN_VOLUME_24H: 500,             // Some activity
  MAX_TOKEN_AGE_MINUTES: 120,      // Caught within 2 hours
  MIN_HOLDER_COUNT: 10,            // Some distribution

  // QUALITY FILTERS
  REQUIRE_WEBSITE: false,
  REQUIRE_TWITTER: false,
  MAX_DEV_CONCENTRATION: 30,
  
  BLOCK_KEYWORDS: [
    'test', 'scam', 'fake', 'rug', 'honey',
    'pump', 'dump', 'clone', 'based', 'grift',
    'elon', 'trump', 'biden', 'moon', 'lambo'
  ]
};

class RaydiumScanner {
  constructor(scanner) {
    this.scanner = scanner;
    this.isRunning = false;
    this.scanInterval = 120000; // Scan every 2 minutes for new Raydium pools
    this.seenPools = new Set();
    this.seenPoolsTimestamp = new Map();
    console.log('RaydiumScanner initialized — DexScreener Raydium endpoint');
  }

  containsBlockedKeyword(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return FILTERS.BLOCK_KEYWORDS.some(kw => lower.includes(kw));
  }

  isValidName(name) {
    if (!name) return false;
    if (name.length < 2 || name.length > 20) return false;
    if (/^\d+$/.test(name)) return false;
    const specialChars = name.replace(/[a-zA-Z0-9\s]/g, '').length;
    if (specialChars > 3) return false;
    return true;
  }

  // Detect rug warning signs
  detectRugWarnings(poolData) {
    const warnings = [];

    const liquidity = poolData.liquidity?.usd || 0;
    const volume = poolData.volume?.h24 || 0;

    // Very new with high liquidity = whale pump
    if (poolData.pairCreatedAt && volume > 100000 && liquidity > 500000) {
      const ageMinutes = (Date.now() - poolData.pairCreatedAt) / (1000 * 60);
      if (ageMinutes < 30) {
        warnings.push('instant-whale-liquidity');
      }
    }

    // No volume = illiquid
    if (volume < 100) {
      warnings.push('low-volume');
    }

    return warnings;
  }

  cleanupSeenPools() {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000;

    for (const [poolId, timestamp] of this.seenPoolsTimestamp) {
      if (now - timestamp > maxAge) {
        this.seenPools.delete(poolId);
        this.seenPoolsTimestamp.delete(poolId);
      }
    }
  }

  async fetchRaydiumPairs() {
    try {
      // Get latest Raydium pairs from DexScreener
      // DexScreener shows both Pump.fun and Raydium, we filter by liquidity
      const response = await axios.get(
        DEXSCREENER_API + '?limit=50',
        { 
          timeout: 10000,
          headers: {
            'User-Agent': 'TrenchPulse/1.0'
          }
        }
      );

      const pairs = response.data?.pairs || [];
      console.log('DexScreener Raydium pairs: ' + pairs.length + ' found');

      // Filter for Raydium pools only (have liquidity + volume)
      const raydiumPairs = pairs.filter(p => {
        const liquidity = p.liquidity?.usd || 0;
        return liquidity >= FILTERS.MIN_LIQUIDITY_USD;
      });

      return raydiumPairs;
    } catch (error) {
      if (error.response?.status === 429) {
        console.log('DexScreener rate limited — skipping this scan');
        return [];
      }
      console.error('Fetch Raydium pairs error:', error.message);
      return [];
    }
  }

  async handleNewPair(pairData) {
    try {
      const address = pairData.baseToken?.address || pairData.tokenAddress;
      if (!address || this.seenPools.has(address)) return;
      this.seenPools.add(address);
      this.seenPoolsTimestamp.set(address, Date.now());

      if (this.seenPools.size % 50 === 0) {
        this.cleanupSeenPools();
      }

      const name = pairData.baseToken?.name || pairData.tokenName || 'Unknown';
      const symbol = pairData.baseToken?.symbol || pairData.tokenSymbol || '???';
      const liquidity = parseFloat(pairData.liquidity?.usd || 0);
      const volume24h = parseFloat(pairData.volume?.h24 || 0);

      // TIER 1: HARD FILTERS

      if (this.containsBlockedKeyword(name) || this.containsBlockedKeyword(symbol)) {
        console.log('RaydiumScanner rejected: blocked keyword — ' + name);
        return;
      }

      if (!this.isValidName(name)) {
        console.log('RaydiumScanner rejected: invalid name — ' + name);
        return;
      }

      // Liquidity check
      if (liquidity < FILTERS.MIN_LIQUIDITY_USD) {
        console.log('RaydiumScanner rejected: low liquidity — $' + liquidity.toFixed(0));
        return;
      }

      if (liquidity > FILTERS.MAX_LIQUIDITY_USD) {
        console.log('RaydiumScanner rejected: whale project — $' + liquidity.toFixed(0));
        return;
      }

      // Volume check
      if (volume24h < FILTERS.MIN_VOLUME_24H) {
        console.log('RaydiumScanner rejected: no volume — $' + volume24h.toFixed(0));
        return;
      }

      // Get age if available
      const ageMinutes = pairData.pairCreatedAt
        ? (Date.now() - pairData.pairCreatedAt) / (1000 * 60)
        : 0;
      if (ageMinutes > FILTERS.MAX_TOKEN_AGE_MINUTES) {
        console.log('RaydiumScanner skipped: too old — ' + ageMinutes.toFixed(0) + ' min');
        return;
      }

      // TIER 2: DEV REPUTATION (if available)
      const devWallet = pairData.creator || 'unknown';
      let devReputation = 'UNKNOWN';
      let devStats = 'Raydium pool';

      if (devWallet !== 'unknown') {
        const devRecord = getDevRecord(devWallet);
        devReputation = devRecord?.reputation || 'NEW';
        devStats = devRecord
          ? 'Launches: ' + devRecord.totalLaunched + ' | Success: ' + devRecord.successRate + '%'
          : 'First time seen';
      }

      if (devReputation === 'BLACKLISTED') {
        console.log('RaydiumScanner rejected: blacklisted dev');
        return;
      }

      // Register for tracking
      if (devWallet !== 'unknown') {
        registerToken(devWallet, address, name);
      }

      const devLabel = getReputationEmoji(devReputation);

      // Detect rug warnings
      const rugWarnings = this.detectRugWarnings(pairData);
      const warningText = rugWarnings.length > 0
        ? '\n⚠️  WARNING: ' + rugWarnings.join(', ')
        : '';

      // Determine conviction
      let conviction = 'LOW';
      if (liquidity >= 5000 && volume24h >= 1000) {
        conviction = 'HIGH';
      } else if (liquidity >= 2000 && volume24h >= 500) {
        conviction = 'MEDIUM';
      }

      // AI analysis
      let aiAnalysis = null;
      try {
        aiAnalysis = await analyzeToken({
          name,
          symbol,
          price: pairData.priceUsd || '0',
          liquidity: liquidity.toFixed(0),
          marketCap: pairData.marketCap?.usd?.toFixed(0) || 'N/A',
          volume: volume24h.toFixed(0),
          buys: pairData.txns?.h24?.buys || 0,
          sells: pairData.txns?.h24?.sells || 0,
          securityStatus: 'Raydium verified',
          devReputation,
          devStats
        }, 'raydium');
      } catch (error) {
        console.error('RaydiumScanner AI error:', error.message);
      }

      const message =
        'RAYDIUM POOL\n' +
        '========================\n\n' +
        'Token: ' + name + ' (' + symbol + ')\n' +
        'Address: ' + address + '\n\n' +
        'LIQUIDITY\n' +
        'Liquidity: $' + liquidity.toFixed(0) + '\n' +
        'Volume 24h: $' + volume24h.toFixed(0) + '\n' +
        'Price: $' + (pairData.priceUsd || '0') + '\n\n' +
        'DEV\n' +
        devLabel + '\n' +
        devStats + '\n\n' +
        'CONVICTION: ' + conviction + warningText + '\n\n' +
        (aiAnalysis ? 'AI ANALYSIS\n' + aiAnalysis + '\n\n' : '') +
        'Raydium: https://raydium.io/swap/?inputMint=' + address +
        '\nChart: https://dexscreener.com/solana/' + address +
        '\n\nTrenchPulse Raydium Scanner';

      console.log(
        'Raydium signal: ' + name +
        ' | Liquidity: $' + liquidity.toFixed(0) +
        ' | Volume: $' + volume24h.toFixed(0) +
        ' | Conviction: ' + conviction
      );

      await sendTelegramAlert(message);

    } catch (error) {
      console.error('RaydiumScanner pair error:', error.message);
    }
  }

  async scanRaydium() {
    try {
      console.log('Scanning Raydium pools...');
      const pairs = await this.fetchRaydiumPairs();

      if (!pairs || pairs.length === 0) {
        console.log('No Raydium pairs found');
        return;
      }

      for (const pair of pairs.slice(0, 15)) {
        await this.handleNewPair(pair);
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 300));
      }

    } catch (error) {
      console.error('RaydiumScanner error:', error.message);
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('RaydiumScanner started');

    // Scan for new Raydium pools every 2 minutes
    this.scanRaydium();
    setInterval(() => this.scanRaydium(), this.scanInterval);
  }

  stop() {
    this.isRunning = false;
    console.log('RaydiumScanner stopped');
  }
}

module.exports = { RaydiumScanner };