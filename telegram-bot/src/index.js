require('dotenv').config();
const { Bot, webhookCallback, session } = require('grammy');
const http = require('http');
const config = require('./config');
const alertStore = require('./alerts/store');

// Validate required config
if (!config.BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required. Set it in .env');
  process.exit(1);
}
if (!config.DATABASE_URL) {
  console.error('DATABASE_URL is required. Set it in .env');
  process.exit(1);
}

const bot = new Bot(config.BOT_TOKEN);

// ── Session middleware (stores per-chat conversation state) ───────────
bot.use(session({
  initial: () => ({}),
}));

// ── Register middleware (order matters) ──────────────────────────────
require('./bot/middleware/logger')(bot);
require('./bot/middleware/rateLimiter')(bot);

// ── Register command handlers ────────────────────────────────────────
require('./bot/commands/start')(bot);
require('./bot/commands/help')(bot);
require('./bot/commands/token')(bot);
require('./bot/commands/search')(bot);
require('./bot/commands/alert')(bot);
require('./bot/commands/alerts')(bot);
require('./bot/commands/removealert')(bot);
require('./bot/commands/stats')(bot);
require('./bot/commands/pvp')(bot);
require('./bot/commands/og')(bot);
require('./bot/commands/community')(bot);
require('./bot/commands/cadetect')(bot);
require('./bot/commands/brief')(bot);

// ── Register message handlers (must come AFTER commands) ─────────────
require('./bot/handlers/caDetector')(bot);
require('./bot/handlers/callbackQuery')(bot);
require('./bot/handlers/briefCallbacks')(bot);

// ── Register error handler ───────────────────────────────────────────
require('./bot/middleware/errorHandler')(bot);

// ── Alert polling & brief scheduler ──────────────────────────────────
const poller = require('./alerts/poller');
const briefScheduler = require('./alerts/briefScheduler');

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
    { command: 'og', description: 'Find the oldest PumpFun tokens by name/ticker' },
    { command: 'community', description: 'Community leaderboards & highlights' },
    { command: 'brief', description: 'Daily Brief — graduated PumpFun tokens' },
    { command: 'stats', description: 'Bot statistics' },
    { command: 'help', description: 'Show all commands' },
  ], { scope: { type: 'all_private_chats' } });

  // Group chat commands — subset (no alert management to keep menu clean)
  await bot.api.setMyCommands([
    { command: 'token', description: 'Look up a token by contract address' },
    { command: 'search', description: 'Search tokens by name or symbol' },
    { command: 'pvp', description: 'Find similar tokens (anti-spoofing)' },
    { command: 'og', description: 'Find the oldest PumpFun tokens by name/ticker' },
    { command: 'community', description: 'Community leaderboards & highlights' },
    { command: 'cadetect', description: 'Toggle CA auto-detection in this group' },
    { command: 'help', description: 'Show all commands' },
  ], { scope: { type: 'all_group_chats' } });
}

// ── Bootstrap ────────────────────────────────────────────────────────
async function main() {
  // Initialize database tables
  await alertStore.init();

  if (config.WEBHOOK_URL) {
    // ── Webhook mode (production on Render) ──────────────────────────
    const handleUpdate = webhookCallback(bot, 'http', {
      secretToken: config.WEBHOOK_SECRET || undefined,
    });

    const server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/webhook') {
        try {
          await handleUpdate(req, res);
        } catch (err) {
          console.error('[Webhook] Error handling update:', err.message);
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mode: 'webhook' }));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    server.listen(config.WEBHOOK_PORT, async () => {
      const webhookUrl = `${config.WEBHOOK_URL}/webhook`;
      await bot.api.setWebhook(webhookUrl, {
        secret_token: config.WEBHOOK_SECRET || undefined,
        allowed_updates: ['message', 'callback_query'],
      });

      const botInfo = await bot.api.getMe();
      console.log(`
  OpenDEX Telegram Bot started (webhook mode)
  Bot: @${botInfo.username}
  Webhook: ${webhookUrl}
  Port: ${config.WEBHOOK_PORT}
  API: ${config.API_BASE_URL}
  Alert polling: every ${config.ALERT_POLL_INTERVAL_MS / 1000}s
      `);
      await setCommands(bot).catch(err => console.error('[Bot] Failed to set commands:', err.message));
      poller.start(bot);
      briefScheduler.start(bot);
    });

    // Graceful shutdown for webhook mode
    const shutdown = async (signal) => {
      console.log(`\n${signal} received. Shutting down...`);
      poller.stop();
      briefScheduler.stop();
      server.close();
      await bot.api.deleteWebhook().catch(() => {});
      await alertStore.close();
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } else {
    // ── Long-polling mode (local dev) ────────────────────────────────
    // Delete any stale webhook first
    await bot.api.deleteWebhook().catch(() => {});

    bot.start({
      allowed_updates: ['message', 'callback_query'],
      onStart: async (botInfo) => {
        console.log(`
  OpenDEX Telegram Bot started (polling mode)
  Bot: @${botInfo.username}
  API: ${config.API_BASE_URL}
  Alert polling: every ${config.ALERT_POLL_INTERVAL_MS / 1000}s
        `);
        await setCommands(bot).catch(err => console.error('[Bot] Failed to set commands:', err.message));
        poller.start(bot);
      briefScheduler.start(bot);
      }
    });

    // Graceful shutdown for polling mode
    const shutdown = async (signal) => {
      console.log(`\n${signal} received. Shutting down...`);
      poller.stop();
      briefScheduler.stop();
      await bot.stop();
      await alertStore.close();
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
}

main().catch(err => {
  console.error('[Bot] Fatal startup error:', err);
  process.exit(1);
});

// Catch unhandled errors to prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Bot] Unhandled rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[Bot] Uncaught exception:', error);
  setTimeout(() => process.exit(1), 1000);
});
