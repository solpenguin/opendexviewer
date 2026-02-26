module.exports = (bot) => {
  bot.catch((err) => {
    const ctx = err.ctx;
    const e = err.error;

    console.error(`[Bot Error] Update ${ctx.update.update_id}:`, e.message || e);

    try {
      ctx.reply('An error occurred. Please try again.').catch(() => {});
    } catch {
      // Cannot reply — chat may be deleted or bot blocked
    }
  });
};
