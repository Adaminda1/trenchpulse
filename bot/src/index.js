require('dotenv').config();
const http = require('http');
const TelegramBotLib = require('node-telegram-bot-api');
const TelegramBot = TelegramBotLib.default || TelegramBotLib;
const { Scanner } = require('./listeners/scanner');
const { PumpScanner } = require('./listeners/pumpscanner');

// Health check server for Render
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('TrenchPulse is running');
});

server.listen(process.env.PORT || 3000, () => {
  console.log('Health check server running');
});

console.log('TRENCHPULSE INITIALIZED');
console.log('========================');
console.log('Solana RPC connected');
console.log('Telegram alerts enabled');
console.log('Scanning for new tokens...');

// Initialize scanners
const scanner = new Scanner();
const pumpScanner = new PumpScanner();

// Telegram bot for receiving approval replies
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: true
});

// Handle approval replies from you
bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  const yourChatId = process.env.TELEGRAM_CHAT_ID;

  // Only accept messages from you
  if (chatId !== yourChatId) return;

  const text = msg.text || '';

  // Handle trade approvals
  if (text.startsWith('BUY ') || text.startsWith('SKIP ')) {
    const handled = await scanner.executor.handleApprovalReply(text);
    if (!handled) {
      bot.sendMessage(chatId, 'Approval not found or expired.');
    }
    return;
  }

  // Handle commands
  if (text === '/positions') {
    const summary = scanner.executor.getPositionsSummary();
    bot.sendMessage(chatId, summary);
    return;
  }

  if (text === '/pause') {
    process.env.AUTO_TRADE_ENABLED = 'false';
    bot.sendMessage(chatId, 'Auto trading paused.');
    return;
  }

  if (text === '/resume') {
    process.env.AUTO_TRADE_ENABLED = 'true';
    bot.sendMessage(chatId, 'Auto trading resumed.');
    return;
  }

  if (text === '/status') {
    bot.sendMessage(chatId,
      'TRENCHPULSE STATUS\n\n' +
      'Auto Trade: ' + process.env.AUTO_TRADE_ENABLED + '\n' +
      'Open Positions: ' + scanner.executor.positions.size + '\n' +
      'Daily Loss: ' + scanner.executor.dailyLoss.toFixed(4) + ' SOL\n\n' +
      'TrenchPulse'
    );
    return;
  }
});

// Start everything
scanner.start();
pumpScanner.start();

process.on('SIGINT', () => {
  scanner.stop();
  pumpScanner.stop();
  process.exit(0);
});