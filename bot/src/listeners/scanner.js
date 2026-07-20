const axios = require('axios');
const { sendTelegramAlert } = require('../managers/trademanager');
const { analyzeToken } = require('../services/aianalysis');
const { AutoExecutor } = require('../executors/autoExecutor');
const {
  getDevRecord,
  registerToken,
  updateTokenOutcome,
  getReputationBoost,
  getReputationEmoji
} = require('../data/devreputation');

const FILTERS = {
  MIN_LIQUIDITY_USD: 5000,
  MAX_MARKET_CAP_USD: 500000,
  MAX_TOKEN_AGE_HOURS: 3,
  REQUIRED_SOCIALS: true,
  SOLANA_ONLY: true,
  MIN_SCORE: 60,
  MAX_TOP_SUSPICIOUS_HOLDER_PERCENT: 20
};

const DEX_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9'
};

const SAFE_HOLDER_ADDRESSES = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  'AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EkAW7vP',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  'EewxydAPCCVuNEyrVN68PuSYdQ7wKn27V9Gjeoi8dy3S',
  '6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc',
  'MFv2hWf31Z9kbCa1snEPdcgp168vLVQLYLiXLy9YKKc',
  'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH',
  'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo',
  'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu',
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',
  'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m',
  'EchesyfXePKdLtoiZSL8pBe8Myagyy8ZRqsACNCFGnvp',
]);

const SAFE_HOLDER_LABELS = [
  'raydium', 'jupiter', 'orca', 'meteora', 'lifinity',
  'serum', 'openbook', 'kamino', 'marginfi', 'solend',
  'drift', 'bonfida', 'streamflow', 'squads', 'realms',
  'binance', 'coinbase', 'okx', 'bybit', 'kraken',
  'kucoin', 'huobi', 'gate', 'mexc', 'bitget',
  'liquidity', 'pool', 'lock', 'burn', 'locked',
  'vesting', 'treasury', 'team', 'foundation',
  'protocol', 'dao', 'multisig', 'program', 'vault',
  'staking', 'yield', 'farm', 'amm', 'lp', 'swap'
];

function isSafeHolder(holder) {
  const tag = (holder.tag || '').toLowerCase();
  const address = (holder.address || '');
  if (SAFE_HOLDER_ADDRESSES.has(address)) return true;
  return SAFE_HOLDER_LABELS.some(label => tag.includes(label));
}

class Scanner {
  constructor() {
    this.isRunning = false;
    this.scanInterval = 300000;
    this.seenTokens = new Set();
    this.trackedTokens = [];
    this.executor = new AutoExecutor();
    console.log('TrenchPulse Scanner initialized');
  }

  async fetchTokenProfiles() {
    try {
      const response = await axios.get(
        'https://api.dexscreener.com/token-boosts/latest/v1',
        { timeout: 15000, headers: DEX_HEADERS }
      );
      const data = response.data || [];
      if (data.length > 0) {
        console.log('DexScreener returned: ' + data.length + ' tokens');
        return data;
      }
      console.log('DexScreener empty — trying fallback...');
      return await this.fetchTokenProfilesFallback();
    } catch (error) {
      if (error.response?.status === 429) {
        console.log('DexScreener rate limited — trying fallback...');
        return await this.fetchTokenProfilesFallback();
      }
      console.error('Fetch profiles error:', error.message);
      return await this.fetchTokenProfilesFallback();
    }
  }

  async fetchTokenProfilesFallback() {
    try {
      console.log('Fetching from DexScreener pairs fallback...');
      const response = await axios.get(
        'https://api.dexscreener.com/latest/dex/pairs/solana',
        { timeout: 15000, headers: DEX_HEADERS }
      );

      const pairs = response.data?.pairs || [];
      console.log('DexScreener pairs returned: ' + pairs.length);

      // Normalize to standard format
      return pairs
        .filter(p => p.baseToken?.address)
        .map(p => ({
          tokenAddress: p.baseToken.address,
          address: p.baseToken.address,
          description: p.baseToken.name || 'Unknown',
          links: p.info?.socials || []
        }));

    } catch (error) {
      console.error('DexScreener pairs fallback error:', error.message);
      return [];
    }
  }

