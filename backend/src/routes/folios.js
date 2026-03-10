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

  // Build compact token summary for Claude
  const fmtUsd = (v) => {
    const n = typeof v === 'number' && v > 0 ? v : null;
    return n ? '$' + (n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : n.toFixed(2)) : 'N/A';
  };

  const tokenLines = folio.tokens.map((t, i) => {
    const name = t.name || t.token_mint?.slice(0, 8) || 'Unknown';
    const symbol = t.symbol || '???';
    const price = fmtUsd(t.price);
    const mcap = fmtUsd(t.market_cap);
    const vol = fmtUsd(t.volume_24h);
    const note = t.note ? ` Note: ${t.note.slice(0, 50)}` : '';
    return `${i + 1}. ${name} (${symbol}) — Price: ${price}, MCap: ${mcap}, Vol24h: ${vol}${note}`;
  }).join('\n');

  const prompt = `Analyze this curated Solana token folio (portfolio list) from KOL "${folio.name}" (@${(folio.twitter_handle || '').replace(/^@/, '')}). Provide a concise but insightful analysis covering:
1. Overall portfolio theme/strategy (what types of tokens, any sector focus)
2. Risk profile (concentration, market cap distribution, any red flags)
3. Notable observations (standout tokens, interesting patterns)
4. Brief summary verdict (1 sentence)

Keep the analysis to 4-6 concise paragraphs. Be factual and data-driven. Do not give financial advice.

Folio: "${folio.name}"${folio.description ? ` — ${folio.description}` : ''}
Token count: ${folio.tokens.length}

Tokens:
${tokenLines}`;

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
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
