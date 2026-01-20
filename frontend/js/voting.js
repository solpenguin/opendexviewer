// Voting System Logic
const voting = {
  // Track vote state for optimistic updates
  pendingVotes: new Set(),
  voteStates: new Map(),

  // Cast a vote
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
        voteType
      });

      // Update the vote state
      if (result.action === 'removed') {
        this.voteStates.delete(submissionId);
      } else {
        this.voteStates.set(submissionId, voteType);
      }

      // Show success feedback
      this.showVoteFeedback(result);

      // Update the vote counts from the response
      this.updateVoteCounts(submissionId, result.upvotes, result.downvotes, result.score);

    } catch (error) {
      console.error('Vote failed:', error);

      // Revert optimistic update
      this.updateVoteUI(submissionId, currentVote, false);

      // Show error
      toast.error('Failed to cast vote. Please try again.');
    } finally {
      this.pendingVotes.delete(submissionId);
    }
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
  updateVoteCounts(submissionId, upvotes, downvotes, score) {
    // Find all elements displaying vote counts for this submission
    const upCountEls = document.querySelectorAll(`[data-upvotes="${submissionId}"]`);
    const downCountEls = document.querySelectorAll(`[data-downvotes="${submissionId}"]`);
    const scoreEls = document.querySelectorAll(`[data-score="${submissionId}"]`);

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
    const messages = {
      created: {
        up: 'Upvoted!',
        down: 'Downvoted!'
      },
      updated: {
        up: 'Changed to upvote',
        down: 'Changed to downvote'
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

    toast.show(icon ? `${icon} ${message}` : message, result.voteType === 'up' ? 'success' : result.voteType === 'down' ? 'error' : 'info', 2000);
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
    if (!wallet.connected) return;

    // Find all submissions on the page
    const submissionEls = document.querySelectorAll('[data-submission-id]');
    const submissionIds = [...new Set([...submissionEls].map(el => parseInt(el.dataset.submissionId)))].filter(id => !isNaN(id));

    if (submissionIds.length > 0) {
      await this.checkMultipleVotes(submissionIds);
    }
  },

  // Reset all vote states (e.g., on wallet disconnect)
  reset() {
    this.voteStates.clear();
    this.pendingVotes.clear();

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
