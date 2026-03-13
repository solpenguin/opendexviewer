const alertStore = require('../../alerts/store');

const startTime = Date.now();

module.exports = (bot) => {
  bot.command('stats', async (ctx) => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;

    const totalAlerts = await alertStore.countAll();
    const activeAlerts = await alertStore.countActive();

    await ctx.reply(
      `<b>OpenDEX Bot Stats</b>\n\n` +
      `Uptime: ${hours}h ${minutes}m ${seconds}s\n` +
      `Active alerts: ${activeAlerts}\n` +
      `Total alerts created: ${totalAlerts}\n` +
      `Node.js: ${process.version}`,
      { parse_mode: 'HTML' }
    );
  });
};
