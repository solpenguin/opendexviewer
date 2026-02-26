const alertStore = require('../../alerts/store');
const { formatPrice } = require('../../utils/format');

module.exports = (bot) => {
  bot.command('alerts', async (ctx) => {
    const userId = ctx.from.id;
    const alerts = alertStore.listByUser(userId);

    if (alerts.length === 0) {
      return ctx.reply('You have no active alerts. Create one with /alert.');
    }

    let text = '<b>Your Active Alerts</b>\n\n';

    for (const alert of alerts) {
      let conditionText;
      if (alert.condition === 'above') {
        conditionText = `above ${formatPrice(alert.target_value)}`;
      } else if (alert.condition === 'below') {
        conditionText = `below ${formatPrice(alert.target_value)}`;
      } else {
        conditionText = `change ${alert.target_value}%`;
      }

      text += `#${alert.id} | <b>${alert.token_symbol || '???'}</b> | ${conditionText}\n`;
      text += `  Set at: ${formatPrice(alert.price_at_creation)}\n\n`;
    }

    text += `Use /removealert &lt;id&gt; to remove an alert.`;

    await ctx.reply(text, { parse_mode: 'HTML' });
  });
};
