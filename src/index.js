require('dotenv').config();
const { Scanner } = require('./listeners/scanner');

console.log('🚀 TRENCHPULSE INITIALIZED');
console.log('==========================');
console.log('✅ Solana RPC connected');
console.log('📱 Telegram alerts enabled');
console.log('🔍 Scanning for new tokens...');
console.log('');

const scanner = new Scanner();
scanner.start();

// Keep process alive
process.stdin.resume();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 TrenchPulse shutting down...');
  scanner.stop();
  process.exit(0);
});