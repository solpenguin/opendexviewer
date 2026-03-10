/* global api, utils, wallet */

const foliosPage = {
  folios: [],
  currentFolio: null,
  isLoading: false,
  aiAnalysisCost: 75,

  init() {
    document.getElementById('folio-back-btn')?.addEventListener('click', () => this.showList());

    // Bind card click once via delegation (not in renderList)
    document.getElementById('folios-grid')?.addEventListener('click', (e) => {
      const card = e.target.closest('.folio-card');
      if (card) {
        const id = parseInt(card.dataset.folioId, 10);
        if (!isNaN(id)) this.loadDetail(id);
      }
    });

    // Load AI analysis cost from config
    api.burnCredits.getConfig().then(config => {
      if (config?.folioAIAnalysisCost) this.aiAnalysisCost = config.folioAIAnalysisCost;
    }).catch(() => {});

    // Check URL for folio ID
    const params = new URLSearchParams(window.location.search);
    const folioId = params.get('id');
    if (folioId) {
      this.loadDetail(parseInt(folioId, 10));
    } else {
      this.loadList();
    }
  },

  async loadList() {
    if (this.isLoading) return;
    this.isLoading = true;

    this.showState('loading');

    try {
      const result = await api.folios.list();
      this.folios = result.data || [];

      if (this.folios.length === 0) {
        this.showState('empty');
      } else {
        this.renderList();
        this.showState('list');
      }
    } catch (error) {
      console.error('Failed to load folios:', error);
      this.showState('error');
    } finally {
      this.isLoading = false;
    }
  },

  async loadDetail(id) {
    if (this.isLoading) return;
    this.isLoading = true;

    this.showState('loading');

    try {
      const result = await api.folios.get(id);
      this.currentFolio = result.data;

      if (!this.currentFolio) {
        this.showState('error', 'Folio not found');
        return;
      }

      this.renderDetail();
      this.showState('detail');

      // Update URL without reload
      const url = new URL(window.location);
      url.searchParams.set('id', id);
      window.history.pushState({}, '', url);
    } catch (error) {
      console.error('Failed to load folio:', error);
      this.showState('error', 'Failed to load folio');
    } finally {
      this.isLoading = false;
    }
  },

  showList() {
    // Clear URL param
    const url = new URL(window.location);
    url.searchParams.delete('id');
    window.history.pushState({}, '', url);

    this.currentFolio = null;

    if (this.folios.length > 0) {
      this.showState('list');
    } else {
      this.loadList();
    }
  },

  showState(state, errorMsg) {
    const els = {
      loading: document.getElementById('folios-loading'),
      list: document.getElementById('folios-list'),
      detail: document.getElementById('folio-detail'),
      empty: document.getElementById('folios-empty'),
      error: document.getElementById('folios-error')
    };

    Object.values(els).forEach(el => { if (el) el.style.display = 'none'; });

    if (els[state]) els[state].style.display = '';

    if (state === 'error' && errorMsg) {
      const msgEl = document.getElementById('folios-error-msg');
      if (msgEl) msgEl.textContent = errorMsg;
    }
  },

  renderList() {
    const grid = document.getElementById('folios-grid');
    if (!grid) return;

    grid.innerHTML = this.folios.map(folio => {
      const handle = this.esc(folio.twitter_handle).replace(/^@/, '');
      const tokenCount = parseInt(folio.token_count, 10) || 0;
      const avatar = folio.twitter_avatar
        ? `<img src="${this.esc(folio.twitter_avatar)}" alt="${handle}" class="folio-card-avatar" width="40" height="40" onerror="this.outerHTML='<div class=\\'folio-card-avatar folio-card-avatar-placeholder\\'>${handle[0].toUpperCase()}</div>'">`
        : `<div class="folio-card-avatar folio-card-avatar-placeholder">${handle[0].toUpperCase()}</div>`;

      return `
        <div class="folio-card" data-folio-id="${folio.id}">
          <div class="folio-card-header">
            ${avatar}
            <div class="folio-card-meta">
              <h3 class="folio-card-name">${this.esc(folio.name)}</h3>
              <span class="folio-card-handle">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                @${handle}
              </span>
            </div>
          </div>
          ${folio.description ? `<p class="folio-card-desc">${this.esc(folio.description)}</p>` : ''}
          <div class="folio-card-footer">
            <span class="folio-card-count">${tokenCount} token${tokenCount === 1 ? '' : 's'}</span>
            <span class="folio-card-arrow">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </span>
          </div>
        </div>
      `;
    }).join('');
  },

  renderDetail() {
    const folio = this.currentFolio;
    if (!folio) return;

    const handle = (folio.twitter_handle || '').replace(/^@/, '');

    // Header info
    const avatarEl = document.getElementById('folio-avatar');
    if (avatarEl) {
      if (folio.twitter_avatar) {
        avatarEl.src = folio.twitter_avatar;
        avatarEl.alt = handle;
        avatarEl.style.display = '';
        avatarEl.onerror = function() { this.style.display = 'none'; };
      } else {
        avatarEl.style.display = 'none';
      }
    }

    document.getElementById('folio-name').textContent = folio.name || '';
    document.getElementById('folio-handle').textContent = `@${handle}`;
    document.getElementById('folio-twitter').href = `https://x.com/${handle}`;

    const descEl = document.getElementById('folio-description');
    if (descEl) {
      descEl.textContent = folio.description || '';
      descEl.style.display = folio.description ? '' : 'none';
    }

    // AI Analysis button
    const aiBtn = document.getElementById('folio-ai-btn');
    const aiResult = document.getElementById('folio-ai-result');
    if (aiBtn) {
      aiBtn.querySelector('.folio-ai-cost').textContent = `${this.aiAnalysisCost} BC`;
      aiBtn.disabled = false;
      aiBtn.onclick = () => this.runAIAnalysis();
    }
    if (aiResult) {
      aiResult.style.display = 'none';
      aiResult.innerHTML = '';
    }

    // Token table
    const tbody = document.getElementById('folio-tokens-body');
    if (!tbody) return;

    if (!folio.tokens || folio.tokens.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No tokens in this folio yet</td></tr>';
      return;
    }

    tbody.innerHTML = folio.tokens.map((t, i) => {
      const mint = t.token_mint || '';
      const name = t.name || (mint ? `${mint.slice(0, 4)}...${mint.slice(-4)}` : 'Loading...');
      const symbol = t.symbol || (mint ? mint.slice(0, 5).toUpperCase() : '...');
      const logo = t.logo_uri
        ? `<img src="${this.esc(t.logo_uri)}" alt="${this.esc(symbol)}" class="token-logo" width="24" height="24" loading="lazy" onerror="this.style.display='none'">`
        : '';
      const price = t.price ? utils.formatPrice(t.price) : '--';
      const mcap = t.market_cap ? utils.formatNumber(t.market_cap) : '--';
      const vol = t.volume_24h ? utils.formatNumber(t.volume_24h) : '--';

      return `
        <tr class="token-row clickable" data-mint="${t.token_mint}" onclick="window.location.href='token.html?mint=${t.token_mint}'">
          <td class="cell-rank">${i + 1}</td>
          <td class="cell-token">
            <div class="token-identity">
              ${logo}
              <div class="token-names">
                <span class="token-name">${this.esc(name)}</span>
                <span class="token-symbol">${this.esc(symbol)}</span>
              </div>
            </div>
          </td>
          <td class="cell-price">${price}</td>
          <td class="cell-mcap">${mcap}</td>
          <td class="cell-volume">${vol}</td>
          <td class="cell-note">${t.note ? this.esc(t.note) : ''}</td>
        </tr>
      `;
    }).join('');
  },

  async runAIAnalysis() {
    const folio = this.currentFolio;
    if (!folio) return;

    // Check wallet connection
    if (typeof wallet === 'undefined' || !wallet.connected || !wallet.address) {
      if (typeof wallet !== 'undefined') wallet.connect();
      return;
    }

    const aiBtn = document.getElementById('folio-ai-btn');
    const aiResult = document.getElementById('folio-ai-result');
    if (!aiBtn || !aiResult) return;

    // Show loading state
    aiBtn.disabled = true;
    aiBtn.innerHTML = `
      <svg class="folio-ai-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4m-3.93 7.07l-2.83-2.83M7.76 7.76L4.93 4.93"/>
      </svg>
      Analyzing...
    `;
    aiResult.style.display = 'none';

    try {
      const result = await api.folios.aiAnalysis(folio.id, wallet.address);

      aiResult.style.display = '';
      aiResult.innerHTML = `
        <div class="folio-ai-analysis">
          <div class="folio-ai-header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2a4 4 0 014 4c0 1.95-1.4 3.58-3.25 3.93L12 22"/>
              <path d="M12 2a4 4 0 00-4 4c0 1.95 1.4 3.58 3.25 3.93"/>
            </svg>
            AI Folio Analysis${result.cached ? ' <span class="folio-ai-cached">(cached)</span>' : ''}
          </div>
          <div class="folio-ai-text">${this.formatAnalysis(result.analysis)}</div>
        </div>
      `;

      // Reset button
      aiBtn.disabled = false;
      aiBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a4 4 0 014 4c0 1.95-1.4 3.58-3.25 3.93L12 22"/>
          <path d="M12 2a4 4 0 00-4 4c0 1.95 1.4 3.58 3.25 3.93"/>
        </svg>
        AI Analysis <span class="folio-ai-cost">${this.aiAnalysisCost} BC</span>
      `;

      // Refresh BC badge if exists
      if (typeof wallet !== 'undefined' && wallet.address) {
        document.dispatchEvent(new CustomEvent('bc-balance-changed'));
      }
    } catch (err) {
      let errorMsg = 'AI analysis temporarily unavailable. Please try again.';

      if (err?.code === 'INSUFFICIENT_BC') {
        errorMsg = `${err.message} <a href="burn.html" class="folio-ai-burn-link">Get more BC</a>`;
      } else if (err?.code === 'WALLET_REQUIRED') {
        errorMsg = 'Please connect your wallet to use AI analysis.';
      } else if (err?.message) {
        errorMsg = this.esc(err.message);
      }

      aiResult.style.display = '';
      aiResult.innerHTML = `<div class="folio-ai-error">${errorMsg}</div>`;

      // Reset button
      aiBtn.disabled = false;
      aiBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a4 4 0 014 4c0 1.95-1.4 3.58-3.25 3.93L12 22"/>
          <path d="M12 2a4 4 0 00-4 4c0 1.95 1.4 3.58 3.25 3.93"/>
        </svg>
        AI Analysis <span class="folio-ai-cost">${this.aiAnalysisCost} BC</span>
      `;
    }
  },

  formatAnalysis(text) {
    if (!text) return '';
    // Convert line breaks to paragraphs, escape HTML
    return text.split(/\n\n+/).map(p => {
      const escaped = p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // Bold **text**
      const bolded = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      return `<p>${bolded}</p>`;
    }).join('');
  },

  esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
};

// Handle browser back/forward
window.addEventListener('popstate', () => {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  if (id) {
    foliosPage.loadDetail(parseInt(id, 10));
  } else {
    foliosPage.showList();
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => foliosPage.init());
} else {
  foliosPage.init();
}
