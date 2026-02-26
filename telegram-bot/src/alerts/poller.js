const alertStore = require('./store');
const notifications = require('./notifications');
const tokensApi = require('../api/tokens');
const config = require('../config');

let pollIntervalId = null;

async function checkAlerts(bot) {
  const distinctMints = alertStore.getDistinctMints();
  if (distinctMints.length === 0) return;

  // Batch fetch prices (up to 50 per request)
  const tokenData = {};
  try {
    for (let i = 0; i < distinctMints.length; i += 50) {
      const chunk = distinctMints.slice(i, i + 50);
      const results = await tokensApi.batchGetTokens(chunk);
      if (Array.isArray(results)) {
        for (const token of results) {
          const addr = token.mintAddress || token.address;
          if (addr) tokenData[addr] = token;
        }
      }
    }
  } catch (error) {
    console.error('[Alerts] Failed to batch fetch prices:', error.message);
    return;
  }

  // Check each active alert
  const alerts = alertStore.getAllActive();

  for (const alert of alerts) {
    const token = tokenData[alert.mint];
    if (!token || !token.price) continue;

    const currentPrice = token.price;
    let triggered = false;

    switch (alert.condition) {
      case 'above':
        triggered = currentPrice >= alert.target_value;
        break;
      case 'below':
        triggered = currentPrice <= alert.target_value;
        break;
      case 'change': {
        const pctChange = Math.abs(
          ((currentPrice - alert.price_at_creation) / alert.price_at_creation) * 100
        );
        triggered = pctChange >= alert.target_value;
        break;
      }
    }

    if (triggered) {
      alertStore.trigger(alert.id);
      await notifications.sendAlertNotification(bot, alert, currentPrice);
    }
  }
}

module.exports = {
  start(bot) {
    console.log(`[Alerts] Starting price polling every ${config.ALERT_POLL_INTERVAL_MS / 1000}s`);
    checkAlerts(bot).catch(err => console.error('[Alerts] Initial poll error:', err.message));
    pollIntervalId = setInterval(() => {
      checkAlerts(bot).catch(err => console.error('[Alerts] Poll error:', err.message));
    }, config.ALERT_POLL_INTERVAL_MS);
  },

  stop() {
    if (pollIntervalId) {
      clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
  }
};
