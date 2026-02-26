module.exports = (bot) => {
  bot.use(async (ctx, next) => {
    const start = Date.now();
    const userId = ctx.from?.id || 'unknown';
    const text = ctx.message?.text?.slice(0, 50) || 'callback';

    await next();

    const ms = Date.now() - start;
    console.log(`[Bot] user=${userId} text="${text}" ${ms}ms`);
  });
};
