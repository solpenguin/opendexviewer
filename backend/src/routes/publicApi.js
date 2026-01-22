/**
 * Public API routes for external access to community content
 * Requires API key authentication
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const {
  validateMint,
  validateApiKey,
  generateApiKey,
  hashApiKey,
  asyncHandler,
  requireDatabase,
  SOLANA_ADDRESS_REGEX
} = require('../middleware/validation');
const { searchLimiter, strictLimiter } = require('../middleware/rateLimit');

// ==========================================
// Public API Endpoints (require API key)
// ==========================================

/**
 * GET /api/v1/community/:mint
 * Get all approved community content for a token
 * Returns banner, social links, and description
 */
router.get('/community/:mint',
  validateApiKey,
  validateMint,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const { mint } = req.params;

    // Get approved submissions for this token
    const submissions = await db.getApprovedSubmissions(mint);

    // Organize by type
    const community = {
      token: mint,
      banner: null,
      links: {
        twitter: null,
        telegram: null,
        discord: null,
        website: null
      },
      submissionCount: submissions.length
    };

    // Find the highest-voted submission of each type
    for (const sub of submissions) {
      if (sub.submission_type === 'banner' && !community.banner) {
        community.banner = {
          url: sub.content_url,
          score: sub.score || 0,
          submittedAt: sub.created_at
        };
      } else if (sub.submission_type !== 'banner') {
        const linkType = sub.submission_type;
        if (community.links[linkType] === null) {
          community.links[linkType] = {
            url: sub.content_url,
            score: sub.score || 0,
            submittedAt: sub.created_at
          };
        }
      }
    }

    res.json({
      success: true,
      data: community
    });
  })
);

/**
 * GET /api/v1/community/:mint/all
 * Get all approved submissions for a token (not just top-voted)
 */
router.get('/community/:mint/all',
  validateApiKey,
  validateMint,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const { mint } = req.params;
    const { type } = req.query;

    // Get approved submissions
    const submissions = await db.getSubmissionsByToken(mint, {
      status: 'approved',
      type: type || undefined
    });

    const formatted = submissions.map(sub => ({
      id: sub.id,
      type: sub.submission_type,
      url: sub.content_url,
      score: sub.score || 0,
      upvotes: sub.upvotes || 0,
      downvotes: sub.downvotes || 0,
      submittedAt: sub.created_at
    }));

    res.json({
      success: true,
      data: {
        token: mint,
        count: formatted.length,
        submissions: formatted
      }
    });
  })
);

/**
 * GET /api/v1/community/batch
 * Get community content for multiple tokens at once
 * Query param: mints (comma-separated, max 20)
 */
router.get('/community/batch',
  validateApiKey,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const { mints } = req.query;

    if (!mints) {
      return res.status(400).json({
        success: false,
        error: 'mints parameter required (comma-separated token addresses)'
      });
    }

    const mintList = mints.split(',').map(m => m.trim()).filter(Boolean);

    // Limit to 20 tokens per request
    if (mintList.length > 20) {
      return res.status(400).json({
        success: false,
        error: 'Maximum 20 tokens per batch request'
      });
    }

    // Validate all addresses
    for (const mint of mintList) {
      if (!SOLANA_ADDRESS_REGEX.test(mint)) {
        return res.status(400).json({
          success: false,
          error: `Invalid token address: ${mint}`
        });
      }
    }

    // Fetch community content for each token
    const results = {};
    await Promise.all(mintList.map(async (mint) => {
      const submissions = await db.getApprovedSubmissions(mint);

      const community = {
        banner: null,
        links: {
          twitter: null,
          telegram: null,
          discord: null,
          website: null
        }
      };

      for (const sub of submissions) {
        if (sub.submission_type === 'banner' && !community.banner) {
          community.banner = sub.content_url;
        } else if (sub.submission_type !== 'banner') {
          const linkType = sub.submission_type;
          if (community.links[linkType] === null) {
            community.links[linkType] = sub.content_url;
          }
        }
      }

      results[mint] = community;
    }));

    res.json({
      success: true,
      data: results
    });
  })
);

// ==========================================
// API Key Management Endpoints
// ==========================================

/**
 * POST /api/v1/keys/register
 * Register a new API key for a wallet
 * Body: { wallet: string, name?: string }
 */
router.post('/keys/register',
  strictLimiter,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const { wallet, name } = req.body;

    if (!wallet) {
      return res.status(400).json({
        success: false,
        error: 'wallet address required'
      });
    }

    if (!SOLANA_ADDRESS_REGEX.test(wallet)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid wallet address format'
      });
    }

    // Check if wallet already has a key
    const existingKey = await db.getApiKeyByWallet(wallet);
    if (existingKey) {
      return res.status(409).json({
        success: false,
        error: 'Wallet already has an API key',
        keyPrefix: existingKey.key_prefix,
        createdAt: existingKey.created_at
      });
    }

    // Generate new key
    const { key, prefix, hash } = generateApiKey();

    // Store in database (including full key for later retrieval)
    const sanitizedName = name ? name.slice(0, 100).replace(/[<>]/g, '') : null;
    const created = await db.createApiKey(wallet, hash, prefix, sanitizedName, key);

    if (!created) {
      return res.status(500).json({
        success: false,
        error: 'Failed to create API key'
      });
    }

    // Return the full key on creation
    res.status(201).json({
      success: true,
      message: 'API key created successfully',
      data: {
        apiKey: key,
        keyPrefix: prefix,
        owner: wallet,
        name: sanitizedName,
        createdAt: created.created_at
      }
    });
  })
);

/**
 * GET /api/v1/keys/info
 * Get info about the current API key
 */
router.get('/keys/info',
  validateApiKey,
  requireDatabase,
  asyncHandler(async (req, res) => {
    // req.apiKey is populated by validateApiKey middleware
    const keyInfo = await db.getApiKeyByWallet(req.apiKey.owner);

    res.json({
      success: true,
      data: {
        keyPrefix: keyInfo.key_prefix,
        owner: keyInfo.owner_wallet,
        name: keyInfo.name,
        createdAt: keyInfo.created_at,
        lastUsedAt: keyInfo.last_used_at,
        requestCount: keyInfo.request_count,
        isActive: keyInfo.is_active
      }
    });
  })
);

/**
 * GET /api/v1/keys/status/:wallet
 * Check if a wallet has an API key (public endpoint)
 */
router.get('/keys/status/:wallet',
  searchLimiter,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const { wallet } = req.params;

    if (!SOLANA_ADDRESS_REGEX.test(wallet)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid wallet address format'
      });
    }

    const keyInfo = await db.getApiKeyByWallet(wallet);

    if (!keyInfo) {
      return res.json({
        success: true,
        data: {
          hasKey: false
        }
      });
    }

    res.json({
      success: true,
      data: {
        hasKey: true,
        apiKey: keyInfo.full_key,
        keyPrefix: keyInfo.key_prefix,
        createdAt: keyInfo.created_at,
        lastUsedAt: keyInfo.last_used_at,
        requestCount: keyInfo.request_count,
        isActive: keyInfo.is_active
      }
    });
  })
);

/**
 * DELETE /api/v1/keys/revoke
 * Revoke (delete) your API key to allow creating a new one
 * Requires current API key for authentication
 */
router.delete('/keys/revoke',
  validateApiKey,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const deleted = await db.deleteApiKey(req.apiKey.owner);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'API key not found'
      });
    }

    res.json({
      success: true,
      message: 'API key has been revoked. You can now register a new key.'
    });
  })
);

module.exports = router;
