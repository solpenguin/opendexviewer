const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { cache, TTL, keys } = require('../services/cache');
const { validateMint, validateSubmission, validateSubmissionSignature, validateWallet, asyncHandler, requireDatabase, sanitizeString } = require('../middleware/validation');
const { strictLimiter } = require('../middleware/rateLimit');

// All routes in this file require database access
router.use(requireDatabase);

// Valid submission types (for query param validation)
const VALID_TYPES = ['banner', 'twitter', 'telegram', 'discord', 'website'];
const VALID_STATUSES = ['pending', 'approved', 'rejected', 'all'];

/**
 * Sanitize submission data for safe output
 * While data is validated on input, this provides defense-in-depth
 */
function sanitizeSubmissionOutput(submission) {
  if (!submission) return null;

  return {
    id: submission.id,
    token_mint: submission.token_mint,
    submission_type: submission.submission_type,
    content_url: submission.content_url,
    submitter_wallet: submission.submitter_wallet,
    status: submission.status,
    created_at: submission.created_at,
    // Vote data
    upvotes: submission.upvotes || 0,
    downvotes: submission.downvotes || 0,
    score: submission.score || 0
  };
}

/**
 * Sanitize array of submissions
 */
function sanitizeSubmissionsArray(submissions) {
  if (!Array.isArray(submissions)) return [];
  return submissions.map(sanitizeSubmissionOutput);
}

// GET /api/submissions/:id - Get submission details
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const submissionId = parseInt(id);

  // Validate ID is a reasonable integer
  if (isNaN(submissionId) || submissionId < 1 || submissionId > 2147483647) {
    return res.status(400).json({ error: 'Invalid submission ID' });
  }

  const submission = await db.getSubmission(submissionId);

  if (!submission) {
    return res.status(404).json({ error: 'Submission not found' });
  }

  res.json(sanitizeSubmissionOutput(submission));
}));

// POST /api/submissions - Create new submission (requires wallet signature)
// Duplicate check is enforced atomically via database unique constraint
router.post('/', strictLimiter, validateSubmission, validateSubmissionSignature, asyncHandler(async (req, res) => {
  const { tokenMint, submissionType, contentUrl, submitterWallet } = req.body;

  try {
    // Create submission - database enforces uniqueness atomically via unique index
    // This prevents race conditions where duplicate check passes but insert happens twice
    const submission = await db.createSubmission({
      tokenMint,
      submissionType,
      contentUrl,
      submitterWallet: submitterWallet || null
    });

    // Clear cache for this token's submissions
    await cache.clearPattern(keys.submissions(tokenMint));

    res.status(201).json({
      ...sanitizeSubmissionOutput(submission),
      message: 'Submission created successfully. It will be visible after community approval.',
      approvalThreshold: db.AUTO_APPROVE_THRESHOLD
    });
  } catch (error) {
    // Handle duplicate submission error from database constraint
    if (error.code === 'DUPLICATE_SUBMISSION') {
      return res.status(409).json({
        error: 'This content has already been submitted for this token'
      });
    }
    throw error; // Re-throw other errors to be handled by asyncHandler
  }
}));

// GET /api/submissions/token/:mint - Get submissions for a token
router.get('/token/:mint', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  let { type, status = 'approved' } = req.query;

  // Validate query params to prevent cache poisoning
  if (type && !VALID_TYPES.includes(type)) {
    return res.status(400).json({
      error: 'Invalid submission type',
      validTypes: VALID_TYPES
    });
  }

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      error: 'Invalid status',
      validStatuses: VALID_STATUSES
    });
  }

  const cacheKey = `${keys.submissions(mint)}:${type || 'all'}:${status}`;

  // Try cache first
  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  const options = {};
  if (type) options.type = type;
  if (status !== 'all') options.status = status;

  const submissions = await db.getSubmissionsByToken(mint, options);
  const sanitized = sanitizeSubmissionsArray(submissions);

  // Cache for 30 seconds
  await cache.set(cacheKey, sanitized, TTL.SHORT);

  res.json(sanitized);
}));

// GET /api/submissions/wallet/:wallet - Get submissions by wallet
router.get('/wallet/:wallet', asyncHandler(async (req, res) => {
  const { wallet } = req.params;

  // Validate wallet
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const submissions = await db.getSubmissionsByWallet(wallet);
  res.json(sanitizeSubmissionsArray(submissions));
}));

// GET /api/submissions/pending - Get pending submissions (for moderation UI)
router.get('/status/pending', asyncHandler(async (req, res) => {
  let { limit = 50 } = req.query;

  // Validate and clamp limit
  limit = parseInt(limit);
  if (isNaN(limit) || limit < 1) limit = 50;
  if (limit > 100) limit = 100;

  const submissions = await db.getPendingSubmissions(limit);
  res.json(sanitizeSubmissionsArray(submissions));
}));

module.exports = router;
