/**
 * Folios Routes
 * Public endpoints for viewing curated KOL token lists.
 * Admin endpoints for creating and managing folios.
 */
const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { asyncHandler, requireDatabase, validateAdminSession, SOLANA_ADDRESS_REGEX } = require('../middleware/validation');
const { searchLimiter } = require('../middleware/rateLimit');
const { cache, keys, TTL } = require('../services/cache');

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

  const response = { success: true, data: folio };
  await cache.set(cacheKey, response, TTL.MEDIUM);
  res.json(response);
}));

module.exports = router;
