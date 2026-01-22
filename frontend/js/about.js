// About Page - API Key Management
const apiKeyManager = {
  currentKey: null, // Stores the current API key

  init() {
    this.bindEvents();
    this.updateUI();
  },

  bindEvents() {
    // Connect wallet button in API section
    const connectApiBtn = document.getElementById('connect-wallet-api');
    if (connectApiBtn) {
      connectApiBtn.addEventListener('click', () => wallet.connect());
    }

    // Register API key button
    const registerBtn = document.getElementById('register-api-key-btn');
    if (registerBtn) {
      registerBtn.addEventListener('click', () => this.registerKey());
    }

    // Revoke API key button
    const revokeBtn = document.getElementById('revoke-api-key-btn');
    if (revokeBtn) {
      revokeBtn.addEventListener('click', () => this.revokeKey());
    }

    // Copy API key button (in info card)
    const copyBtn = document.getElementById('copy-api-key-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => this.copyKey());
    }

    // Copy API key button (in created card)
    const copyCreatedBtn = document.getElementById('copy-api-key-created-btn');
    if (copyCreatedBtn) {
      copyCreatedBtn.addEventListener('click', () => this.copyKey());
    }

    // Done button (after key creation)
    const doneBtn = document.getElementById('api-key-done-btn');
    if (doneBtn) {
      doneBtn.addEventListener('click', () => this.finishKeyCreation());
    }

    // Listen for wallet connect/disconnect events
    window.addEventListener('walletConnected', () => {
      this.updateUI();
    });

    window.addEventListener('walletDisconnected', () => {
      this.updateUI();
    });
  },

  async updateUI() {
    const connectCard = document.getElementById('api-key-connect');
    const registerCard = document.getElementById('api-key-register');
    const infoCard = document.getElementById('api-key-info');
    const createdCard = document.getElementById('api-key-created');

    // Hide all cards first
    [connectCard, registerCard, infoCard, createdCard].forEach(card => {
      if (card) card.style.display = 'none';
    });

    // Check if wallet is connected
    if (!wallet.connected || !wallet.address) {
      if (connectCard) connectCard.style.display = 'block';
      return;
    }

    // Check if user has an API key
    try {
      const response = await api.apiKeys.getStatus(wallet.address);

      if (response.success && response.data.hasKey) {
        // User has a key - show info card
        if (infoCard) {
          infoCard.style.display = 'block';

          // Store the key for copy functionality
          this.currentKey = response.data.apiKey;

          // Update the display with full API key
          const keyDisplayEl = document.getElementById('api-key-display');
          const createdEl = document.getElementById('api-key-created-date');
          const lastUsedEl = document.getElementById('api-key-last-used');
          const requestsEl = document.getElementById('api-key-requests');

          if (keyDisplayEl) {
            // Show full key or fallback to prefix if full key not available (legacy keys)
            keyDisplayEl.textContent = response.data.apiKey || (response.data.keyPrefix + '...');
          }
          if (createdEl) createdEl.textContent = new Date(response.data.createdAt).toLocaleDateString();
          if (lastUsedEl) {
            lastUsedEl.textContent = response.data.lastUsedAt
              ? utils.formatTimeAgo(response.data.lastUsedAt)
              : 'Never';
          }
          if (requestsEl) requestsEl.textContent = (response.data.requestCount || 0).toLocaleString();
        }
      } else {
        // User doesn't have a key - show register card
        if (registerCard) registerCard.style.display = 'block';
      }
    } catch (error) {
      console.error('Failed to check API key status:', error);
      // Show register card on error
      if (registerCard) registerCard.style.display = 'block';
    }
  },

  async registerKey() {
    if (!wallet.connected || !wallet.address) {
      toast.error('Please connect your wallet first');
      return;
    }

    const nameInput = document.getElementById('api-key-name');
    const name = nameInput ? nameInput.value.trim() : null;
    const btn = document.getElementById('register-api-key-btn');

    try {
      // Disable button and show loading
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="loading-spinner small"></div> Generating...';
      }

      const response = await api.apiKeys.register(wallet.address, name);

      if (response.success && response.data.apiKey) {
        // Store the key
        this.currentKey = response.data.apiKey;

        // Show the created card with the full key
        const createdCard = document.getElementById('api-key-created');
        const registerCard = document.getElementById('api-key-register');
        const keyDisplay = document.getElementById('api-key-full');

        if (registerCard) registerCard.style.display = 'none';
        if (createdCard) createdCard.style.display = 'block';
        if (keyDisplay) keyDisplay.textContent = this.currentKey;

        toast.success('API key created successfully!');
      } else {
        throw new Error(response.error || 'Failed to create API key');
      }
    } catch (error) {
      console.error('Failed to register API key:', error);
      toast.error(error.message || 'Failed to create API key');
    } finally {
      // Reset button
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Generate API Key
        `;
      }
    }
  },

  async copyKey() {
    if (!this.currentKey) {
      toast.error('No API key to copy');
      return;
    }

    const success = await utils.copyToClipboard(this.currentKey, false);
    if (success) {
      toast.success('API key copied to clipboard!');
    } else {
      toast.error('Failed to copy API key');
    }
  },

  finishKeyCreation() {
    // Refresh the UI to show the info card (key is preserved)
    this.updateUI();
  },

  async revokeKey() {
    if (!confirm('Are you sure you want to revoke your API key? You will need to create a new one.')) {
      return;
    }

    // Use the stored key for revocation
    const apiKey = this.currentKey;

    if (!apiKey) {
      toast.error('Unable to revoke - API key not found');
      return;
    }

    const btn = document.getElementById('revoke-api-key-btn');

    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Revoking...';
      }

      const response = await api.apiKeys.revoke(apiKey);

      if (response.success) {
        this.currentKey = null;
        toast.success('API key revoked successfully');
        this.updateUI();
      } else {
        throw new Error(response.error || 'Failed to revoke API key');
      }
    } catch (error) {
      console.error('Failed to revoke API key:', error);
      toast.error(error.message || 'Failed to revoke API key');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Revoke Key';
      }
    }
  }
};

// Initialize API key manager when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Only init if we're on a page with the API section
  if (document.getElementById('api-section')) {
    apiKeyManager.init();
  }
});
