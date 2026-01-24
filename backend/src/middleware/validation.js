/**
 * Input validation middleware
 */

// Validate Solana address format (base58, exactly 43-44 characters for public keys)
// Standard Solana addresses are 44 characters, but some derived addresses can be 43
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

// Validate URL format
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// URL allowlist for submission types
const URL_ALLOWLISTS = {
  twitter: ['twitter.com', 'x.com', 'mobile.twitter.com'],
  telegram: ['t.me', 'telegram.me', 'telegram.org'],
  discord: ['discord.gg', 'discord.com', 'discordapp.com'],
  tiktok: ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com'],
  banner: null, // Any image host allowed
  website: null // Any website allowed
};

// Known malicious/spam domains (expandable)
const BLOCKED_DOMAINS = [
  // URL shorteners (hide destination)
  'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'is.gd', 'v.gd', 'shorte.st', 'adf.ly',
  'ow.ly', 'buff.ly', 'j.mp', 'tiny.cc', 'rb.gy', 'cutt.ly', 'shorturl.at',
  // Local/private addresses
  'localhost', '127.0.0.1', '0.0.0.0',
  // Known crypto scam/phishing patterns
  'metamask-wallet.com', 'phantom-wallet.com', 'solflare-wallet.com',
  'claim-airdrop.com', 'free-airdrop.com', 'token-airdrop.com',
  'solana-airdrop.com', 'sol-airdrop.com', 'crypto-airdrop.com',
  'connect-wallet.com', 'wallet-connect.com', 'walletconnect-app.com',
  // Typosquatting common sites
  'dlscord.com', 'discorrd.com', 'disc0rd.com', 'dlscord.gg',
  'twiitter.com', 'twltter.com', 'tvvitter.com',
  'telegran.me', 'telegrarn.me', 'teiegram.me',
  // Generic suspicious patterns
  'free-crypto.com', 'crypto-giveaway.com', 'token-giveaway.com'
];

// Suspicious hostname patterns (regex)
const SUSPICIOUS_PATTERNS = [
  /airdrop/i,
  /giveaway/i,
  /claim.*token/i,
  /free.*crypto/i,
  /wallet.*connect/i,
  /connect.*wallet/i
];

