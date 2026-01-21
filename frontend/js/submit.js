// Submit Page Logic - Enhanced with multi-field submission and live preview
const submitPage = {
  tokenValid: false,
  holderVerified: false,
  tokenData: null,
  holderData: null,
  mySubmissions: [],
  walletConnected: false,

  // Track validation state for each field
  fieldValidation: {
    banner: { valid: false, url: '' },
    twitter: { valid: false, url: '' },
    telegram: { valid: false, url: '' },
    discord: { valid: false, url: '' },
    website: { valid: false, url: '' }
  },

  // Initialize
  init() {
    this.bindEvents();
    this.updateWalletUI();
    this.restoreFromUrl();
    this.updateFormState();
  },

  // Update wallet UI based on current state
  updateWalletUI() {
    const connectSection = document.getElementById('wallet-connect-section');
    const connectedSection = document.getElementById('wallet-connected-section');
    const walletInput = document.getElementById('submitter-wallet');
    const addressDisplay = document.getElementById('connected-wallet-address');

    if (wallet.connected && wallet.address) {
      this.walletConnected = true;
      if (connectSection) connectSection.style.display = 'none';
      if (connectedSection) connectedSection.style.display = 'block';
      if (walletInput) walletInput.value = wallet.address;
      if (addressDisplay) addressDisplay.textContent = utils.truncateAddress(wallet.address);

      // Load user's submissions
      this.loadMySubmissions(wallet.address);

      // If we already have a valid token, check holder status
      if (this.tokenValid && this.tokenData) {
        this.checkHolderStatus(this.tokenData.mintAddress || this.tokenData.address);
      }
    } else {
      this.walletConnected = false;
      if (connectSection) connectSection.style.display = 'block';
      if (connectedSection) connectedSection.style.display = 'none';
      if (walletInput) walletInput.value = '';
      this.holderVerified = false;
      this.holderData = null;
      this.hideHolderVerification();
    }

    this.updateFormState();
  },

  // Restore state from URL parameters
  restoreFromUrl() {
    const mint = utils.getUrlParam('mint');
    if (mint) {
      const tokenInput = document.getElementById('token-mint');
      if (tokenInput) {
        tokenInput.value = mint;
        this.lookupToken(mint);
      }
    }
  },

  // Bind events
  bindEvents() {
    const form = document.getElementById('submit-form');
    const tokenMintInput = document.getElementById('token-mint');

    // Main connect wallet button
    const connectMain = document.getElementById('connect-wallet-main');
    if (connectMain) {
      connectMain.addEventListener('click', () => wallet.connect());
    }

    // Disconnect button
    const disconnectBtn = document.getElementById('disconnect-wallet-btn');
    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', () => wallet.disconnect());
    }

    // Token mint lookup
    if (tokenMintInput) {
      tokenMintInput.addEventListener('input', utils.debounce((e) => {
        const value = e.target.value.trim();
        if (value.length >= 32) {
          this.lookupToken(value);
        } else {
          this.resetTokenPreview();
        }
      }, 400));

      tokenMintInput.addEventListener('blur', () => {
        const value = tokenMintInput.value.trim();
        if (value && value.length < 32) {
          this.showTokenError('Please enter a valid Solana address (32+ characters)');
        }
      });
    }

    // Bind all content URL inputs
    const contentTypes = ['banner', 'twitter', 'telegram', 'discord', 'website'];
    contentTypes.forEach(type => {
      const input = document.getElementById(`${type}-url`);
      if (input) {
        input.addEventListener('input', utils.debounce((e) => {
          this.validateField(type, e.target.value);
        }, 300));

        input.addEventListener('blur', () => {
          this.validateField(type, input.value);
        });
      }
    });

    // Form submission
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.submitForm();
      });
    }

    // Imgur help button
    const imgurHelpBtn = document.getElementById('imgur-help-btn');
    if (imgurHelpBtn) {
      imgurHelpBtn.addEventListener('click', () => this.showImgurHelpModal());
    }

    // Wallet connection buttons for submissions section
    const connectSubmissions = document.getElementById('connect-wallet-submissions');
    if (connectSubmissions) {
      connectSubmissions.addEventListener('click', () => wallet.connect());
    }

    // Wallet events
    window.addEventListener('walletConnected', (e) => {
      this.updateWalletUI();
    });

    window.addEventListener('walletDisconnected', () => {
      this.walletConnected = false;
      this.holderVerified = false;
      this.holderData = null;
      this.updateWalletUI();
      this.resetMySubmissions();
      this.updateFormState();
    });
  },

  // Validate a specific field
  validateField(type, url) {
    const statusEl = document.getElementById(`${type}-status`);

    if (!url || url.trim() === '') {
      this.fieldValidation[type] = { valid: false, url: '' };
      if (statusEl) {
        statusEl.innerHTML = '';
        statusEl.className = 'input-status';
      }
      this.updateFilledCount();
      this.updateLivePreview();
      this.updateFormState();
      return;
    }

    // Basic URL validation
    let parsedUrl;
    try {
      parsedUrl = new URL(url.trim());
    } catch {
      this.fieldValidation[type] = { valid: false, url: '' };
      if (statusEl) {
        statusEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
        statusEl.className = 'input-status error';
      }
      this.updateFilledCount();
      this.updateLivePreview();
      this.updateFormState();
      return;
    }

    // Type-specific validation
    const result = this.validateUrlForType(parsedUrl, type);

    if (!result.valid) {
      this.fieldValidation[type] = { valid: false, url: '' };
      if (statusEl) {
        statusEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
        statusEl.className = 'input-status error';
        statusEl.title = result.message;
      }
    } else {
      this.fieldValidation[type] = { valid: true, url: url.trim() };
      if (statusEl) {
        statusEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
        statusEl.className = 'input-status success';
        statusEl.title = '';
      }

      // Show banner preview if banner type
      if (type === 'banner') {
        this.showBannerPreviewMini(url.trim());
      }
    }

    this.updateFilledCount();
    this.updateLivePreview();
    this.updateFormState();
  },

  // Validate URL for specific type
  validateUrlForType(url, type) {
    const hostname = url.hostname.toLowerCase();

    switch (type) {
      case 'twitter':
        if (!hostname.includes('twitter.com') && !hostname.includes('x.com')) {
          return { valid: false, message: 'Please enter a valid Twitter/X URL' };
        }
        break;
      case 'telegram':
        if (!hostname.includes('t.me') && !hostname.includes('telegram.me')) {
          return { valid: false, message: 'Please enter a valid Telegram URL' };
        }
        break;
      case 'discord':
        if (!hostname.includes('discord.gg') && !hostname.includes('discord.com')) {
          return { valid: false, message: 'Please enter a valid Discord URL' };
        }
        break;
      case 'banner':
        const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
        const hasImageExtension = imageExtensions.some(ext => url.pathname.toLowerCase().includes(ext));
        const isImageHost = ['imgur.com', 'i.imgur.com', 'cloudinary.com', 'imagekit.io'].some(h => hostname.includes(h));

        if (!hasImageExtension && !isImageHost) {
          return { valid: false, message: 'Please enter a direct image URL (PNG, JPG, GIF, WebP)' };
        }
        break;
    }

    return { valid: true };
  },

  // Show mini banner preview in the form
  showBannerPreviewMini(url) {
    const container = document.getElementById('banner-preview-mini');
    const img = document.getElementById('banner-preview-img');
    const overlay = container?.querySelector('.banner-preview-overlay');

    if (!container || !img) return;

    container.style.display = 'block';
    if (overlay) overlay.style.display = 'flex';
    img.style.display = 'none';

    img.onload = () => {
      if (overlay) overlay.style.display = 'none';
      img.style.display = 'block';
    };

    img.onerror = () => {
      if (overlay) overlay.style.display = 'none';
      container.style.display = 'none';
      this.fieldValidation.banner = { valid: false, url: '' };
      const statusEl = document.getElementById('banner-status');
      if (statusEl) {
        statusEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
        statusEl.className = 'input-status error';
      }
      this.updateFormState();
    };

    img.src = url;
  },

  // Update filled count indicator
  updateFilledCount() {
    const countEl = document.getElementById('filled-count');
    if (!countEl) return;

    const count = Object.values(this.fieldValidation).filter(f => f.valid).length;
    countEl.textContent = count;
  },

  // Update live preview panel
  updateLivePreview() {
    const placeholder = document.getElementById('preview-placeholder');
    const tokenPage = document.getElementById('preview-token-page');

    // Show placeholder if no token selected
    if (!this.tokenValid || !this.tokenData) {
      if (placeholder) placeholder.style.display = 'flex';
      if (tokenPage) tokenPage.style.display = 'none';
      return;
    }

    // Show token page preview
    if (placeholder) placeholder.style.display = 'none';
    if (tokenPage) tokenPage.style.display = 'block';

    // Update token info in preview
    const logo = document.getElementById('preview-token-logo');
    const name = document.getElementById('preview-token-name');
    const symbol = document.getElementById('preview-token-symbol');

    if (logo) {
      logo.src = this.tokenData.logoUri || this.tokenData.logoURI || this.tokenData.logo || utils.getDefaultLogo();
      logo.onerror = function() { this.src = utils.getDefaultLogo(); };
    }
    if (name) name.textContent = this.tokenData.name || 'Unknown Token';
    if (symbol) symbol.textContent = this.tokenData.symbol || '???';

    // Update banner preview
    const bannerImg = document.getElementById('preview-banner-img');
    const bannerPlaceholder = document.getElementById('preview-banner-placeholder');

    if (this.fieldValidation.banner.valid && this.fieldValidation.banner.url) {
      if (bannerImg) {
        bannerImg.src = this.fieldValidation.banner.url;
        bannerImg.style.display = 'block';
        bannerImg.onerror = function() { this.style.display = 'none'; };
      }
      if (bannerPlaceholder) bannerPlaceholder.style.display = 'none';
    } else {
      if (bannerImg) bannerImg.style.display = 'none';
      if (bannerPlaceholder) bannerPlaceholder.style.display = 'flex';
    }

    // Update social link chips
    const socialTypes = ['twitter', 'telegram', 'discord', 'website'];
    let hasAnyLink = false;

    socialTypes.forEach(type => {
      const chip = document.getElementById(`preview-${type}-chip`);
      if (chip) {
        const isValid = this.fieldValidation[type].valid;
        chip.style.display = isValid ? 'flex' : 'none';
        if (isValid) hasAnyLink = true;
      }
    });

    // Show/hide empty links message
    const emptyLinks = document.getElementById('preview-empty-links');
    if (emptyLinks) {
      emptyLinks.style.display = hasAnyLink ? 'none' : 'block';
    }
  },

  // Check if connected wallet holds the token
  async checkHolderStatus(mint) {
    if (!this.walletConnected || !wallet.address || !mint) {
      this.holderVerified = false;
      this.holderData = null;
      this.hideHolderVerification();
      return;
    }

    const holderSection = document.getElementById('holder-verification');
    const loadingEl = document.getElementById('holder-loading');
    const resultEl = document.getElementById('holder-result');

    // Show loading state
    if (holderSection) holderSection.style.display = 'block';
    if (loadingEl) loadingEl.style.display = 'flex';
    if (resultEl) resultEl.style.display = 'none';

    try {
      const holderInfo = await api.tokens.getHolderBalance(mint, wallet.address);
      this.holderData = holderInfo;
      this.holderVerified = holderInfo.holdsToken;

      // Update UI
      if (loadingEl) loadingEl.style.display = 'none';
      if (resultEl) resultEl.style.display = 'block';

      const statusIcon = document.getElementById('holder-status-icon');
      const statusText = document.getElementById('holder-status-text');
      const statusDiv = document.getElementById('holder-status');
      const balanceInfo = document.getElementById('holder-balance-info');
      const balanceEl = document.getElementById('holder-balance');
      const percentageEl = document.getElementById('holder-percentage');

      if (holderInfo.holdsToken) {
        statusDiv.className = 'holder-status verified';
        statusIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
        statusText.textContent = 'You hold this token';
        balanceInfo.style.display = 'block';

        // Format balance
        const formattedBalance = holderInfo.balance >= 1000000
          ? utils.formatNumber(holderInfo.balance, '')
          : holderInfo.balance.toLocaleString(undefined, { maximumFractionDigits: 4 });
        balanceEl.textContent = `${formattedBalance} ${this.tokenData?.symbol || ''}`;

        // Format percentage
        if (holderInfo.percentageHeld !== null && holderInfo.percentageHeld !== undefined) {
          const pct = holderInfo.percentageHeld;
          percentageEl.textContent = pct < 0.0001 ? '<0.0001%' : `${pct.toFixed(4)}%`;
        } else {
          percentageEl.textContent = 'N/A';
        }
      } else {
        statusDiv.className = 'holder-status not-holder';
        statusIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
        statusText.textContent = 'You do not hold this token';
        balanceInfo.style.display = 'none';
      }

      this.updateFormState();

    } catch (error) {
      console.error('Failed to check holder status:', error);
      if (loadingEl) loadingEl.style.display = 'none';
      this.holderVerified = false;
      this.holderData = null;
      this.hideHolderVerification();
      this.updateFormState();
    }
  },

  // Hide holder verification section
  hideHolderVerification() {
    const holderSection = document.getElementById('holder-verification');
    if (holderSection) holderSection.style.display = 'none';
  },

  // Lookup token by mint address
  async lookupToken(mint) {
    const preview = document.getElementById('token-preview');
    const status = document.getElementById('token-status');
    const errorEl = document.getElementById('token-error');

    if (!mint || !utils.isValidSolanaAddress(mint)) {
      this.resetTokenPreview();
      if (mint && mint.length >= 32) {
        this.showTokenError('Invalid Solana address format');
      }
      return;
    }

    // Show loading state
    status.innerHTML = '<div class="loading-spinner small"></div>';
    status.className = 'input-status loading';
    errorEl.style.display = 'none';

    try {
      const token = await api.tokens.get(mint);

      if (!token) {
        throw new Error('Token not found');
      }

      this.tokenData = token;
      this.tokenValid = true;

      // Update preview
      const logoEl = document.getElementById('preview-logo');
      logoEl.src = token.logoUri || token.logoURI || token.logo || utils.getDefaultLogo();
      logoEl.onerror = function() { this.src = utils.getDefaultLogo(); };

      document.getElementById('preview-name').textContent = token.name || 'Unknown Token';
      document.getElementById('preview-symbol').textContent = token.symbol || '???';

      preview.style.display = 'flex';
      status.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
      status.className = 'input-status success';

      // Check if wallet is connected and verify holder status
      if (this.walletConnected) {
        this.checkHolderStatus(mint);
      }

      this.updateLivePreview();
      this.updateFormState();

    } catch (error) {
      console.error('Token lookup failed:', error);
      this.tokenValid = false;
      this.tokenData = null;
      this.holderVerified = false;
      this.holderData = null;
      preview.style.display = 'none';
      this.hideHolderVerification();

      status.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
      status.className = 'input-status error';

      this.showTokenError('Token not found. Please check the address.');
      this.updateLivePreview();
      this.updateFormState();
    }
  },

  // Reset token preview
  resetTokenPreview() {
    this.tokenValid = false;
    this.tokenData = null;
    this.holderVerified = false;
    this.holderData = null;

    const preview = document.getElementById('token-preview');
    const status = document.getElementById('token-status');
    const errorEl = document.getElementById('token-error');

    if (preview) preview.style.display = 'none';
    if (status) {
      status.innerHTML = '';
      status.className = 'input-status';
    }
    if (errorEl) errorEl.style.display = 'none';

    this.hideHolderVerification();
    this.updateLivePreview();
    this.updateFormState();
  },

  // Show token error
  showTokenError(message) {
    const errorEl = document.getElementById('token-error');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = 'block';
    }
  },

  // Update form submit button state
  updateFormState() {
    const submitBtn = document.getElementById('submit-btn');
    const submitBtnText = document.getElementById('submit-btn-text');
    const formStatus = document.getElementById('form-status');

    // Count valid submissions
    const validCount = Object.values(this.fieldValidation).filter(f => f.valid).length;

    // Requirements: wallet connected, token valid, at least one valid field, and must hold the token
    const canSubmit = this.walletConnected && this.tokenValid && validCount > 0 && this.holderVerified;

    if (submitBtn) {
      submitBtn.disabled = !canSubmit;
    }

    if (submitBtnText) {
      if (validCount > 1) {
        submitBtnText.textContent = `Submit ${validCount} Items for Review`;
      } else if (validCount === 1) {
        submitBtnText.textContent = 'Submit for Community Review';
      } else {
        submitBtnText.textContent = 'Submit for Community Review';
      }
    }

    if (formStatus) {
      if (!this.walletConnected) {
        formStatus.textContent = 'Connect your wallet to submit content';
      } else if (!this.tokenValid) {
        formStatus.textContent = 'Enter a valid token address to continue';
      } else if (!this.holderVerified) {
        formStatus.textContent = 'You must hold this token to submit content for it';
      } else if (validCount === 0) {
        formStatus.textContent = 'Fill in at least one content field';
      } else {
        formStatus.textContent = '';
      }
    }
  },

  // Submit form - handles multiple submissions
  async submitForm() {
    if (!this.walletConnected) {
      toast.error('Please connect your wallet first');
      return;
    }

    if (!this.holderVerified) {
      toast.error('You must hold this token to submit content for it');
      return;
    }

    // Collect all valid submissions
    const submissions = [];
    const tokenMint = document.getElementById('token-mint')?.value?.trim();

    Object.entries(this.fieldValidation).forEach(([type, data]) => {
      if (data.valid && data.url) {
        submissions.push({
          tokenMint,
          submissionType: type,
          contentUrl: data.url,
          submitterWallet: wallet.address
        });
      }
    });

    if (submissions.length === 0) {
      toast.error('Please fill in at least one content field');
      return;
    }

    const submitBtn = document.getElementById('submit-btn');
    const submitBtnText = document.getElementById('submit-btn-text');

    // Disable button during submission
    submitBtn.disabled = true;
    submitBtn.innerHTML = `
      <div class="loading-spinner small"></div>
      <span>Submitting ${submissions.length} item${submissions.length > 1 ? 's' : ''}...</span>
    `;

    try {
      // Submit all items
      const results = [];
      const errors = [];

      for (const submission of submissions) {
        try {
          const result = await api.submissions.create(submission);
          results.push({ type: submission.submissionType, result });
        } catch (error) {
          errors.push({ type: submission.submissionType, error: error.message });
        }
      }

      // Show results
      if (results.length > 0) {
        const types = results.map(r => r.type).join(', ');
        toast.success(`${results.length} submission${results.length > 1 ? 's' : ''} received!`);
        this.showSuccessModal(results, errors);
      }

      if (errors.length > 0 && results.length === 0) {
        toast.error('All submissions failed. Please try again.');
      }

      // Clear form if at least one succeeded
      if (results.length > 0) {
        this.clearForm();
        this.loadMySubmissions(wallet.address);
      }

    } catch (error) {
      console.error('Submission failed:', error);
      toast.error(error.message || 'Submission failed. Please try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <span id="submit-btn-text">Submit for Community Review</span>
      `;
      this.updateFormState();
    }
  },

  // Clear the form after successful submission
  clearForm() {
    document.getElementById('token-mint').value = '';
    ['banner', 'twitter', 'telegram', 'discord', 'website'].forEach(type => {
      const input = document.getElementById(`${type}-url`);
      if (input) input.value = '';
      this.fieldValidation[type] = { valid: false, url: '' };
      const status = document.getElementById(`${type}-status`);
      if (status) {
        status.innerHTML = '';
        status.className = 'input-status';
      }
    });

    const bannerPreview = document.getElementById('banner-preview-mini');
    if (bannerPreview) bannerPreview.style.display = 'none';

    this.resetTokenPreview();
    this.updateFilledCount();
    this.updateLivePreview();
    this.updateFormState();
  },

  // Show success modal
  showSuccessModal(results, errors) {
    const safeTokenSymbol = utils.escapeHtml(this.tokenData?.symbol || 'Unknown');
    const safeTokenMint = encodeURIComponent(document.getElementById('token-mint')?.value || '');

    const successItems = results.map(r => `<li>${utils.escapeHtml(r.type)}</li>`).join('');
    const errorItems = errors.map(e => `<li>${utils.escapeHtml(e.type)}: ${utils.escapeHtml(e.error)}</li>`).join('');

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content success-modal">
        <div class="success-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <h3>Submission${results.length > 1 ? 's' : ''} Received!</h3>
        <p>Your content has been submitted for community review.</p>
        <div class="success-details">
          <div class="detail-row">
            <span class="label">Submitted:</span>
            <ul class="submitted-list">${successItems}</ul>
          </div>
          ${errors.length > 0 ? `
          <div class="detail-row error">
            <span class="label">Failed:</span>
            <ul class="error-list">${errorItems}</ul>
          </div>
          ` : ''}
          <div class="detail-row">
            <span class="label">Token:</span>
            <span class="value">${safeTokenSymbol}</span>
          </div>
        </div>
        <p class="success-note">The community will vote on your submission${results.length > 1 ? 's' : ''}. Once they reach +5 votes, they will be automatically approved.</p>
        <div class="modal-actions">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">
            Submit More
          </button>
          <a href="token.html?mint=${safeTokenMint}" class="btn btn-primary">
            View Token Page
          </a>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        modal.remove();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);
  },

  // Show Imgur upload help modal
  showImgurHelpModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content imgur-help-modal">
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
        <div class="modal-header">
          <h3>How to Upload Your Banner</h3>
        </div>
        <div class="imgur-steps">
          <div class="imgur-step">
            <span class="step-number">1</span>
            <div class="step-content">
              <h4>Create Your Banner</h4>
              <p>Design a banner image (<strong>1200 x 300px</strong> recommended). PNG or JPG format works best.</p>
            </div>
          </div>
          <div class="imgur-step">
            <span class="step-number">2</span>
            <div class="step-content">
              <h4>Upload to Imgur</h4>
              <p>Visit <a href="https://imgur.com/upload" target="_blank" rel="noopener noreferrer" class="link">imgur.com/upload</a> (no account required)</p>
            </div>
          </div>
          <div class="imgur-step">
            <span class="step-number">3</span>
            <div class="step-content">
              <h4>Get Direct Link</h4>
              <p>After upload, right-click the image and select <strong>"Copy image address"</strong>. The URL should look like: <code>https://i.imgur.com/xxxxx.png</code></p>
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <a href="https://imgur.com/upload" target="_blank" rel="noopener noreferrer" class="btn btn-primary">
            Open Imgur
          </a>
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">
            Got it
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        modal.remove();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);
  },

  // Load user's submissions
  async loadMySubmissions(walletAddress) {
    const container = document.getElementById('my-submissions');
    const countEl = document.getElementById('my-submissions-count');

    if (!walletAddress) {
      this.resetMySubmissions();
      return;
    }

    try {
      this.mySubmissions = await api.submissions.getByWallet(walletAddress);

      if (countEl) {
        countEl.textContent = `${this.mySubmissions.length} submission${this.mySubmissions.length !== 1 ? 's' : ''}`;
      }

      if (this.mySubmissions.length === 0) {
        container.innerHTML = `
          <div class="empty-submissions">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <line x1="12" y1="8" x2="12" y2="16"/>
              <line x1="8" y1="12" x2="16" y2="12"/>
            </svg>
            <p>You haven't submitted anything yet</p>
            <p class="hint">Use the form above to submit banners or social links for tokens you hold</p>
          </div>
        `;
        return;
      }

      // Build submission cards safely
      container.innerHTML = '';
      this.mySubmissions.forEach(s => {
        const card = document.createElement('div');
        card.className = 'my-submission-card';

        const iconDiv = document.createElement('div');
        iconDiv.className = 'submission-type-icon';
        iconDiv.innerHTML = this.getTypeIcon(s.submission_type);

        const infoDiv = document.createElement('div');
        infoDiv.className = 'submission-info';

        const titleDiv = document.createElement('div');
        titleDiv.className = 'submission-title';

        const typeLabel = document.createElement('span');
        typeLabel.className = 'type-label';
        typeLabel.textContent = s.submission_type;

        const tokenLink = document.createElement('a');
        tokenLink.className = 'token-link';
        tokenLink.href = `token.html?mint=${encodeURIComponent(s.token_mint)}`;
        tokenLink.textContent = this.truncateAddress(s.token_mint);

        titleDiv.appendChild(typeLabel);
        titleDiv.appendChild(tokenLink);

        const contentLink = document.createElement('a');
        contentLink.className = 'content-url';
        contentLink.href = s.content_url;
        contentLink.target = '_blank';
        contentLink.rel = 'noopener noreferrer';
        contentLink.textContent = this.truncateUrl(s.content_url);

        infoDiv.appendChild(titleDiv);
        infoDiv.appendChild(contentLink);

        const statusBadge = document.createElement('div');
        statusBadge.className = `submission-status-badge status-${utils.escapeHtml(s.status)}`;
        statusBadge.textContent = s.status;

        const scoreDiv = document.createElement('div');
        const score = s.score || 0;
        scoreDiv.className = `submission-score ${score >= 0 ? 'positive' : 'negative'}`;
        scoreDiv.textContent = score > 0 ? `+${score}` : String(score);

        card.appendChild(iconDiv);
        card.appendChild(infoDiv);
        card.appendChild(statusBadge);
        card.appendChild(scoreDiv);

        container.appendChild(card);
      });

    } catch (error) {
      console.error('Failed to load submissions:', error);
      container.innerHTML = '';
      const errorDiv = document.createElement('div');
      errorDiv.className = 'empty-submissions error';

      const errorText = document.createElement('p');
      errorText.textContent = 'Failed to load your submissions';

      const retryBtn = document.createElement('button');
      retryBtn.className = 'btn btn-secondary btn-sm';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', () => {
        submitPage.loadMySubmissions(walletAddress);
      });

      errorDiv.appendChild(errorText);
      errorDiv.appendChild(retryBtn);
      container.appendChild(errorDiv);
    }
  },

  // Reset my submissions section
  resetMySubmissions() {
    const container = document.getElementById('my-submissions');
    const countEl = document.getElementById('my-submissions-count');

    this.mySubmissions = [];

    if (countEl) {
      countEl.textContent = '0 submissions';
    }

    if (container) {
      container.innerHTML = `
        <div class="empty-submissions">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/>
            <path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/>
            <path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>
          </svg>
          <p>Connect your wallet to see your submissions</p>
          <button type="button" id="connect-wallet-submissions" class="btn btn-secondary" onclick="wallet.connect()">
            Connect Wallet
          </button>
        </div>
      `;
    }
  },

  // Get icon for submission type
  getTypeIcon(type) {
    const icons = {
      banner: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
      twitter: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
      telegram: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.03-1.99 1.27-5.62 3.72-.53.36-1.01.54-1.44.53-.47-.01-1.38-.27-2.06-.49-.83-.27-1.49-.42-1.43-.88.03-.24.37-.49 1.02-.74 3.99-1.74 6.65-2.89 7.99-3.45 3.8-1.6 4.59-1.88 5.1-1.89.11 0 .37.03.54.17.14.12.18.28.2.45-.01.06.01.24 0 .38z"/></svg>',
      discord: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>',
      website: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>'
    };
    return icons[type] || icons.website;
  },

  // Truncate address
  truncateAddress(address) {
    if (!address) return '';
    return address.slice(0, 4) + '...' + address.slice(-4);
  },

  // Truncate URL for display
  truncateUrl(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.length > 20 ? parsed.pathname.slice(0, 20) + '...' : parsed.pathname;
      return parsed.hostname + path;
    } catch {
      return url.slice(0, 40) + (url.length > 40 ? '...' : '');
    }
  }
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  submitPage.init();
});

// ==========================================
// API Key Management
// ==========================================
const apiKeyManager = {
  currentKey: null, // Temporarily stores the full key after creation

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

    // Copy API key button
    const copyBtn = document.getElementById('copy-api-key-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => this.copyKey());
    }

    // Done button (after key creation)
    const doneBtn = document.getElementById('api-key-done-btn');
    if (doneBtn) {
      doneBtn.addEventListener('click', () => this.finishKeyCreation());
    }

    // Listen for wallet connect/disconnect
    if (typeof wallet !== 'undefined') {
      const originalOnConnect = wallet.onConnect;
      wallet.onConnect = () => {
        if (originalOnConnect) originalOnConnect();
        this.updateUI();
      };

      const originalOnDisconnect = wallet.onDisconnect;
      wallet.onDisconnect = () => {
        if (originalOnDisconnect) originalOnDisconnect();
        this.updateUI();
      };
    }
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

          // Update the info
          const prefixEl = document.getElementById('api-key-prefix');
          const createdEl = document.getElementById('api-key-created');
          const lastUsedEl = document.getElementById('api-key-last-used');
          const requestsEl = document.getElementById('api-key-requests');

          if (prefixEl) prefixEl.textContent = response.data.keyPrefix + '...';
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
        // Store the key temporarily
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
    // Clear the temporary key
    this.currentKey = null;

    // Refresh the UI to show the info card
    this.updateUI();
  },

  async revokeKey() {
    if (!confirm('Are you sure you want to revoke your API key? You will need to create a new one.')) {
      return;
    }

    // For revocation, we need the user to provide their API key
    // Since we don't store it, we'll prompt them
    const apiKey = prompt('Enter your API key to confirm revocation:');

    if (!apiKey) {
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
