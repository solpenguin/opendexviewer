const alertStore = require('./store');
const notifications = require('./notifications');
const tokensApi = require('../api/tokens');
const config = require('../config');

let pollIntervalId = null;
let pruneIntervalId = null;
let isPolling = false;

// Cancellable timeout — avoids unhandled rejection when the poll finishes first
function timeoutWithCancel(ms) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Poll timeout after ${ms}ms`)), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function checkAlerts(bot) {
  // Prevent overlapping poll cycles
  if (isPolling) return;
  isPolling = true;

  const timeout = timeoutWithCancel(55000);
  try {
    await Promise.race([_doCheckAlerts(bot), timeout.promise]);
  } catch (err) {
    console.error('[Alerts] Poll cycle error:', err.message);
  } finally {
    timeout.cancel();
    isPolling = false;
  }
}

async function _doCheckAlerts(bot) {
  const distinctMints = await alertStore.getDistinctMints();
  if (distinctMints.length === 0) return;

  // Fetch fresh price data for each alerted token individually.
  const tokenData = {};
  const CONCURRENCY = 20;

  for (let i = 0; i < distinctMints.length; i += CONCURRENCY) {
    const chunk = distinctMints.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(async (mint) => {
        const priceData = await tokensApi.getPrice(mint);
        return { mint, data: priceData };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.data) {
        const { mint, data } = result.value;
        tokenData[mint] = data;
      } else if (result.status === 'rejected') {
        console.error('[Alerts] Failed to fetch price:', result.reason?.message);
      }
    }
  }

  // Check each active alert against current market cap
  const alerts = await alertStore.getAllActive();

  for (const alert of alerts) {
    const priceData = tokenData[alert.mint];
    const currentMcap = priceData?.marketCap || priceData?.fdv || 0;
    if (!currentMcap) {
      console.warn(`[Alerts] No market cap data for ${alert.mint}, skipping alert #${alert.id}`);
      continue;
    }

    let triggered = false;

    switch (alert.condition) {
      case 'above':
        triggered = currentMcap >= alert.target_value;
        break;
      case 'below':
        triggered = currentMcap <= alert.target_value;
        break;
      case 'change': {
        if (alert.mcap_at_creation > 0) {
          const pctChange = Math.abs(
            ((currentMcap - alert.mcap_at_creation) / alert.mcap_at_creation) * 100
          );
          triggered = pctChange >= alert.target_value;
        }
        break;
      }
    }

    if (triggered) {
      console.log(`[Alerts] Alert #${alert.id} triggered: ${alert.condition} ${alert.target_value} (current mcap: ${currentMcap})`);
      const sent = await notifications.sendAlertNotification(bot, alert, currentMcap);
      if (sent) {
        await alertStore.trigger(alert.id);
      } else {
        console.warn(`[Alerts] Alert #${alert.id} triggered but notification failed, will retry`);
      }
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

    // Prune old triggered alerts once per hour
    pruneIntervalId = setInterval(() => {
      alertStore.pruneOld().catch(err => console.error('[Alerts] Prune error:', err.message));
    }, 60 * 60 * 1000);
  },

  stop() {
    if (pollIntervalId) {
      clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
    if (pruneIntervalId) {
      clearInterval(pruneIntervalId);
      pruneIntervalId = null;
    }
  }
};
