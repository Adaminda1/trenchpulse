require('dotenv').config();
const { Scanner } = require('./listeners/scanner');

console.log('TRENCHPULSE INITIALIZED');
console.log('========================');
console.log('Solana RPC connected');
console.log('Telegram alerts enabled');
console.log('Scanning for new tokens...');

const scanner = new Scanner();
scanner.start();

process.stdin.resume();

process.on('SIGINT', () => {
  scanner.stop();
  process.exit(0);
});