const config = require('../../config');

const userRequests = new Map();

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of userRequests) {
    if (now - data.windowStart > config.RATE_LIMIT_WINDOW_MS * 2) {
      userRequests.delete(userId);
    }
  }
}, 5 * 60 * 1000).unref();

module.exports = (bot) => {
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();

    const now = Date.now();
    let userData = userRequests.get(userId);

    if (!userData || now - userData.windowStart > config.RATE_LIMIT_WINDOW_MS) {
      userData = { count: 0, windowStart: now };
      userRequests.set(userId, userData);
    }

    userData.count++;

    if (userData.count > config.RATE_LIMIT_MAX_REQUESTS) {
      // In groups, silently ignore to avoid spamming the chat with rate limit messages
      if (ctx.chat?.type !== 'private') return;
      return ctx.reply('You are sending too many requests. Please wait a moment.');
    }

    await next();
  });
};
