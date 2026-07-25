const Groq = require('groq-sdk');
require('dotenv').config();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

async function analyzeToken(tokenData, source) {
  try {
    const prompt = buildPrompt(tokenData, source);

    // ADD TIMEOUT: 5 second max for Groq call
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Groq API timeout after 5s')), 5000)
    );

    const completionPromise = groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 300,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: 'You are a professional crypto analyst specializing in Solana memecoins and early-stage token opportunities. Be direct, concise, and data-driven. No hype. No disclaimers.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const completion = await Promise.race([completionPromise, timeoutPromise]);
    return completion.choices[0]?.message?.content || null;

  } catch (error) {
    // Log timeout but don't block — return null gracefully
    if (error.message.includes('timeout')) {
      console.error('Groq timeout: signal sent without AI analysis');
    } else {
      console.error('AI analysis error:', error.message);
    }
    return null;
  }
}

function buildPrompt(tokenData, source) {
  if (source === 'dexscreener') {
    return `Analyze this Solana token and provide a structured professional assessment:

TOKEN: ${tokenData.name} (${tokenData.symbol})
SIGNAL SCORE: ${tokenData.score}/100
RATING: ${tokenData.rating}

MARKET DATA:
Price: $${tokenData.price}
Price Change 1h: ${tokenData.priceChange}%
Liquidity: $${tokenData.liquidity}
Market Cap: $${tokenData.marketCap}
Volume 1h: $${tokenData.volume}
Buys: ${tokenData.buys} | Sells: ${tokenData.sells}

SECURITY: ${tokenData.securityStatus}
DEV REPUTATION: ${tokenData.devReputation}

Respond in exactly this format:
VERDICT: (BUY / WATCH / AVOID — one line reason)
OPPORTUNITY: (2 sentences max)
RISK: (2 sentences max)
STRATEGY: (1 sentence)`;

  } else {
    return `Analyze this brand new Pump.fun token launch on Solana:

TOKEN: ${tokenData.name} (${tokenData.symbol})
SOURCE: Pump.fun (seconds old)

LAUNCH DATA:
Initial Buy: ${tokenData.solAmount} SOL
Market Cap at Launch: ${tokenData.marketCapSol} SOL
Conviction Level: ${tokenData.conviction}

DEV REPUTATION: ${tokenData.devReputation}
DEV HISTORY: ${tokenData.devStats}

Respond in exactly this format:
VERDICT: (EARLY ENTRY / WATCH / SKIP — one line reason)
OPPORTUNITY: (2 sentences max)
RISK: (2 sentences max)
STRATEGY: (1 sentence)`;
  }
}

module.exports = { analyzeToken };