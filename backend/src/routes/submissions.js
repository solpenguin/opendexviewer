const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { cache, TTL, keys } = require('../services/cache');
const { validateMint, validateSubmission, validateWallet, asyncHandler, requireDatabase } = require('../middleware/validation');
const { strictLimiter } = require('../middleware/rateLimit');

// All routes in this file require database access
router.use(requireDatabase);

// GET /api/submissions/:id - Get submission details
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const submissionId = parseInt(id);

  if (isNaN(submissionId)) {
    return res.status(400).json({ error: 'Invalid submission ID' });
  }

  const submission = await db.getSubmission(submissionId);

  if (!submission) {
    return res.status(404).json({ error: 'Submission not found' });
  }

  res.json(submission);
}));

// POST /api/submissions - Create new submission
router.post('/', strictLimiter, validateSubmission, validateWallet, asyncHandler(async (req, res) => {
  const { tokenMint, submissionType, contentUrl, submitterWallet } = req.body;

  // Check for duplicate submissions (same token, type, and URL)
  const existing = await db.getSubmissionsByToken(tokenMint, { type: submissionType });
  const isDuplicate = existing.some(s =>
    s.content_url.toLowerCase() === contentUrl.toLowerCase() &&
    s.status !== 'rejected'
  );

  if (isDuplicate) {
    return res.status(409).json({
      error: 'This content has already been submitted for this token'
    });
  }

  // Create submission
  const submission = await db.createSubmission({
    tokenMint,
    submissionType,
    contentUrl,
    submitterWallet: submitterWallet || null
  });

  // Clear cache for this token's submissions
  cache.clearPattern(keys.submissions(tokenMint));

  res.status(201).json({
    ...submission,
    message: 'Submission created successfully. It will be visible after community approval.',
    approvalThreshold: db.AUTO_APPROVE_THRESHOLD
  });
}));

// GET /api/submissions/token/:mint - Get submissions for a token
router.get('/token/:mint', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const { type, status = 'approved' } = req.query;

  const cacheKey = `${keys.submissions(mint)}:${type || 'all'}:${status}`;

  // Try cache first
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  const options = {};
  if (type) options.type = type;
  if (status !== 'all') options.status = status;

  const submissions = await db.getSubmissionsByToken(mint, options);

  // Cache for 30 seconds
  cache.set(cacheKey, submissions, TTL.SHORT);

  res.json(submissions);
}));

// GET /api/submissions/wallet/:wallet - Get submissions by wallet
router.get('/wallet/:wallet', asyncHandler(async (req, res) => {
  const { wallet } = req.params;

  // Validate wallet
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const submissions = await db.getSubmissionsByWallet(wallet);
  res.json(submissions);
}));

// GET /api/submissions/pending - Get pending submissions (for moderation UI)
router.get('/status/pending', asyncHandler(async (req, res) => {
  const { limit = 50 } = req.query;
  const submissions = await db.getPendingSubmissions(parseInt(limit));
  res.json(submissions);
}));

module.exports = router;
