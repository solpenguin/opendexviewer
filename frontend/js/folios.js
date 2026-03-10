/* global api, utils */

const foliosPage = {
  folios: [],
  currentFolio: null,
  isLoading: false,

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

    // Token table
    const tbody = document.getElementById('folio-tokens-body');
    if (!tbody) return;

    if (!folio.tokens || folio.tokens.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No tokens in this folio yet</td></tr>';
      return;
    }

    tbody.innerHTML = folio.tokens.map((t, i) => {
      const name = t.name || 'Unknown';
      const symbol = t.symbol || '???';
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
