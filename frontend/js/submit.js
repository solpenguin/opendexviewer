// Submit Page Logic
const submitPage = {
  tokenValid: false,
  urlValid: false,
  holderVerified: false,
  tokenData: null,
  holderData: null,
  mySubmissions: [],
  walletConnected: false,

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
    const contentUrlInput = document.getElementById('content-url');
    const typeRadios = document.querySelectorAll('input[name="submissionType"]');

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

    // Content URL validation and preview
    if (contentUrlInput) {
      contentUrlInput.addEventListener('input', utils.debounce((e) => {
        this.validateUrl(e.target.value);
      }, 400));

      contentUrlInput.addEventListener('blur', () => {
        this.validateUrl(contentUrlInput.value);
      });
    }

    // Type selection - update hint text and revalidate URL
    typeRadios.forEach(radio => {
      radio.addEventListener('change', () => {
        this.updateUrlHint(radio.value);
        this.updateProgressStep(2);
        this.validateUrl(contentUrlInput?.value);
      });
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
      // Don't block on verification errors - just hide the section
      this.hideHolderVerification();
      this.updateFormState();
    }
  },

  // Hide holder verification section
  hideHolderVerification() {
    const holderSection = document.getElementById('holder-verification');
    if (holderSection) holderSection.style.display = 'none';
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
          <div class="imgur-logo">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="#1BB76E">
              <path d="M21.84,9.25c-.29-1.38-.81-2.66-1.52-3.84-.71-1.18-1.61-2.23-2.66-3.1-1.05-.87-2.24-1.57-3.54-2.05S11.61,0,10.22.07c-1.39.07-2.72.39-3.95.92S4.04,2.16,3.07,2.99c-.97.83-1.78,1.82-2.39,2.93-.61,1.11-1.03,2.33-1.24,3.61-.21,1.28-.19,2.6.03,3.89.22,1.29.66,2.52,1.3,3.66.64,1.14,1.46,2.16,2.44,3.01.98.85,2.1,1.52,3.32,1.98s2.54.72,3.92.72c1.39,0,2.72-.26,3.94-.73s2.35-1.15,3.33-2c.98-.85,1.8-1.86,2.44-3,.64-1.14,1.08-2.38,1.3-3.67.22-1.29.24-2.6.04-3.88l-.06-.06ZM12,18c-3.31,0-6-2.69-6-6s2.69-6,6-6,6,2.69,6,6-2.69,6-6,6Z"/>
            </svg>
          </div>
          <h3>How to Upload Your Banner to Imgur</h3>
        </div>
        <div class="imgur-steps">
          <div class="imgur-step">
            <span class="step-number">1</span>
            <div class="step-content">
              <h4>Create Your Banner</h4>
              <p>Design a banner image with recommended dimensions of <strong>1200 x 300 pixels</strong>. PNG or JPG format works best.</p>
            </div>
          </div>
          <div class="imgur-step">
            <span class="step-number">2</span>
            <div class="step-content">
              <h4>Go to Imgur</h4>
              <p>Visit <a href="https://imgur.com/upload" target="_blank" rel="noopener noreferrer" class="link">imgur.com/upload</a> (no account required)</p>
            </div>
          </div>
          <div class="imgur-step">
            <span class="step-number">3</span>
            <div class="step-content">
              <h4>Upload Your Image</h4>
              <p>Drag and drop your banner image or click to browse and select your file.</p>
            </div>
          </div>
          <div class="imgur-step">
            <span class="step-number">4</span>
            <div class="step-content">
              <h4>Copy the Direct Link</h4>
              <p>After upload, right-click the image and select <strong>"Copy image address"</strong>, or click the share button and copy the <strong>Direct Link</strong> (ends in .png or .jpg).</p>
            </div>
          </div>
          <div class="imgur-step">
            <span class="step-number">5</span>
            <div class="step-content">
              <h4>Paste the URL</h4>
              <p>Paste the direct image URL into the Content URL field above. Make sure it looks like: <code>https://i.imgur.com/xxxxx.png</code></p>
            </div>
          </div>
        </div>
        <div class="imgur-tips">
          <h4>Tips for Great Banners</h4>
          <ul>
            <li>Use high-quality images (minimum 800px wide)</li>
            <li>Keep text readable and not too small</li>
            <li>Include your token logo and name</li>
            <li>Avoid misleading or inappropriate content</li>
          </ul>
        </div>
        <div class="modal-actions">
          <a href="https://imgur.com/upload" target="_blank" rel="noopener noreferrer" class="btn btn-primary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            Open Imgur
          </a>
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">
            Got it
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    // Close on Escape
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        modal.remove();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);
  },

  // Update progress step indicators
  updateProgressStep(step) {
    document.querySelectorAll('.progress-step').forEach((el, index) => {
      if (index + 1 < step) {
        el.classList.add('completed');
        el.classList.remove('active');
      } else if (index + 1 === step) {
        el.classList.add('active');
        el.classList.remove('completed');
      } else {
        el.classList.remove('active', 'completed');
      }
    });
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

      this.updateProgressStep(2);
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

  // Validate URL
  validateUrl(url) {
    const type = document.querySelector('input[name="submissionType"]:checked')?.value;
    const status = document.getElementById('url-status');
    const errorEl = document.getElementById('url-error');

    if (!url) {
      this.urlValid = false;
      status.innerHTML = '';
      status.className = 'input-status';
      errorEl.style.display = 'none';
      this.hideBannerPreview();
      this.updateFormState();
      return;
    }

    // Basic URL validation
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      this.urlValid = false;
      status.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
      status.className = 'input-status error';
      this.showUrlError('Please enter a valid URL');
      this.hideBannerPreview();
      this.updateFormState();
      return;
    }

    // Type-specific validation
    const validationResult = this.validateUrlForType(parsedUrl, type);

    if (!validationResult.valid) {
      this.urlValid = false;
      status.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
      status.className = 'input-status error';
      this.showUrlError(validationResult.message);
      this.hideBannerPreview();
    } else {
      this.urlValid = true;
      status.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
      status.className = 'input-status success';
      errorEl.style.display = 'none';

      // Show banner preview if banner type
      if (type === 'banner') {
        this.showBannerPreview(url);
      } else {
        this.hideBannerPreview();
      }

      this.updateProgressStep(3);
    }

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

  // Show URL error
  showUrlError(message) {
    const errorEl = document.getElementById('url-error');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = 'block';
    }
  },

  // Update URL hint based on submission type
  updateUrlHint(type) {
    const hintText = document.getElementById('url-hint-text');
    const helpBtn = document.getElementById('imgur-help-btn');

    const hints = {
      banner: 'Direct image URL (PNG, JPG, GIF, WebP). Recommended size: 1200x300px.',
      twitter: 'Enter the full Twitter/X profile URL (e.g., https://twitter.com/yourtoken)',
      telegram: 'Enter the Telegram group/channel URL (e.g., https://t.me/yourtoken)',
      discord: 'Enter the Discord invite URL (e.g., https://discord.gg/yourtoken)',
      website: 'Enter the official website URL (e.g., https://yourtoken.com)'
    };

    if (hintText) {
      hintText.textContent = hints[type] || '';
    }

    // Show/hide Imgur help button based on type
    if (helpBtn) {
      helpBtn.style.display = type === 'banner' ? 'inline-flex' : 'none';
    }
  },

  // Show banner preview
  showBannerPreview(url) {
    const container = document.getElementById('banner-preview-container');
    const img = document.getElementById('banner-preview');
    const loading = document.getElementById('banner-loading');
    const error = document.getElementById('banner-error');
    const dimensions = document.getElementById('banner-dimensions');

    container.style.display = 'block';
    loading.style.display = 'flex';
    error.style.display = 'none';
    img.style.display = 'none';
    dimensions.textContent = '';

    img.onload = () => {
      loading.style.display = 'none';
      img.style.display = 'block';
      dimensions.textContent = `Image dimensions: ${img.naturalWidth} x ${img.naturalHeight}px`;

      // Warn if dimensions are not ideal
      if (img.naturalWidth < 800 || img.naturalHeight < 200) {
        dimensions.innerHTML += ' <span class="warning">(Recommended: 1200x300px)</span>';
      }
    };

    img.onerror = () => {
      loading.style.display = 'none';
      error.style.display = 'flex';
      this.urlValid = false;
      this.updateFormState();
    };

    img.src = url;
  },

  // Hide banner preview
  hideBannerPreview() {
    const container = document.getElementById('banner-preview-container');
    if (container) {
      container.style.display = 'none';
    }
  },

  // Update form submit button state
  updateFormState() {
    const submitBtn = document.getElementById('submit-btn');
    const formStatus = document.getElementById('form-status');

    // Requirements: wallet connected, token valid, URL valid, and must hold the token
    const canSubmit = this.walletConnected && this.tokenValid && this.urlValid && this.holderVerified;

    if (submitBtn) {
      submitBtn.disabled = !canSubmit;
    }

    if (formStatus) {
      if (!this.walletConnected) {
        formStatus.textContent = 'Connect your wallet to submit content';
      } else if (!this.tokenValid) {
        formStatus.textContent = 'Enter a valid token address to continue';
      } else if (!this.holderVerified) {
        formStatus.textContent = 'You must hold this token to submit content for it';
      } else if (!this.urlValid) {
        formStatus.textContent = 'Enter a valid content URL to continue';
      } else {
        formStatus.textContent = '';
      }
    }
  },

  // Submit form
  async submitForm() {
    if (!this.walletConnected) {
      toast.error('Please connect your wallet first');
      return;
    }

    if (!this.holderVerified) {
      toast.error('You must hold this token to submit content for it');
      return;
    }

    if (!this.tokenValid || !this.urlValid) {
      toast.error('Please fill in all required fields correctly');
      return;
    }

    const form = document.getElementById('submit-form');
    const submitBtn = document.getElementById('submit-btn');

    const formData = new FormData(form);
    const data = {
      tokenMint: formData.get('tokenMint')?.trim(),
      submissionType: formData.get('submissionType'),
      contentUrl: formData.get('contentUrl')?.trim(),
      submitterWallet: wallet.address
    };

    // Disable button during submission
    submitBtn.disabled = true;
    submitBtn.innerHTML = `
      <div class="loading-spinner small"></div>
      <span>Submitting...</span>
    `;

    try {
      const result = await api.submissions.create(data);

      // Success!
      toast.success('Submission received! It will be reviewed by the community.');
      this.showSuccessModal(result);

      // Clear form (but keep wallet connected)
      document.getElementById('token-mint').value = '';
      document.getElementById('content-url').value = '';
      this.resetTokenPreview();
      this.hideBannerPreview();
      this.urlValid = false;
      this.updateFormState();
      this.updateProgressStep(1);

      // Reload user's submissions
      this.loadMySubmissions(wallet.address);

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
        <span>Submit for Community Review</span>
      `;
      this.updateFormState();
    }
  },

  // Show success modal
  showSuccessModal(submission) {
    const safeSubmissionType = utils.escapeHtml(submission.submission_type);
    const safeTokenSymbol = utils.escapeHtml(this.tokenData?.symbol || 'Unknown');
    const safeTokenMint = encodeURIComponent(submission.token_mint);

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content success-modal">
        <div class="success-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <h3>Submission Received!</h3>
        <p>Your <strong>${safeSubmissionType}</strong> has been submitted for community review.</p>
        <div class="success-details">
          <div class="detail-row">
            <span class="label">Status:</span>
            <span class="value status-pending">Pending Review</span>
          </div>
          <div class="detail-row">
            <span class="label">Token:</span>
            <span class="value">${safeTokenSymbol}</span>
          </div>
        </div>
        <p class="success-note">The community will vote on your submission. Once it reaches +5 votes, it will be automatically approved.</p>
        <div class="modal-actions">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">
            Submit Another
          </button>
          <a href="token.html?mint=${safeTokenMint}" class="btn btn-primary">
            View Token
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
