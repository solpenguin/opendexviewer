// Voting System Logic
const voting = {
  // Track vote state for optimistic updates
  pendingVotes: new Set(),
  voteStates: new Map(),
  holderCache: new Map(), // Cache holder status per token
  holderCacheMaxSize: 100, // Maximum cache entries to prevent memory leak

  // Voting requirements (loaded from server)
  requirements: {
    minVoteBalancePercent: 0.001,
    approvalThreshold: 10,
    rejectThreshold: -10,
    minReviewMinutes: 5,
    voteWeightTiers: []
  },

  // Get the token mint for a submission
  getTokenMintForSubmission(submissionId) {
    // Try to get from tokenDetail if available
    if (typeof tokenDetail !== 'undefined' && tokenDetail.mint) {
      return tokenDetail.mint;
    }
    // Try to get from DOM
    const container = document.querySelector(`[data-submission-id="${submissionId}"]`);
    if (container && container.dataset.tokenMint) {
      return container.dataset.tokenMint;
    }
    // Fallback: get from submission data
    if (typeof tokenDetail !== 'undefined' && tokenDetail.submissions) {
      const sub = tokenDetail.submissions.find(s => s.id === submissionId);
      if (sub) return sub.token_mint;
    }
    return null;
  },

  // Check if wallet holds the token
  // forceRefresh: true to bypass cache and get fresh data (used before voting)
  async checkHolderStatus(tokenMint, forceRefresh = false) {
    if (!wallet.connected || !tokenMint) return null;

    // Use pipe separator to prevent cache key collisions if mint contains colons
    const cacheKey = `${tokenMint}|${wallet.address}`;

    // Check cache first (valid for 2 minutes) unless force refresh
    if (!forceRefresh) {
      const cached = this.holderCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < 120000) {
        return cached.data;
      }
    }

    try {
      const holderData = await api.tokens.getHolderBalance(tokenMint, wallet.address);

      // Evict oldest entries if cache is full (LRU-style eviction)
      if (this.holderCache.size >= this.holderCacheMaxSize) {
        const oldestKey = this.holderCache.keys().next().value;
        this.holderCache.delete(oldestKey);
      }

      this.holderCache.set(cacheKey, { data: holderData, timestamp: Date.now() });
      return holderData;
    } catch (error) {
      console.error('Failed to check holder status:', error);
      return null;
    }
  },

  // Create signature message for vote (must match backend)
  createVoteSignatureMessage(voteType, submissionId, timestamp) {
    return `OpenDex Vote: ${voteType} on submission #${submissionId} at ${timestamp}`;
  },

  // Cast a vote (now with holder verification and wallet signature)
  async vote(submissionId, voteType) {
    // Prevent double-voting while a vote is pending
    if (this.pendingVotes.has(submissionId)) {
      return;
    }

    // Check wallet connection
    if (!wallet.connected) {
      const connected = await wallet.connect();
      if (!connected) {
        toast.warning('Please connect your wallet to vote');
        return;
      }
    }

    // Get token mint for this submission
    const tokenMint = this.getTokenMintForSubmission(submissionId);
    if (!tokenMint) {
      toast.error('Unable to verify token - please refresh the page');
      return;
    }

    // Check holder status BEFORE voting - force refresh to get current balance
    const holderData = await this.checkHolderStatus(tokenMint, true);

    if (!holderData || !holderData.holdsToken) {
      toast.error('You must hold this token to vote');
      this.showHolderRequiredModal(tokenMint);
      return;
    }

    // Check minimum balance requirement (with proper null/NaN handling)
    const percentageHeld = parseFloat(holderData.percentageHeld);
    if (isNaN(percentageHeld) || percentageHeld < this.requirements.minVoteBalancePercent) {
      toast.error(`Minimum ${this.requirements.minVoteBalancePercent}% of supply required to vote`);
      this.showInsufficientBalanceModal(holderData, this.requirements.minVoteBalancePercent);
      return;
    }

    // Sign the vote with wallet
    const timestamp = Date.now();
    const message = this.createVoteSignatureMessage(voteType, submissionId, timestamp);

    let signatureData;
    try {
      signatureData = await wallet.signMessage(message);
    } catch (error) {
      console.error('Failed to sign vote:', error);
      if (error.message?.includes('User rejected')) {
        toast.warning('Vote cancelled - signature required');
      } else {
        toast.error('Failed to sign vote. Please try again.');
      }
      return;
    }

    // Get current vote state
    const currentVote = this.voteStates.get(submissionId);
    const isSameVote = currentVote === voteType;

    // Optimistic update
    this.pendingVotes.add(submissionId);
    this.updateVoteUI(submissionId, isSameVote ? null : voteType, true);

    try {
      const result = await api.votes.cast({
        submissionId,
        voterWallet: wallet.address,
        voteType,
        signature: signatureData.signature,
        signatureTimestamp: timestamp
      });

      // Update the vote state
      if (result.action === 'removed') {
        this.voteStates.delete(submissionId);
      } else {
        this.voteStates.set(submissionId, voteType);
      }

      // Show success feedback with vote weight
      this.showVoteFeedback(result);

      // Update the vote counts from the response
      const tally = result.tally || {};
      this.updateVoteCounts(submissionId, tally.upvotes, tally.downvotes, tally.score, tally.weightedScore);

    } catch (error) {
      console.error('Vote failed:', error);

      // Revert optimistic update
      this.updateVoteUI(submissionId, currentVote, false);

      // Handle specific error codes
      if (error.message && error.message.includes('NOT_HOLDER')) {
        toast.error('You must hold this token to vote');
      } else if (error.message && error.message.includes('INSUFFICIENT_BALANCE')) {
        toast.error('Insufficient token balance to vote');
      } else if (error.message && error.message.includes('SIGNATURE_EXPIRED')) {
        toast.error('Signature expired - please try again');
      } else if (error.message && error.message.includes('INVALID_SIGNATURE')) {
        toast.error('Invalid signature - please reconnect your wallet');
      } else if (error.message && error.message.includes('VOTE_COOLDOWN')) {
        // Extract seconds from error message if available
        const match = error.message.match(/wait (\d+) seconds/);
        const seconds = match ? match[1] : '10';
        toast.warning(`Please wait ${seconds}s before changing your vote`);
      } else {
        toast.error('Failed to cast vote. Please try again.');
      }
    } finally {
      this.pendingVotes.delete(submissionId);
    }
  },

  // Show modal explaining holder requirement
  showHolderRequiredModal(tokenMint) {
    const modal = document.createElement('div');
    modal.className = 'voting-modal-overlay';
    modal.innerHTML = `
      <div class="voting-modal">
        <div class="voting-modal-icon error">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        </div>
        <h3>Token Holder Required</h3>
        <p>You must hold this token to vote on community submissions. This ensures only genuine stakeholders can influence content decisions.</p>
        <div class="voting-modal-actions">
          <button class="btn btn-primary" onclick="this.closest('.voting-modal-overlay').remove()">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  },

  // Escape HTML to prevent XSS
  escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  },

  // Show modal for insufficient balance
  showInsufficientBalanceModal(holderData, required) {
    // Safely escape all user-controlled values
    const safeRequired = this.escapeHtml(String(required));
    const safeBalance = this.escapeHtml((holderData.balance || 0).toLocaleString());
    const safePercentage = this.escapeHtml((parseFloat(holderData.percentageHeld) || 0).toFixed(6));

    const modal = document.createElement('div');
    modal.className = 'voting-modal-overlay';
    modal.innerHTML = `
      <div class="voting-modal">
        <div class="voting-modal-icon warning">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>
        <h3>Insufficient Balance</h3>
        <p>You need at least <strong>${safeRequired}%</strong> of the token supply to vote.</p>
        <div class="holder-balance-info">
          <div class="balance-row">
            <span>Your balance:</span>
            <span>${safeBalance} tokens</span>
          </div>
          <div class="balance-row">
            <span>Your share:</span>
            <span>${safePercentage}%</span>
          </div>
          <div class="balance-row required">
            <span>Required:</span>
            <span>${safeRequired}%</span>
          </div>
        </div>
        <div class="voting-modal-actions">
          <button class="btn btn-primary" onclick="this.closest('.voting-modal-overlay').remove()">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  },

  // Update vote UI (buttons and counts)
  updateVoteUI(submissionId, voteType, isPending = false) {
    // Find all vote button containers for this submission
    const containers = document.querySelectorAll(`[data-submission-id="${submissionId}"]`);

    containers.forEach(container => {
      const upBtn = container.querySelector('.vote-up');
      const downBtn = container.querySelector('.vote-down');

      if (upBtn && downBtn) {
        // Update button states
        upBtn.classList.toggle('voted', voteType === 'up');
        downBtn.classList.toggle('voted', voteType === 'down');

        // Add pending state
        upBtn.classList.toggle('pending', isPending);
        downBtn.classList.toggle('pending', isPending);
      }
    });

    // Also update any inline vote buttons (for submissions rendered differently)
    const upBtns = document.querySelectorAll(`.vote-up[data-submission="${submissionId}"]`);
    const downBtns = document.querySelectorAll(`.vote-down[data-submission="${submissionId}"]`);

    upBtns.forEach(btn => {
      btn.classList.toggle('voted', voteType === 'up');
      btn.classList.toggle('pending', isPending);
    });

    downBtns.forEach(btn => {
      btn.classList.toggle('voted', voteType === 'down');
      btn.classList.toggle('pending', isPending);
    });
  },

  // Update vote counts in the UI
  updateVoteCounts(submissionId, upvotes, downvotes, score, weightedScore = null) {
    // Find all elements displaying vote counts for this submission
    const upCountEls = document.querySelectorAll(`[data-upvotes="${submissionId}"]`);
    const downCountEls = document.querySelectorAll(`[data-downvotes="${submissionId}"]`);
    const scoreEls = document.querySelectorAll(`[data-score="${submissionId}"]`);
    const weightedScoreEls = document.querySelectorAll(`[data-weighted-score="${submissionId}"]`);

    upCountEls.forEach(el => {
      el.textContent = upvotes;
      this.animateCount(el);
    });

    downCountEls.forEach(el => {
      el.textContent = downvotes;
      this.animateCount(el);
    });

    scoreEls.forEach(el => {
      el.textContent = score;
      el.classList.toggle('positive', score >= 0);
      el.classList.toggle('negative', score < 0);
      this.animateCount(el);
    });

    // Update weighted score displays
    if (weightedScore !== null) {
      weightedScoreEls.forEach(el => {
        el.textContent = weightedScore.toFixed(1);
        el.classList.toggle('positive', weightedScore >= 0);
        el.classList.toggle('negative', weightedScore < 0);
        this.animateCount(el);
      });
    }

    // Also update banner voting if present
    const bannerUpvotes = document.getElementById('banner-upvotes');
    const bannerDownvotes = document.getElementById('banner-downvotes');

    if (bannerUpvotes && bannerUpvotes.dataset.submissionId === String(submissionId)) {
      bannerUpvotes.textContent = upvotes;
      this.animateCount(bannerUpvotes);
    }

    if (bannerDownvotes && bannerDownvotes.dataset.submissionId === String(submissionId)) {
      bannerDownvotes.textContent = downvotes;
      this.animateCount(bannerDownvotes);
    }

    // Refresh submissions on token detail page for full re-render
    if (typeof tokenDetail !== 'undefined' && tokenDetail.submissions) {
      // Update the local submission data
      const submission = tokenDetail.submissions.find(s => s.id === submissionId);
      if (submission) {
        submission.upvotes = upvotes;
        submission.downvotes = downvotes;
        submission.score = score;
        if (weightedScore !== null) {
          submission.weighted_score = weightedScore;
        }
      }
    }
  },

  // Animate count change
  animateCount(element) {
    element.classList.add('count-updated');
    setTimeout(() => element.classList.remove('count-updated'), 300);
  },

  // Show vote feedback using toast system
  showVoteFeedback(result) {
    const weight = result.voteWeight || 1;
    const weightText = weight > 1 ? ` (${weight}x weight)` : '';

    const messages = {
      created: {
        up: `Upvoted!${weightText}`,
        down: `Downvoted!${weightText}`
      },
      updated: {
        up: `Changed to upvote${weightText}`,
        down: `Changed to downvote${weightText}`
      },
      removed: 'Vote removed'
    };

    let message;
    if (result.action === 'removed') {
      message = messages.removed;
    } else {
      message = messages[result.action]?.[result.voteType] || 'Vote recorded';
    }

    const icon = result.action === 'removed' ? '' : result.voteType === 'up' ? '+1' : '-1';

    toast.show(icon ? `${icon} ${message}` : message, result.voteType === 'up' ? 'success' : result.voteType === 'down' ? 'error' : 'info', 2500);
  },

  // Check user's vote status for a submission
  async checkVote(submissionId) {
    if (!wallet.connected) return null;

    try {
      const result = await api.votes.check(submissionId, wallet.address);

      if (result && result.hasVoted) {
        this.voteStates.set(submissionId, result.voteType);
      }

      return result;
    } catch (error) {
      console.error('Failed to check vote:', error);
      return null;
    }
  },

  // Check votes for multiple submissions
  async checkMultipleVotes(submissionIds) {
    if (!wallet.connected || submissionIds.length === 0) return;

    try {
      const results = await api.votes.checkBulk(submissionIds, wallet.address);

      results.forEach(result => {
        if (result.hasVoted) {
          this.voteStates.set(result.submissionId, result.voteType);
          this.updateVoteUI(result.submissionId, result.voteType, false);
        }
      });
    } catch (error) {
      console.error('Failed to check bulk votes:', error);
    }
  },

  // Update vote buttons to show user's current vote
  async updateVoteButtons(submissionId, upBtn, downBtn) {
    const voteStatus = await this.checkVote(submissionId);

    if (!voteStatus || !voteStatus.hasVoted) {
      upBtn.classList.remove('voted');
      downBtn.classList.remove('voted');
      return;
    }

    if (voteStatus.voteType === 'up') {
      upBtn.classList.add('voted');
      downBtn.classList.remove('voted');
    } else {
      upBtn.classList.remove('voted');
      downBtn.classList.add('voted');
    }
  },

  // Initialize voting for a page
  async initForPage() {
    // Load voting requirements from server
    await this.loadRequirements();

    if (!wallet.connected) return;

    // Find all submissions on the page
    const submissionEls = document.querySelectorAll('[data-submission-id]');
    const submissionIds = [...new Set([...submissionEls].map(el => parseInt(el.dataset.submissionId)))].filter(id => !isNaN(id));

    if (submissionIds.length > 0) {
      await this.checkMultipleVotes(submissionIds);
    }
  },

  // Load voting requirements from server
  async loadRequirements() {
    try {
      const reqs = await api.votes.getRequirements();
      this.requirements = {
        minVoteBalancePercent: reqs.minVoteBalancePercent || 0.001,
        approvalThreshold: reqs.approvalThreshold || 10,
        rejectThreshold: reqs.rejectThreshold || -10,
        minReviewMinutes: reqs.minReviewMinutes || 5,
        voteWeightTiers: reqs.voteWeightTiers || []
      };
    } catch (error) {
      // Use defaults if fetch fails
      console.warn('Failed to load voting requirements, using defaults:', error.message);
    }
  },

  // Show voting info modal (explains how voting works)
  showVotingInfoModal() {
    const tiers = this.requirements.voteWeightTiers || [];
    const tiersHtml = tiers.map(t =>
      `<div class="tier-row">
        <span>≥${t.minPercent}% holdings</span>
        <span>${t.weight}x vote weight</span>
      </div>`
    ).join('');

    const modal = document.createElement('div');
    modal.className = 'voting-modal-overlay';
    modal.innerHTML = `
      <div class="voting-modal" style="max-width: 450px;">
        <div class="voting-modal-icon success">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
        </div>
        <h3>How Voting Works</h3>
        <div class="voting-info-content">
          <div class="voting-rule">
            <strong>Holder Verification</strong>
            <p>You must hold the token to vote on its community submissions.</p>
          </div>
          <div class="voting-rule">
            <strong>Minimum Balance</strong>
            <p>At least ${this.requirements.minVoteBalancePercent}% of supply required to vote.</p>
          </div>
          <div class="voting-rule">
            <strong>Vote Weight</strong>
            <p>Larger holders have more voting power:</p>
            <div class="vote-tiers">${tiersHtml}</div>
          </div>
          <div class="voting-rule">
            <strong>Auto-Moderation</strong>
            <p>Submissions are auto-approved at +${this.requirements.approvalThreshold} weighted score (requires ~10% of supply) after ${this.requirements.minReviewMinutes} minute(s) of review.</p>
          </div>
        </div>
        <div class="voting-modal-actions">
          <button class="btn btn-primary" onclick="this.closest('.voting-modal-overlay').remove()">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  },

  // Reset all vote states (e.g., on wallet disconnect)
  reset() {
    this.voteStates.clear();
    this.pendingVotes.clear();
    this.holderCache.clear();

    // Remove all voted classes
    document.querySelectorAll('.vote-btn.voted').forEach(btn => {
      btn.classList.remove('voted');
    });
  }
};

// Listen for wallet connection to update vote buttons
window.addEventListener('walletConnected', () => {
  voting.initForPage();
});

// Listen for wallet disconnection to reset vote states
window.addEventListener('walletDisconnected', () => {
  voting.reset();
});

// Add voting-specific CSS
(function addVotingStyles() {
  if (document.getElementById('voting-dynamic-styles')) return;

  const style = document.createElement('style');
  style.id = 'voting-dynamic-styles';
  style.textContent = `
    /* Vote button states */
    .vote-btn {
      transition: all 0.15s ease;
    }

    .vote-btn.pending {
      opacity: 0.6;
      pointer-events: none;
    }

    .vote-btn.voted.vote-up {
      color: var(--green) !important;
      border-color: var(--green) !important;
      background: var(--green-light) !important;
    }

    .vote-btn.voted.vote-down {
      color: var(--red) !important;
      border-color: var(--red) !important;
      background: var(--red-light) !important;
    }

    /* Count animation */
    .count-updated {
      animation: countPop 0.3s ease;
    }

    @keyframes countPop {
      0% { transform: scale(1); }
      50% { transform: scale(1.3); }
      100% { transform: scale(1); }
    }

    /* Vote button hover effects */
    .vote-btn:not(.pending):hover {
      transform: translateY(-1px);
    }

    .vote-btn:active {
      transform: scale(0.95);
    }

    /* Voting feedback pulse */
    .vote-btn.just-voted {
      animation: votePulse 0.5s ease;
    }

    @keyframes votePulse {
      0%, 100% { box-shadow: 0 0 0 0 transparent; }
      50% { box-shadow: 0 0 0 4px var(--accent-light); }
    }
  `;

  document.head.appendChild(style);
})();
