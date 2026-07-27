const axios = require('axios');
const { sendTelegramAlert } = require('../managers/trademanager');
const { analyzeToken } = require('../services/aianalysis');
const {
  getDevRecord,
  registerToken,
  getReputationEmoji
} = require('../data/devreputation');

// Raydium API endpoints
const RAYDIUM_API = 'https://api.raydium.io/v2';
const RAYDIUM_FUSION_API = 'https://fusion-api-v2.raydium.io';

const FILTERS = {
  // NEW POOL DETECTION
  MIN_LIQUIDITY_USD: 1000,        // Real liquidity, not test
  MAX_LIQUIDITY_USD: 10000000,    // Avoid whale projects
  MIN_VOLUME_24H: 500,             // Some activity
  MAX_TOKEN_AGE_MINUTES: 60,       // Caught early
  MIN_HOLDER_COUNT: 10,            // Some distribution

  // QUALITY FILTERS
  REQUIRE_WEBSITE: false,          // Not all day-1 projects have sites
  REQUIRE_TWITTER: false,          // Early projects may not have Twitter yet
  MAX_DEV_CONCENTRATION: 30,       // Dev shouldn't hold >30%
  
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
    this.scanInterval = 60000; // Scan every 60 seconds for new pools
    this.seenPools = new Set();
    this.seenPoolsTimestamp = new Map();
    this.lastScanTime = 0;
    console.log('RaydiumScanner initialized');
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

  // Detect rug warning signs for new pools
  detectRugWarnings(poolData, tokenData) {
    const warnings = [];

    // Extreme dev concentration
    if (tokenData.devHoldPercent > 40) {
      warnings.push('high-dev-concentration');
    }

    // Very new with high liquidity = possible whale pump
    if (poolData.ageMinutes < 5 && poolData.liquidityUsd > 100000) {
      warnings.push('instant-whale-liquidity');
    }

    // No volume on new pool = illiquid
    if (poolData.volume24h < 100) {
      warnings.push('no-volume');
    }

    // Few holders = concentrated
    if (tokenData.holderCount < 20) {
      warnings.push('low-holder-count');
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

  async fetchPoolDetails(poolId) {
    try {
      // Get pool details from Raydium
      const response = await axios.get(
        RAYDIUM_API + '/pools?ids=' + poolId,
        { timeout: 8000 }
      );

      const pool = response.data?.data?.[0];
      if (!pool) return null;

      return {
        id: pool.id,
        poolAddress: pool.address,
        baseToken: pool.baseMint,
        quoteToken: pool.quoteMint,
        liquidityUsd: parseFloat(pool.liquidity || 0),
        volume24h: parseFloat(pool.volume24h || 0),
        volume7d: parseFloat(pool.volume7d || 0),
        volume24hQuote: parseFloat(pool.volume24hQuote || 0),
        fee: pool.fee || 0.25,
        createdAt: pool.openTime || Date.now()
      };
    } catch (error) {
      console.error('Fetch pool details error:', error.message);
      return null;
    }
  }

  async fetchTokenMetadata(tokenAddress) {
    try {
      // Get token metadata from on-chain or Raydium
      const response = await axios.get(
        'https://api.solscan.io/api/token/meta?token=' + tokenAddress,
        { timeout: 8000 }
      );

      const data = response.data?.data;
      if (!data) return null;

      return {
        address: tokenAddress,
        symbol: data.symbol || '???',
        name: data.name || 'Unknown',
        decimals: data.decimals || 9,
        logo: data.icon || null,
        devHoldPercent: parseFloat(data.owner_percentage || 0) * 100,
        holderCount: parseInt(data.holder || 0),
        website: data.website || null,
        twitter: data.twitter || null,
        telegram: data.telegram || null
      };
    } catch (error) {
      console.error('Fetch token metadata error:', error.message);
      return null;
    }
  }

  async fetchNewPools() {
    try {
      const response = await axios.get(
        RAYDIUM_FUSION_API + '/latest/pools?limit=30&sortField=createdTime&sortType=desc',
        { timeout: 10000 }
      );

      const pools = response.data?.data || [];
      console.log('Raydium new pools: ' + pools.length + ' found');
      return pools;
    } catch (error) {
      if (error.response?.status === 429) {
        console.log('Raydium rate limited — skipping this scan');
        return [];
      }
      console.error('Fetch new pools error:', error.message);
      return [];
    }
  }

  async handleNewPool(poolData) {
    try {
      const poolId = poolData.id;
      if (!poolId || this.seenPools.has(poolId)) return;
      this.seenPools.add(poolId);
      this.seenPoolsTimestamp.set(poolId, Date.now());

      if (this.seenPools.size % 50 === 0) {
        this.cleanupSeenPools();
      }

      // Get base token (usually the new token, not USDC/USDT)
      const baseTokenAddress = poolData.baseMint;
      if (!baseTokenAddress) return;

      // Fetch full details
      const tokenData = await this.fetchTokenMetadata(baseTokenAddress);
      if (!tokenData) return;

      const { name, symbol, devHoldPercent, holderCount, website, twitter, telegram } = tokenData;

      // TIER 1: HARD FILTERS

      if (this.containsBlockedKeyword(name) || this.containsBlockedKeyword(symbol)) {
        console.log('RaydiumScanner rejected: blocked keyword — ' + name);
        return;
      }

      if (!this.isValidName(name)) {
        console.log('RaydiumScanner rejected: invalid name — ' + name);
        return;
      }

      // Get age of pool
      const ageMinutes = (Date.now() - poolData.createdTime) / (1000 * 60);
      if (ageMinutes > FILTERS.MAX_TOKEN_AGE_MINUTES) {
        console.log('RaydiumScanner skipped: too old — ' + ageMinutes.toFixed(0) + ' min');
        return;
      }

      // Liquidity checks
      const liquidityUsd = parseFloat(poolData.liquidity?.usd || 0);
      if (liquidityUsd < FILTERS.MIN_LIQUIDITY_USD) {
        console.log('RaydiumScanner rejected: low liquidity — $' + liquidityUsd.toFixed(0));
        return;
      }

      if (liquidityUsd > FILTERS.MAX_LIQUIDITY_USD) {
        console.log('RaydiumScanner rejected: whale project — $' + liquidityUsd.toFixed(0));
        return;
      }

      // Volume check
      const volume24h = parseFloat(poolData.volume24h?.usd || 0);
      if (volume24h < FILTERS.MIN_VOLUME_24H) {
        console.log('RaydiumScanner rejected: no volume — $' + volume24h.toFixed(0));
        return;
      }

      // TIER 2: DEV REPUTATION CHECK

      const devWallet = poolData.creator || 'unknown';
      const devRecord = getDevRecord(devWallet);
      const devReputation = devRecord?.reputation || 'NEW';

      if (devReputation === 'BLACKLISTED') {
        console.log('RaydiumScanner rejected: blacklisted dev — ' + name);
        return;
      }

      // Register for tracking
      if (devWallet !== 'unknown') {
        registerToken(devWallet, baseTokenAddress, name);
      }

      const devLabel = getReputationEmoji(devReputation);
      const devStats = devRecord
        ? 'Launches: ' + devRecord.totalLaunched +
          ' | Success Rate: ' + devRecord.successRate + '%' +
          ' | Rugs: ' + devRecord.rugCount
        : 'First time seen';

      // Detect rug warnings
      const rugWarnings = this.detectRugWarnings(
        { liquidityUsd, volume24h, ageMinutes },
        { devHoldPercent, holderCount }
      );
      const warningText = rugWarnings.length > 0
        ? '\n⚠️  WARNING: ' + rugWarnings.join(', ')
        : '';

      // Determine conviction level
      let conviction = 'LOW';
      let confidence = 'Manual review required';

      if (liquidityUsd >= 5000 && volume24h >= 1000 && holderCount >= 50) {
        conviction = 'HIGH';
        confidence = 'Real liquidity + volume + distribution';
      } else if (liquidityUsd >= 2000 && volume24h >= 500) {
        conviction = 'MEDIUM';
        confidence = 'Decent liquidity, watch for activity';
      }

      // AI analysis
      let aiAnalysis = null;
      try {
        aiAnalysis = await analyzeToken({
          name,
          symbol,
          price: '0',
          liquidity: liquidityUsd.toFixed(0),
          marketCap: 'N/A',
          volume: volume24h.toFixed(0),
          buys: 0,
          sells: 0,
          securityStatus: 'DEX verified',
          devReputation,
          devStats
        }, 'raydium');
      } catch (error) {
        console.error('RaydiumScanner AI analysis error:', error.message);
      }

      const links = [];
      if (website) links.push('Website: ' + website + '\n');
      if (twitter) links.push('Twitter: ' + twitter + '\n');
      if (telegram) links.push('Telegram: ' + telegram + '\n');

      const message =
        'RAYDIUM NEW POOL\n' +
        '========================\n\n' +
        'Token: ' + name + ' (' + symbol + ')\n' +
        'Chain: Solana\n' +
        'Address: ' + baseTokenAddress + '\n\n' +
        'POOL DATA\n' +
        'Liquidity: $' + liquidityUsd.toFixed(0) + '\n' +
        'Volume 24h: $' + volume24h.toFixed(0) + '\n' +
        'Pool Age: ' + ageMinutes.toFixed(1) + ' minutes\n' +
        'Holders: ' + holderCount + '\n\n' +
        'DEV PROFILE\n' +
        'Dev Hold: ' + devHoldPercent.toFixed(1) + '%\n' +
        devLabel + '\n' +
        devStats + '\n\n' +
        'CONVICTION: ' + conviction + warningText + '\n' +
        'Confidence: ' + confidence + '\n\n' +
        (links.length > 0 ? 'LINKS\n' + links.join('') + '\n' : '') +
        (aiAnalysis ? 'AI ANALYSIS\n' + aiAnalysis + '\n\n' : '') +
        'Raydium: https://raydium.io/swap/?inputMint=' + baseTokenAddress +
        '\nDexScreener: https://dexscreener.com/solana/' + baseTokenAddress +
        '\n\nTrenchPulse Raydium Scanner';

      console.log(
        'Raydium signal: ' + name +
        ' | Liquidity: $' + liquidityUsd.toFixed(0) +
        ' | Volume: $' + volume24h.toFixed(0) +
        ' | Age: ' + ageMinutes.toFixed(1) + ' min' +
        ' | Dev: ' + devReputation +
        ' | Conviction: ' + conviction
      );

      await sendTelegramAlert(message);

      // Pass to scanner for deep analysis after 5 minutes (Raydium moves slower)
      if (this.scanner && liquidityUsd >= 1000) {
        setTimeout(async () => {
          await this.scanner.analyzeAndAlert({
            address: baseTokenAddress,
            name,
            symbol,
            devWallet,
            links: twitter ? [{ type: 'twitter', url: twitter }] : []
          });
        }, 300000); // 5 minutes
      }

    } catch (error) {
      console.error('RaydiumScanner pool error:', error.message);
    }
  }

  async scanNewPools() {
    try {
      console.log('Scanning Raydium for new pools...');
      const pools = await this.fetchNewPools();

      if (!pools || pools.length === 0) {
        console.log('No new Raydium pools found');
        return;
      }

      for (const pool of pools.slice(0, 20)) {
        await this.handleNewPool(pool);
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      }

    } catch (error) {
      console.error('RaydiumScanner error:', error.message);
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('RaydiumScanner started');

    // Scan for new pools every 60 seconds
    this.scanNewPools();
    setInterval(() => this.scanNewPools(), this.scanInterval);
  }

  stop() {
    this.isRunning = false;
    console.log('RaydiumScanner stopped');
  }
}

module.exports = { RaydiumScanner };