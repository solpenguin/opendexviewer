/**
 * Daily Brief — Shows tokens that recently graduated to PumpSwap.
 *
 * Discovery is handled by the background worker (src/worker.js) which polls
 * GeckoTerminal /new_pools filtered to PumpSwap DEX every 3 minutes.
 * Each new PumpSwap pool = a token that just graduated from PumpFun.
 *
 * This route is a thin read layer — it reads from the daily_brief_tokens
 * table in PostgreSQL (written by the worker) and serves it to the frontend.
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const jobQueue = require('../services/jobQueue');
const { searchLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/validation');

function computeAggregateStats(tokens) {
  if (tokens.length === 0) {
    return {
      count: 0, avgMcap: 0, medianMcap: 0, totalVolume: 0,
      avgGradVelocity: null, medianGradVelocity: null,
      avgHolders: 0, avgVolMcapRatio: 0, avgLiqMcapRatio: 0,
      gainersCount: 0, losersCount: 0, avgPriceChange: 0
    };
  }

  const mcaps = tokens.map(t => t.marketCap || 0).filter(v => v > 0).sort((a, b) => a - b);
  const velocities = tokens.map(t => t.gradVelocityHours).filter(v => v != null && v > 0).sort((a, b) => a - b);
  const holders = tokens.map(t => t.holders || 0).filter(v => v > 0);
  const volRatios = tokens.map(t => t.volMcapRatio || 0).filter(v => v > 0).sort((a, b) => a - b);
  const liqRatios = tokens.map(t => t.liqMcapRatio || 0).filter(v => v > 0);
  // Only include tokens with actual price change data (non-zero = has data)
  const changes = tokens.map(t => t.priceChange24h || 0).filter(c => c !== 0);

  function median(arr) {
    if (arr.length === 0) return 0;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 !== 0 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }
  function avg(arr) {
    return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  }

  return {
    count: tokens.length,
    avgMcap: avg(mcaps),
    medianMcap: median(mcaps),
    totalVolume: tokens.reduce((s, t) => s + (t.volume24h || 0), 0),
    avgGradVelocity: velocities.length > 0 ? avg(velocities) : null,
    medianGradVelocity: velocities.length > 0 ? median(velocities) : null,
    avgHolders: avg(holders),
    avgVolMcapRatio: avg(volRatios),
    topVolMcapRatio: volRatios.length > 0 ? volRatios[volRatios.length - 1] : 0,
    avgLiqMcapRatio: avg(liqRatios),
    gainersCount: changes.filter(c => c > 0).length,
    losersCount: changes.filter(c => c < 0).length,
    avgPriceChange: avg(changes)
  };
}

// GET /api/daily-brief
router.get('/', searchLimiter, asyncHandler(async (req, res) => {
  const { hours = 24, limit = 50 } = req.query;
  const hoursAgo = Math.max(1, Math.min(24, parseInt(hours) || 24));
  const resultLimit = Math.max(1, Math.min(100, parseInt(limit) || 50));

  // Read from database (written by worker)
  const [tokens, totalGraduated, dbStats] = await Promise.all([
    db.getDailyBriefTokens(hoursAgo, resultLimit),
    db.getDailyBriefCount(hoursAgo),
    db.getDailyBriefStats()
  ]);

  const stats = computeAggregateStats(tokens);

  res.json({
    tokens,
    totalGraduated,
    hoursAgo,
    updatedAt: dbStats.lastRefresh || 0,
    stats
  });
}));

// ── Admin helpers (used by admin route) ──────────────────────────────

async function clearStore() {
  const result = await jobQueue.triggerDailyBriefClear();
  return { cleared: result };
}

async function getStoreStats() {
  const stats = await db.getDailyBriefStats();
  return {
    storeSize: stats.storeSize,
    lastRefresh: stats.lastRefresh,
    storeReady: stats.storeSize > 0,
    refreshInFlight: false
  };
}

module.exports = router;
module.exports.clearStore = clearStore;
module.exports.getStoreStats = getStoreStats;
