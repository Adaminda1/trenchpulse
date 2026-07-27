require('dotenv').config();
const http = require('http');
const https = require('https');
const { PumpScanner } = require('./listeners/pumpscanner');
const { RaydiumScanner } = require('./listeners/raydium-scanner');

// Initialize dual scanners
const pumpScanner = new PumpScanner(null); // Pump.fun catches community tokens at birth
const raydiumScanner = new RaydiumScanner(null); // Raydium catches DEX launches with real liquidity

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

// Telegram bot — separate from node-telegram-bot-api
// Using raw API to avoid polling conflicts
const axios = require('axios');
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
console.log('Bot started — watching chat ID: ' + TELEGRAM_CHAT_ID);
let lastUpdateId = 0;

async function sendMessage(chatId, text) {
  try {
    await axios.post(
      'https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage',
      { chat_id: chatId, text: text },
      { timeout: 10000 }
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
const yourId = String(TELEGRAM_CHAT_ID).trim();
const incomingId = String(chatId).trim();

if (incomingId !== yourId) {
  console.log('Ignored chat: ' + incomingId + 
    ' expected: ' + yourId);
  continue;
}

      console.log('Telegram message received: ' + text);

      if (text.startsWith('BUY ') || text.startsWith('SKIP ')) {
        // Fire and forget — don't block polling
        console.log('Approval message received (manual review)');
        await sendMessage(chatId, 'Manual review mode active — signals sent to your review queue.')
          .catch(err => console.error('Approval error:', err.message));
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
            'Status: ONLINE\n' +
            'Scanners: Pump.fun ✓ + Raydium ✓\n' +
            'Uptime: ' +
            Math.floor(process.uptime() / 60) + ' minutes\n\n' +
            'Mode: Manual Review\n' +
            'Strategy: 0.05+ SOL Pump.fun + Real Liquidity Raydium\n\n' +
            'TrenchPulse'
          ).catch(err => console.error('Status message error:', err.message));
          break;

        case '/help':
          sendMessage(chatId,
            'TRENCHPULSE COMMANDS\n' +
            '========================\n\n' +
            '/start — Welcome message\n' +
            '/status — Bot status\n' +
            '/help — Show commands\n\n' +
            'SIGNAL TYPES\n' +
            'PUMP.FUN EARLY LAUNCH — Community tokens at seconds old\n' +
            '  → 0.05+ SOL conviction required\n' +
            '  → Manual review for quality\n\n' +
            'RAYDIUM NEW POOL — DEX launches with real liquidity\n' +
            '  → $1k+ liquidity minimum\n' +
            '  → Real volume verification\n\n' +
            'TrenchPulse'
          ).catch(err => console.error('Help error:', err.message));
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