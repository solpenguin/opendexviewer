const express = require('express');
const router = express.Router();
const db = require('../services/database');
const solanaService = require('../services/solana');
const geckoTerminal = require('../services/geckoTerminal');
const { cache, keys, TTL } = require('../services/cache');
const { validateVote, validateVoteSignature, validateBatchVotes, validateBatchVoteSignature, asyncHandler, requireDatabase } = require('../middleware/validation');
const { walletLimiter } = require('../middleware/rateLimit');
const { adminSettings } = require('./admin');

// All routes in this file require database access
router.use(requireDatabase);

/**
 * Verify holder status server-side (DO NOT trust frontend data)
 * Uses Solana RPC to verify actual token balance
 */
async function verifyHolderStatus(wallet, tokenMint) {
  const cacheKey = `holder-verify:${tokenMint}:${wallet}`;

  // Check cache first (short TTL - 30 seconds for voting verification)
  const cached = await cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    // Get token accounts for this wallet that hold the specific token
    const tokenAccounts = await solanaService.getTokenAccountsByOwner(wallet, tokenMint);

    let balance = 0;
    let decimals = 9;

    if (tokenAccounts && tokenAccounts.value && tokenAccounts.value.length > 0) {
      // Sum all token accounts for this mint (usually just one)
      for (const account of tokenAccounts.value) {
        const info = account.account?.data?.parsed?.info;
        if (info && info.mint === tokenMint) {
          balance += parseFloat(info.tokenAmount?.uiAmount || 0);
          decimals = info.tokenAmount?.decimals || 9;
        }
      }
    }

    // Get token supply for percentage calculation
    let circulatingSupply = null;
    let percentageHeld = null;

    // Try to get token info from cache for supply data
    const tokenInfo = await cache.get(keys.tokenInfo(tokenMint));
    if (tokenInfo && tokenInfo.circulatingSupply) {
      circulatingSupply = tokenInfo.circulatingSupply;
    } else if (tokenInfo && tokenInfo.supply) {
      circulatingSupply = tokenInfo.supply;
    }

    // Calculate percentage if we have supply data
    if (balance > 0 && circulatingSupply && circulatingSupply > 0) {
      percentageHeld = (balance / circulatingSupply) * 100;
    }

    const result = {
      wallet,
      mint: tokenMint,
      balance,
      decimals,
      holdsToken: balance > 0,
      circulatingSupply,
      percentageHeld: percentageHeld !== null ? parseFloat(percentageHeld.toFixed(6)) : 0,
      verifiedAt: Date.now()
    };

    // Cache for 30 seconds - short TTL to prevent abuse via token transfers after voting
    // Balance can change quickly in DeFi, so we need relatively fresh verification
    await cache.set(cacheKey, result, TTL.SHORT);

    return result;
  } catch (error) {
    // Privacy: Don't log error details
    // Return a failed verification - don't allow voting if we can't verify
    return {
      wallet,
      mint: tokenMint,
      balance: 0,
      holdsToken: false,
      percentageHeld: 0,
      error: 'Unable to verify balance'
    };
  }
}

