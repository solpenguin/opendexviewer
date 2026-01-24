// Voting System Logic
const voting = {
  // Track vote state for optimistic updates
  pendingVotes: new Set(),
  voteStates: new Map(),
  holderCache: new Map(), // Cache holder status per token
  holderCacheMaxSize: 100, // Maximum cache entries to prevent memory leak
  developmentMode: false, // When true, bypasses holder verification

  // Vote queue for batch submission
  voteQueue: new Map(), // Map of submissionId -> voteType
  voteQueueTimeout: null, // Timeout for debounced batch submission
  voteQueueDelay: 500, // ms to wait before submitting batch (allows collecting multiple votes)

  // Voting requirements (loaded from server)
  requirements: {
    minVoteBalancePercent: 0.001,
    approvalThreshold: 10,
    rejectThreshold: -10,
    minReviewMinutes: 5,
    voteWeightTiers: []
  },

  // Check if development mode is enabled
  async checkDevelopmentMode() {
    try {
      const result = await api.admin.getDevelopmentMode();
      this.developmentMode = result.developmentMode === true;
      if (this.developmentMode) {
        console.log('[Voting] Development mode enabled - holder verification bypassed');
      }
    } catch (error) {
      // Development mode check failed, default to disabled
      this.developmentMode = false;
    }
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

  // Create signature message for batch votes (must match backend)
  // Format: "OpenDex Vote Batch: up:[ids];down:[ids] for wallet at [timestamp]"
  createBatchVoteSignatureMessage(votes, wallet, timestamp) {
    // Group votes by type and sort IDs
    const upVotes = votes.filter(v => v.voteType === 'up').map(v => v.submissionId).sort((a, b) => a - b);
    const downVotes = votes.filter(v => v.voteType === 'down').map(v => v.submissionId).sort((a, b) => a - b);

    const parts = [];
    if (upVotes.length > 0) parts.push(`up:${upVotes.join(',')}`);
    if (downVotes.length > 0) parts.push(`down:${downVotes.join(',')}`);

    return `OpenDex Vote Batch: ${parts.join(';')} for ${wallet} at ${timestamp}`;
  },

  // Cast a vote - queues votes and submits them in batches with a single signature
  // This allows users to click multiple vote buttons quickly without multiple signature requests
  async vote(submissionId, voteType) {
    // Prevent double-voting - check if already in queue or pending
    if (this.pendingVotes.has(submissionId)) {
      return;
    }

    // Check wallet connection first
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

    // DEVELOPMENT MODE: Skip holder verification when enabled
    if (!this.developmentMode) {
      // Check holder status BEFORE voting - use cached value for quick validation
      const holderData = await this.checkHolderStatus(tokenMint, false);

      if (!holderData || !holderData.holdsToken) {
        toast.error('You must hold this token to vote');
        this.showHolderRequiredModal(tokenMint);
        return;
      }

      const percentageHeld = parseFloat(holderData.percentageHeld);
      if (isNaN(percentageHeld) || percentageHeld < this.requirements.minVoteBalancePercent) {
        toast.error(`Minimum ${this.requirements.minVoteBalancePercent}% of supply required to vote`);
        this.showInsufficientBalanceModal(holderData, this.requirements.minVoteBalancePercent);
        return;
      }
    }

    // Get current vote state to determine action
    const currentVote = this.voteStates.get(submissionId);
    const isSameVote = currentVote === voteType;

    // Update UI immediately (optimistic update)
    this.updateVoteUI(submissionId, isSameVote ? null : voteType, true);

    // Add to queue (or update existing entry)
    this.voteQueue.set(submissionId, voteType);

    // Clear existing timeout
    if (this.voteQueueTimeout) {
      clearTimeout(this.voteQueueTimeout);
    }

    // Set timeout to submit batch after delay (allows collecting multiple votes)
    this.voteQueueTimeout = setTimeout(() => {
      this.submitQueuedVotes();
    }, this.voteQueueDelay);
  },

  // Submit all queued votes as a batch
  async submitQueuedVotes() {
    if (this.voteQueue.size === 0) {
      return;
    }

    // Copy queue and clear it
    const votes = Array.from(this.voteQueue.entries()).map(([submissionId, voteType]) => ({
      submissionId,
      voteType
    }));
    this.voteQueue.clear();
    this.voteQueueTimeout = null;

    // Mark all as pending
    votes.forEach(v => this.pendingVotes.add(v.submissionId));

    try {
      // Use batch voting for all queued votes
      await this.voteBatch(votes);
    } finally {
      // Note: pendingVotes are cleared in voteBatch
    }
  },

  // Cast multiple votes with a single signature (batch voting)
  // votes: Array of {submissionId, voteType}
  async voteBatch(votes) {
    if (!votes || votes.length === 0) {
      toast.warning('No votes to submit');
      return;
    }

    // Check if any votes are already pending
    const pendingIds = votes.filter(v => this.pendingVotes.has(v.submissionId));
    if (pendingIds.length > 0) {
      toast.warning('Some votes are already being processed');
      return;
    }

    // Mark all as pending
    votes.forEach(v => this.pendingVotes.add(v.submissionId));

    try {
      // Check wallet connection
      if (!wallet.connected) {
        const connected = await wallet.connect();
        if (!connected) {
          toast.warning('Please connect your wallet to vote');
          votes.forEach(v => this.pendingVotes.delete(v.submissionId));
          return;
        }
      }

      // Get token mint (all submissions should be for the same token on a token page)
      const tokenMint = this.getTokenMintForSubmission(votes[0].submissionId);
      if (!tokenMint) {
        toast.error('Unable to verify token - please refresh the page');
        votes.forEach(v => this.pendingVotes.delete(v.submissionId));
        return;
      }

      // DEVELOPMENT MODE: Skip holder verification when enabled
      if (!this.developmentMode) {
        const holderData = await this.checkHolderStatus(tokenMint, true);

        if (!holderData || !holderData.holdsToken) {
          toast.error('You must hold this token to vote');
          this.showHolderRequiredModal(tokenMint);
          votes.forEach(v => this.pendingVotes.delete(v.submissionId));
          return;
        }

        const percentageHeld = parseFloat(holderData.percentageHeld);
        if (isNaN(percentageHeld) || percentageHeld < this.requirements.minVoteBalancePercent) {
          toast.error(`Minimum ${this.requirements.minVoteBalancePercent}% of supply required to vote`);
          this.showInsufficientBalanceModal(holderData, this.requirements.minVoteBalancePercent);
          votes.forEach(v => this.pendingVotes.delete(v.submissionId));
          return;
        }
      }

      // Sign all votes with a single wallet signature
      toast.info('Please sign your votes with your wallet...');
      const timestamp = Date.now();
      const message = this.createBatchVoteSignatureMessage(votes, wallet.address, timestamp);

      let signatureData;
      try {
        signatureData = await wallet.signMessage(message);
      } catch (error) {
        console.error('Failed to sign votes:', error);
        if (error.message?.includes('User rejected')) {
          toast.warning('Votes cancelled - signature required');
        } else {
          toast.error('Failed to sign votes. Please try again.');
        }
        votes.forEach(v => this.pendingVotes.delete(v.submissionId));
        return;
      }

      // Optimistic UI update
      votes.forEach(v => {
        const currentVote = this.voteStates.get(v.submissionId);
        const isSameVote = currentVote === v.voteType;
        this.updateVoteUI(v.submissionId, isSameVote ? null : v.voteType, true);
      });

      // Submit batch votes
      const result = await api.votes.castBatch({
        votes: votes.map(v => ({
          submissionId: v.submissionId,
          voteType: v.voteType
        })),
        voterWallet: wallet.address,
        signature: signatureData.signature,
        signatureTimestamp: timestamp
      });

      // Process results
      const successResults = result.results || [];
      const errorResults = result.errors || [];

      // Update vote states for successful votes
      successResults.forEach(r => {
        if (r.action === 'removed') {
          this.voteStates.delete(r.submissionId);
        } else {
          this.voteStates.set(r.submissionId, r.voteType);
        }

        // Update vote counts in UI
        if (r.tally) {
          this.updateVoteCounts(r.submissionId, r.tally.upvotes, r.tally.downvotes, r.tally.score, r.tally.weightedScore);
        }
      });

      // Revert UI for failed votes
      errorResults.forEach(e => {
        const currentVote = this.voteStates.get(e.submissionId);
        this.updateVoteUI(e.submissionId, currentVote, false);
      });

      // Show feedback
      if (successResults.length > 0 && errorResults.length === 0) {
        toast.success(`${successResults.length} vote${successResults.length > 1 ? 's' : ''} submitted!`);
      } else if (successResults.length > 0 && errorResults.length > 0) {
        toast.warning(`${successResults.length} succeeded, ${errorResults.length} failed`);
      } else {
        toast.error('All votes failed');
      }

      return { results: successResults, errors: errorResults };
    } catch (error) {
      console.error('Batch vote failed:', error);

      // Revert all optimistic updates
      votes.forEach(v => {
        const currentVote = this.voteStates.get(v.submissionId);
        this.updateVoteUI(v.submissionId, currentVote, false);
      });

      toast.error('Failed to submit votes. Please try again.');
    } finally {
      votes.forEach(v => this.pendingVotes.delete(v.submissionId));
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
          <button class="btn btn-primary voting-modal-close">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    // CSP-compliant event listeners
    modal.querySelector('.voting-modal-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
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
    const safePercentage = this.escapeHtml((parseFloat(holderData.percentageHeld) || 0).toFixed(4));

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
        <p class="voting-modal-hint">Vote weight scales with holdings: 0.1%=1x up to 3%+=3x</p>
        <div class="voting-modal-actions">
          <button class="btn btn-primary voting-modal-close">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    // CSP-compliant event listeners
    modal.querySelector('.voting-modal-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
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

    // Check development mode
    await this.checkDevelopmentMode();

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
          <button class="btn btn-primary voting-modal-close">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    // CSP-compliant event listeners
    modal.querySelector('.voting-modal-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  },

  // Reset all vote states (e.g., on wallet disconnect)
  reset() {
    this.voteStates.clear();
    this.pendingVotes.clear();
    this.holderCache.clear();
    this.voteQueue.clear();

    // Clear any pending vote timeout
    if (this.voteQueueTimeout) {
      clearTimeout(this.voteQueueTimeout);
      this.voteQueueTimeout = null;
    }

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

// Bind voting info button (CSP-compliant - no inline onclick)
document.addEventListener('DOMContentLoaded', () => {
  const votingInfoBtn = document.getElementById('voting-info-btn');
  if (votingInfoBtn) {
    votingInfoBtn.addEventListener('click', () => voting.showVotingInfoModal());
  }
});
