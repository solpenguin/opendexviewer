/* global api, wallet, config, solanaWeb3, toast */

const burnPage = {
  config: null,
  walletAddress: null,
  odBalance: null,
  conversionRate: 1000,
  connection: null,

  // Solana constants
  OD_TOKEN_MINT: '8pNbASzvHB19Skw1zK9rb97QnAVSmenrgvqpRNbppump',
  OD_DECIMALS: 6,
  SPL_TOKEN_PROGRAM_ID: null,
  ASSOCIATED_TOKEN_PROGRAM_ID: null,

  init() {
    this.loadConfig();
    this.setupWalletListeners();
    this.setupTabListeners();
    this.setupFormListeners();
    this.setupDirectBurnListeners();
    this.initSolana();

    // Check if wallet is already connected (handles auto-connect race)
    if (typeof wallet !== 'undefined' && wallet.connected && wallet.address) {
      this.walletAddress = wallet.address;
      this.onWalletConnected();
    } else {
      // Listen for walletReady in case wallet.init() hasn't finished yet
      window.addEventListener('walletReady', (e) => {
        if (e.detail?.connected && e.detail?.address) {
          this.walletAddress = e.detail.address;
          this.onWalletConnected();
        }
      });
    }
  },

  initSolana() {
    if (typeof solanaWeb3 === 'undefined') {
      console.warn('[Burn] Solana web3.js not loaded - direct burn unavailable');
      return;
    }
    this.SPL_TOKEN_PROGRAM_ID = new solanaWeb3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    this.ASSOCIATED_TOKEN_PROGRAM_ID = new solanaWeb3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

    const rpcUrl = (typeof config !== 'undefined' && config.solana?.rpcEndpoint)
      ? config.solana.rpcEndpoint
      : 'https://api.mainnet-beta.solana.com';
    this.connection = new solanaWeb3.Connection(rpcUrl, 'confirmed');
  },

  async loadConfig() {
    try {
      this.config = await api.burnCredits.getConfig();
      if (this.config) {
        this.conversionRate = Number(this.config.conversionRate) || 1000;
        const rateEl = document.getElementById('burn-rate-display');
        if (rateEl) rateEl.textContent = `${this.conversionRate.toLocaleString()} $OD = 1 Burn Credit`;
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
      this.odBalance = null;
      this.onWalletDisconnected();
    });

    const connectBtn = document.getElementById('burn-connect-btn');
    if (connectBtn) {
      connectBtn.addEventListener('click', () => {
        if (typeof wallet !== 'undefined') {
          wallet.connect();
        } else {
          const mainBtn = document.getElementById('connect-wallet');
          if (mainBtn) mainBtn.click();
        }
      });
    }
  },

  setupTabListeners() {
    const tabs = document.querySelectorAll('.burn-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        document.querySelectorAll('.burn-panel').forEach(p => p.classList.remove('active'));
        const panel = document.getElementById(`burn-panel-${target}`);
        if (panel) panel.classList.add('active');

        // Hide result/error when switching tabs
        this.hideMessages();
      });
    });
  },

  setupFormListeners() {
    const submitBtn = document.getElementById('burn-submit-btn');
    if (submitBtn) submitBtn.addEventListener('click', () => this.submitManualBurn());

    const txInput = document.getElementById('burn-tx-input');
    if (txInput) txInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submitManualBurn();
    });
  },

  setupDirectBurnListeners() {
    const amountInput = document.getElementById('burn-amount-input');
    if (amountInput) {
      amountInput.addEventListener('input', () => this.onAmountChange());
      amountInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.executeBurn();
      });
    }

    // Percent buttons
    document.querySelectorAll('.burn-percent-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pct = parseInt(btn.dataset.pct);
        if (this.odBalance && this.odBalance > 0) {
          const amount = this.odBalance * (pct / 100);
          const input = document.getElementById('burn-amount-input');
          if (input) {
            // For MAX, use full precision to avoid dust
            input.value = pct === 100 ? this.odBalance.toString() : amount.toFixed(2);
            this.onAmountChange();
          }
        }
      });
    });

    const executeBtn = document.getElementById('burn-execute-btn');
    if (executeBtn) executeBtn.addEventListener('click', () => this.executeBurn());
  },

  onAmountChange() {
    const input = document.getElementById('burn-amount-input');
    const executeBtn = document.getElementById('burn-execute-btn');
    const executeText = document.getElementById('burn-execute-text');
    const conversionPreview = document.getElementById('burn-conversion-preview');

    if (!input) return;

    const amount = parseFloat(input.value);
    const isValid = amount >= 1 && !isNaN(amount);
    const hasBalance = this.odBalance !== null && this.odBalance > 0;
    const withinBalance = hasBalance && amount <= this.odBalance;

    if (executeBtn) executeBtn.disabled = !isValid || !withinBalance;

    if (executeText) {
      if (!input.value || isNaN(amount) || amount <= 0) {
        executeText.textContent = 'Enter an amount';
      } else if (amount < 1) {
        executeText.textContent = 'Minimum 1 $OD';
      } else if (!hasBalance) {
        executeText.textContent = 'No $OD balance';
      } else if (!withinBalance) {
        executeText.textContent = 'Insufficient balance';
      } else {
        executeText.textContent = `Burn ${this.formatNumber(amount)} $OD`;
      }
    }

    if (conversionPreview) {
      if (isValid && this.conversionRate > 0) {
        const credits = amount / this.conversionRate;
        conversionPreview.innerHTML = `You will receive <strong>${this.formatNumber(credits)}</strong> Burn Credits`;
      } else {
        conversionPreview.innerHTML = 'You will receive <strong>0</strong> Burn Credits';
      }
    }
  },

  onWalletConnected() {
    const connectPrompt = document.getElementById('burn-connect-prompt');
    const mainForm = document.getElementById('burn-main-form');
    const statsSection = document.getElementById('burn-stats-section');
    const historySection = document.getElementById('burn-history-section');

    if (connectPrompt) connectPrompt.style.display = 'none';
    if (mainForm) mainForm.style.display = 'block';
    if (statsSection) statsSection.style.display = 'block';
    if (historySection) historySection.style.display = 'block';

    this.loadBalance();
    this.loadHistory();
    this.loadOdBalance();
  },

  onWalletDisconnected() {
    const connectPrompt = document.getElementById('burn-connect-prompt');
    const mainForm = document.getElementById('burn-main-form');
    const statsSection = document.getElementById('burn-stats-section');
    const historySection = document.getElementById('burn-history-section');

    if (connectPrompt) connectPrompt.style.display = '';
    if (mainForm) mainForm.style.display = 'none';
    if (statsSection) statsSection.style.display = 'none';
    if (historySection) historySection.style.display = 'none';

    // Reset balance display
    const balVal = document.getElementById('burn-od-balance-val');
    if (balVal) balVal.textContent = '--';
  },

  // Load $OD token balance via backend API (uses Helius RPC, avoids public rate limits)
  async loadOdBalance() {
    if (!this.walletAddress) return;

    const balVal = document.getElementById('burn-od-balance-val');

    try {
      const data = await api.burnCredits.getOdBalance(this.walletAddress);
      this.odBalance = (data && typeof data.balance === 'number') ? data.balance : 0;
      if (balVal) balVal.textContent = this.formatNumber(this.odBalance);
    } catch (error) {
      console.error('[Burn] Failed to load $OD balance:', error);
      // Fallback: try direct RPC if backend fails
      await this.loadOdBalanceFallback();
    }

    this.onAmountChange();
  },

  // Fallback: load $OD balance directly from Solana RPC
  async loadOdBalanceFallback() {
    if (!this.walletAddress || !this.connection) return;

    const balVal = document.getElementById('burn-od-balance-val');

    try {
      const walletPubkey = new solanaWeb3.PublicKey(this.walletAddress);
      const mintPubkey = new solanaWeb3.PublicKey(this.OD_TOKEN_MINT);
      const ata = this.getAssociatedTokenAddress(walletPubkey, mintPubkey);

      const accountInfo = await this.connection.getTokenAccountBalance(ata);
      this.odBalance = parseFloat(accountInfo.value.uiAmountString || '0');
      if (balVal) balVal.textContent = this.formatNumber(this.odBalance);
    } catch (_) {
      this.odBalance = 0;
      if (balVal) balVal.textContent = '0';
    }
  },

  // Poll backend for transaction confirmation
  async waitForConfirmation(txSignature, maxAttempts = 30, intervalMs = 2000) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const status = await api.burnCredits.getTxStatus(txSignature);
        if (status.err) {
          throw new Error('Transaction failed on-chain');
        }
        if (status.confirmed) {
          return;
        }
      } catch (error) {
        // If it's an actual tx failure, throw immediately
        if (error.message === 'Transaction failed on-chain') throw error;
        // Otherwise keep polling (backend might be temporarily unavailable)
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error('Transaction confirmation timed out. Check your wallet for status.');
  },

  getAssociatedTokenAddress(walletPubkey, mintPubkey) {
    const [ata] = solanaWeb3.PublicKey.findProgramAddressSync(
      [
        walletPubkey.toBuffer(),
        this.SPL_TOKEN_PROGRAM_ID.toBuffer(),
        mintPubkey.toBuffer()
      ],
      this.ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return ata;
  },

  createBurnCheckedInstruction(tokenAccount, mint, authority, amount, decimals) {
    // Instruction index 15 = burnChecked
    const data = new Uint8Array(1 + 8 + 1);
    const view = new DataView(data.buffer);
    data[0] = 15; // burnChecked
    // Write amount as u64 LE
    view.setBigUint64(1, BigInt(amount), true);
    data[9] = decimals;

    return new solanaWeb3.TransactionInstruction({
      keys: [
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: true, isWritable: false }
      ],
      programId: this.SPL_TOKEN_PROGRAM_ID,
      data
    });
  },

  async executeBurn() {
    const amountInput = document.getElementById('burn-amount-input');
    const executeBtn = document.getElementById('burn-execute-btn');
    const executeText = document.getElementById('burn-execute-text');
    const statusEl = document.getElementById('burn-execute-status');

    if (!amountInput || !this.walletAddress) return;

    const amount = parseFloat(amountInput.value);
    if (!amount || amount <= 0 || isNaN(amount)) {
      this.showError('Please enter a valid amount');
      return;
    }

    if (amount < 1) {
      this.showError('Minimum burn amount is 1 $OD');
      return;
    }

    // Prevent precision issues with amounts exceeding safe integer range when scaled
    const MAX_SAFE_AMOUNT = Number.MAX_SAFE_INTEGER / Math.pow(10, this.OD_DECIMALS);
    if (amount > MAX_SAFE_AMOUNT) {
      this.showError('Amount is too large');
      return;
    }

    if (this.odBalance !== null && amount > this.odBalance) {
      this.showError('Insufficient $OD balance');
      return;
    }

    if (typeof solanaWeb3 === 'undefined') {
      this.showError('Solana library not available. Please refresh the page.');
      return;
    }

    if (typeof wallet === 'undefined' || !wallet.provider) {
      this.showError('Wallet not connected. Please reconnect your wallet.');
      return;
    }

    if (wallet.providerName === 'device-session') {
      this.showError('Direct burn requires a browser wallet. Device sessions cannot sign transactions.');
      return;
    }

    this.hideMessages();

    if (executeBtn) executeBtn.disabled = true;
    if (executeText) executeText.textContent = 'Building transaction...';
    if (statusEl) statusEl.textContent = '';

    try {
      const walletPubkey = new solanaWeb3.PublicKey(this.walletAddress);
      const mintPubkey = new solanaWeb3.PublicKey(this.OD_TOKEN_MINT);
      const ata = this.getAssociatedTokenAddress(walletPubkey, mintPubkey);

      // Convert UI amount to raw amount (multiply by 10^decimals)
      const rawAmount = Math.round(amount * Math.pow(10, this.OD_DECIMALS));

      const burnIx = this.createBurnCheckedInstruction(
        ata, mintPubkey, walletPubkey, rawAmount, this.OD_DECIMALS
      );

      if (executeText) executeText.textContent = 'Getting blockhash...';

      // Fetch blockhash via backend Helius RPC
      const bhData = await api.burnCredits.getBlockhash();
      const { blockhash, lastValidBlockHeight } = bhData;

      const transaction = new solanaWeb3.Transaction({
        feePayer: walletPubkey,
        recentBlockhash: blockhash,
        lastValidBlockHeight
      }).add(burnIx);

      if (executeText) executeText.textContent = 'Approve in wallet...';
      if (statusEl) statusEl.textContent = 'Please approve the transaction in your wallet';

      // Use signAndSendTransaction if available (preferred - wallet handles its own RPC)
      let txSignature;
      if (wallet.provider.signAndSendTransaction) {
        const result = await wallet.provider.signAndSendTransaction(transaction);
        txSignature = result.signature;
      } else {
        // Fallback: sign locally, send via backend Helius RPC
        const signed = await wallet.provider.signTransaction(transaction);
        const serialized = signed.serialize();
        const base64Tx = btoa(String.fromCharCode(...serialized));
        const sendResult = await api.burnCredits.sendTransaction(base64Tx);
        txSignature = sendResult.signature;
      }

      if (executeText) executeText.textContent = 'Confirming on-chain...';
      if (statusEl) statusEl.textContent = 'Waiting for transaction confirmation...';

      // Poll for confirmation via backend RPC
      await this.waitForConfirmation(txSignature);

      // Transaction confirmed - now submit to backend for credit
      if (executeText) executeText.textContent = 'Verifying burn...';
      if (statusEl) statusEl.textContent = 'Crediting your account...';

      await this.submitTxToBackend(txSignature);

      // Clear input
      amountInput.value = '';
      if (statusEl) statusEl.textContent = '';
      this.onAmountChange();

      // Refresh balances
      this.loadBalance();
      this.loadHistory();
      this.loadOdBalance();
      this.refreshHeaderBadge();

    } catch (error) {
      console.error('[Burn] Execute error:', error);
      if (statusEl) statusEl.textContent = '';

      if (error.code === 4001 || error.message?.includes('User rejected') || error.message?.includes('cancelled')) {
        this.showError('Transaction was cancelled');
      } else if (error.message?.includes('insufficient')) {
        this.showError('Insufficient SOL for transaction fee or insufficient $OD balance');
      } else if (error.message?.includes('Blockhash not found')) {
        this.showError('Transaction expired. Please try again.');
      } else {
        this.showError(error.message || 'Failed to execute burn transaction');
      }
    } finally {
      if (executeBtn) executeBtn.disabled = false;
      this.onAmountChange(); // Reset button text properly
    }
  },

  async submitTxToBackend(txSignature) {
    // Sign a message to prove wallet ownership
    const signatureTimestamp = Date.now();
    const message = `OpenDex Burn: submit burn tx for ${this.walletAddress} at ${signatureTimestamp}`;

    const signResult = await wallet.signMessage(message);
    if (!signResult || !signResult.signature) {
      throw new Error('Failed to get wallet signature for verification');
    }

    const result = await api.burnCredits.submit({
      txSignature,
      walletAddress: this.walletAddress,
      signature: signResult.signature,
      signatureTimestamp
    });

    // Show success
    const resultEl = document.getElementById('burn-result');
    const resultDetails = document.getElementById('burn-result-details');
    if (resultEl && resultDetails) {
      resultDetails.innerHTML = `
        <strong>${this.formatNumber(result.tokensBurned)} $OD</strong> burned
        &rarr; <strong>${this.formatNumber(result.creditsAwarded)} BC</strong> earned<br>
        New balance: <strong>${this.formatNumber(result.newBalance)} BC</strong>
      `;
      resultEl.style.display = 'block';
    }
  },

  async submitManualBurn() {
    const txInput = document.getElementById('burn-tx-input');
    const submitBtn = document.getElementById('burn-submit-btn');
    const submitText = document.getElementById('burn-submit-text');
    const statusEl = document.getElementById('burn-submit-status');

    if (!txInput || !this.walletAddress) return;

    const txSignature = txInput.value.trim();
    if (!txSignature) {
      this.showError('Please enter a transaction URL or signature');
      return;
    }

    this.hideMessages();

    if (submitBtn) submitBtn.disabled = true;
    if (submitText) submitText.textContent = 'Signing...';
    if (statusEl) statusEl.textContent = 'Requesting wallet signature...';

    try {
      if (typeof wallet === 'undefined' || !wallet.provider) {
        throw new Error('Wallet not connected');
      }
      if (wallet.providerName === 'device-session') {
        throw new Error('Cannot sign messages with a linked device session');
      }

      await this.submitTxToBackend(txSignature);

      // Clear input
      txInput.value = '';
      if (statusEl) statusEl.textContent = '';

      this.loadBalance();
      this.loadHistory();
      this.loadOdBalance();
      this.refreshHeaderBadge();

    } catch (error) {
      const msg = error.message || 'Failed to submit burn transaction';
      this.showError(msg);
      if (statusEl) statusEl.textContent = '';
    } finally {
      if (submitBtn) submitBtn.disabled = false;
      if (submitText) submitText.textContent = 'Submit Burn';
    }
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
            <td class="burn-history-od">${this.formatNumber(parseFloat(entry.token_amount))}</td>
            <td class="burn-history-bc">${this.formatNumber(parseFloat(entry.credits_awarded))}</td>
            <td class="burn-history-rate">${this.escapeHtml(Number(entry.conversion_rate).toLocaleString())}:1</td>
            <td><a href="${solscanUrl}" target="_blank" rel="noopener" class="burn-history-link">${this.escapeHtml(shortSig)}</a></td>
          </tr>`;
      }).join('');
    } catch (error) {
      console.error('Failed to load burn history:', error);
    }
  },

  refreshHeaderBadge() {
    const badge = document.getElementById('header-bc-badge');
    if (badge && typeof wallet !== 'undefined' && wallet._loadHeaderBurnCredits) {
      wallet._loadHeaderBurnCredits(badge);
    }
  },

  hideMessages() {
    const resultEl = document.getElementById('burn-result');
    const errorEl = document.getElementById('burn-error');
    if (resultEl) resultEl.style.display = 'none';
    if (errorEl) errorEl.style.display = 'none';
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
