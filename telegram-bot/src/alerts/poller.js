const alertStore = require('./store');
const notifications = require('./notifications');
const tokensApi = require('../api/tokens');
const config = require('../config');

let pollIntervalId = null;

async function checkAlerts(bot) {
  const distinctMints = alertStore.getDistinctMints();
  if (distinctMints.length === 0) return;

  // Batch fetch token data (up to 50 per request)
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
    console.error('[Alerts] Failed to batch fetch token data:', error.message);
    return;
  }

  // Check each active alert against current market cap
  const alerts = alertStore.getAllActive();

  for (const alert of alerts) {
    const token = tokenData[alert.mint];
    if (!token || !token.marketCap) continue;

    const currentMcap = token.marketCap;
    let triggered = false;

    switch (alert.condition) {
      case 'above':
        triggered = currentMcap >= alert.target_value;
        break;
      case 'below':
        triggered = currentMcap <= alert.target_value;
        break;
      case 'change': {
        const pctChange = Math.abs(
          ((currentMcap - alert.mcap_at_creation) / alert.mcap_at_creation) * 100
        );
        triggered = pctChange >= alert.target_value;
        break;
      }
    }

    if (triggered) {
      alertStore.trigger(alert.id);
      await notifications.sendAlertNotification(bot, alert, currentMcap);
    }
  }
}

module.exports = {
  start(bot) {
    console.log(`[Alerts] Starting market cap polling every ${config.ALERT_POLL_INTERVAL_MS / 1000}s`);
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
