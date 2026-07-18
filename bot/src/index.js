require('dotenv').config();
const http = require('http');
const { Scanner } = require('./listeners/scanner');

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

const scanner = new Scanner();
scanner.start();

process.on('SIGINT', () => {
  scanner.stop();
  process.exit(0);
});