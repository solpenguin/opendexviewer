// Wallet Connection Handler
const wallet = {
  connected: false,
  address: null,
  provider: null,

  // Check if Phantom is installed
  isPhantomInstalled() {
    return window.solana && window.solana.isPhantom;
  },

  // Check if Solflare is installed
  isSolflareInstalled() {
    return window.solflare && window.solflare.isSolflare;
  },

  // Get available wallet
  getProvider() {
    if (this.isPhantomInstalled()) {
      return window.solana;
    }
    if (this.isSolflareInstalled()) {
      return window.solflare;
    }
    return null;
  },

  // Connect wallet
  async connect() {
    const provider = this.getProvider();

    if (!provider) {
      alert('No Solana wallet found. Please install Phantom or Solflare.');
      window.open('https://phantom.app/', '_blank');
      return false;
    }

    try {
      const response = await provider.connect();
      this.connected = true;
      this.address = response.publicKey.toString();
      this.provider = provider;

      this.updateUI();
      this.saveConnection();

      // Emit connection event
      window.dispatchEvent(new CustomEvent('walletConnected', {
        detail: { address: this.address }
      }));

      return true;
    } catch (error) {
      console.error('Wallet connection error:', error);
      return false;
    }
  },

  // Disconnect wallet
  async disconnect() {
    if (this.provider) {
      try {
        await this.provider.disconnect();
      } catch (error) {
        console.error('Disconnect error:', error);
      }
    }

    this.connected = false;
    this.address = null;
    this.provider = null;

    this.updateUI();
    this.clearConnection();

    // Emit disconnection event
    window.dispatchEvent(new CustomEvent('walletDisconnected'));
  },

  // Sign message (for vote verification)
  async signMessage(message) {
    if (!this.connected || !this.provider) {
      throw new Error('Wallet not connected');
    }

    const encodedMessage = new TextEncoder().encode(message);

    try {
      const { signature } = await this.provider.signMessage(encodedMessage, 'utf8');
      return {
        signature: Array.from(signature),
        address: this.address
      };
    } catch (error) {
      console.error('Sign message error:', error);
      throw error;
    }
  },

  // Update UI elements
  updateUI() {
    const connectBtn = document.getElementById('connect-wallet');
    const walletInput = document.getElementById('submitter-wallet');

    if (connectBtn) {
      if (this.connected) {
        connectBtn.textContent = utils.truncateAddress(this.address);
        connectBtn.classList.add('connected');
        connectBtn.onclick = () => this.showWalletMenu();
      } else {
        connectBtn.textContent = 'Connect Wallet';
        connectBtn.classList.remove('connected');
        connectBtn.onclick = () => this.connect();
      }
    }

    if (walletInput && this.connected) {
      walletInput.value = this.address;
    }
  },

  // Show wallet menu (connected state)
  // Styles are in config.js (opendex-shared-styles) - no duplicate injection
  showWalletMenu() {
    const menu = document.createElement('div');
    menu.className = 'wallet-menu';

    // Build menu using DOM methods for XSS safety
    const overlay = document.createElement('div');
    overlay.className = 'wallet-menu-overlay';
    overlay.onclick = () => menu.remove();

    const content = document.createElement('div');
    content.className = 'wallet-menu-content';

    const addressP = document.createElement('p');
    addressP.className = 'wallet-address';
    addressP.textContent = this.address; // Safe: textContent escapes HTML

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-secondary';
    copyBtn.textContent = 'Copy Address';
    copyBtn.onclick = () => {
      utils.copyToClipboard(this.address);
      copyBtn.textContent = 'Copied!';
    };

    const disconnectBtn = document.createElement('button');
    disconnectBtn.className = 'btn btn-secondary';
    disconnectBtn.textContent = 'Disconnect';
    disconnectBtn.onclick = () => {
      wallet.disconnect();
      menu.remove();
    };

    content.appendChild(addressP);
    content.appendChild(copyBtn);
    content.appendChild(disconnectBtn);
    menu.appendChild(overlay);
    menu.appendChild(content);

    document.body.appendChild(menu);
  },

  // Get storage key (uses config if available, fallback for safety)
  _getStorageKey(key) {
    return (typeof config !== 'undefined' && config.storageKeys?.[key])
      ? config.storageKeys[key]
      : `opendex_${key}`;
  },

  // Save connection to localStorage
  saveConnection() {
    if (this.connected && this.address) {
      localStorage.setItem(this._getStorageKey('walletConnected'), 'true');
      localStorage.setItem(this._getStorageKey('walletAddress'), this.address);
    }
  },

  // Clear saved connection
  clearConnection() {
    localStorage.removeItem(this._getStorageKey('walletConnected'));
    localStorage.removeItem(this._getStorageKey('walletAddress'));
  },

  // Auto-reconnect on page load
  async autoConnect() {
    const wasConnected = localStorage.getItem(this._getStorageKey('walletConnected')) === 'true';

    if (wasConnected && this.getProvider()) {
      try {
        // Check if already connected
        const provider = this.getProvider();
        if (provider.isConnected) {
          this.connected = true;
          this.address = provider.publicKey?.toString();
          this.provider = provider;
          this.updateUI();
        }
      } catch (error) {
        console.log('Auto-connect failed:', error.message);
        this.clearConnection();
      }
    }
  },

  // Initialize
  init() {
    // Set up connect button
    const connectBtn = document.getElementById('connect-wallet');
    if (connectBtn) {
      connectBtn.onclick = () => this.connect();
    }

    // Listen for wallet events
    const provider = this.getProvider();
    if (provider) {
      provider.on('connect', () => {
        this.connected = true;
        this.address = provider.publicKey?.toString();
        this.provider = provider;
        this.updateUI();
      });

      provider.on('disconnect', () => {
        this.connected = false;
        this.address = null;
        this.updateUI();
      });

      provider.on('accountChanged', (publicKey) => {
        if (publicKey) {
          this.address = publicKey.toString();
          this.updateUI();
        } else {
          this.disconnect();
        }
      });
    }

    // Try auto-connect
    this.autoConnect();
  }
};

// Initialize wallet on DOM load
document.addEventListener('DOMContentLoaded', () => {
  wallet.init();
});
