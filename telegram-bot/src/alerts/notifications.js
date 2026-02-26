const { formatNumber } = require('../utils/format');
const config = require('../config');

module.exports = {
  async sendAlertNotification(bot, alert, currentMcap) {
    const conditionText = alert.condition === 'change'
      ? `changed by ${alert.target_value}%`
      : `went ${alert.condition} ${formatNumber(alert.target_value)}`;

    const text =
      `<b>Market Cap Alert Triggered!</b>\n\n` +
      `<b>${alert.token_name || 'Unknown'}</b> (${alert.token_symbol || '???'})\n` +
      `Market cap ${conditionText}\n\n` +
      `Current market cap: ${formatNumber(currentMcap)}\n` +
      `Market cap when set: ${formatNumber(alert.mcap_at_creation)}\n\n` +
      `<a href="${config.FRONTEND_URL}/token.html?mint=${alert.mint}">View on OpenDEX</a>`;

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
