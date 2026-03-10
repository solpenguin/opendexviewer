/**
 * Folios Routes
 * Public endpoints for viewing curated KOL token lists.
 * Admin endpoints for creating and managing folios.
 */
const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../services/database');
const jupiterService = require('../services/jupiter');
const geckoService = require('../services/geckoTerminal');
const { asyncHandler, requireDatabase, validateAdminSession, SOLANA_ADDRESS_REGEX } = require('../middleware/validation');
const { searchLimiter, veryStrictLimiter } = require('../middleware/rateLimit');
const { cache, keys, TTL } = require('../services/cache');

const PLACEHOLDER_NAMES = new Set(['unknown token', 'unknown', '']);

/**
 * Enrich tokens that have placeholder names by fetching from Jupiter.
 * Updates DB in the background so future requests are fast.
 */
async function enrichUnknownTokens(tokens) {
  const unknown = tokens.filter(t =>
    !t.name || PLACEHOLDER_NAMES.has(t.name.toLowerCase())
  );
  if (unknown.length === 0) return;

  await Promise.all(unknown.map(async (t) => {
    try {
      const info = await jupiterService.getTokenInfo(t.token_mint);
      if (info?.name && !PLACEHOLDER_NAMES.has(info.name.toLowerCase())) {
        t.name = info.name;
        t.symbol = info.symbol || t.symbol;
        t.logo_uri = info.logoUri || info.logoURI || t.logo_uri;
        // Save to DB for future requests
        db.upsertToken({
          mintAddress: t.token_mint,
          name: info.name,
          symbol: info.symbol,
          decimals: info.decimals,
          logoUri: info.logoUri || info.logoURI
        }).catch(() => {});
      }
    } catch { /* non-critical */ }
  }));
}

// All routes require database
router.use(requireDatabase);

// ==========================================
// Admin Endpoints (must be before /:id to avoid param capture)
// ==========================================

/**
 * GET /api/folios/admin/all
 * List all folios (including inactive) for admin management.
 */
router.get('/admin/all', validateAdminSession, asyncHandler(async (req, res) => {
  const folios = await db.getAllFolios(false);
  res.json({ success: true, data: folios });
}));

/**
 * POST /api/folios/admin
 * Create a new folio.
 */
router.post('/admin', validateAdminSession, asyncHandler(async (req, res) => {
  const { name, description, twitterHandle, twitterAvatar, sortOrder } = req.body;

  if (!name || !twitterHandle) {
    return res.status(400).json({ error: 'Name and Twitter handle are required' });
  }

  if (name.length > 100) return res.status(400).json({ error: 'Name too long (max 100 chars)' });
  if (twitterHandle.length > 50) return res.status(400).json({ error: 'Twitter handle too long' });

  const folio = await db.createFolio({ name, description, twitterHandle, twitterAvatar, sortOrder });
  await cache.delete('folios:list');
  res.json({ success: true, data: folio });
}));

/**
 * PATCH /api/folios/admin/:id
 * Update a folio's metadata.
 */
router.patch('/admin/:id', validateAdminSession, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid folio ID' });

  const { name, description, twitterHandle, twitterAvatar, isActive, sortOrder } = req.body;
  const folio = await db.updateFolio(id, { name, description, twitterHandle, twitterAvatar, isActive, sortOrder });
  if (!folio) return res.status(404).json({ error: 'Folio not found' });

  await cache.delete('folios:list');
  await cache.delete(`folios:detail:${id}`);
  res.json({ success: true, data: folio });
}));

/**
 * DELETE /api/folios/admin/:id
 * Delete a folio and all its tokens.
 */
router.delete('/admin/:id', validateAdminSession, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid folio ID' });

  const deleted = await db.deleteFolio(id);
  if (!deleted) return res.status(404).json({ error: 'Folio not found' });

  await cache.delete('folios:list');
  await cache.delete(`folios:detail:${id}`);
  res.json({ success: true });
}));

/**
 * POST /api/folios/admin/:id/tokens
 * Add a token to a folio.
 */
router.post('/admin/:id/tokens', validateAdminSession, asyncHandler(async (req, res) => {
  const folioId = parseInt(req.params.id, 10);
  if (isNaN(folioId)) return res.status(400).json({ error: 'Invalid folio ID' });

  const { tokenMint, note } = req.body;
  if (!tokenMint || !SOLANA_ADDRESS_REGEX.test(tokenMint)) {
    return res.status(400).json({ error: 'Valid token mint address is required' });
  }

  const folio = await db.getFolio(folioId);
  if (!folio) return res.status(404).json({ error: 'Folio not found' });

  const item = await db.addFolioToken(folioId, tokenMint, note);
  await cache.delete(`folios:detail:${folioId}`);
  await cache.delete('folios:list');
  res.json({ success: true, data: item });
}));

