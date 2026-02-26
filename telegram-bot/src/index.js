require('dotenv').config();
const { Bot } = require('grammy');
const config = require('./config');

// Validate required config
if (!config.BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required. Set it in .env');
  process.exit(1);
}

const bot = new Bot(config.BOT_TOKEN);

// Register middleware (order matters)
require('./bot/middleware/logger')(bot);
require('./bot/middleware/rateLimiter')(bot);

// Register command handlers
require('./bot/commands/start')(bot);
require('./bot/commands/help')(bot);
require('./bot/commands/token')(bot);
require('./bot/commands/search')(bot);
require('./bot/commands/alert')(bot);
require('./bot/commands/alerts')(bot);
require('./bot/commands/removealert')(bot);
require('./bot/commands/stats')(bot);

// Register message handlers (must come AFTER commands)
require('./bot/handlers/caDetector')(bot);
require('./bot/handlers/callbackQuery')(bot);

// Register error handler
require('./bot/middleware/errorHandler')(bot);

// Start alert polling
const poller = require('./alerts/poller');

// Start bot
bot.start({
  onStart: (botInfo) => {
    console.log(`
  OpenDEX Telegram Bot started
  Bot: @${botInfo.username}
  API: ${config.API_BASE_URL}
  Alert polling: every ${config.ALERT_POLL_INTERVAL_MS / 1000}s
    `);
    poller.start(bot);
  }
});

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`\n${signal} received. Shutting down...`);
  poller.stop();
  await bot.stop();
  const alertStore = require('./alerts/store');
  alertStore.close();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
