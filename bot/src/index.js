require('dotenv').config();
const http = require('http');
const https = require('https');
const { PumpScanner } = require('./listeners/pumpscanner');
const { RaydiumScanner } = require('./listeners/raydium-scanner');

// Initialize dual scanners
const pumpScanner = new PumpScanner(null);
const raydiumScanner = new RaydiumScanner(null);

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
console.log('Dual scanner mode: Pump.fun + Raydium');
console.log('Scanning for new tokens...');

// Telegram bot
const axios = require('axios');
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
console.log('Bot started — watching chat ID: ' + TELEGRAM_CHAT_ID);
let lastUpdateId = 0;
let telegramRetries = 0;
const MAX_TELEGRAM_RETRIES = 3;

async function sendMessage(chatId, text) {
  try {
    await axios.post(
      'https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage',
      { chat_id: chatId, text: text },
      { timeout: 10000 }
    );
  } catch (error) {
    if (error.response?.status === 409) {
      console.log('Telegram 409 conflict (duplicate?) — skipping');
    } else {
      console.error('Send message error:', error.message);
    }
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

    // Reset retry counter on successful poll
    telegramRetries = 0;

    const updates = response.data?.result || [];
    if (updates.length > 0) {
      console.log('Telegram: ' + updates.length + ' update(s)');
    }

    for (const update of updates) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg) continue;

      const chatId = msg.chat.id.toString();
      const text = msg.text || '';

      // Only respond to your chat
      const yourId = String(TELEGRAM_CHAT_ID).trim();
      const incomingId = String(chatId).trim();

      if (incomingId !== yourId) {
        continue;
      }

      console.log('Telegram message: ' + text);

      if (text.startsWith('BUY ') || text.startsWith('SKIP ')) {
        console.log('Manual review message received');
        await sendMessage(chatId, 'Noted — manual review mode active.');
        continue;
      }

      switch (text) {
        case '/start':
          sendMessage(chatId,
            'TrenchPulse is LIVE\n\n' +
            'Scanning Pump.fun + Raydium 24/7\n\n' +
            'Pump.fun: Community tokens at birth (0.05+ SOL)\n' +
            'Raydium: DEX launches with real liquidity\n\n' +
            'Commands:\n' +
            '/status — Bot status\n' +
            '/help — All commands'
          ).catch(err => console.error('Start message error:', err.message));
          break;

        case '/status':
          sendMessage(chatId,
            'TRENCHPULSE STATUS\n' +
            '========================\n\n' +
            'Status: ONLINE ✓\n' +
            'Scanners: Pump.fun ✓ + Raydium ✓\n' +
            'Uptime: ' +
            Math.floor(process.uptime() / 60) + ' minutes\n\n' +
            'Mode: Manual Review\n' +
            'Signals: Alerts only\n\n' +
            'TrenchPulse'
          ).catch(err => console.error('Status message error:', err.message));
          break;

        case '/help':
          sendMessage(chatId,
            'TRENCHPULSE COMMANDS\n' +
            '========================\n\n' +
            '/start — Welcome\n' +
            '/status — Bot status\n' +
            '/help — Show commands\n\n' +
            'SIGNALS\n' +
            'PUMP.FUN EARLY LAUNCH\n' +
            '  → Community tokens, seconds old\n' +
            '  → 0.05+ SOL backing\n\n' +
            'RAYDIUM POOL\n' +
            '  → DEX launches\n' +
            '  → $1k+ liquidity\n\n' +
            'TrenchPulse'
          ).catch(err => console.error('Help error:', err.message));
          break;

        default:
          break;
      }
    }
  } catch (error) {
    if (error.response?.status === 409) {
      console.log('Telegram 409 conflict on poll — retrying...');
      telegramRetries++;
      if (telegramRetries > MAX_TELEGRAM_RETRIES) {
        console.error('Telegram 409 retries exceeded — resetting offset');
        telegramRetries = 0;
        lastUpdateId = 0; // Reset to start fresh
      }
    } else {
      console.error('Telegram poll error:', error.message);
      telegramRetries++;
      if (telegramRetries > MAX_TELEGRAM_RETRIES) {
        telegramRetries = 0;
      }
    }
  }

  // Poll again after 1 second
  setTimeout(pollTelegram, 1000);
}

// Start Telegram polling (non-blocking)
pollTelegram();
console.log('Telegram polling started');

// Start dual scanners
pumpScanner.start();
raydiumScanner.start();
console.log('Pump.fun + Raydium scanners started');

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
  pumpScanner.stop();
  raydiumScanner.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('TrenchPulse shutting down...');
  pumpScanner.stop();
  raydiumScanner.stop();
  process.exit(0);
});