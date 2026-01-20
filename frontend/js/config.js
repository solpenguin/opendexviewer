// OpenDexViewer Frontend Configuration
// This file contains environment-specific settings and must be loaded BEFORE api.js

const config = {
  // API Configuration
  api: {
    // Auto-detect environment based on hostname
    baseUrl: (() => {
      const hostname = window.location.hostname;

      // Local development
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return 'http://localhost:3000';
      }

      // Render deployment - update this with your actual API URL
      if (hostname.includes('onrender.com')) {
        return 'https://opendex-api.onrender.com';
      }

      // Custom domain (update as needed)
      // if (hostname === 'yourdomain.com') {
      //   return 'https://api.yourdomain.com';
      // }

      // Default to relative path (same origin)
      return '';
    })(),

    // Request timeout in milliseconds
    timeout: 30000,

    // Retry configuration
    retries: 2,
    retryDelay: 1000
  },

  // App settings
  app: {
    name: 'OpenDexViewer',
    version: '1.0.0',
    debug: window.location.hostname === 'localhost'
  },

  // Feature flags
  features: {
    enableWalletConnect: true,
    enableVoting: true,
    enableSubmissions: true,
    enablePriceAlerts: false,  // Future feature
    enableWatchlist: false      // Future feature
  },

  // UI Configuration
  ui: {
    // Token list refresh interval (ms)
    refreshInterval: 30000,

    // Price refresh interval (ms)
    priceRefreshInterval: 15000,

    // Chart default settings
    chart: {
      defaultInterval: '1h',
      defaultType: 'line'
    },

    // Pagination
    itemsPerPage: 50,

    // Toast notifications
    toastDuration: 4000
  },

  // External links
  links: {
    solscan: 'https://solscan.io',
    jupiter: 'https://jup.ag/swap',
    raydium: 'https://raydium.io/swap',
    github: 'https://github.com/SolPenguin/opendexviewer'
  },

  // Solana configuration
  solana: {
    network: 'mainnet-beta',
    rpcEndpoint: 'https://api.mainnet-beta.solana.com'
  },

  // Centralized localStorage keys (prevents typos and makes refactoring easier)
  storageKeys: {
    walletConnected: 'opendex_wallet_connected',
    walletAddress: 'opendex_wallet_address',
    theme: 'opendex_theme',
    lastFilter: 'opendex_last_filter'
  }
};

// Freeze config to prevent modifications
Object.freeze(config);
Object.freeze(config.api);
Object.freeze(config.app);
Object.freeze(config.features);
Object.freeze(config.ui);
Object.freeze(config.links);
Object.freeze(config.solana);
Object.freeze(config.storageKeys);

// Inject shared dynamic styles (toast, modals, wallet menu)
// This prevents duplicate style injection across multiple JS files
(function injectSharedStyles() {
  if (document.getElementById('opendex-shared-styles')) return;

  const style = document.createElement('style');
  style.id = 'opendex-shared-styles';
  style.textContent = `
    /* Toast Container */
    .toast-container {
      position: fixed;
      bottom: 1.5rem;
      right: 1.5rem;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      pointer-events: none;
    }
    .toast {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.875rem 1.25rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      color: var(--text-primary);
      font-size: 0.875rem;
      box-shadow: var(--shadow);
      pointer-events: auto;
      animation: toastSlideIn 0.3s ease;
      max-width: 350px;
    }
    .toast.success { border-left: 3px solid var(--green); }
    .toast.error { border-left: 3px solid var(--red); }
    .toast.info { border-left: 3px solid var(--accent-primary); }
    .toast.warning { border-left: 3px solid #f59e0b; }
    .toast-icon { font-size: 1.25rem; flex-shrink: 0; }
    .toast-message { flex: 1; }
    .toast-close {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 0.25rem;
      font-size: 1rem;
      line-height: 1;
    }
    .toast-close:hover { color: var(--text-primary); }
    .toast.hiding { animation: toastSlideOut 0.3s ease forwards; }
    @keyframes toastSlideIn {
      from { opacity: 0; transform: translateX(100%); }
      to { opacity: 1; transform: translateX(0); }
    }
    @keyframes toastSlideOut {
      from { opacity: 1; transform: translateX(0); }
      to { opacity: 0; transform: translateX(100%); }
    }

    /* Wallet Menu Modal */
    .wallet-menu {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .wallet-menu-overlay {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
    }
    .wallet-menu-content {
      position: relative;
      background: var(--bg-secondary);
      padding: 1.5rem;
      border-radius: var(--radius-lg);
      border: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      min-width: 300px;
    }
    .wallet-address {
      font-family: monospace;
      font-size: 0.875rem;
      word-break: break-all;
      padding: 0.75rem;
      background: var(--bg-tertiary);
      border-radius: var(--radius-md);
    }

    /* Modal Overlay (generic) */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      animation: fadeIn 0.2s ease;
    }
    .modal-content {
      position: relative;
      background: var(--bg-secondary);
      padding: 2rem;
      border-radius: var(--radius-lg);
      border: 1px solid var(--border-color);
      max-width: 90%;
      max-height: 90vh;
      overflow-y: auto;
      animation: slideUp 0.3s ease;
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes slideUp {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Responsive adjustments */
    @media (max-width: 480px) {
      .toast-container {
        left: 1rem;
        right: 1rem;
        bottom: 1rem;
      }
      .toast { max-width: 100%; }
      .modal-content { padding: 1.5rem; }
    }
  `;
  document.head.appendChild(style);
})();

// Export for debugging
if (config.app.debug) {
  console.log('OpenDexViewer Config:', config);
}