/**
 * DELETE /api/folios/admin/:id/tokens/:mint
 * Remove a token from a folio.
 */
router.delete('/admin/:id/tokens/:mint', validateAdminSession, asyncHandler(async (req, res) => {
  const folioId = parseInt(req.params.id, 10);
  if (isNaN(folioId)) return res.status(400).json({ error: 'Invalid folio ID' });

  const { mint } = req.params;
  if (!SOLANA_ADDRESS_REGEX.test(mint)) {
    return res.status(400).json({ error: 'Invalid token mint address' });
  }

  const removed = await db.removeFolioToken(folioId, mint);
  if (!removed) return res.status(404).json({ error: 'Token not found in folio' });

  await cache.delete(`folios:detail:${folioId}`);
  await cache.delete('folios:list');
  res.json({ success: true });
}));

// ==========================================
// Public Endpoints
// ==========================================

/**
 * GET /api/folios
 * List all active folios with token counts.
 */
router.get('/', searchLimiter, asyncHandler(async (req, res) => {
  const cacheKey = 'folios:list';
  const cached = await cache.get(cacheKey);
  if (cached) return res.json(cached);

  const folios = await db.getAllFolios(true);
  const response = { success: true, data: folios };
  await cache.set(cacheKey, response, TTL.MEDIUM);
  res.json(response);
}));

/**
 * GET /api/folios/:id
 * Get a single folio with its token list and market data.
 */
router.get('/:id', searchLimiter, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid folio ID' });

  const cacheKey = `folios:detail:${id}`;
  const cached = await cache.get(cacheKey);
  if (cached) return res.json(cached);

  const folio = await db.getFolioWithTokens(id);
  if (!folio) return res.status(404).json({ error: 'Folio not found' });
  if (!folio.is_active) return res.status(404).json({ error: 'Folio not found' });

  // Enrich any tokens with placeholder names before returning
  if (folio.tokens?.length > 0) {
    await enrichUnknownTokens(folio.tokens);

    // Fetch live market data from GeckoTerminal (reliable 24h change) + Jupiter (prices)
    const mints = folio.tokens.map(t => t.token_mint).filter(Boolean);
    if (mints.length > 0) {
      try {
        const [geckoData, batchPrices] = await Promise.all([
          geckoService.getMultiTokenInfo(mints).catch(() => ({})),
          jupiterService.getTokenPrices(mints).catch(() => ({}))
        ]);
        folio.tokens.forEach(t => {
          const g = geckoData[t.token_mint] || {};
          const bp = batchPrices[t.token_mint] || {};
          if (g.price || bp.price) t.price = g.price || bp.price;
          if (g.marketCap) t.market_cap = g.marketCap;
          if (g.volume24h) t.volume_24h = g.volume24h;
          if (g.priceChange24h != null) t.price_change_24h = g.priceChange24h;
        });
      } catch { /* non-critical */ }
    }
  }

  const response = { success: true, data: folio };
  await cache.set(cacheKey, response, TTL.MEDIUM);
  res.json(response);
}));

/**
 * POST /api/folios/:id/ai-analysis
 * AI analysis of a folio's tokens. Costs 50 BC (configurable).
 * Cached for 3 hours per folio ID. Requires wallet for BC payment.
 */
