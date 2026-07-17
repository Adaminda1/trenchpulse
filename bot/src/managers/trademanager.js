const axios = require('axios');
require('dotenv').config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramAlert(message) {
  try {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      console.error('Missing Telegram credentials');
      return;
    }

    const cleanMessage = message
      .replace(/[^\w\s\n:.\/]/g, '')
      .trim();

    await axios.post(
      'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage',
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: cleanMessage
      }
    );

    console.log('Telegram alert sent successfully');
  } catch (error) {
    if (error.response) {
      console.error('Telegram error details:', JSON.stringify(error.response.data));
    } else {
      console.error('Telegram error:', error.message);
    }
  }
}

module.exports = { sendTelegramAlert };