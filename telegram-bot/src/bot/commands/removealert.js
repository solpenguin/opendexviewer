const alertStore = require('../../alerts/store');

module.exports = (bot) => {
  bot.command('removealert', async (ctx) => {
    const idStr = ctx.match?.trim();
    const id = Number(idStr);

    if (!idStr || !Number.isInteger(id) || id <= 0) {
      return ctx.reply('Usage: /removealert &lt;id&gt;\nUse /alerts to see your alert IDs.', { parse_mode: 'HTML' });
    }

    const userId = ctx.from.id;
    const removed = alertStore.remove(id, userId);

    if (removed) {
      await ctx.reply(`Alert #${id} removed.`);
    } else {
      await ctx.reply(`Alert #${id} not found or does not belong to you.`);
    }
  });
};
