/* global api, walletManager */

const burnPage = {
  config: null,
  walletAddress: null,

  init() {
    this.loadConfig();
    this.setupWalletListeners();
    this.setupFormListeners();
    this.checkWalletState();
  },

  async loadConfig() {
    try {
      this.config = await api.burnCredits.getConfig();
      const rateEl = document.getElementById('burn-rate-display');
      if (rateEl && this.config) {
        rateEl.textContent = `${Number(this.config.conversionRate).toLocaleString()} $OD = 1 Burn Credit`;
      }
    } catch (error) {
      console.error('Failed to load burn config:', error);
      const rateEl = document.getElementById('burn-rate-display');
      if (rateEl) rateEl.textContent = '1,000 $OD = 1 Burn Credit';
    }
  },

  setupWalletListeners() {
    window.addEventListener('walletConnected', (e) => {
      this.walletAddress = e.detail?.address || e.detail;
      this.onWalletConnected();
    });

    window.addEventListener('walletDisconnected', () => {
      this.walletAddress = null;
      this.onWalletDisconnected();
    });

    const connectBtn = document.getElementById('burn-connect-btn');
    if (connectBtn) {
      connectBtn.addEventListener('click', () => {
        const mainConnectBtn = document.getElementById('connect-wallet');
        if (mainConnectBtn) mainConnectBtn.click();
      });
    }
  },

  setupFormListeners() {
    const submitBtn = document.getElementById('burn-submit-btn');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => this.submitBurn());
    }

    const txInput = document.getElementById('burn-tx-input');
    if (txInput) {
      txInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.submitBurn();
      });
    }
  },

  checkWalletState() {
    if (typeof walletManager !== 'undefined' && walletManager.address) {
      this.walletAddress = walletManager.address;
      this.onWalletConnected();
    }
  },

  onWalletConnected() {
    const connectPrompt = document.getElementById('burn-connect-prompt');
    const submitForm = document.getElementById('burn-submit-form');
    const balanceSection = document.getElementById('burn-balance-section');
    const historySection = document.getElementById('burn-history-section');

    if (connectPrompt) connectPrompt.style.display = 'none';
    if (submitForm) submitForm.style.display = 'block';
    if (balanceSection) balanceSection.style.display = 'block';
    if (historySection) historySection.style.display = 'block';

    this.loadBalance();
    this.loadHistory();
  },

  onWalletDisconnected() {
    const connectPrompt = document.getElementById('burn-connect-prompt');
    const submitForm = document.getElementById('burn-submit-form');
    const balanceSection = document.getElementById('burn-balance-section');
    const historySection = document.getElementById('burn-history-section');

    if (connectPrompt) connectPrompt.style.display = 'block';
    if (submitForm) submitForm.style.display = 'none';
    if (balanceSection) balanceSection.style.display = 'none';
    if (historySection) historySection.style.display = 'none';
  },

  async loadBalance() {
    if (!this.walletAddress) return;

    try {
      const data = await api.burnCredits.getBalance(this.walletAddress);
      const balanceEl = document.getElementById('burn-balance');
      const burnedEl = document.getElementById('burn-total-burned');
      const subsEl = document.getElementById('burn-submissions');

      if (balanceEl) balanceEl.textContent = this.formatNumber(data.balance);
      if (burnedEl) burnedEl.textContent = this.formatNumber(data.totalBurned);
      if (subsEl) subsEl.textContent = data.submissions;
    } catch (error) {
      console.error('Failed to load burn balance:', error);
    }
  },

  async loadHistory() {
    if (!this.walletAddress) return;

    const tbody = document.getElementById('burn-history-body');
    if (!tbody) return;

    try {
      const data = await api.burnCredits.getHistory(this.walletAddress);
      const history = data.history || [];

      if (history.length === 0) {
        tbody.innerHTML = `
          <tr class="empty-row">
            <td colspan="5">
              <div class="empty-state"><span>No burn history yet</span></div>
            </td>
          </tr>`;
        return;
      }

      tbody.innerHTML = history.map(entry => {
        const date = new Date(entry.created_at);
        const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const sig = entry.tx_signature;
        const shortSig = sig.slice(0, 8) + '...' + sig.slice(-6);
        const solscanUrl = `https://solscan.io/tx/${encodeURIComponent(sig)}`;

        return `
          <tr>
            <td>${this.escapeHtml(dateStr)}</td>
            <td style="font-family: 'JetBrains Mono', monospace; color: var(--yellow);">${this.formatNumber(parseFloat(entry.token_amount))}</td>
            <td style="font-family: 'JetBrains Mono', monospace; color: var(--accent-hover); font-weight: 600;">${this.formatNumber(parseFloat(entry.credits_awarded))}</td>
            <td style="color: var(--text-muted);">${this.escapeHtml(Number(entry.conversion_rate).toLocaleString())}:1</td>
            <td><a href="${solscanUrl}" target="_blank" rel="noopener" style="color: var(--accent-hover); text-decoration: none;">${this.escapeHtml(shortSig)}</a></td>
          </tr>`;
      }).join('');
    } catch (error) {
      console.error('Failed to load burn history:', error);
    }
  },

  async submitBurn() {
    const txInput = document.getElementById('burn-tx-input');
    const submitBtn = document.getElementById('burn-submit-btn');
    const statusEl = document.getElementById('burn-submit-status');
    const resultEl = document.getElementById('burn-result');
    const resultDetails = document.getElementById('burn-result-details');
    const errorEl = document.getElementById('burn-error');

    if (!txInput || !this.walletAddress) return;

    const txSignature = txInput.value.trim();
    if (!txSignature) {
      this.showError('Please enter a transaction URL or signature');
      return;
    }

    // Reset displays
    if (resultEl) resultEl.style.display = 'none';
    if (errorEl) errorEl.style.display = 'none';

    // Disable button during submission
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Signing...';
    }
    if (statusEl) statusEl.textContent = 'Requesting wallet signature...';

    try {
      // Sign a message to prove wallet ownership
      const signatureTimestamp = Date.now();
      const message = `OpenDex Burn: submit burn tx for ${this.walletAddress} at ${signatureTimestamp}`;

      let signResult;
      try {
        signResult = await walletManager.signMessage(message);
      } catch (signError) {
        this.showError('Wallet signature was rejected. Please approve the signature to continue.');
        if (statusEl) statusEl.textContent = '';
        return;
      }

      if (!signResult || !signResult.signature) {
        this.showError('Failed to get wallet signature. Please try again.');
        if (statusEl) statusEl.textContent = '';
        return;
      }

      const signature = signResult.signature;

      if (submitBtn) submitBtn.textContent = 'Verifying...';
      if (statusEl) statusEl.textContent = 'Verifying transaction on-chain...';

      const result = await api.burnCredits.submit({
        txSignature,
        walletAddress: this.walletAddress,
        signature,
        signatureTimestamp
      });

      // Show success
      if (resultEl && resultDetails) {
        resultDetails.innerHTML = `
          <strong>${this.formatNumber(result.tokensBurned)} $OD</strong> burned
          &rarr; <strong>${this.formatNumber(result.creditsAwarded)} BC</strong> earned<br>
          New balance: <strong>${this.formatNumber(result.newBalance)} BC</strong>
        `;
        resultEl.style.display = 'block';
      }

      // Clear input
      txInput.value = '';
      if (statusEl) statusEl.textContent = '';

      // Refresh balance, history, and header badge
      this.loadBalance();
      this.loadHistory();
      this.refreshHeaderBadge();

    } catch (error) {
      const message = error.message || 'Failed to submit burn transaction';
      this.showError(message);
      if (statusEl) statusEl.textContent = '';
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Burn';
      }
    }
  },

  refreshHeaderBadge() {
    const badge = document.getElementById('header-bc-badge');
    if (badge && typeof walletManager !== 'undefined' && walletManager._loadHeaderBurnCredits) {
      walletManager._loadHeaderBurnCredits(badge);
    }
  },

  showError(msg) {
    const errorEl = document.getElementById('burn-error');
    const errorText = document.getElementById('burn-error-text');
    if (errorEl && errorText) {
      errorText.textContent = msg;
      errorEl.style.display = 'block';
    }
  },

  formatNumber(num) {
    if (num === 0) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(2) + 'K';
    if (num < 1) return num.toFixed(6);
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
};

// Initialize on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => burnPage.init());
} else {
  burnPage.init();
}
