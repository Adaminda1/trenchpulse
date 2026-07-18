const {
  Connection,
  PublicKey,
  Keypair,
  VersionedTransaction
} = require('@solana/web3.js');
const fetch = require('node-fetch');
require('dotenv').config();

const { sendTelegramAlert } = require('../managers/trademanager');

const CONFIG = {
  TRADE_AMOUNT_SOL: parseFloat(process.env.TRADE_AMOUNT_SOL || 0.05),
  MAX_POSITIONS: parseInt(process.env.MAX_POSITIONS || 5),
  DAILY_LOSS_LIMIT_SOL: parseFloat(process.env.DAILY_LOSS_LIMIT_SOL || 0.15),
  SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS || 1500),
  AUTO_TRADE_ENABLED: process.env.AUTO_TRADE_ENABLED === 'true',
  CHECK_INTERVAL: 30000
};

const TAKE_PROFIT = [
  { multiple: 2, sellPercent: 50 },
  { multiple: 5, sellPercent: 25 },
  { multiple: 10, sellPercent: 15 }
];

const STOP_LOSS_PERCENT = 30;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

class AutoExecutor {
  constructor() {
    this.connection = new Connection(
      process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    this.wallet = this.loadWallet();
    this.positions = new Map();
    this.pendingApprovals = new Map();
    this.dailyLoss = 0;
    this.dailyLossResetTime = Date.now();
    this.isRunning = false;
    console.log('AutoExecutor initialized');
    console.log('Auto trade enabled:', CONFIG.AUTO_TRADE_ENABLED);
    console.log('Trade amount:', CONFIG.TRADE_AMOUNT_SOL, 'SOL');
  }

  loadWallet() {
    try {
      const privateKey = process.env.PRIVATE_KEY;
      if (!privateKey) {
        console.error('No private key found in .env');
        return null;
      }

      // Handle array format [1,2,3...]
      if (privateKey.startsWith('[')) {
        const keyArray = JSON.parse(privateKey);
        return Keypair.fromSecretKey(Uint8Array.from(keyArray));
      }

      // Handle base58 format
      try {
        const bs58 = require('bs58');
        const decode = typeof bs58.decode === 'function'
          ? bs58.decode
          : bs58.default?.decode;
        const decoded = decode(privateKey);
        return Keypair.fromSecretKey(decoded);
      } catch (e) {
        // Try buffer decode as fallback
        const decoded = Buffer.from(privateKey, 'base64');
        return Keypair.fromSecretKey(decoded);
      }

    } catch (error) {
      console.error('Wallet load error:', error.message);
      return null;
    }
  }

  resetDailyLossIfNeeded() {
    const now = Date.now();
    const hoursSinceReset = (now - this.dailyLossResetTime) / (1000 * 60 * 60);
    if (hoursSinceReset >= 24) {
      this.dailyLoss = 0;
      this.dailyLossResetTime = now;
      console.log('Daily loss counter reset');
    }
  }

  isDailyLimitHit() {
    this.resetDailyLossIfNeeded();
    return this.dailyLoss >= CONFIG.DAILY_LOSS_LIMIT_SOL;
  }

  canOpenNewPosition() {
    if (!this.wallet) {
      console.log('No wallet loaded — skipping trade');
      return false;
    }
    if (this.positions.size >= CONFIG.MAX_POSITIONS) {
      console.log('Max positions reached');
      return false;
    }
    if (this.isDailyLimitHit()) {
      console.log('Daily loss limit hit');
      return false;
    }
    return true;
  }

  async getTokenPrice(tokenAddress) {
    try {
      const response = await fetch(
        'https://api.jup.ag/price/v2?ids=' + tokenAddress,
        { timeout: 10000 }
      );
      const data = await response.json();
      return parseFloat(data?.data?.[tokenAddress]?.price || 0);
    } catch (error) {
      console.error('Price fetch error:', error.message);
      return 0;
    }
  }

  async getSwapQuote(inputMint, outputMint, amountLamports) {
    try {
      const url =
        'https://quote-api.jup.ag/v6/quote' +
        '?inputMint=' + inputMint +
        '&outputMint=' + outputMint +
        '&amount=' + amountLamports +
        '&slippageBps=' + CONFIG.SLIPPAGE_BPS;

      const response = await fetch(url, { timeout: 15000 });
      return await response.json();
    } catch (error) {
      console.error('Quote error:', error.message);
      return null;
    }
  }

  async executeSwap(quote) {
    try {
      if (!this.wallet) throw new Error('No wallet loaded');

      const swapResponse = await fetch(
        'https://quote-api.jup.ag/v6/swap',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: this.wallet.publicKey.toString(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 'auto'
          })
        }
      );

      const swapData = await swapResponse.json();
      if (!swapData.swapTransaction) {
        throw new Error('No swap transaction returned');
      }

      const transactionBuffer = Buffer.from(
        swapData.swapTransaction, 'base64'
      );
      const transaction = VersionedTransaction.deserialize(
        transactionBuffer
      );
      transaction.sign([this.wallet]);

      const signature = await this.connection.sendTransaction(
        transaction, { maxRetries: 3 }
      );
      await this.connection.confirmTransaction(signature, 'confirmed');
      return signature;

    } catch (error) {
      console.error('Swap execution error:', error.message);
      return null;
    }
  }

  async buyToken(tokenAddress, tokenName, tokenSymbol) {
    try {
      if (!this.canOpenNewPosition()) return false;

      const amountLamports = Math.floor(CONFIG.TRADE_AMOUNT_SOL * 1e9);

      console.log(
        'Buying ' + tokenName +
        ' with ' + CONFIG.TRADE_AMOUNT_SOL + ' SOL...'
      );

      const quote = await this.getSwapQuote(
        SOL_MINT, tokenAddress, amountLamports
      );

      if (!quote || quote.error) {
        console.error('Quote failed for ' + tokenName);
        return false;
      }

      const signature = await this.executeSwap(quote);
      if (!signature) return false;

      const entryPrice = await this.getTokenPrice(tokenAddress);

      this.positions.set(tokenAddress, {
        address: tokenAddress,
        name: tokenName,
        symbol: tokenSymbol,
        entryPrice,
        amountSol: CONFIG.TRADE_AMOUNT_SOL,
        tokensReceived: parseInt(quote.outAmount),
        remainingPercent: 100,
        peakPrice: entryPrice,
        tpLevel: 0,
        openedAt: Date.now(),
        signature
      });

      await sendTelegramAlert(
        'TRENCHPULSE TRADE OPENED\n' +
        '========================\n\n' +
        'Token: ' + tokenName + ' (' + tokenSymbol + ')\n' +
        'Amount: ' + CONFIG.TRADE_AMOUNT_SOL + ' SOL\n' +
        'Entry Price: $' + entryPrice.toFixed(8) + '\n' +
        'Open Positions: ' + this.positions.size + '/' +
        CONFIG.MAX_POSITIONS + '\n\n' +
        'TX: ' + signature + '\n\n' +
        'Take Profit: 2x, 5x, 10x\n' +
        'Stop Loss: -30%\n\n' +
        'TrenchPulse AutoExecutor'
      );

      console.log('Buy successful: ' + tokenName);
      return true;

    } catch (error) {
      console.error('Buy error:', error.message);
      return false;
    }
  }

  async sellToken(tokenAddress, sellPercent, reason) {
    try {
      const position = this.positions.get(tokenAddress);
      if (!position) return false;

      const tokensToSell = Math.floor(
        position.tokensReceived *
        (position.remainingPercent / 100) *
        (sellPercent / 100)
      );

      if (tokensToSell <= 0) return false;

      console.log(
        'Selling ' + sellPercent + '% of ' +
        position.name + ' — ' + reason
      );

      const quote = await this.getSwapQuote(
        tokenAddress, SOL_MINT, tokensToSell
      );

      if (!quote || quote.error) {
        console.error('Sell quote failed');
        return false;
      }

      const signature = await this.executeSwap(quote);
      if (!signature) return false;

      const currentPrice = await this.getTokenPrice(tokenAddress);
      const multiple = position.entryPrice > 0
        ? currentPrice / position.entryPrice : 0;
      const solReceived = parseInt(quote.outAmount) / 1e9;

      // Update remaining position
      const soldPercent = position.remainingPercent * sellPercent / 100;
      position.remainingPercent -= soldPercent;

      if (position.remainingPercent < 1 || sellPercent === 100) {
        const pnl = solReceived -
          (position.amountSol * sellPercent / 100);
        if (pnl < 0) this.dailyLoss += Math.abs(pnl);
        this.positions.delete(tokenAddress);

        await sendTelegramAlert(
          'TRENCHPULSE POSITION CLOSED\n' +
          '========================\n\n' +
          'Token: ' + position.name + ' (' + position.symbol + ')\n' +
          'Reason: ' + reason + '\n' +
          'Entry: $' + position.entryPrice.toFixed(8) + '\n' +
          'Exit: $' + currentPrice.toFixed(8) + '\n' +
          'Multiple: ' + multiple.toFixed(2) + 'x\n' +
          'SOL Received: ' + solReceived.toFixed(4) + ' SOL\n\n' +
          'TX: ' + signature + '\n\n' +
          'TrenchPulse AutoExecutor'
        );
      } else {
        this.positions.set(tokenAddress, position);

        await sendTelegramAlert(
          'TRENCHPULSE PARTIAL SELL\n' +
          '========================\n\n' +
          'Token: ' + position.name + ' (' + position.symbol + ')\n' +
          'Sold: ' + sellPercent + '%\n' +
          'Reason: ' + reason + '\n' +
          'Current: ' + multiple.toFixed(2) + 'x\n' +
          'SOL Received: ' + solReceived.toFixed(4) + ' SOL\n' +
          'Remaining: ' + position.remainingPercent.toFixed(0) + '%\n\n' +
          'TX: ' + signature + '\n\n' +
          'TrenchPulse AutoExecutor'
        );
      }

      console.log('Sell successful: ' + position.name);
      return true;

    } catch (error) {
      console.error('Sell error:', error.message);
      return false;
    }
  }

  async monitorPositions() {
    if (this.positions.size === 0) return;

    for (const [address, position] of this.positions) {
      try {
        const currentPrice = await this.getTokenPrice(address);
        if (!currentPrice || currentPrice === 0) continue;

        const multiple = position.entryPrice > 0
          ? currentPrice / position.entryPrice : 0;
        const drawdown = position.peakPrice > 0
          ? ((position.peakPrice - currentPrice) / position.peakPrice) * 100
          : 0;

        // Update peak price
        if (currentPrice > position.peakPrice) {
          position.peakPrice = currentPrice;
          this.positions.set(address, position);
        }

        console.log(
          'Monitoring ' + position.name +
          ' | ' + multiple.toFixed(2) + 'x' +
          ' | Drawdown: ' + drawdown.toFixed(1) + '%'
        );

        // Stop loss — 30% from peak
        if (drawdown >= STOP_LOSS_PERCENT) {
          console.log('Stop loss triggered: ' + position.name);
          await this.sellToken(address, 100, 'Stop Loss -30%');
          continue;
        }

        // Tiered take profit
        for (let i = position.tpLevel; i < TAKE_PROFIT.length; i++) {
          const tp = TAKE_PROFIT[i];
          if (multiple >= tp.multiple) {
            console.log(
              'Take profit ' + tp.multiple + 'x: ' + position.name
            );
            await this.sellToken(
              address,
              tp.sellPercent,
              'Take Profit ' + tp.multiple + 'x'
            );
            position.tpLevel = i + 1;
            this.positions.set(address, position);
            break;
          }
        }

      } catch (error) {
        console.error('Monitor error:', error.message);
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  async requestApproval(tokenAddress, tokenName, tokenSymbol, score) {
    const approvalId = tokenAddress.slice(0, 8);

    this.pendingApprovals.set(approvalId, {
      tokenAddress,
      tokenName,
      tokenSymbol,
      requestedAt: Date.now()
    });

    await sendTelegramAlert(
      'TRENCHPULSE APPROVAL NEEDED\n' +
      '========================\n\n' +
      'Token: ' + tokenName + ' (' + tokenSymbol + ')\n' +
      'Score: ' + score + '/100\n' +
      'Amount: ' + CONFIG.TRADE_AMOUNT_SOL + ' SOL\n\n' +
      'Reply with:\n' +
      'BUY ' + approvalId + ' to approve\n' +
      'SKIP ' + approvalId + ' to reject\n\n' +
      'Expires in 5 minutes\n\n' +
      'TrenchPulse AutoExecutor'
    );

    setTimeout(() => {
      if (this.pendingApprovals.has(approvalId)) {
        this.pendingApprovals.delete(approvalId);
        console.log('Approval expired: ' + tokenName);
      }
    }, 5 * 60 * 1000);
  }

  async handleApprovalReply(text) {
    const parts = text.trim().split(' ');
    if (parts.length !== 2) return false;

    const command = parts[0].toUpperCase();
    const approvalId = parts[1];

    if (!this.pendingApprovals.has(approvalId)) return false;

    const pending = this.pendingApprovals.get(approvalId);
    this.pendingApprovals.delete(approvalId);

    if (command === 'BUY') {
      await sendTelegramAlert(
        'Approved! Buying ' + pending.tokenName + '...'
      );
      await this.buyToken(
        pending.tokenAddress,
        pending.tokenName,
        pending.tokenSymbol
      );
      return true;
    }

    if (command === 'SKIP') {
      await sendTelegramAlert('Skipped ' + pending.tokenName);
      return true;
    }

    return false;
  }

  async processSignal(token, isAutoTrade) {
    if (!CONFIG.AUTO_TRADE_ENABLED) {
      console.log('Auto trade disabled — signal only');
      return;
    }

    if (!this.canOpenNewPosition()) {
      if (this.isDailyLimitHit()) {
        await sendTelegramAlert(
          'TRENCHPULSE ALERT\n\n' +
          'Daily loss limit reached.\n' +
          'Trading paused for 24 hours.\n' +
          'Daily Loss: ' + this.dailyLoss.toFixed(4) + ' SOL\n\n' +
          'TrenchPulse AutoExecutor'
        );
      }
      return;
    }

    if (isAutoTrade) {
      await this.buyToken(token.address, token.name, token.symbol);
    } else {
      await this.requestApproval(
        token.address,
        token.name,
        token.symbol,
        token.score
      );
    }
  }

  getPositionsSummary() {
    if (this.positions.size === 0) return 'No open positions';
    let summary = 'OPEN POSITIONS\n========================\n\n';
    for (const [address, pos] of this.positions) {
      summary +=
        'Token: ' + pos.name + '\n' +
        'Entry: $' + pos.entryPrice.toFixed(8) + '\n' +
        'Remaining: ' + pos.remainingPercent.toFixed(0) + '%\n\n';
    }
    return summary;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('AutoExecutor started');
    setInterval(() => this.monitorPositions(), CONFIG.CHECK_INTERVAL);
  }

  stop() {
    this.isRunning = false;
    console.log('AutoExecutor stopped');
  }
}

module.exports = { AutoExecutor };