// POST /api/votes - Cast a vote (requires holder verification and wallet signature)
router.post('/', walletLimiter, validateVote, validateVoteSignature, asyncHandler(async (req, res) => {
  const { submissionId, voterWallet, voteType } = req.body;
  const parsedId = parseInt(submissionId, 10);

  // Check if submission exists
  const submission = await db.getSubmission(parsedId);
  if (!submission) {
    return res.status(404).json({ error: 'Submission not found' });
  }

  // DEVELOPMENT MODE: Bypass holder verification for testing
  const isDevelopmentMode = adminSettings?.developmentMode === true;

  let holderData;
  let voterPercentage = 0;
  let voteWeight = 1;
  let voterBalance = 0;

  if (isDevelopmentMode) {
    // In development mode, simulate holder data
    holderData = {
      wallet: voterWallet,
      mint: submission.token_mint,
      balance: 1000000,
      holdsToken: true,
      percentageHeld: 1.0,
      verifiedAt: Date.now(),
      developmentMode: true
    };
    voterPercentage = 1.0;
    voteWeight = 1;
    voterBalance = 1000000;
    console.log('[Votes] Development mode - holder verification bypassed');
  } else {
    // SERVER-SIDE HOLDER VERIFICATION: Do NOT trust frontend holderData
    // Always verify directly from Solana RPC
    holderData = await verifyHolderStatus(voterWallet, submission.token_mint);

    // HOLDER VERIFICATION: Voter must hold the token
    if (!holderData || !holderData.holdsToken) {
      return res.status(403).json({
        error: 'You must hold this token to vote',
        code: 'NOT_HOLDER'
      });
    }

    // MINIMUM BALANCE CHECK: Voter must hold minimum percentage
    voterPercentage = holderData.percentageHeld || 0;
    if (voterPercentage < db.MIN_VOTE_BALANCE_PERCENT) {
      return res.status(403).json({
        error: `Minimum ${db.MIN_VOTE_BALANCE_PERCENT}% of supply required to vote`,
        code: 'INSUFFICIENT_BALANCE',
        required: db.MIN_VOTE_BALANCE_PERCENT,
        held: voterPercentage
      });
    }

    // Calculate vote weight based on holder percentage
    voteWeight = db.calculateVoteWeight(voterPercentage);
    voterBalance = holderData.balance || 0;
  }

  // Fetch market cap for tiered approval thresholds
  // Try cache first, then fetch from GeckoTerminal
  let marketCap = null;
  try {
    const tokenInfo = await cache.get(keys.tokenInfo(submission.token_mint));
    if (tokenInfo && tokenInfo.marketCap) {
      marketCap = tokenInfo.marketCap;
    } else {
      // Fetch fresh market data
      const marketData = await geckoTerminal.getMarketData(submission.token_mint);
      if (marketData && marketData.marketCap) {
        marketCap = marketData.marketCap;
      }
    }
  } catch (err) {
    // Privacy: Don't log error details - continue with null market cap (will use lowest threshold)
  }

  // Set market cap context for auto-moderation threshold calculation
  db.setModerationMarketCap(marketCap);

  // Check for existing vote
  const existingVote = await db.getVote(parsedId, voterWallet);

  // Vote cooldown period (10 seconds) to prevent rapid vote flipping
  const VOTE_COOLDOWN_MS = 10 * 1000;

  let result;

  if (existingVote) {
    // Check vote cooldown - prevent rapid vote changes
    const lastVoteTime = new Date(existingVote.updated_at || existingVote.created_at).getTime();
    const timeSinceLastVote = Date.now() - lastVoteTime;

    if (timeSinceLastVote < VOTE_COOLDOWN_MS) {
      const remainingSeconds = Math.ceil((VOTE_COOLDOWN_MS - timeSinceLastVote) / 1000);
      return res.status(429).json({
        error: `Please wait ${remainingSeconds} seconds before changing your vote`,
        code: 'VOTE_COOLDOWN',
        retryAfter: remainingSeconds
      });
    }

    if (existingVote.vote_type === voteType) {
      // Same vote - remove it (toggle off)
      await db.deleteVote(parsedId, voterWallet);
      result = { message: 'Vote removed', action: 'removed', voteWeight: 0 };
    } else {
      // Different vote - update it (with new weight based on current balance)
      await db.updateVote(parsedId, voterWallet, voteType);
      result = { message: 'Vote updated', action: 'updated', voteType, voteWeight };
    }
  } else {
    // Create new vote with holder data
    await db.createVote({
      submissionId: parsedId,
      voterWallet,
      voteType,
      voterBalance,
      voterPercentage
    });
    result = { message: 'Vote cast', action: 'created', voteType, voteWeight };
  }

  // Clear cache for this token's submissions
  await cache.clearPattern(keys.submissions(submission.token_mint));

  // Get updated tally
  const tally = await db.getVoteTally(parsedId);

  // Check if submission was auto-moderated
  const updatedSubmission = await db.getSubmission(parsedId);

  res.json({
    ...result,
    tally: {
      upvotes: tally?.upvotes || 0,
      downvotes: tally?.downvotes || 0,
      score: tally?.score || 0,
      weightedScore: parseFloat(tally?.weighted_score) || 0
    },
    submissionStatus: updatedSubmission?.status || 'unknown'
    // Privacy: Don't expose voterInfo (balance, percentage, weight) in response
  });
}));

