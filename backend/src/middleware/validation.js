/**
 * Input validation middleware
 */

// Validate Solana address format (base58, 32-44 characters)
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Validate URL format
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Sanitize string input
function sanitizeString(str, maxLength = 255) {
  if (typeof str !== 'string') return '';
  return str
    .trim()
    .slice(0, maxLength)
    .replace(/[<>]/g, ''); // Basic XSS prevention
}

// Validate mint address parameter
function validateMint(req, res, next) {
  const mint = req.params.mint || req.body.tokenMint;

  if (!mint) {
    return res.status(400).json({ error: 'Mint address is required' });
  }

  if (!SOLANA_ADDRESS_REGEX.test(mint)) {
    return res.status(400).json({ error: 'Invalid Solana address format' });
  }

  next();
}

// Validate wallet address
function validateWallet(req, res, next) {
  const wallet = req.body.voterWallet || req.body.submitterWallet || req.query.wallet;

  if (wallet && !SOLANA_ADDRESS_REGEX.test(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address format' });
  }

  next();
}

// Validate submission input
function validateSubmission(req, res, next) {
  const { tokenMint, submissionType, contentUrl } = req.body;
  const validTypes = ['banner', 'twitter', 'telegram', 'discord', 'website'];

  // Required fields
  if (!tokenMint || !submissionType || !contentUrl) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['tokenMint', 'submissionType', 'contentUrl']
    });
  }

  // Validate mint
  if (!SOLANA_ADDRESS_REGEX.test(tokenMint)) {
    return res.status(400).json({ error: 'Invalid token mint address' });
  }

  // Validate type
  if (!validTypes.includes(submissionType)) {
    return res.status(400).json({
      error: 'Invalid submission type',
      validTypes
    });
  }

  // Validate URL
  if (!isValidUrl(contentUrl)) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  // Additional URL validation based on type
  const urlLower = contentUrl.toLowerCase();

  if (submissionType === 'twitter' && !urlLower.includes('twitter.com') && !urlLower.includes('x.com')) {
    return res.status(400).json({ error: 'URL must be a Twitter/X link' });
  }

  if (submissionType === 'telegram' && !urlLower.includes('t.me')) {
    return res.status(400).json({ error: 'URL must be a Telegram link' });
  }

  if (submissionType === 'discord' && !urlLower.includes('discord')) {
    return res.status(400).json({ error: 'URL must be a Discord link' });
  }

  // For banners, check for image extensions or known image hosts
  if (submissionType === 'banner') {
    const isImageUrl = /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(contentUrl) ||
      urlLower.includes('imgur.com') ||
      urlLower.includes('cloudinary.com') ||
      urlLower.includes('ipfs.io') ||
      urlLower.includes('arweave.net');

    if (!isImageUrl) {
      return res.status(400).json({
        error: 'Banner URL must be a direct image link (PNG, JPG, GIF, WebP)'
      });
    }
  }

  next();
}

// Validate vote input
function validateVote(req, res, next) {
  const { submissionId, voterWallet, voteType } = req.body;

  if (!submissionId || !voterWallet || !voteType) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['submissionId', 'voterWallet', 'voteType']
    });
  }

  if (typeof submissionId !== 'number' && isNaN(parseInt(submissionId))) {
    return res.status(400).json({ error: 'Invalid submission ID' });
  }

  if (!SOLANA_ADDRESS_REGEX.test(voterWallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  if (!['up', 'down'].includes(voteType)) {
    return res.status(400).json({ error: 'Vote type must be "up" or "down"' });
  }

  next();
}

// Validate pagination parameters
function validatePagination(req, res, next) {
  const { limit, offset, page } = req.query;

  if (limit) {
    const limitNum = parseInt(limit);
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      return res.status(400).json({ error: 'Limit must be between 1 and 100' });
    }
    req.query.limit = limitNum;
  }

  if (offset) {
    const offsetNum = parseInt(offset);
    if (isNaN(offsetNum) || offsetNum < 0) {
      return res.status(400).json({ error: 'Offset must be 0 or greater' });
    }
    req.query.offset = offsetNum;
  }

  if (page) {
    const pageNum = parseInt(page);
    if (isNaN(pageNum) || pageNum < 1) {
      return res.status(400).json({ error: 'Page must be 1 or greater' });
    }
    req.query.page = pageNum;
  }

  next();
}

// Validate search query
function validateSearch(req, res, next) {
  const { q } = req.query;

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }

  if (q.length > 100) {
    return res.status(400).json({ error: 'Search query too long' });
  }

  // Sanitize
  req.query.q = sanitizeString(q, 100);

  next();
}

// Generic error handler wrapper
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  validateMint,
  validateWallet,
  validateSubmission,
  validateVote,
  validatePagination,
  validateSearch,
  asyncHandler,
  sanitizeString,
  isValidUrl,
  SOLANA_ADDRESS_REGEX
};
