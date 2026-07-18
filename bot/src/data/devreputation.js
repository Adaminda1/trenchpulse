const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'devdb.json');

function loadDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, JSON.stringify({}));
    }
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (error) {
    console.error('DevDB load error:', error.message);
    return {};
  }
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (error) {
    console.error('DevDB save error:', error.message);
  }
}

function getDevRecord(walletAddress) {
  const db = loadDB();
  return db[walletAddress] || null;
}

function registerToken(walletAddress, tokenAddress, tokenName) {
  const db = loadDB();

  if (!db[walletAddress]) {
    db[walletAddress] = {
      wallet: walletAddress,
      tokensLaunched: [],
      totalLaunched: 0,
      successCount: 0,
      rugCount: 0,
      successRate: 0,
      reputation: 'NEW',
      firstSeen: Date.now(),
      lastSeen: Date.now()
    };
  }

  const dev = db[walletAddress];

  // Only register if not already tracked
  const alreadyTracked = dev.tokensLaunched.find(t => t.address === tokenAddress);
  if (!alreadyTracked) {
    dev.tokensLaunched.push({
      address: tokenAddress,
      name: tokenName,
      launchedAt: Date.now(),
      status: 'PENDING',
      peakMultiple: 1
    });
    dev.totalLaunched += 1;
    dev.lastSeen = Date.now();
    updateReputation(dev);
    db[walletAddress] = dev;
    saveDB(db);
    console.log('Dev registered: ' + walletAddress.slice(0, 8) + '...');
  }

  return db[walletAddress];
}

async function updateTokenOutcome(walletAddress, tokenAddress, currentPrice, initialPrice) {
  const db = loadDB();
  if (!db[walletAddress]) return;

  const dev = db[walletAddress];
  const token = dev.tokensLaunched.find(t => t.address === tokenAddress);
  if (!token || token.status !== 'PENDING') return;

  const ageHours = (Date.now() - token.launchedAt) / (1000 * 60 * 60);
  if (ageHours < 24) return; // Wait 24 hours before judging

  const multiple = currentPrice / initialPrice;
  token.peakMultiple = multiple;

  if (multiple >= 2) {
    token.status = 'SUCCESS';
    dev.successCount += 1;
    console.log('Dev success recorded: ' + walletAddress.slice(0, 8) + '...');
  } else if (multiple < 0.2) {
    token.status = 'RUG';
    dev.rugCount += 1;
    console.log('Dev rug recorded: ' + walletAddress.slice(0, 8) + '...');
  } else {
    token.status = 'NEUTRAL';
  }

  updateReputation(dev);
  db[walletAddress] = dev;
  saveDB(db);
}

function updateReputation(dev) {
  const judged = dev.successCount + dev.rugCount;
  if (judged === 0) {
    dev.reputation = 'NEW';
    dev.successRate = 0;
    return;
  }

  dev.successRate = Math.round((dev.successCount / judged) * 100);

  if (dev.rugCount >= 3) {
    dev.reputation = 'BLACKLISTED';
  } else if (dev.successRate >= 70 && judged >= 3) {
    dev.reputation = 'ALPHA';
  } else if (dev.successRate >= 50 && judged >= 2) {
    dev.reputation = 'TRUSTED';
  } else if (dev.rugCount >= 1) {
    dev.reputation = 'RISKY';
  } else {
    dev.reputation = 'NEW';
  }
}

function getReputationBoost(reputation) {
  switch (reputation) {
    case 'ALPHA': return 30;
    case 'TRUSTED': return 15;
    case 'NEW': return 0;
    case 'RISKY': return -20;
    case 'BLACKLISTED': return -100;
    default: return 0;
  }
}

function getReputationEmoji(reputation) {
  switch (reputation) {
    case 'ALPHA': return 'ALPHA DEV';
    case 'TRUSTED': return 'TRUSTED DEV';
    case 'NEW': return 'NEW DEV';
    case 'RISKY': return 'RISKY DEV';
    case 'BLACKLISTED': return 'BLACKLISTED';
    default: return 'UNKNOWN';
  }
}

module.exports = {
  getDevRecord,
  registerToken,
  updateTokenOutcome,
  getReputationBoost,
  getReputationEmoji
};