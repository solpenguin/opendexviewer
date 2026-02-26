const { formatPrice } = require('../utils/format');
const config = require('../config');

module.exports = {
  async sendAlertNotification(bot, alert, currentPrice) {
    const conditionText = alert.condition === 'change'
      ? `changed by ${alert.target_value}%`
      : `went ${alert.condition} ${formatPrice(alert.target_value)}`;

    const text =
      `<b>Price Alert Triggered!</b>\n\n` +
      `<b>${alert.token_name || 'Unknown'}</b> (${alert.token_symbol || '???'})\n` +
      `Price ${conditionText}\n\n` +
      `Current price: ${formatPrice(currentPrice)}\n` +
      `Price when set: ${formatPrice(alert.price_at_creation)}\n\n` +
      `<a href="${config.FRONTEND_URL}/token/${alert.mint}">View on OpenDEX</a>`;

    try {
      await bot.api.sendMessage(alert.chat_id, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true }
      });
    } catch (error) {
      console.error(`[Alerts] Failed to send notification to chat ${alert.chat_id}:`, error.message);
    }
  }
};
