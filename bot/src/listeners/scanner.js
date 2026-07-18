const axios = require('axios');
const { sendTelegramAlert } = require('../managers/trademanager');
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
  MAX_TOKEN_AGE_HOURS: 2,
  REQUIRED_SOCIALS: true,
  SOLANA_ONLY: true,
};

class Scanner {
  constructor() {
    this.isRunning = false;
    this.scanInterval = 60000;
    this.seenTokens = new Set();
    this.trackedTokens = [];
    console.log('TrenchPulse Scanner initialized');
  }

  async fetchTokenProfiles() {
    try {
      const response = await axios.get(
        'https://api.dexscreener.com/token-profiles/latest/v1',
        { timeout: 15000 }
      );
      return response.data || [];
    } catch (error) {
      console.error('Fetch profiles error:', error.message);
      return [];
    }
  }

  async fetchTokenData(address) {
    try {
      const response = await axios.get(
        'https://api.dexscreener.com/latest/dex/tokens/' + address,
        { timeout: 15000 }
      );
      const pairs = response.data?.pairs;
      if (!pairs || pairs.length === 0) return null;
      return pairs.sort((a, b) =>
        (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
      )[0];
    } catch (error) {
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

  calculateSignalScore(pairData, security, devReputation) {
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

    // Dev reputation boost
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
    const address = profile.tokenAddress;

    const pairData = await this.fetchTokenData(address);
    if (!pairData) return null;

    if (FILTERS.SOLANA_ONLY && pairData.chainId !== 'solana') return null;
    if (this.isTokenTooOld(pairData.pairCreatedAt)) return null;

    const liquidity = pairData.liquidity?.usd || 0;
    if (liquidity < FILTERS.MIN_LIQUIDITY_USD) return null;

    const marketCap = pairData.marketCap || 0;
    if (marketCap > FILTERS.MAX_MARKET_CAP_USD) return null;

    if (FILTERS.REQUIRED_SOCIALS && !this.hasSocials(profile, pairData)) return null;

    const security = await this.fetchSecurityData(address);
    const securityFlags = this.checkSecurityFlags(security);

    if (securityFlags.includes('Honeypot detected')) return null;
    if (securityFlags.includes('Token blacklisted')) return null;

    // Dev reputation check
    const devWallet = security?.creator_address || 'unknown';
    let devRecord = getDevRecord(devWallet);
    const devReputation = devRecord?.reputation || 'NEW';

    // Block blacklisted devs immediately
    if (devReputation === 'BLACKLISTED') {
      console.log('Blocked blacklisted dev: ' + devWallet.slice(0, 8) + '...');
      return null;
    }

    // Register dev and token for future tracking
    if (devWallet !== 'unknown') {
      devRecord = registerToken(devWallet, address, profile.description || 'Unknown');
    }

    // Price momentum check
const priceChange5m = pairData?.priceChange?.m5 || 0;
const priceChange1h = pairData?.priceChange?.h1 || 0;

// Block negative 5min price action
if (priceChange5m < 0) {
  console.log('Rejected: negative 5min price action');
  return null;
}

// Block if sell volume beats buy volume
const buyVolume = pairData?.volume?.buyVolume || 0;
const sellVolume = pairData?.volume?.sellVolume || 0;
if (sellVolume > buyVolume && buyVolume > 0) {
  console.log('Rejected: sell volume dominates');
  return null;
}

// Block if 1h price is deeply negative
if (priceChange1h < -15) {
  console.log('Rejected: down more than 15% in 1 hour');
  return null;
}

const score = this.calculateSignalScore(pairData, security, devReputation);

    // Track for outcome learning
    this.trackedTokens.push({
      address,
      devWallet,
      initialPrice: parseFloat(pairData.priceUsd || 0),
      trackedAt: Date.now()
    });

    return {
      address,
      name: pairData.baseToken?.name || profile.description || 'Unknown',
      symbol: pairData.baseToken?.symbol || '???',
      liquidity,
      marketCap,
      score,
      rating: this.getScoreRating(score),
      securityFlags,
      devWallet,
      devReputation,
      devRecord,
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
        if (!pairData || !tracked.devWallet || tracked.devWallet === 'unknown') continue;

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

    // Clean up old tracked tokens (over 48 hours)
    this.trackedTokens = this.trackedTokens.filter(t =>
      (now - t.trackedAt) < 48 * 60 * 60 * 1000
    );
  }

  formatAlert(token) {
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

    return (
      'TRENCHPULSE SIGNAL\n' +
      '========================\n\n' +
      'Token: ' + token.name + ' (' + token.symbol + ')\n' +
      'Chain: Solana\n' +
      'Address: ' + token.address + '\n\n' +
      'SCORE: ' + token.score + '/100 - ' + token.rating + '\n\n' +
      'MARKET DATA\n' +
      'Price: $' + parseFloat(price).toFixed(8) + '\n' +
      'Price Change 1h: ' + trend + ' ' + Math.abs(priceChange) + '%\n' +
      'Liquidity: $' + token.liquidity.toLocaleString() + '\n' +
      'Market Cap: $' + token.marketCap.toLocaleString() + '\n' +
      'Volume 1h: $' + volume.toLocaleString() + '\n\n' +
      'ACTIVITY\n' +
      'Buys: ' + buys + ' | Sells: ' + sells + '\n\n' +
      'SECURITY\n' +
      securityStatus + '\n\n' +
      'DEV REPUTATION\n' +
      devLabel + '\n' +
      devStats + '\n\n' +
      'Chart: ' + (token.pairData?.url || 'N/A') + '\n\n' +
      'TrenchPulse Scanner'
    );
  }

  async scanNewTokens() {
    try {
      console.log('Scanning for new tokens...');
      const profiles = await this.fetchTokenProfiles();
      if (!profiles || profiles.length === 0) return;

      for (const profile of profiles.slice(0, 20)) {
        const address = profile.tokenAddress;
        if (!address || this.seenTokens.has(address)) continue;
        this.seenTokens.add(address);

      const token = await this.analyzeToken(profile);
      if (!token) continue;
      if (token.score < 60) continue;

        console.log(
          'Signal: ' + token.name +
          ' | Score: ' + token.score +
          ' | Dev: ' + token.devReputation
        );

        const message = this.formatAlert(token);
        await sendTelegramAlert(message);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      // Check outcomes of previously tracked tokens
      await this.checkTrackedOutcomes();

    } catch (error) {
      console.error('Scanner error:', error.message);
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
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