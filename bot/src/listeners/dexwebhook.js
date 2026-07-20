const { sendTelegramAlert } = require('../managers/trademanager');
const { analyzeToken } = require('../services/aianalysis');
const {
  getDevRecord,
  registerToken,
  getReputationEmoji
} = require('../data/devreputation');

class DexWebhook {
  constructor(scanner) {
    this.scanner = scanner;
    this.seenTokens = new Set();
    console.log('DexWebhook listener initialized');
  }

  async handleWebhookData(data) {
    try {
      if (!data || !data.pairs) return;

      for (const pair of data.pairs) {
        const address = pair.baseToken?.address;
        if (!address || this.seenTokens.has(address)) continue;
        this.seenTokens.add(address);

        // Pass to main scanner analyzer
        const profile = {
          tokenAddress: address,
          address: address,
          description: pair.baseToken?.name || 'Unknown',
          links: pair.info?.socials || []
        };

        const token = await this.scanner.analyzeToken(profile);
        if (!token) continue;

        console.log(
          'DexWebhook signal: ' + token.name +
          ' | Score: ' + token.score
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
          volume: (token.pairData?.volume?.h1 || 0).toLocaleString(),
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

        const message = this.scanner.formatAlert(token, aiAnalysis);
        await sendTelegramAlert(message);

        const isAutoTrade = token.score >= 80 &&
          token.devReputation === 'ALPHA';
        await this.scanner.executor.processSignal(token, isAutoTrade);

      }
    } catch (error) {
      console.error('DexWebhook error:', error.message);
    }
  }
}

module.exports = { DexWebhook };