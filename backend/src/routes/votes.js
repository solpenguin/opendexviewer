const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { cache, keys } = require('../services/cache');
const { validateVote, asyncHandler, requireDatabase } = require('../middleware/validation');
const { walletLimiter } = require('../middleware/rateLimit');

// All routes in this file require database access
router.use(requireDatabase);

// POST /api/votes - Cast a vote
router.post('/', walletLimiter, validateVote, asyncHandler(async (req, res) => {
  const { submissionId, voterWallet, voteType } = req.body;
  const parsedId = parseInt(submissionId);

  // Check if submission exists
  const submission = await db.getSubmission(parsedId);
  if (!submission) {
    return res.status(404).json({ error: 'Submission not found' });
  }

  // Check for existing vote
  const existingVote = await db.getVote(parsedId, voterWallet);

  let result;

  if (existingVote) {
    if (existingVote.vote_type === voteType) {
      // Same vote - remove it (toggle off)
      await db.deleteVote(parsedId, voterWallet);
      result = { message: 'Vote removed', action: 'removed' };
    } else {
      // Different vote - update it
      await db.updateVote(parsedId, voterWallet, voteType);
      result = { message: 'Vote updated', action: 'updated', voteType };
    }
  } else {
    // Create new vote
    await db.createVote({
      submissionId: parsedId,
      voterWallet,
      voteType
    });
    result = { message: 'Vote cast', action: 'created', voteType };
  }

  // Clear cache for this token's submissions
  cache.clearPattern(keys.submissions(submission.token_mint));

  // Get updated tally
  const tally = await db.getVoteTally(parsedId);

  // Check if submission was auto-moderated
  const updatedSubmission = await db.getSubmission(parsedId);

  res.json({
    ...result,
    tally: {
      upvotes: tally?.upvotes || 0,
      downvotes: tally?.downvotes || 0,
      score: tally?.score || 0
    },
    submissionStatus: updatedSubmission.status
  });
}));

// GET /api/votes/submission/:id - Get votes for a submission
router.get('/submission/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const parsedId = parseInt(id);

  if (isNaN(parsedId)) {
    return res.status(400).json({ error: 'Invalid submission ID' });
  }

  const tally = await db.getVoteTally(parsedId);

  res.json({
    submissionId: parsedId,
    upvotes: tally?.upvotes || 0,
    downvotes: tally?.downvotes || 0,
    score: tally?.score || 0,
    approvalThreshold: db.AUTO_APPROVE_THRESHOLD,
    rejectThreshold: db.AUTO_REJECT_THRESHOLD
  });
}));

// GET /api/votes/check - Check if wallet has voted
router.get('/check', asyncHandler(async (req, res) => {
  const { submissionId, wallet } = req.query;

  if (!submissionId || !wallet) {
    return res.status(400).json({ error: 'Missing submissionId or wallet' });
  }

  // Validate wallet
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const vote = await db.getVote(parseInt(submissionId), wallet);

  res.json({
    hasVoted: !!vote,
    voteType: vote?.vote_type || null,
    votedAt: vote?.created_at || null
  });
}));

// GET /api/votes/bulk-check - Check multiple votes at once
router.post('/bulk-check', asyncHandler(async (req, res) => {
  const { submissionIds, wallet } = req.body;

  if (!Array.isArray(submissionIds) || !wallet) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (submissionIds.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 submissions per request' });
  }

  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const results = {};

  for (const id of submissionIds) {
    const vote = await db.getVote(parseInt(id), wallet);
    results[id] = {
      hasVoted: !!vote,
      voteType: vote?.vote_type || null
    };
  }

  res.json(results);
}));

module.exports = router;
