/**
 * Announcements banner
 * Polls /api/announcements/active and renders a sticky top-of-page banner.
 * Dismissed announcement IDs are stored in localStorage so the banner
 * stays hidden across page reloads.
 */

// ── Inject CSS ──────────────────────────────────────────────────────────────
(function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    #announcement-banner {
      display: none;
      position: sticky;
      top: 0;
      z-index: 1100;
      padding: 10px 20px;
      box-sizing: border-box;
      width: 100%;
    }
    #announcement-banner[data-type="info"] {
      background: #0d2140;
      color: #7ec8e3;
      border-bottom: 2px solid #1e5a8a;
    }
    #announcement-banner[data-type="warning"] {
      background: #2d1f00;
      color: #ffc107;
      border-bottom: 2px solid #a07800;
    }
    #announcement-banner[data-type="success"] {
      background: #071f0f;
      color: #4caf50;
      border-bottom: 2px solid #1b5e20;
    }
    #announcement-banner[data-type="error"] {
      background: #1f0707;
      color: #ef5350;
      border-bottom: 2px solid #b71c1c;
    }
    .announcement-inner {
      max-width: 960px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .announcement-icon {
      flex-shrink: 0;
      font-size: 1rem;
      line-height: 1;
    }
    .announcement-title {
      font-weight: 700;
      white-space: nowrap;
    }
    .announcement-sep {
      opacity: 0.5;
      white-space: nowrap;
    }
    .announcement-message {
      flex: 1;
      line-height: 1.4;
    }
    .announcement-dismiss {
      flex-shrink: 0;
      background: none;
      border: none;
      cursor: pointer;
      opacity: 0.65;
      font-size: 1.25rem;
      line-height: 1;
      padding: 0 4px;
      color: inherit;
      transition: opacity 0.15s;
    }
    .announcement-dismiss:hover { opacity: 1; }
  `;
  document.head.appendChild(style);
})();

// ── Module ───────────────────────────────────────────────────────────────────
const announcements = {
  POLL_INTERVAL_MS: 5 * 60 * 1000,   // re-check every 5 minutes
  LS_KEY: 'dismissed_announcements',  // localStorage key
  _timer: null,

  // IDs the user has permanently dismissed
  getDismissed() {
    try {
      return JSON.parse(localStorage.getItem(this.LS_KEY) || '[]');
    } catch {
      return [];
    }
  },

  dismiss(id) {
    const dismissed = this.getDismissed();
    if (!dismissed.includes(id)) {
      dismissed.push(id);
      // Trim to the last 200 entries to prevent unbounded growth
      const trimmed = dismissed.slice(-200);
      localStorage.setItem(this.LS_KEY, JSON.stringify(trimmed));
    }
    this.hideBanner();
  },

  hideBanner() {
    const banner = document.getElementById('announcement-banner');
    if (banner) banner.style.display = 'none';
  },

  showBanner(announcement) {
    const banner = document.getElementById('announcement-banner');
    if (!banner) return;

    const icons = { info: 'ℹ️', warning: '⚠️', success: '✅', error: '🚨' };
    const icon = icons[announcement.type] || 'ℹ️';

    // Escape helper — utils from api.js may not be loaded on every page,
    // so we include a local fallback
    const esc = (typeof utils !== 'undefined' && utils.escapeHtml)
      ? (s) => utils.escapeHtml(s)
      : (s) => String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');

    banner.dataset.type = announcement.type;
    banner.innerHTML = `
      <div class="announcement-inner">
        <span class="announcement-icon">${icon}</span>
        <strong class="announcement-title">${esc(announcement.title)}</strong>
        <span class="announcement-sep">—</span>
        <span class="announcement-message">${esc(announcement.message)}</span>
        <button
          class="announcement-dismiss"
          aria-label="Dismiss announcement"
          data-id="${announcement.id}"
        >✕</button>
      </div>
    `;

    banner.querySelector('.announcement-dismiss').addEventListener('click', () => {
      this.dismiss(announcement.id);
    });

    banner.style.display = 'block';
  },

  async fetchAndRender() {
    try {
      const apiBase = (typeof config !== 'undefined' && config.api && config.api.baseUrl)
        ? config.api.baseUrl
        : '';
      const res = await fetch(`${apiBase}/api/announcements/active`);
      if (!res.ok) return;

      const data = await res.json();
      const active = (data.announcements || []);
      const dismissed = this.getDismissed();

      // Show the first announcement that the user hasn't dismissed
      const toShow = active.find(a => !dismissed.includes(a.id));
      if (toShow) {
        this.showBanner(toShow);
      } else {
        this.hideBanner();
      }
    } catch {
      // Network errors are silent — the banner just stays hidden
    }
  },

  init() {
    this.fetchAndRender();
    this._timer = setInterval(() => this.fetchAndRender(), this.POLL_INTERVAL_MS);
  }
};

// Start on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => announcements.init());
} else {
  announcements.init();
}
