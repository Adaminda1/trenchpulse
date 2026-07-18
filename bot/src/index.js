require('dotenv').config();
const http = require('http');
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

// DexScreener scanner - catches tokens minutes old
const scanner = new Scanner();
scanner.start();

// Pump.fun scanner - catches tokens seconds old
const pumpScanner = new PumpScanner();
pumpScanner.start();

process.on('SIGINT', () => {
  scanner.stop();
  pumpScanner.stop();
  process.exit(0);
});