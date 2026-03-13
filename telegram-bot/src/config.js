require('dotenv').config();

module.exports = {
  // Telegram
  BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,

  // Webhook mode (set WEBHOOK_URL to enable; leave empty for long-polling)
  WEBHOOK_URL: process.env.WEBHOOK_URL || '',
  WEBHOOK_PORT: (() => { const v = parseInt(process.env.WEBHOOK_PORT || process.env.PORT); return isNaN(v) ? 3000 : v; })(),
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',

  // OpenDex API
  API_BASE_URL: process.env.OPENDEX_API_URL || 'https://opendex-api-dy30.onrender.com',

  // Frontend URL for "View on OpenDEX" links
  FRONTEND_URL: process.env.OPENDEX_FRONTEND_URL || 'https://opendex.online',

  // Alert polling
  ALERT_POLL_INTERVAL_MS: (() => { const v = parseInt(process.env.ALERT_POLL_INTERVAL_MS); return isNaN(v) ? 60000 : v; })(),
  MAX_ALERTS_PER_USER: (() => { const v = parseInt(process.env.MAX_ALERTS_PER_USER); return isNaN(v) ? 10 : v; })(),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: 60000,
  RATE_LIMIT_MAX_REQUESTS: 20,

  // PostgreSQL
  DATABASE_URL: process.env.DATABASE_URL,
  DB_SSL_REJECT_UNAUTHORIZED: process.env.DB_SSL_REJECT_UNAUTHORIZED || 'true',

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info'
};
