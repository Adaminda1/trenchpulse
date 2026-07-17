console.log('🐊 TRENCHPULSE INITIALIZED');
console.log('===========================');
console.log('✅ Solana RPC connected');
console.log('📨 Telegram alerts enabled');
console.log('🔍 Scanning for new tokens...');
console.log('');

const { Scanner } = require('./listeners/scanner');

const scanner = new Scanner();
scanner.start();

process.stdin.resume();