  async fetchTokenData(address) {
    try {
      const response = await axios.get(
        'https://api.dexscreener.com/latest/dex/tokens/' + address,
        { timeout: 15000, headers: DEX_HEADERS }
      );
      const pairs = response.data?.pairs;
      if (!pairs || pairs.length === 0) return null;
      return pairs.sort((a, b) =>
        (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
      )[0];
    } catch (error) {
      if (error.response?.status === 429) {
        await new Promise(resolve => setTimeout(resolve, 30000));
        return null;
      }
      console.error('Fetch token error:', error.message);
      return null;
    }
  }

  async fetchSecurityData(address) {
    try {
      const response = await axios.get(
        'https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=' + address,
        { timeout: 15000 }
      );
      return response.data?.result?.[address.toLowerCase()] || null;
    } catch (error) {
      console.error('Fetch security error:', error.message);
      return null;
    }
  }

  async fetchHolderData(address) {
    try {
      const response = await axios.get(
        'https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=' + address,
        { timeout: 15000 }
      );
      const result = response.data?.result?.[address.toLowerCase()];
      if (!result) return null;

      const holders = result.holder_list || [];
      if (holders.length === 0) return null;

      const safeHolders = holders.filter(h => isSafeHolder(h));
      const suspiciousHolders = holders.filter(h => !isSafeHolder(h));

      const topSuspiciousPercent = suspiciousHolders.length > 0
        ? parseFloat(suspiciousHolders[0]?.percent || 0) * 100
        : 0;

      const top10SuspiciousPercent = suspiciousHolders
        .slice(0, 10)
        .reduce((sum, h) =>
          sum + parseFloat(h?.percent || 0) * 100, 0
        );

      const largeInstitutionalHolders = safeHolders
        .filter(h => parseFloat(h?.percent || 0) * 100 > 5)
        .map(h => ({
          tag: h.tag || 'Known Protocol',
          percent: (parseFloat(h?.percent || 0) * 100).toFixed(1)
        }));

      return {
        topSuspiciousPercent,
        top10SuspiciousPercent,
        totalHolders: parseInt(result.holder_count || 0),
        largeInstitutionalHolders,
        hasInstitutionalSupport: largeInstitutionalHolders.length > 0
      };

    } catch (error) {
      console.error('Fetch holder error:', error.message);
      return null;
    }
  }

  isTokenTooOld(pairCreatedAt) {
    if (!pairCreatedAt) return true;
    const ageHours = (Date.now() - pairCreatedAt) / (1000 * 60 * 60);
    return ageHours > FILTERS.MAX_TOKEN_AGE_HOURS;
  }

  hasSocials(profile, pairData) {
    const links = profile.links || [];
    const socials = pairData?.info?.socials || [];
    return (
      links.some(l =>
        l.type === 'twitter' ||
        l.type === 'telegram' ||
        (l.label || '').toLowerCase().includes('twitter') ||
        (l.label || '').toLowerCase().includes('telegram')
      ) || socials.length > 0
    );
  }

  checkSecurityFlags(security) {
    const flags = [];
    if (!security) return ['Security data unavailable'];
    if (security.mintable === '1') flags.push('Mint authority active');
    if (security.freezable === '1') flags.push('Freeze authority active');
    if (security.is_honeypot === '1') flags.push('Honeypot detected');
    if (security.is_blacklisted === '1') flags.push('Token blacklisted');
    if (parseFloat(security.creator_percentage || 0) > 20) {
      flags.push('Dev holds ' + security.creator_percentage + '%');
    }
    return flags;
  }

  calculateSignalScore(pairData, security, devReputation, holderData) {
    let score = 0;

    const liquidity = pairData?.liquidity?.usd || 0;
    if (liquidity >= 50000) score += 20;
    else if (liquidity >= 20000) score += 15;
    else if (liquidity >= 10000) score += 10;
    else if (liquidity >= 5000) score += 5;

    const mcap = pairData?.marketCap || 0;
    if (mcap <= 100000) score += 20;
    else if (mcap <= 250000) score += 15;
    else if (mcap <= 500000) score += 10;

    const txns = pairData?.txns?.h1 || {};
    const buys = txns.buys || 0;
    const sells = txns.sells || 0;
    if (buys > sells * 1.5) score += 20;
    else if (buys > sells) score += 10;

    const volume = pairData?.volume?.h1 || 0;
    if (volume >= 50000) score += 15;
    else if (volume >= 10000) score += 10;
    else if (volume >= 1000) score += 5;

    if (security) {
      if (security.mintable !== '1') score += 10;
      if (security.freezable !== '1') score += 5;
    }

    if (holderData?.hasInstitutionalSupport) score += 10;

    const reputationBoost = getReputationBoost(devReputation);
    score += reputationBoost;

    return Math.min(Math.max(score, 0), 100);
  }

  getScoreRating(score) {
    if (score >= 80) return 'STRONG BUY';
    if (score >= 60) return 'BUY';
    if (score >= 40) return 'WATCH';
    return 'RISKY';
  }

  async analyzeToken(profile) {
    const address = profile.tokenAddress || profile.address;
    if (!address) return null;

    const pairData = await this.fetchTokenData(address);
    if (!pairData) return null;

    if (FILTERS.SOLANA_ONLY && pairData.chainId !== 'solana') return null;
    if (this.isTokenTooOld(pairData.pairCreatedAt)) return null;

    const liquidity = pairData.liquidity?.usd || 0;
    if (liquidity < FILTERS.MIN_LIQUIDITY_USD) return null;

    const marketCap = pairData.marketCap || 0;
    if (marketCap > FILTERS.MAX_MARKET_CAP_USD) return null;

    if (FILTERS.REQUIRED_SOCIALS &&
        !this.hasSocials(profile, pairData)) return null;

    const priceChange5m = pairData?.priceChange?.m5 || 0;
    const priceChange1h = pairData?.priceChange?.h1 || 0;

    if (priceChange5m < 0) {
      console.log('Rejected: negative 5min price action');
      return null;
    }

    if (priceChange1h < -15) {
      console.log('Rejected: down more than 15% in 1 hour');
      return null;
    }

    const buyVolume = pairData?.volume?.buyVolume || 0;
    const sellVolume = pairData?.volume?.sellVolume || 0;
    if (sellVolume > buyVolume && buyVolume > 0) {
      console.log('Rejected: sell volume dominates');
      return null;
    }

    const security = await this.fetchSecurityData(address);
    const securityFlags = this.checkSecurityFlags(security);

    if (securityFlags.includes('Honeypot detected')) return null;
    if (securityFlags.includes('Token blacklisted')) return null;

    const holderData = await this.fetchHolderData(address);
    if (holderData) {
      if (holderData.topSuspiciousPercent >
          FILTERS.MAX_TOP_SUSPICIOUS_HOLDER_PERCENT) {
        console.log(
          'Rejected: suspicious holder owns ' +
          holderData.topSuspiciousPercent.toFixed(1) + '%'
        );
        return null;
      }
      if (holderData.top10SuspiciousPercent > 80) {
        console.log(
          'Rejected: suspicious holders combined ' +
          holderData.top10SuspiciousPercent.toFixed(1) + '%'
        );
        return null;
      }
    }

    const devWallet = security?.creator_address || 'unknown';
    let devRecord = getDevRecord(devWallet);
    const devReputation = devRecord?.reputation || 'NEW';

    if (devReputation === 'BLACKLISTED') {
      console.log('Blocked blacklisted dev: ' + devWallet.slice(0, 8));
      return null;
    }

    if (devWallet !== 'unknown') {
      devRecord = registerToken(
        devWallet, address,
        profile.description || 'Unknown'
      );
    }

    const score = this.calculateSignalScore(
      pairData, security, devReputation, holderData
    );

    if (score < FILTERS.MIN_SCORE) return null;

    this.trackedTokens.push({
      address,
      devWallet,
      initialPrice: parseFloat(pairData.priceUsd || 0),
      trackedAt: Date.now()
    });

    return {
      address,
      name: pairData.baseToken?.name ||
        profile.description || 'Unknown',
      symbol: pairData.baseToken?.symbol || '???',
      liquidity,
      marketCap,
      score,
      rating: this.getScoreRating(score),
      securityFlags,
      devWallet,
      devReputation,
      devRecord,
      holderData,
      pairData
    };
  }

  async checkTrackedOutcomes() {
    const now = Date.now();
    for (const tracked of this.trackedTokens) {
      const ageHours = (now - tracked.trackedAt) / (1000 * 60 * 60);
      if (ageHours < 24) continue;
      try {
        const pairData = await this.fetchTokenData(tracked.address);
        if (!pairData || !tracked.devWallet ||
            tracked.devWallet === 'unknown') continue;
        const currentPrice = parseFloat(pairData.priceUsd || 0);
        await updateTokenOutcome(
          tracked.devWallet,
          tracked.address,
          currentPrice,
          tracked.initialPrice
        );
      } catch (error) {
        console.error('Outcome check error:', error.message);
      }
    }
    this.trackedTokens = this.trackedTokens.filter(t =>
      (now - t.trackedAt) < 48 * 60 * 60 * 1000
    );
  }

  formatAlert(token, aiAnalysis) {
    const txns = token.pairData?.txns?.h1 || {};
    const buys = txns.buys || 0;
    const sells = txns.sells || 0;
    const volume = token.pairData?.volume?.h1 || 0;
    const price = token.pairData?.priceUsd || '0';
    const priceChange = token.pairData?.priceChange?.h1 || 0;
    const trend = priceChange >= 0 ? 'UP' : 'DOWN';

    const securityStatus = token.securityFlags.length === 0
      ? 'CLEAN'
      : 'FLAGS: ' + token.securityFlags.join(', ');

    const devLabel = getReputationEmoji(token.devReputation);
    const devStats = token.devRecord
      ? 'Launches: ' + token.devRecord.totalLaunched +
        ' | Success Rate: ' + token.devRecord.successRate + '%' +
        ' | Rugs: ' + token.devRecord.rugCount
      : 'First time seen';

    let holderSection = '';
    if (token.holderData) {
      holderSection = 'HOLDER ANALYSIS\n' +
        'Top Suspicious Holder: ' +
        token.holderData.topSuspiciousPercent.toFixed(1) + '%\n' +
        'Total Holders: ' +
        token.holderData.totalHolders + '\n';

      if (token.holderData.hasInstitutionalSupport) {
        holderSection += 'Institutional Holders:\n';
        token.holderData.largeInstitutionalHolders.forEach(h => {
          holderSection +=
            '  ' + h.tag + ': ' + h.percent + '%\n';
        });
        holderSection += 'INSTITUTIONAL SUPPORT\n';
      }
      holderSection += '\n';
    }

    return (
      'TRENCHPULSE SIGNAL\n' +
      '========================\n\n' +
      'Token: ' + token.name + ' (' + token.symbol + ')\n' +
      'Chain: Solana\n' +
      'Address: ' + token.address + '\n\n' +
      'SCORE: ' + token.score + '/100 - ' + token.rating + '\n\n' +
      'MARKET DATA\n' +
      'Price: $' + parseFloat(price).toFixed(8) + '\n' +
      'Price Change 1h: ' + trend + ' ' +
      Math.abs(priceChange) + '%\n' +
      'Liquidity: $' + token.liquidity.toLocaleString() + '\n' +
      'Market Cap: $' + token.marketCap.toLocaleString() + '\n' +
      'Volume 1h: $' + volume.toLocaleString() + '\n\n' +
      'ACTIVITY\n' +
      'Buys: ' + buys + ' | Sells: ' + sells + '\n\n' +
      'SECURITY\n' +
      securityStatus + '\n\n' +
      holderSection +
      'DEV REPUTATION\n' +
      devLabel + '\n' +
      devStats + '\n\n' +
      (aiAnalysis ? 'AI ANALYSIS\n' + aiAnalysis + '\n\n' : '') +
      'Chart: ' + (token.pairData?.url || 'N/A') + '\n\n' +
      'TrenchPulse Scanner'
    );
  }

  async scanNewTokens() {
    try {
      console.log('Scanning for new tokens...');
      const profiles = await this.fetchTokenProfiles();

      if (!profiles || profiles.length === 0) {
        console.log('No profiles returned from any source');
        return;
      }

      console.log('Processing ' + profiles.length + ' profiles...');

      for (const profile of profiles.slice(0, 20)) {
        const address = profile.tokenAddress || profile.address;
        if (!address || this.seenTokens.has(address)) continue;
        this.seenTokens.add(address);

        const token = await this.analyzeToken(profile);
        if (!token) continue;

        console.log(
          'Signal: ' + token.name +
          ' | Score: ' + token.score +
          ' | Dev: ' + token.devReputation +
          (token.holderData?.hasInstitutionalSupport
            ? ' | INSTITUTIONAL' : '')
        );

        const aiAnalysis = await analyzeToken({
          name: token.name,
          symbol: token.symbol,
          score: token.score,
          rating: token.rating,
          price: parseFloat(
            token.pairData?.priceUsd || 0
          ).toFixed(8),
          priceChange: token.pairData?.priceChange?.h1 || 0,
          liquidity: token.liquidity.toLocaleString(),
          marketCap: token.marketCap.toLocaleString(),
          volume: (
            token.pairData?.volume?.h1 || 0
          ).toLocaleString(),
          buys: token.pairData?.txns?.h1?.buys || 0,
          sells: token.pairData?.txns?.h1?.sells || 0,
          securityStatus: token.securityFlags.length === 0
            ? 'CLEAN' : token.securityFlags.join(', '),
          devReputation: token.devReputation,
          institutionalSupport: token.holderData
            ?.hasInstitutionalSupport
            ? token.holderData.largeInstitutionalHolders
                .map(h => h.tag + ' ' + h.percent + '%').join(', ')
            : 'None'
        }, 'dexscreener');

        const message = this.formatAlert(token, aiAnalysis);
        await sendTelegramAlert(message);

        const isAutoTrade = token.score >= 80 &&
          token.devReputation === 'ALPHA';
        await this.executor.processSignal(token, isAutoTrade);

        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      await this.checkTrackedOutcomes();

    } catch (error) {
      console.error('Scanner error:', error.message);
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.executor.start();
    console.log('TrenchPulse Scanner started');
    this.scanNewTokens();
    setInterval(() => this.scanNewTokens(), this.scanInterval);
  }

  stop() {
    this.isRunning = false;
    console.log('TrenchPulse Scanner stopped');
  }
}

module.exports = { Scanner };