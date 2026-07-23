require('dotenv').config();
const http = require('http');
const https = require('https');
const { Scanner } = require('./listeners/scanner');
const { PumpScanner } = require('./listeners/pumpscanner');

// Initialize scanners
const scanner = new Scanner();
const pumpScanner = new PumpScanner(scanner);

// Health check server
const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache'
  });
  res.end(JSON.stringify({
    status: 'alive',
    service: 'TrenchPulse',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime())
  }));
});

server.listen(process.env.PORT || 3000, () => {
  console.log('Health check server running');
});

console.log('TRENCHPULSE INITIALIZED');
console.log('========================');
console.log('Solana RPC connected');
console.log('Telegram alerts enabled');
console.log('Scanning for new tokens...');

// Telegram bot — separate from node-telegram-bot-api
// Using raw API to avoid polling conflicts
const axios = require('axios');
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
let lastUpdateId = 0;

async function sendMessage(chatId, text) {
  try {
    await axios.post(
      'https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage',
      { chat_id: chatId, text: text }
    );
  } catch (error) {
    console.error('Send message error:', error.message);
  }
}

async function pollTelegram() {
  try {
    const response = await axios.get(
      'https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/getUpdates',
      {
        params: {
          offset: lastUpdateId + 1,
          timeout: 30,
          allowed_updates: ['message']
        },
        timeout: 35000
      }
    );

    const updates = response.data?.result || [];
    if (updates.length > 0) {
  console.log('Telegram update received from chat: ' +
    updates[0]?.message?.chat?.id);
  console.log('Expected chat ID: ' + TELEGRAM_CHAT_ID);
}

    for (const update of updates) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg) continue;

      const chatId = msg.chat.id.toString();
      const text = msg.text || '';

      // Only respond to your chat
      if (chatId !== TELEGRAM_CHAT_ID &&
    chatId !== String(TELEGRAM_CHAT_ID)) {
  console.log('Message from unknown chat: ' + chatId);
  continue;
}

      console.log('Telegram message received: ' + text);

      if (text.startsWith('BUY ') || text.startsWith('SKIP ')) {
        const handled = await scanner.executor
          .handleApprovalReply(text);
        if (!handled) {
          await sendMessage(chatId, 'Approval not found or expired.');
        }
        continue;
      }

      switch (text) {
        case '/start':
          await sendMessage(chatId,
            'TrenchPulse is LIVE\n\n' +
            'Scanning Pump.fun and DexScreener 24/7\n\n' +
            'Commands:\n' +
            '/status — Bot status\n' +
            '/positions — Open trades\n' +
            '/pause — Pause trading\n' +
            '/resume — Resume trading\n' +
            '/help — All commands'
          );
          break;

        case '/status':
          await sendMessage(chatId,
            'TRENCHPULSE STATUS\n' +
            '========================\n\n' +
            'Status: ONLINE\n' +
            'Auto Trade: ' + process.env.AUTO_TRADE_ENABLED + '\n' +
            'Open Positions: ' +
            scanner.executor.positions.size + '\n' +
            'Daily Loss: ' +
            scanner.executor.dailyLoss.toFixed(4) + ' SOL\n' +
            'Uptime: ' +
            Math.floor(process.uptime() / 60) + ' minutes\n\n' +
            'TrenchPulse'
          );
          break;

        case '/positions':
          await sendMessage(chatId,
            scanner.executor.getPositionsSummary()
          );
          break;

        case '/pause':
          process.env.AUTO_TRADE_ENABLED = 'false';
          await sendMessage(chatId, 'Auto trading paused.');
          break;

        case '/resume':
          process.env.AUTO_TRADE_ENABLED = 'true';
          await sendMessage(chatId, 'Auto trading resumed.');
          break;

        case '/help':
          await sendMessage(chatId,
            'TRENCHPULSE COMMANDS\n' +
            '========================\n\n' +
            'BUY xxxxxxxx — Approve trade\n' +
            'SKIP xxxxxxxx — Reject trade\n' +
            '/start — Welcome message\n' +
            '/status — Bot status\n' +
            '/positions — Open positions\n' +
            '/pause — Pause auto trading\n' +
            '/resume — Resume auto trading\n' +
            '/help — Show commands\n\n' +
            'TrenchPulse'
          );
          break;

        default:
          break;
      }
    }
  } catch (error) {
    console.error('Telegram poll error:', error.message);
  }

  // Poll again after 1 second
  setTimeout(pollTelegram, 1000);
}

// Start Telegram polling
pollTelegram();
console.log('Telegram polling started');

// Start scanners
scanner.start();
pumpScanner.start();

// Self ping every 10 minutes
const RENDER_URL = process.env.RENDER_URL ||
  'https://trenchpulse-qceu.onrender.com';

setInterval(() => {
  try {
    const client = RENDER_URL.startsWith('https') ? https : http;
    client.get(RENDER_URL, (res) => {
      console.log('Self-ping: ' + res.statusCode);
    }).on('error', (err) => {
      console.log('Self-ping error:', err.message);
    });
  } catch (error) {
    console.log('Self-ping failed:', error.message);
  }
}, 10 * 60 * 1000);

console.log('Self-ping active every 10 minutes');

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('TrenchPulse shutting down...');
  scanner.stop();
  pumpScanner.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('TrenchPulse shutting down...');
  scanner.stop();
  pumpScanner.stop();
  process.exit(0);
});