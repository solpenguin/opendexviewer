const store = require('./store');
const tokensApi = require('../api/tokens');
const { applyFilters, formatBriefMessage } = require('../bot/commands/brief');
const config = require('../config');

let intervalId = null;
const POLL_MS = 60 * 1000; // Check for due subs every 60 seconds

// Throttle sends to stay under Telegram rate limits
let lastSendTime = 0;
const SEND_INTERVAL_MS = 100; // max 10/sec (conservative)

async function throttle() {
  const now = Date.now();
  const elapsed = now - lastSendTime;
  if (elapsed < SEND_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, SEND_INTERVAL_MS - elapsed));
  }
  lastSendTime = Date.now();
}

// Cache brief data per (hours) to avoid re-fetching for each subscriber
const briefCache = new Map();
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

async function getCachedBrief(hours) {
  const key = String(hours);
  const now = Date.now();
  const cached = briefCache.get(key);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  // Prune expired entries to prevent unbounded growth
  for (const [k, v] of briefCache) {
    if (now - v.fetchedAt >= CACHE_TTL_MS) briefCache.delete(k);
  }
  const data = await tokensApi.getDailyBrief({ hours, limit: 100 });
  briefCache.set(key, { data, fetchedAt: now });
  return data;
}

async function processDueSubs(bot) {
  let subs;
  try {
    subs = await store.getDueBriefSubs();
  } catch (err) {
    console.error('[BriefScheduler] Failed to fetch due subs:', err.message);
    return;
  }

  if (subs.length === 0) return;

  console.log(`[BriefScheduler] Processing ${subs.length} due subscription(s)`);

  for (const sub of subs) {
    try {
      const data = await getCachedBrief(sub.hours_window);
      const filtered = applyFilters(data.tokens || [], sub.filter_mcap, sub.filter_vol, sub.filter_ratio);
      const { text, keyboard } = formatBriefMessage(filtered, sub.hours_window, sub.filter_mcap, sub.filter_vol, sub.filter_ratio);

      await throttle();
      await bot.api.sendMessage(sub.chat_id, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });

      await store.markBriefSent(sub.id);
    } catch (err) {
      console.error(`[BriefScheduler] Failed to send brief to chat ${sub.chat_id}:`, err.message);

      // If chat is gone or bot was blocked, deactivate subscription
      const permanent = err.description?.includes('blocked') ||
        err.description?.includes('chat not found') ||
        err.description?.includes('deactivated');
      if (permanent) {
        console.warn(`[BriefScheduler] Chat ${sub.chat_id} unreachable, removing subscription`);
        await store.removeBriefSub(sub.chat_id).catch(() => {});
      }
    }
  }
}

module.exports = {
  start(bot) {
    console.log('[BriefScheduler] Starting subscription scheduler (checking every 60s)');
    // Run once on start after a short delay (give DB time to warm up)
    setTimeout(() => {
      processDueSubs(bot).catch(err => console.error('[BriefScheduler] Initial run error:', err.message));
    }, 10000);

    intervalId = setInterval(() => {
      processDueSubs(bot).catch(err => console.error('[BriefScheduler] Poll error:', err.message));
    }, POLL_MS);
  },

  stop() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    briefCache.clear();
  }
};
