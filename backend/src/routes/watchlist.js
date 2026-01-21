const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { asyncHandler, requireDatabase } = require('../middleware/validation');
const { walletLimiter } = require('../middleware/rateLimit');

// All routes in this file require database access
router.use(requireDatabase);

// Validate wallet address format (Solana base58)
const isValidWallet = (address) => {
  return address && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
};

// Validate token mint format
const isValidMint = (mint) => {
  return mint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint);
};

// GET /api/watchlist/:wallet - Get user's watchlist
router.get('/:wallet', asyncHandler(async (req, res) => {
  const { wallet } = req.params;

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const watchlist = await db.getWatchlist(wallet);
  const count = watchlist.length;

  res.json({
    wallet,
    count,
    tokens: watchlist
  });
}));

// POST /api/watchlist - Add token to watchlist
router.post('/', walletLimiter, asyncHandler(async (req, res) => {
  const { wallet, tokenMint } = req.body;

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  if (!isValidMint(tokenMint)) {
    return res.status(400).json({ error: 'Invalid token mint address' });
  }

  // Check watchlist limit (max 100 tokens per wallet)
  const currentCount = await db.getWatchlistCount(wallet);
  if (currentCount >= 100) {
    return res.status(400).json({
      error: 'Watchlist limit reached (max 100 tokens)',
      code: 'WATCHLIST_LIMIT'
    });
  }

  const result = await db.addToWatchlist(wallet, tokenMint);

  res.json({
    success: true,
    message: result.exists ? 'Token already in watchlist' : 'Token added to watchlist',
    alreadyExists: !!result.exists,
    tokenMint,
    wallet
  });
}));

// DELETE /api/watchlist - Remove token from watchlist
router.delete('/', walletLimiter, asyncHandler(async (req, res) => {
  const { wallet, tokenMint } = req.body;

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  if (!isValidMint(tokenMint)) {
    return res.status(400).json({ error: 'Invalid token mint address' });
  }

  const result = await db.removeFromWatchlist(wallet, tokenMint);

  if (!result) {
    return res.status(404).json({
      error: 'Token not found in watchlist',
      tokenMint,
      wallet
    });
  }

  res.json({
    success: true,
    message: 'Token removed from watchlist',
    tokenMint,
    wallet
  });
}));

// POST /api/watchlist/check - Check if token is in watchlist
router.post('/check', asyncHandler(async (req, res) => {
  const { wallet, tokenMint } = req.body;

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  if (!isValidMint(tokenMint)) {
    return res.status(400).json({ error: 'Invalid token mint address' });
  }

  const inWatchlist = await db.isInWatchlist(wallet, tokenMint);

  res.json({
    tokenMint,
    wallet,
    inWatchlist
  });
}));

// POST /api/watchlist/check-batch - Check multiple tokens against watchlist
router.post('/check-batch', asyncHandler(async (req, res) => {
  const { wallet, tokenMints } = req.body;

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  if (!Array.isArray(tokenMints) || tokenMints.length === 0) {
    return res.status(400).json({ error: 'tokenMints must be a non-empty array' });
  }

  // Limit batch size
  if (tokenMints.length > 100) {
    return res.status(400).json({ error: 'Maximum 100 tokens per batch' });
  }

  // Validate all mints
  const validMints = tokenMints.filter(isValidMint);
  if (validMints.length !== tokenMints.length) {
    return res.status(400).json({ error: 'One or more invalid token mint addresses' });
  }

  const watchlistMap = await db.checkWatchlistBatch(wallet, validMints);

  res.json({
    wallet,
    watchlist: watchlistMap
  });
}));

// GET /api/watchlist/:wallet/count - Get watchlist count
router.get('/:wallet/count', asyncHandler(async (req, res) => {
  const { wallet } = req.params;

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const count = await db.getWatchlistCount(wallet);

  res.json({
    wallet,
    count
  });
}));

module.exports = router;
