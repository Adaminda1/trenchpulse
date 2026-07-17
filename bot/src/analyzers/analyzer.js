async function analyzeToken(token) {
  try {
    const score = calculateScore(token);

    return {
      address: token.tokenAddress,
      score,
      verdict: score >= 7 ? '🟢 Strong' : score >= 4 ? '🟡 Moderate' : '🔴 Weak',
      summary: `Token scored ${score}/10 based on available data`
    };
  } catch (error) {
    console.error('❌ Analyzer error:', error.message);
    return null;
  }
}

function calculateScore(token) {
  let score = 0;
  if (token.tokenAddress) score += 2;
  if (token.description) score += 2;
  if (token.url) score += 2;
  if (token.chainId === 'solana') score += 4;
  return Math.min(score, 10);
}

module.exports = { analyzeToken };