router.post('/:id/ai-analysis', veryStrictLimiter, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid folio ID' });

  const cacheKey = `ai-folio:${id}`;

  // Return cached result if available (free — no BC charge)
  const cached = await cache.get(cacheKey);
  if (cached) return res.json(cached);

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI analysis not configured' });
  }

  // Require wallet address for BC payment
  const walletAddress = req.body.walletAddress;
  if (!walletAddress || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
    return res.status(400).json({ error: 'Wallet connection required to use AI analysis', code: 'WALLET_REQUIRED' });
  }

  // Load the folio with token data
  const folio = await db.getFolioWithTokens(id);
  if (!folio || !folio.is_active) {
    return res.status(404).json({ error: 'Folio not found' });
  }

  if (!folio.tokens || folio.tokens.length === 0) {
    return res.status(400).json({ error: 'This folio has no tokens to analyze' });
  }

  // Enrich unknown tokens first
  await enrichUnknownTokens(folio.tokens);

  // Charge Burn Credits
  const cost = await db.getFolioAIAnalysisCost();
  const charged = await db.spendBurnCredits(walletAddress, cost, 'folio_ai_analysis', { folioId: id });
  if (!charged) {
    const balance = await db.getBurnCreditBalance(walletAddress);
    return res.status(402).json({
      error: `Insufficient Burn Credits. Folio analysis costs ${cost} BC.`,
      code: 'INSUFFICIENT_BC',
      required: cost,
      balance: balance.balance
    });
  }

  // Fetch live metrics from GeckoTerminal (24h change, price, mcap, vol) + Jupiter V2 (holders, liquidity)
  const mints = folio.tokens.map(t => t.token_mint).filter(Boolean);
  const [geckoData, tokenMetrics] = await Promise.all([
    geckoService.getMultiTokenInfo(mints).catch(() => ({})),
    Promise.all(folio.tokens.map(async (t) => {
      try { return await jupiterService.getTokenMetrics(t.token_mint); }
      catch { return null; }
    }))
  ]);

  // Formatting helpers
  const fmtUsd = (v) => {
    const n = typeof v === 'number' && v > 0 ? v : null;
    return n ? '$' + (n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : n.toFixed(2)) : 'N/A';
  };
  const fmtNum = (v) => {
    if (v == null || v <= 0) return 'N/A';
    return v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(1)+'K' : String(v);
  };
  const fmtPct = (v) => {
    if (v == null || typeof v !== 'number') return 'N/A';
    return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  };
  const fmtAge = (v) => {
    if (!v) return 'N/A';
    const ms = Date.now() - new Date(v).getTime();
    if (ms < 0 || isNaN(ms)) return 'N/A';
    const d = Math.floor(ms / 86400000);
    if (d >= 365) return Math.floor(d / 365) + 'y ' + (d % 365 >= 30 ? Math.floor((d % 365) / 30) + 'mo' : '');
    if (d >= 30) return Math.floor(d / 30) + 'mo ' + (d % 30) + 'd';
    if (d >= 1) return d + 'd';
    return Math.floor(ms / 3600000) + 'h';
  };

  const tokenLines = folio.tokens.map((t, i) => {
    const mint = t.token_mint || '';
    const g = geckoData[mint] || {};
    const m = tokenMetrics[i] || {};
    const name = t.name || mint.slice(0, 8) || 'Unknown';
    const symbol = t.symbol || '???';
    // GeckoTerminal for price/mcap/vol/change, Jupiter V2 for holders/liquidity, DB as fallback
    const price = fmtUsd(g.price || m.price || (t.price ? parseFloat(t.price) : null));
    const mcap = fmtUsd(g.marketCap || m.marketCap || (t.market_cap ? parseFloat(t.market_cap) : null));
    const vol = fmtUsd(g.volume24h || m.volume24h || (t.volume_24h ? parseFloat(t.volume_24h) : null));
    const change24h = fmtPct(g.priceChange24h ?? (t.price_change_24h != null ? parseFloat(t.price_change_24h) : null));
    const liq = fmtUsd(m.liquidity);
    const holders = fmtNum(m.holderCount);
    const age = fmtAge(t.pair_created_at);
    const note = t.note ? ` | Note: ${t.note.slice(0, 50)}` : '';
    return `${i + 1}. ${name} (${symbol}) — Price: ${price} (24h: ${change24h}), MCap: ${mcap}, Vol24h: ${vol}, Liq: ${liq}, Holders: ${holders}, Age: ${age}${note}`;
  }).join('\n');

  const prompt = `You are analyzing a curated Solana token folio from KOL "${folio.name}" (@${(folio.twitter_handle || '').replace(/^@/, '')}).

Provide a balanced, insightful analysis covering:
1. Portfolio theme/strategy — what types of tokens are included, any sector focus or diversification approach
2. Market snapshot — summarize the price action, market cap range, volume levels, and liquidity across the portfolio
3. Holder conviction — for Solana memecoins and micro/small-caps, holder counts in the thousands are normal and healthy. Evaluate holder counts relative to each token's age and market cap. Growing holder bases relative to token age indicate strong community adoption. Do NOT treat typical Solana holder counts as concerning.
4. Standout picks — highlight the most interesting tokens and why they stand out
5. One-sentence summary verdict

IMPORTANT GUIDELINES:
- Be balanced and objective. Highlight both strengths and areas to watch.
- Solana tokens naturally have different metrics than Ethereum tokens. Do not apply Ethereum-scale expectations.
- "N/A" for a metric means data is unavailable — do not treat missing data as a red flag or negative signal. Simply note it is unavailable if relevant.
- Keep the tone informative and constructive, not alarmist.
- 4-6 concise paragraphs. No financial advice.

Folio: "${folio.name}"${folio.description ? ` — ${folio.description}` : ''}
Token count: ${folio.tokens.length}

Tokens:
${tokenLines}`;

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }]
    });

    const analysis = (response.content[0]?.text || '').trim();
    const result = { analysis, cached: false, folioId: id, folioName: folio.name, tokenCount: folio.tokens.length };

    // Cache for 3 hours
    await cache.set(cacheKey, { ...result, cached: true }, 3 * TTL.HOUR);

    res.json(result);
  } catch (err) {
    console.error('[Folio AI Analysis] Anthropic API error:', err.message);
    res.status(502).json({ error: 'AI analysis temporarily unavailable' });
  }
}));

module.exports = router;
