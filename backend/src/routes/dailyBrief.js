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
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../services/database');
const jobQueue = require('../services/jobQueue');
const { searchLimiter, veryStrictLimiter } = require('../middleware/rateLimit');
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
  const hoursAgo = Math.max(1, Math.min(72, parseInt(hours) || 24));
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

// POST /api/daily-brief/ai-kol
// AI KOL analysis of the tokens currently displayed in the Daily Brief table.
// Frontend sends pre-aggregated token summaries. Costs 100 BC (configurable).
router.post('/ai-kol', veryStrictLimiter, asyncHandler(async (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI analysis not configured' });
  }

  const { tokens, walletAddress, hoursWindow } = req.body;

  if (!Array.isArray(tokens) || tokens.length === 0 || tokens.length > 50) {
    return res.status(400).json({ error: 'tokens must be an array of 1-50 items' });
  }

  // Require wallet for BC payment
  if (!walletAddress || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
    return res.status(400).json({ error: 'Wallet connection required', code: 'WALLET_REQUIRED' });
  }

  // Check balance
  const kolCost = await db.getDailyBriefKolCost();
  const preBalance = await db.getBurnCreditBalance(walletAddress);
  if (preBalance.balance < kolCost) {
    return res.status(402).json({
      error: `Insufficient Burn Credits. KOL analysis costs ${kolCost} BC.`,
      code: 'INSUFFICIENT_BC',
      required: kolCost,
      balance: preBalance.balance
    });
  }

  // Sanitize token data
  const num = (v, min = -1e12, max = 1e12) => typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, v)) : 0;
  const safe = (v, maxLen = 20) => typeof v === 'string' ? v.replace(/[^a-zA-Z0-9 $.\-]/g, '').slice(0, maxLen) : '';
  const fmtUsd = (v) => {
    const n = num(v, 0);
    if (!n) return '$0';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n.toFixed(0);
  };

  // Build compact token table for the prompt
  const tokenLines = tokens.slice(0, 50).map((t, i) => {
    const name = safe(t.name, 16) || '???';
    const symbol = safe(t.symbol, 10) || '???';
    const mcap = fmtUsd(t.marketCap);
    const vol = fmtUsd(t.volume24h);
    const change = num(t.priceChange24h, -10000, 10000);
    const changeStr = (change >= 0 ? '+' : '') + change.toFixed(1) + '%';
    const ratio = num(t.volMcapRatio, 0, 1000);
    return `${i + 1}. ${name} (${symbol}) | MCap:${mcap} Vol:${vol} 24h:${changeStr} V/M:${ratio.toFixed(2)}x`;
  }).join('\n');

  // Aggregate stats for context
  const mcaps = tokens.map(t => num(t.marketCap, 0)).filter(v => v > 0);
  const vols = tokens.map(t => num(t.volume24h, 0)).filter(v => v > 0);
  const changes = tokens.map(t => num(t.priceChange24h, -10000, 10000));
  const gainers = changes.filter(c => c > 0).length;
  const losers = changes.filter(c => c < 0).length;
  const avgMcap = mcaps.length ? mcaps.reduce((a, b) => a + b, 0) / mcaps.length : 0;
  const totalVol = vols.reduce((a, b) => a + b, 0);
  const avgChange = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;

  const hours = parseInt(hoursWindow) || 24;

  const prompt = `You are a crypto KOL (Key Opinion Leader) analyst reviewing newly graduated PumpFun tokens on Solana. These tokens just migrated from PumpFun's bonding curve to PumpSwap (a DEX) within the last ${hours} hours.

Analyze the following ${tokens.length} graduated tokens and provide a brief, opinionated KOL-style market commentary. Be direct, data-driven, and highlight what stands out.

=== AGGREGATE STATS ===
Tokens: ${tokens.length} | Gainers: ${gainers} | Losers: ${losers}
Avg MCap: ${fmtUsd(avgMcap)} | Total Vol: ${fmtUsd(totalVol)} | Avg 24h Change: ${avgChange >= 0 ? '+' : ''}${avgChange.toFixed(1)}%

=== TOKEN TABLE ===
${tokenLines}

=== INSTRUCTIONS ===
Provide your analysis in this exact format:

OVERALL: One sentence summary of the market sentiment for these graduates.

STANDOUTS: Identify 2-3 tokens that stand out (positive or negative) and briefly explain why (high volume, unusual vol/mcap ratio, strong price action, etc).

PATTERNS: Note any patterns you see (e.g., most tokens dumping, high vol/mcap ratios across the board, particular sector trends based on names).

VERDICT: One-sentence actionable takeaway for traders watching PumpFun graduates.

Keep each section to 1-3 sentences. Be concise and direct.`;

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });

    const analysis = response.content[0]?.text || '';

    // Charge BC after successful API call
    const charged = await db.spendBurnCredits(walletAddress, kolCost, 'daily_brief_kol', { tokenCount: tokens.length, hoursWindow: hours });
    if (!charged) {
      return res.status(402).json({ error: 'Insufficient balance', code: 'INSUFFICIENT_BC' });
    }

    res.json({ analysis, tokenCount: tokens.length, cached: false });
  } catch (err) {
    console.error('[Daily Brief KOL] Anthropic API error:', err.message);
    res.status(502).json({ error: 'AI analysis temporarily unavailable' });
  }
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
