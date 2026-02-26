require('dotenv').config();

module.exports = {
  // Telegram
  BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,

  // OpenDex API
  API_BASE_URL: process.env.OPENDEX_API_URL || 'https://opendex-api-dy30.onrender.com',

  // Frontend URL for "View on OpenDEX" links
  FRONTEND_URL: process.env.OPENDEX_FRONTEND_URL || 'https://opendex.online',

  // Alert polling
  ALERT_POLL_INTERVAL_MS: parseInt(process.env.ALERT_POLL_INTERVAL_MS) || 60000,
  MAX_ALERTS_PER_USER: parseInt(process.env.MAX_ALERTS_PER_USER) || 10,

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: 60000,
  RATE_LIMIT_MAX_REQUESTS: 20,

  // Database
  DB_PATH: process.env.DB_PATH || './data/alerts.json',

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info'
};
