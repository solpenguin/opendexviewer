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
require('./bot/commands/pvp')(bot);

// Register message handlers (must come AFTER commands)
require('./bot/handlers/caDetector')(bot);
require('./bot/handlers/callbackQuery')(bot);

// Register error handler
require('./bot/middleware/errorHandler')(bot);

// Start alert polling
const poller = require('./alerts/poller');

// Register command menus with Telegram (shown when users type "/")
async function setCommands(bot) {
  // Private chat commands — full list including alerts
  await bot.api.setMyCommands([
    { command: 'token', description: 'Look up a token by contract address' },
    { command: 'search', description: 'Search tokens by name or symbol' },
    { command: 'pvp', description: 'Find similar tokens (anti-spoofing)' },
    { command: 'alert', description: 'Set a market cap alert' },
    { command: 'alerts', description: 'List your active alerts' },
    { command: 'removealert', description: 'Remove an alert' },
    { command: 'stats', description: 'Bot statistics' },
    { command: 'help', description: 'Show all commands' },
  ], { scope: { type: 'all_private_chats' } });

  // Group chat commands — subset (no alert management to keep menu clean)
  await bot.api.setMyCommands([
    { command: 'token', description: 'Look up a token by contract address' },
    { command: 'search', description: 'Search tokens by name or symbol' },
    { command: 'pvp', description: 'Find similar tokens (anti-spoofing)' },
    { command: 'help', description: 'Show all commands' },
  ], { scope: { type: 'all_group_chats' } });
}

// Start bot
bot.start({
  onStart: async (botInfo) => {
    console.log(`
  OpenDEX Telegram Bot started
  Bot: @${botInfo.username}
  API: ${config.API_BASE_URL}
  Alert polling: every ${config.ALERT_POLL_INTERVAL_MS / 1000}s
    `);
    await setCommands(bot).catch(err => console.error('[Bot] Failed to set commands:', err.message));
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

// Catch unhandled errors to prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Bot] Unhandled rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[Bot] Uncaught exception:', error);
  // Give time to log, then exit (let process manager restart)
  setTimeout(() => process.exit(1), 1000);
});
