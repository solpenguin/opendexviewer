/**
 * Rate limiting middleware configurations
 */
const rateLimit = require('express-rate-limit');

// Default rate limiter
const defaultLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Strict limiter for write operations (submissions, votes)
const strictLimiter = rateLimit({
  windowMs: 60000, // 1 minute
  max: 10,         // 10 requests per minute
  message: { error: 'Too many submissions, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Very strict limiter for sensitive operations
const veryStrictLimiter = rateLimit({
  windowMs: 3600000, // 1 hour
  max: 50,           // 50 per hour
  message: { error: 'Rate limit exceeded. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Search-specific limiter (prevent abuse)
const searchLimiter = rateLimit({
  windowMs: 60000, // 1 minute
  max: 30,         // 30 searches per minute
  message: { error: 'Too many search requests.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Limiter by wallet address (for voting)
const walletLimiter = rateLimit({
  windowMs: 60000, // 1 minute
  max: 20,         // 20 votes per minute per IP
  message: { error: 'Voting too fast. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use wallet address if available, otherwise IP
    return req.body?.voterWallet || req.ip;
  }
});

module.exports = {
  defaultLimiter,
  strictLimiter,
  veryStrictLimiter,
  searchLimiter,
  walletLimiter
};
