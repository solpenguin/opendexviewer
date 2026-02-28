const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { asyncHandler, requireDatabase, validateMint, validateCallSignature, SOLANA_ADDRESS_REGEX } = require('../middleware/validation');
const { defaultLimiter, walletLimiter } = require('../middleware/rateLimit');

router.use(requireDatabase);

// GET /api/calls/cooldown/:wallet
// Check cooldown status for a wallet
router.get('/cooldown/:wallet', defaultLimiter, asyncHandler(async (req, res) => {
  const { wallet } = req.params;
  if (!SOLANA_ADDRESS_REGEX.test(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }
  const cooldown = await db.getCallCooldown(wallet);
  res.json({ cooldown });
}));

// POST /api/calls/:mint
// Call (endorse) a token — one per wallet per 24h
// Body: { callerWallet }
router.post('/:mint', walletLimiter, validateMint, validateCallSignature, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const { callerWallet } = req.body;

  if (!callerWallet) {
    return res.status(400).json({ error: 'callerWallet required' });
  }
  if (!SOLANA_ADDRESS_REGEX.test(callerWallet)) {
    return res.status(400).json({ error: 'Invalid wallet address format' });
  }

  const result = await db.callToken(mint, callerWallet);

  if (!result.success) {
    return res.status(429).json({
      error: 'You can only call one token per 24 hours',
      existingMint: result.existingMint,
      cooldownEndsAt: result.cooldownEndsAt
    });
  }

  res.json({ success: true, message: 'Token called successfully', mcapAtCall: result.mcapAtCall ?? null });
}));

// GET /api/calls/wallet/:wallet
// Get a wallet's full call history with current token data
router.get('/wallet/:wallet', defaultLimiter, asyncHandler(async (req, res) => {
  const { wallet } = req.params;
  if (!SOLANA_ADDRESS_REGEX.test(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 50), 100);
  const offset = Math.max(0, parseInt(req.query.offset) || 0);

  const { calls: rows, total } = await db.getCallsByWallet(wallet, limit, offset);

  const calls = rows.map(r => ({
    id: r.id,
    tokenMint: r.token_mint,
    name: r.name || `${r.token_mint.slice(0, 4)}...${r.token_mint.slice(-4)}`,
    symbol: r.symbol || '???',
    logoUri: r.logo_uri || null,
    mcapAtCall: r.mcap_at_call ? parseFloat(r.mcap_at_call) : null,
    currentMcap: r.market_cap ? parseFloat(r.market_cap) : null,
    currentPrice: r.price ? parseFloat(r.price) : null,
    volume24h: r.volume_24h ? parseFloat(r.volume_24h) : null,
    calledAt: r.created_at
  }));

  res.json({ calls, total });
}));

module.exports = router;