// Validate URL is not a redirect/shortener and matches allowed domains
function validateUrlDomain(urlString, submissionType) {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();

    // Block known malicious/redirect domains
    for (const blocked of BLOCKED_DOMAINS) {
      if (hostname === blocked || hostname.endsWith('.' + blocked)) {
        return { valid: false, message: 'This URL is not allowed. Please use the official direct URL.' };
      }
    }

    // Check for suspicious patterns in hostname
    for (const pattern of SUSPICIOUS_PATTERNS) {
      if (pattern.test(hostname)) {
        return { valid: false, message: 'This URL contains suspicious patterns and is not allowed.' };
      }
    }

    // Check allowlist for specific submission types
    const allowlist = URL_ALLOWLISTS[submissionType];
    if (allowlist) {
      const isAllowed = allowlist.some(domain =>
        hostname === domain || hostname.endsWith('.' + domain)
      );
      if (!isAllowed) {
        return { valid: false, message: `URL must be from: ${allowlist.join(', ')}` };
      }
    }

    return { valid: true };
  } catch {
    return { valid: false, message: 'Invalid URL format' };
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

// Maximum URL length to prevent abuse
const MAX_URL_LENGTH = 2000;

// Validate submission input
function validateSubmission(req, res, next) {
  const { tokenMint, submissionType, contentUrl } = req.body;
  const validTypes = ['banner', 'twitter', 'telegram', 'discord', 'tiktok', 'website'];

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

  // Validate URL length
  if (contentUrl.length > MAX_URL_LENGTH) {
    return res.status(400).json({ error: `URL too long (max ${MAX_URL_LENGTH} characters)` });
  }

  // Validate basic URL format
  if (!isValidUrl(contentUrl)) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  // Validate URL domain (blocks shorteners, validates allowlists)
  const domainValidation = validateUrlDomain(contentUrl, submissionType);
  if (!domainValidation.valid) {
    return res.status(400).json({ error: domainValidation.message });
  }

  // Type-specific validation
  if (submissionType === 'banner') {
    // For banners, check for image extensions or known image hosts
    const urlLower = contentUrl.toLowerCase();
    const isImageUrl = /\.(jpg|jpeg|png|gif|webp|svg)(\?.*)?$/i.test(contentUrl) ||
      urlLower.includes('imgur.com') ||
      urlLower.includes('i.imgur.com') ||
      urlLower.includes('cloudinary.com') ||
      urlLower.includes('imagekit.io') ||
      urlLower.includes('ipfs.io') ||
      urlLower.includes('arweave.net') ||
      urlLower.includes('nftstorage.link');

    if (!isImageUrl) {
      return res.status(400).json({
        error: 'Banner URL must be a direct image link (PNG, JPG, GIF, WebP, SVG) or from a known image host'
      });
    }
  }

  // Sanitize the URL (normalize)
  try {
    const normalized = new URL(contentUrl);
    req.body.contentUrl = normalized.href;
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
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
// Handles both sync and async errors properly
function asyncHandler(fn) {
  return (req, res, next) => {
    try {
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (error) {
      // Catch synchronous errors thrown before async execution
      next(error);
    }
  };
}

// Middleware to check if database is available
// Use this for routes that require database access
function requireDatabase(req, res, next) {
  const db = require('../services/database');
  if (!db.isReady()) {
    return res.status(503).json({
      error: 'Database temporarily unavailable',
      message: 'The database is starting up. Please try again in a few moments.',
      retryAfter: 5
    });
  }
  next();
}

// Hash an API key using SHA-256
function hashApiKey(apiKey) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

// Generate a new API key (32 bytes = 64 hex chars)
function generateApiKey() {
  const crypto = require('crypto');
  const key = crypto.randomBytes(32).toString('hex');
  const prefix = key.slice(0, 8); // First 8 chars for display
  return { key, prefix, hash: hashApiKey(key) };
}

// Middleware to validate API key from header
// API key should be passed in X-API-Key header
async function validateApiKey(req, res, next) {
  const db = require('../services/database');

  const apiKey = req.header('X-API-Key');

  if (!apiKey) {
    return res.status(401).json({
      error: 'API key required',
      message: 'Please provide your API key in the X-API-Key header'
    });
  }

  // Validate key format (should be 64 hex characters)
  if (!/^[a-f0-9]{64}$/i.test(apiKey)) {
    return res.status(401).json({
      error: 'Invalid API key format'
    });
  }

  try {
    const keyHash = hashApiKey(apiKey);
    const keyInfo = await db.getApiKeyByHash(keyHash);

    if (!keyInfo) {
      return res.status(401).json({
        error: 'Invalid API key'
      });
    }

    if (!keyInfo.is_active) {
      return res.status(403).json({
        error: 'API key has been revoked'
      });
    }

    // Update usage stats (fire and forget)
    db.updateApiKeyUsage(keyHash).catch(err =>
      console.error('Failed to update API key usage:', err.message)
    );

    // Attach key info to request for use in routes
    req.apiKey = {
      id: keyInfo.id,
      prefix: keyInfo.key_prefix,
      owner: keyInfo.owner_wallet,
      name: keyInfo.name
    };

    next();
  } catch (error) {
    console.error('API key validation error:', error.message);
    return res.status(500).json({
      error: 'Failed to validate API key'
    });
  }
}

// ==========================================
// Wallet Signature Verification
// ==========================================

// Signature expiry time (2 minutes) - prevents replay attacks while allowing reasonable signing time
const SIGNATURE_EXPIRY_MS = 2 * 60 * 1000;

/**
 * Verify a Solana wallet signature
 * Uses Ed25519 signature verification via tweetnacl
 *
 * @param {string} message - The message that was signed
 * @param {number[]} signature - The signature as an array of bytes
 * @param {string} walletAddress - The wallet address (base58 public key)
 * @returns {boolean} True if signature is valid
 */
function verifyWalletSignature(message, signature, walletAddress) {
  try {
    const nacl = require('tweetnacl');
    const bs58 = require('bs58');

    // Decode the wallet address (base58 public key)
    const publicKey = bs58.decode(walletAddress);

    // Ensure public key is 32 bytes (Ed25519)
    if (publicKey.length !== 32) {
      console.error('[Signature] Invalid public key length:', publicKey.length);
      return false;
    }

    // Convert signature array to Uint8Array
    const signatureBytes = new Uint8Array(signature);

    // Ensure signature is 64 bytes (Ed25519)
    if (signatureBytes.length !== 64) {
      console.error('[Signature] Invalid signature length:', signatureBytes.length);
      return false;
    }

    // Encode the message
    const messageBytes = new TextEncoder().encode(message);

    // Verify the signature
    const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey);

    return isValid;
  } catch (error) {
    console.error('[Signature] Verification error:', error.message);
    return false;
  }
}

/**
 * Create the message to be signed for a vote
 * Format: "OpenDex Vote: [voteType] on [submissionId] at [timestamp]"
 *
 * @param {string} voteType - 'up' or 'down'
 * @param {number} submissionId - The submission ID
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} The message to sign
 */
function createVoteSignatureMessage(voteType, submissionId, timestamp) {
  return `OpenDex Vote: ${voteType} on submission #${submissionId} at ${timestamp}`;
}

/**
 * Create the message to be signed for a batch of votes
 * Format: "OpenDex Vote Batch: up:[ids];down:[ids] for wallet at [timestamp]"
 * Submission IDs are sorted numerically for consistent signature verification
 *
 * @param {Array<{submissionId: number, voteType: string}>} votes - Array of vote objects
 * @param {string} wallet - The voter wallet address
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} The message to sign
 */
function createBatchVoteSignatureMessage(votes, wallet, timestamp) {
  // Group votes by type and sort IDs
  const upVotes = votes.filter(v => v.voteType === 'up').map(v => v.submissionId).sort((a, b) => a - b);
  const downVotes = votes.filter(v => v.voteType === 'down').map(v => v.submissionId).sort((a, b) => a - b);

  const parts = [];
  if (upVotes.length > 0) parts.push(`up:${upVotes.join(',')}`);
  if (downVotes.length > 0) parts.push(`down:${downVotes.join(',')}`);

  return `OpenDex Vote Batch: ${parts.join(';')} for ${wallet} at ${timestamp}`;
}

/**
 * Create the message to be signed for a submission
 * Format: "OpenDex Submit: [type] for [tokenMint] at [timestamp]"
 *
 * @param {string} submissionType - The submission type
 * @param {string} tokenMint - The token mint address
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} The message to sign
 */
function createSubmissionSignatureMessage(submissionType, tokenMint, timestamp) {
  return `OpenDex Submit: ${submissionType} for ${tokenMint} at ${timestamp}`;
}

/**
 * Create the message to be signed for a batch submission
 * Format: "OpenDex Submit Batch: [types-comma-separated] for [tokenMint] at [timestamp]"
 * Types are sorted alphabetically for consistent signature verification
 *
 * @param {string[]} submissionTypes - Array of submission types
 * @param {string} tokenMint - The token mint address
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} The message to sign
 */
function createBatchSubmissionSignatureMessage(submissionTypes, tokenMint, timestamp) {
  // Sort types alphabetically for consistent verification
  const sortedTypes = [...submissionTypes].sort().join(',');
  return `OpenDex Submit Batch: ${sortedTypes} for ${tokenMint} at ${timestamp}`;
}

/**
 * Create signature message for data deletion (GDPR)
 * @param {string} wallet - The wallet address
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} The message to sign
 */
function createDataDeletionSignatureMessage(wallet, timestamp) {
  return `OpenDex Delete Data: ${wallet} at ${timestamp}`;
}

/**
 * Middleware to validate wallet signature for data deletion (GDPR)
 * Requires: wallet, signature, signatureTimestamp in request body
 */
function validateWalletSignature(req, res, next) {
  const { wallet, signature, signatureTimestamp } = req.body;

  // Check if signature fields are present
  if (!signature || !signatureTimestamp || !wallet) {
    return res.status(400).json({
      error: 'Signature required',
      message: 'Please sign the request with your wallet',
      code: 'SIGNATURE_REQUIRED'
    });
  }

  // Validate wallet format
  if (!SOLANA_ADDRESS_REGEX.test(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  // Validate signature timestamp (must be within expiry window)
  const now = Date.now();
  const timestamp = parseInt(signatureTimestamp);

  if (isNaN(timestamp)) {
    return res.status(400).json({
      error: 'Invalid timestamp',
      code: 'INVALID_TIMESTAMP'
    });
  }

  if (now - timestamp > SIGNATURE_EXPIRY_MS) {
    return res.status(400).json({
      error: 'Signature expired',
      message: 'Please sign a fresh request',
      code: 'SIGNATURE_EXPIRED'
    });
  }

  // Validate signature format (should be array of numbers)
  if (!Array.isArray(signature) || signature.length !== 64) {
    return res.status(400).json({
      error: 'Invalid signature format',
      code: 'INVALID_SIGNATURE_FORMAT'
    });
  }

  // Recreate the expected message
  const expectedMessage = createDataDeletionSignatureMessage(wallet, timestamp);

  // Verify the signature
  const isValid = verifyWalletSignature(expectedMessage, signature, wallet);

  if (!isValid) {
    return res.status(401).json({
      error: 'Invalid signature',
      message: 'Wallet signature verification failed',
      code: 'INVALID_SIGNATURE'
    });
  }

  // Signature is valid - proceed
  next();
}

/**
 * Middleware to validate wallet signature for votes
 * Signature is OPTIONAL - if provided, it will be validated
 * Connected wallet already proves ownership, so signature is not required
 */
function validateVoteSignature(req, res, next) {
  const { submissionId, voterWallet, voteType, signature, signatureTimestamp } = req.body;

  // Signature is optional - if not provided, skip validation
  // Connected wallet already proves ownership
  if (!signature || !signatureTimestamp) {
    return next();
  }

  // Validate signature timestamp (must be within expiry window)
  const now = Date.now();
  const timestamp = parseInt(signatureTimestamp);

  if (isNaN(timestamp)) {
    return res.status(400).json({
      error: 'Invalid timestamp',
      code: 'INVALID_TIMESTAMP'
    });
  }

  if (now - timestamp > SIGNATURE_EXPIRY_MS) {
    return res.status(400).json({
      error: 'Signature expired',
      message: 'Please sign again - signatures expire after 2 minutes',
      code: 'SIGNATURE_EXPIRED'
    });
  }

  // Prevent future timestamps (with 10 second tolerance for clock skew)
  if (timestamp > now + 10000) {
    return res.status(400).json({
      error: 'Invalid timestamp',
      message: 'Signature timestamp is in the future',
      code: 'INVALID_TIMESTAMP'
    });
  }

  // Validate signature format (should be array of numbers)
  if (!Array.isArray(signature) || signature.length !== 64) {
    return res.status(400).json({
      error: 'Invalid signature format',
      code: 'INVALID_SIGNATURE_FORMAT'
    });
  }

  // Recreate the expected message
  const expectedMessage = createVoteSignatureMessage(voteType, parseInt(submissionId), timestamp);

  // Verify the signature
  const isValid = verifyWalletSignature(expectedMessage, signature, voterWallet);

  if (!isValid) {
    return res.status(401).json({
      error: 'Invalid signature',
      message: 'Wallet signature verification failed',
      code: 'INVALID_SIGNATURE'
    });
  }

  // Signature is valid - proceed
  next();
}

/**
 * Validate batch votes array format
 * Used before signature verification
 */
function validateBatchVotes(req, res, next) {
  const { votes, voterWallet } = req.body;

  // Validate required fields
  if (!votes || !voterWallet) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['votes', 'voterWallet']
    });
  }

  // Validate votes is an array
  if (!Array.isArray(votes) || votes.length === 0) {
    return res.status(400).json({
      error: 'Votes must be a non-empty array'
    });
  }

  // Limit batch size
  if (votes.length > 20) {
    return res.status(400).json({
      error: 'Maximum 20 votes per batch'
    });
  }

  // Validate voter wallet
  if (!SOLANA_ADDRESS_REGEX.test(voterWallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  // Validate each vote
  const seenIds = new Set();
  for (const vote of votes) {
    if (!vote.submissionId || !vote.voteType) {
      return res.status(400).json({
        error: 'Each vote must have submissionId and voteType'
      });
    }

    const submissionId = parseInt(vote.submissionId);
    if (isNaN(submissionId) || submissionId < 1) {
      return res.status(400).json({
        error: `Invalid submission ID: ${vote.submissionId}`
      });
    }

    if (!['up', 'down'].includes(vote.voteType)) {
      return res.status(400).json({
        error: `Invalid vote type: ${vote.voteType}`,
        validTypes: ['up', 'down']
      });
    }

    // Check for duplicate submission IDs in batch
    if (seenIds.has(submissionId)) {
      return res.status(400).json({
        error: `Duplicate submission ID in batch: ${submissionId}`
      });
    }
    seenIds.add(submissionId);

    // Normalize submissionId to integer
    vote.submissionId = submissionId;
  }

  next();
}

/**
 * Middleware to validate wallet signature for batch votes
 * Signature is OPTIONAL - if provided, it will be validated
 * Connected wallet already proves ownership, so signature is not required
 */
function validateBatchVoteSignature(req, res, next) {
  const { votes, voterWallet, signature, signatureTimestamp } = req.body;

  // Signature is optional - if not provided, skip validation
  // Connected wallet already proves ownership
  if (!signature || !signatureTimestamp) {
    return next();
  }

  // Validate signature timestamp (must be within expiry window)
  const now = Date.now();
  const timestamp = parseInt(signatureTimestamp);

  if (isNaN(timestamp)) {
    return res.status(400).json({
      error: 'Invalid timestamp',
      code: 'INVALID_TIMESTAMP'
    });
  }

  if (now - timestamp > SIGNATURE_EXPIRY_MS) {
    return res.status(400).json({
      error: 'Signature expired',
      message: 'Please sign again - signatures expire after 2 minutes',
      code: 'SIGNATURE_EXPIRED'
    });
  }

  // Prevent future timestamps (with 10 second tolerance for clock skew)
  if (timestamp > now + 10000) {
    return res.status(400).json({
      error: 'Invalid timestamp',
      message: 'Signature timestamp is in the future',
      code: 'INVALID_TIMESTAMP'
    });
  }

  // Validate signature format (should be array of numbers)
  if (!Array.isArray(signature) || signature.length !== 64) {
    return res.status(400).json({
      error: 'Invalid signature format',
      code: 'INVALID_SIGNATURE_FORMAT'
    });
  }

  // Recreate the expected message
  const expectedMessage = createBatchVoteSignatureMessage(votes, voterWallet, timestamp);

  // Verify the signature
  const isValid = verifyWalletSignature(expectedMessage, signature, voterWallet);

  if (!isValid) {
    return res.status(401).json({
      error: 'Invalid signature',
      message: 'Wallet signature verification failed',
      code: 'INVALID_SIGNATURE'
    });
  }

  // Signature is valid - proceed
  next();
}

/**
 * Middleware to validate wallet signature for submissions
 * Signature is OPTIONAL - if provided, it will be validated
 * Connected wallet already proves ownership, so signature is not required
 */
function validateSubmissionSignature(req, res, next) {
  const { tokenMint, submissionType, submitterWallet, signature, signatureTimestamp } = req.body;

  // Signature is optional - if not provided, skip validation
  // Connected wallet already proves ownership
  if (!signature || !signatureTimestamp) {
    return next();
  }

  // Validate submitter wallet format
  if (!SOLANA_ADDRESS_REGEX.test(submitterWallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  // Validate signature timestamp (must be within expiry window)
  const now = Date.now();
  const timestamp = parseInt(signatureTimestamp);

  if (isNaN(timestamp)) {
    return res.status(400).json({
      error: 'Invalid timestamp',
      code: 'INVALID_TIMESTAMP'
    });
  }

  if (now - timestamp > SIGNATURE_EXPIRY_MS) {
    return res.status(400).json({
      error: 'Signature expired',
      message: 'Please sign again - signatures expire after 2 minutes',
      code: 'SIGNATURE_EXPIRED'
    });
  }

  // Prevent future timestamps (with 10 second tolerance for clock skew)
  if (timestamp > now + 10000) {
    return res.status(400).json({
      error: 'Invalid timestamp',
      message: 'Signature timestamp is in the future',
      code: 'INVALID_TIMESTAMP'
    });
  }

  // Validate signature format (should be array of numbers)
  if (!Array.isArray(signature) || signature.length !== 64) {
    return res.status(400).json({
      error: 'Invalid signature format',
      code: 'INVALID_SIGNATURE_FORMAT'
    });
  }

  // Recreate the expected message
  const expectedMessage = createSubmissionSignatureMessage(submissionType, tokenMint, timestamp);

  // Verify the signature
  const isValid = verifyWalletSignature(expectedMessage, signature, submitterWallet);

  if (!isValid) {
    return res.status(401).json({
      error: 'Invalid signature',
      message: 'Wallet signature verification failed',
      code: 'INVALID_SIGNATURE'
    });
  }

  // Signature is valid - proceed
  next();
}

/**
 * Validate batch submissions array format
 * Used before signature verification
 */
function validateBatchSubmissions(req, res, next) {
  const { tokenMint, submissions, submitterWallet } = req.body;
  const validTypes = ['banner', 'twitter', 'telegram', 'discord', 'tiktok', 'website'];

  // Validate required fields
  if (!tokenMint || !submissions || !submitterWallet) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['tokenMint', 'submissions', 'submitterWallet']
    });
  }

  // Validate submissions is an array
  if (!Array.isArray(submissions) || submissions.length === 0) {
    return res.status(400).json({
      error: 'Submissions must be a non-empty array'
    });
  }

  // Limit batch size
  if (submissions.length > 6) {
    return res.status(400).json({
      error: 'Maximum 6 submissions per batch'
    });
  }

  // Validate token mint
  if (!SOLANA_ADDRESS_REGEX.test(tokenMint)) {
    return res.status(400).json({ error: 'Invalid token mint address' });
  }

  // Validate submitter wallet
  if (!SOLANA_ADDRESS_REGEX.test(submitterWallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  // Validate each submission
  const seenTypes = new Set();
  for (const sub of submissions) {
    if (!sub.submissionType || !sub.contentUrl) {
      return res.status(400).json({
        error: 'Each submission must have submissionType and contentUrl'
      });
    }

    if (!validTypes.includes(sub.submissionType)) {
      return res.status(400).json({
        error: `Invalid submission type: ${sub.submissionType}`,
        validTypes
      });
    }

    // Check for duplicate types in batch
    if (seenTypes.has(sub.submissionType)) {
      return res.status(400).json({
        error: `Duplicate submission type in batch: ${sub.submissionType}`
      });
    }
    seenTypes.add(sub.submissionType);

    // Validate URL length
    if (sub.contentUrl.length > MAX_URL_LENGTH) {
      return res.status(400).json({
        error: `URL too long for ${sub.submissionType} (max ${MAX_URL_LENGTH} characters)`
      });
    }

    // Validate basic URL format
    if (!isValidUrl(sub.contentUrl)) {
      return res.status(400).json({
        error: `Invalid URL format for ${sub.submissionType}`
      });
    }

    // Validate URL domain
    const domainValidation = validateUrlDomain(sub.contentUrl, sub.submissionType);
    if (!domainValidation.valid) {
      return res.status(400).json({
        error: `${sub.submissionType}: ${domainValidation.message}`
      });
    }

    // Type-specific validation for banners
    if (sub.submissionType === 'banner') {
      const urlLower = sub.contentUrl.toLowerCase();
      const isImageUrl = /\.(jpg|jpeg|png|gif|webp|svg)(\?.*)?$/i.test(sub.contentUrl) ||
        urlLower.includes('imgur.com') ||
        urlLower.includes('i.imgur.com') ||
        urlLower.includes('cloudinary.com') ||
        urlLower.includes('imagekit.io') ||
        urlLower.includes('ipfs.io') ||
        urlLower.includes('arweave.net') ||
        urlLower.includes('nftstorage.link');

      if (!isImageUrl) {
        return res.status(400).json({
          error: 'Banner URL must be a direct image link (PNG, JPG, GIF, WebP, SVG) or from a known image host'
        });
      }
    }

    // Normalize URL
    try {
      const normalized = new URL(sub.contentUrl);
      sub.contentUrl = normalized.href;
    } catch {
      return res.status(400).json({
        error: `Invalid URL format for ${sub.submissionType}`
      });
    }
  }

  next();
}

/**
 * Middleware to validate wallet signature for batch submissions
 * Signature is OPTIONAL - if provided, it will be validated
 * Connected wallet already proves ownership, so signature is not required
 */
function validateBatchSubmissionSignature(req, res, next) {
  const { tokenMint, submissions, submitterWallet, signature, signatureTimestamp } = req.body;

  // Signature is optional - if not provided, skip validation
  // Connected wallet already proves ownership
  if (!signature || !signatureTimestamp) {
    return next();
  }

  // Validate signature timestamp (must be within expiry window)
  const now = Date.now();
  const timestamp = parseInt(signatureTimestamp);

  if (isNaN(timestamp)) {
    return res.status(400).json({
      error: 'Invalid timestamp',
      code: 'INVALID_TIMESTAMP'
    });
  }

  if (now - timestamp > SIGNATURE_EXPIRY_MS) {
    return res.status(400).json({
      error: 'Signature expired',
      message: 'Please sign again - signatures expire after 2 minutes',
      code: 'SIGNATURE_EXPIRED'
    });
  }

  // Prevent future timestamps (with 10 second tolerance for clock skew)
  if (timestamp > now + 10000) {
    return res.status(400).json({
      error: 'Invalid timestamp',
      message: 'Signature timestamp is in the future',
      code: 'INVALID_TIMESTAMP'
    });
  }

  // Validate signature format (should be array of numbers)
  if (!Array.isArray(signature) || signature.length !== 64) {
    return res.status(400).json({
      error: 'Invalid signature format',
      code: 'INVALID_SIGNATURE_FORMAT'
    });
  }

  // Extract submission types for signature verification
  const submissionTypes = submissions.map(s => s.submissionType);

  // Recreate the expected message (types are sorted in the function)
  const expectedMessage = createBatchSubmissionSignatureMessage(submissionTypes, tokenMint, timestamp);

  // Verify the signature
  const isValid = verifyWalletSignature(expectedMessage, signature, submitterWallet);

  if (!isValid) {
    return res.status(401).json({
      error: 'Invalid signature',
      message: 'Wallet signature verification failed',
      code: 'INVALID_SIGNATURE'
    });
  }

  // Signature is valid - proceed
  next();
}

// ==========================================
// Admin Authentication
// ==========================================

// Session duration (24 hours)
const ADMIN_SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

// Generate admin session token
function generateAdminSessionToken() {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
}

// Verify admin password
function verifyAdminPassword(password) {
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    console.error('ADMIN_PASSWORD not configured');
    return false;
  }

  // Use constant-time comparison to prevent timing attacks
  const crypto = require('crypto');
  const passwordBuffer = Buffer.from(password || '');
  const adminBuffer = Buffer.from(adminPassword);

  // Pad shorter buffer to match length for constant-time comparison
  const maxLength = Math.max(passwordBuffer.length, adminBuffer.length);
  const paddedPassword = Buffer.alloc(maxLength);
  const paddedAdmin = Buffer.alloc(maxLength);
  passwordBuffer.copy(paddedPassword);
  adminBuffer.copy(paddedAdmin);

  // Always compare same-length buffers, then check if original lengths matched
  const match = crypto.timingSafeEqual(paddedPassword, paddedAdmin);
  return match && passwordBuffer.length === adminBuffer.length;
}

// Middleware to validate admin session
async function validateAdminSession(req, res, next) {
  const db = require('../services/database');

  // Get session token from cookie or header
  const sessionToken = req.cookies?.admin_session || req.header('X-Admin-Session');

  if (!sessionToken) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Please log in to access the admin panel'
    });
  }

  // Validate token format (64 hex chars)
  if (!/^[a-f0-9]{64}$/i.test(sessionToken)) {
    return res.status(401).json({
      error: 'Invalid session'
    });
  }

  try {
    const session = await db.getAdminSession(sessionToken);

    if (!session) {
      return res.status(401).json({
        error: 'Session expired',
        message: 'Please log in again'
      });
    }

    // Attach session to request
    req.adminSession = session;
    next();
  } catch (error) {
    console.error('Admin session validation error:', error.message);
    return res.status(500).json({
      error: 'Failed to validate session'
    });
  }
}

module.exports = {
  validateMint,
  validateWallet,
  validateSubmission,
  validateVote,
  validatePagination,
  validateSearch,
  asyncHandler,
  requireDatabase,
  sanitizeString,
  isValidUrl,
  validateUrlDomain,
  // API Key functions
  hashApiKey,
  generateApiKey,
  validateApiKey,
  // Wallet Signature functions
  verifyWalletSignature,
  validateVoteSignature,
  validateSubmissionSignature,
  validateWalletSignature,
  validateBatchSubmissions,
  validateBatchSubmissionSignature,
  validateBatchVotes,
  validateBatchVoteSignature,
  createVoteSignatureMessage,
  createBatchVoteSignatureMessage,
  createSubmissionSignatureMessage,
  createBatchSubmissionSignatureMessage,
  createDataDeletionSignatureMessage,
  SIGNATURE_EXPIRY_MS,
  // Admin functions
  generateAdminSessionToken,
  verifyAdminPassword,
  validateAdminSession,
  ADMIN_SESSION_DURATION_MS,
  // Constants
  SOLANA_ADDRESS_REGEX,
  BLOCKED_DOMAINS,
  SUSPICIOUS_PATTERNS,
  MAX_URL_LENGTH
};
