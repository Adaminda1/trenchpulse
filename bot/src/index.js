require('dotenv').config();
const http = require('http');
const https = require('https');
const TelegramBotLib = require('node-telegram-bot-api');
const TelegramBot = TelegramBotLib.default || TelegramBotLib;
const { Scanner } = require('./listeners/scanner');
const { PumpScanner } = require('./listeners/pumpscanner');
const { DexWebhook } = require('./listeners/dexwebhook');

// Initialize scanners
const scanner = new Scanner();
const pumpScanner = new PumpScanner();
const dexWebhook = new DexWebhook(scanner);

// HTTP server — handles health check AND DexScreener webhooks
const server = http.createServer(async (req, res) => {

  // Health check endpoint
  if (req.method === 'GET' && req.url === '/') {
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
    return;
  }

  // DexScreener webhook endpoint
  if (req.method === 'POST' && req.url === '/webhook/dexscreener') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));

        const data = JSON.parse(body);
        console.log('DexScreener webhook received');
        await dexWebhook.handleWebhookData(data);

      } catch (error) {
        console.error('Webhook parse error:', error.message);
      }
    });
    return;
  }

  // 404 for everything else
  res.writeHead(404);
  res.end('Not found');
});

server.listen(process.env.PORT || 3000, () => {
  console.log('TrenchPulse server running on port ' +
    (process.env.PORT || 3000));
});

console.log('TRENCHPULSE INITIALIZED');
console.log('========================');
console.log('Solana RPC connected');
console.log('Telegram alerts enabled');
console.log('Scanning for new tokens...');

// Telegram bot for commands
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: true
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  const yourChatId = process.env.TELEGRAM_CHAT_ID;
  if (chatId !== yourChatId) return;

  const text = msg.text || '';

  if (text.startsWith('BUY ') || text.startsWith('SKIP ')) {
    const handled = await scanner.executor.handleApprovalReply(text);
    if (!handled) {
      bot.sendMessage(chatId, 'Approval not found or expired.');
    }
    return;
  }

  switch (text) {
    case '/positions':
      bot.sendMessage(chatId,
        scanner.executor.getPositionsSummary()
      );
      break;

    case '/pause':
      process.env.AUTO_TRADE_ENABLED = 'false';
      bot.sendMessage(chatId, 'Auto trading paused.');
      break;

    case '/resume':
      process.env.AUTO_TRADE_ENABLED = 'true';
      bot.sendMessage(chatId, 'Auto trading resumed.');
      break;

    case '/status':
      bot.sendMessage(chatId,
        'TRENCHPULSE STATUS\n' +
        '========================\n\n' +
        'Auto Trade: ' + process.env.AUTO_TRADE_ENABLED + '\n' +
        'Open Positions: ' +
        scanner.executor.positions.size + '\n' +
        'Daily Loss: ' +
        scanner.executor.dailyLoss.toFixed(4) + ' SOL\n' +
        'Uptime: ' + Math.floor(process.uptime() / 60) +
        ' minutes\n\n' +
        'TrenchPulse'
      );
      break;

    case '/help':
      bot.sendMessage(chatId,
        'TRENCHPULSE COMMANDS\n' +
        '========================\n\n' +
        'BUY xxxxxxxx — Approve trade\n' +
        'SKIP xxxxxxxx — Reject trade\n' +
        '/positions — Open positions\n' +
        '/status — Bot status\n' +
        '/pause — Pause auto trading\n' +
        '/resume — Resume auto trading\n' +
        '/help — Show commands\n\n' +
        'TrenchPulse'
      );
      break;

    default:
      break;
  }
});

// Start Pump.fun scanner
pumpScanner.start();

// Start DexScreener polling as backup
// (webhook is primary, polling is fallback)
scanner.start();

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
console.log('Webhook URL: ' + RENDER_URL + '/webhook/dexscreener');

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