// POST /api/votes/batch - Cast multiple votes with a single signature
router.post('/batch', walletLimiter, validateBatchVotes, validateBatchVoteSignature, asyncHandler(async (req, res) => {
  const { votes, voterWallet } = req.body;

  const results = [];
  const errors = [];
  const tokensToInvalidate = new Set();

  // DEVELOPMENT MODE: Bypass holder verification for testing
  const isDevelopmentMode = adminSettings?.developmentMode === true;

  for (const vote of votes) {
    const { submissionId, voteType } = vote;

    try {
      // Check if submission exists
      const submission = await db.getSubmission(submissionId);
      if (!submission) {
        errors.push({
          submissionId,
          success: false,
          error: 'Submission not found'
        });
        continue;
      }

      let voterPercentage = 0;
      let voteWeight = 1;
      let voterBalance = 0;

      if (isDevelopmentMode) {
        // In development mode, simulate holder data
        voterPercentage = 1.0;
        voteWeight = 1;
        voterBalance = 1000000;
      } else {
        // SERVER-SIDE HOLDER VERIFICATION
        const holderData = await verifyHolderStatus(voterWallet, submission.token_mint);

        if (!holderData || !holderData.holdsToken) {
          errors.push({
            submissionId,
            success: false,
            error: 'You must hold this token to vote',
            code: 'NOT_HOLDER'
          });
          continue;
        }

        voterPercentage = holderData.percentageHeld || 0;
        if (voterPercentage < db.MIN_VOTE_BALANCE_PERCENT) {
          errors.push({
            submissionId,
            success: false,
            error: `Minimum ${db.MIN_VOTE_BALANCE_PERCENT}% of supply required to vote`,
            code: 'INSUFFICIENT_BALANCE'
          });
          continue;
        }

        voteWeight = db.calculateVoteWeight(voterPercentage);
        voterBalance = holderData.balance || 0;
      }

      // Check for existing vote
      const existingVote = await db.getVote(submissionId, voterWallet);

      let result;
      if (existingVote) {
        if (existingVote.vote_type === voteType) {
          // Same vote - remove it (toggle off)
          await db.deleteVote(submissionId, voterWallet);
          result = { action: 'removed', voteWeight: 0 };
        } else {
          // Different vote - update it
          await db.updateVote(submissionId, voterWallet, voteType);
          result = { action: 'updated', voteType, voteWeight };
        }
      } else {
        // Create new vote
        await db.createVote({
          submissionId,
          voterWallet,
          voteType,
          voterBalance,
          voterPercentage
        });
        result = { action: 'created', voteType, voteWeight };
      }

      // Track tokens to invalidate cache
      tokensToInvalidate.add(submission.token_mint);

      // Get updated tally
      const tally = await db.getVoteTally(submissionId);
      const updatedSubmission = await db.getSubmission(submissionId);

      results.push({
        submissionId,
        success: true,
        ...result,
        tally: {
          upvotes: tally?.upvotes || 0,
          downvotes: tally?.downvotes || 0,
          score: tally?.score || 0,
          weightedScore: parseFloat(tally?.weighted_score) || 0
        },
        submissionStatus: updatedSubmission?.status || 'unknown'
      });
    } catch (error) {
      errors.push({
        submissionId,
        success: false,
        error: error.message || 'Failed to process vote'
      });
    }
  }

  // Clear cache for all affected tokens
  for (const tokenMint of tokensToInvalidate) {
    await cache.clearPattern(keys.submissions(tokenMint));
  }

  // Return results
  const successCount = results.length;
  const errorCount = errors.length;

  if (successCount === 0 && errorCount > 0) {
    return res.status(400).json({
      message: 'All votes failed',
      results: [],
      errors,
      successCount: 0,
      errorCount
    });
  }

  res.json({
    message: successCount === votes.length
      ? 'All votes processed successfully'
      : `${successCount} of ${votes.length} votes processed`,
    results,
    errors,
    successCount,
    errorCount
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
  const submission = await db.getSubmission(parsedId);

  // Calculate time until eligible for auto-approval (in minutes)
  let minutesUntilEligible = 0;
  let isFirstSubmission = false;
  let effectiveReviewMinutes = db.MIN_REVIEW_MINUTES;
  let marketCap = null;
  let effectiveApprovalThreshold = db.AUTO_APPROVE_THRESHOLD;

  if (submission && submission.status === 'pending') {
    // Check if this token has any approved submissions (determines review period)
    const approvedSubmissions = await db.getApprovedSubmissions(submission.token_mint);
    isFirstSubmission = approvedSubmissions.length === 0;
    effectiveReviewMinutes = isFirstSubmission ? db.FIRST_SUBMISSION_REVIEW_MINUTES : db.MIN_REVIEW_MINUTES;

    const createdAt = new Date(submission.created_at);
    const now = new Date();
    const minutesSinceCreation = (now - createdAt) / (1000 * 60);
    minutesUntilEligible = Math.max(0, effectiveReviewMinutes - minutesSinceCreation);

    // Fetch market cap for tiered threshold display
    try {
      const tokenInfo = await cache.get(keys.tokenInfo(submission.token_mint));
      if (tokenInfo && tokenInfo.marketCap) {
        marketCap = tokenInfo.marketCap;
      } else {
        const marketData = await geckoTerminal.getMarketData(submission.token_mint);
        if (marketData && marketData.marketCap) {
          marketCap = marketData.marketCap;
        }
      }
      effectiveApprovalThreshold = db.getApprovalThreshold(marketCap);
    } catch (err) {
      // Use default threshold on error
    }
  }

  res.json({
    submissionId: parsedId,
    upvotes: tally?.upvotes || 0,
    downvotes: tally?.downvotes || 0,
    score: tally?.score || 0,
    weightedScore: parseFloat(tally?.weighted_score) || 0,
    // Voting requirements info
    requirements: {
      approvalThreshold: effectiveApprovalThreshold,
      rejectThreshold: db.AUTO_REJECT_THRESHOLD,
      approvalThresholdTiers: db.APPROVAL_THRESHOLDS,
      marketCap: marketCap,
      minReviewMinutes: effectiveReviewMinutes,
      firstSubmissionReviewMinutes: db.FIRST_SUBMISSION_REVIEW_MINUTES,
      standardReviewMinutes: db.MIN_REVIEW_MINUTES,
      isFirstSubmission,
      minVoteBalancePercent: db.MIN_VOTE_BALANCE_PERCENT,
      minutesUntilEligible: parseFloat(minutesUntilEligible.toFixed(2)),
      voteWeightTiers: db.VOTE_WEIGHT_TIERS
    }
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
    // Privacy: Don't expose voteWeight, voterBalance, voterPercentage in response
  });
}));

// POST /api/votes/bulk-check - Check multiple votes at once
router.post('/bulk-check', walletLimiter, asyncHandler(async (req, res) => {
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

  // Validate all IDs are valid integers - reject if any are invalid
  const parsedIds = [];
  for (const id of submissionIds) {
    const parsed = parseInt(id);
    if (isNaN(parsed) || parsed <= 0) {
      return res.status(400).json({ error: `Invalid submission ID: ${id}` });
    }
    parsedIds.push(parsed);
  }

  // Use batch query for efficiency
  const votes = await db.getVotesBatch(parsedIds, wallet);

  // Build results map
  const results = {};
  for (const id of parsedIds) {
    const vote = votes.find(v => v.submission_id === id);
    results[id] = {
      hasVoted: !!vote,
      voteType: vote?.vote_type || null
    };
  }

  res.json(results);
}));

// GET /api/votes/requirements - Get voting requirements and thresholds
router.get('/requirements', asyncHandler(async (req, res) => {
  res.json({
    approvalThresholdTiers: db.APPROVAL_THRESHOLDS,
    approvalThresholdMax: db.AUTO_APPROVE_THRESHOLD,
    rejectThreshold: db.AUTO_REJECT_THRESHOLD,
    minReviewMinutes: db.MIN_REVIEW_MINUTES,
    firstSubmissionReviewMinutes: db.FIRST_SUBMISSION_REVIEW_MINUTES,
    minVoteBalancePercent: db.MIN_VOTE_BALANCE_PERCENT,
    voteWeightTiers: db.VOTE_WEIGHT_TIERS,
    description: {
      holderRequired: 'You must hold the token to vote on submissions',
      minBalance: `You need at least ${db.MIN_VOTE_BALANCE_PERCENT}% of supply to vote`,
      voteWeight: 'Vote weight scales from 1x (0.1% holdings) to 3x (3%+ holdings)',
      weightTiers: '0.1%=1x, 0.3%=1.5x, 0.75%=2x, 1.5%=2.5x, 3%+=3x',
      reviewPeriod: `First submission: ${db.FIRST_SUBMISSION_REVIEW_MINUTES} min review, subsequent: ${db.MIN_REVIEW_MINUTES} min`,
      approvalScore: `Approval threshold based on market cap: <$50k = +10, $50k-$100k = +15, >$100k = +25`,
      rejectionScore: `Submissions are auto-rejected at ${db.AUTO_REJECT_THRESHOLD} weighted score`
    }
  });
}));

module.exports = router;
