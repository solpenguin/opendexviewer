const { formatNumber } = require('../utils/format');
const config = require('../config');

// Throttle to stay under Telegram's 30 msg/sec limit
let lastSendTime = 0;
const SEND_INTERVAL_MS = 50; // max 20/sec

async function throttle() {
  const now = Date.now();
  const elapsed = now - lastSendTime;
  if (elapsed < SEND_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, SEND_INTERVAL_MS - elapsed));
  }
  lastSendTime = Date.now();
}

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
      await throttle();
      await bot.api.sendMessage(alert.chat_id, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true }
      });
      return true;
    } catch (error) {
      console.error(`[Alerts] Failed to send notification to chat ${alert.chat_id}:`, error.message);
      // If chat is gone or bot was blocked, deactivate alert permanently
      const permanent = error.description?.includes('blocked') ||
        error.description?.includes('chat not found') ||
        error.description?.includes('deactivated');
      if (permanent) {
        console.warn(`[Alerts] Chat ${alert.chat_id} unreachable, alert will be deactivated`);
        return true; // Allow trigger() to deactivate it
      }
      return false; // Transient error — retry next cycle
    }
  }
};
