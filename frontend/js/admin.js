/**
 * Admin Panel JavaScript
 * Handles authentication, data loading, and admin actions
 */

// Admin API client
const adminApi = {
  sessionToken: null,

  // Get headers with session token
  getHeaders() {
    const headers = {
      'Content-Type': 'application/json'
    };
    if (this.sessionToken) {
      headers['X-Admin-Session'] = this.sessionToken;
    }
    return headers;
  },

  // Generic request wrapper
  async request(endpoint, options = {}) {
    const _t0 = performance.now();
    const url = `${API_BASE_URL}${endpoint}`;
    let _ok = false;
    try {
      const response = await fetch(url, {
        ...options,
        headers: this.getHeaders(),
        credentials: 'include' // Include cookies
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      _ok = true;
      return data;
    } finally {
      if (typeof latencyTracker !== 'undefined') {
        latencyTracker.record(endpoint, performance.now() - _t0, _ok);
      }
    }
  },

  // Auth endpoints
  async login(password) {
    const result = await this.request('/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password })
    });
    if (result.success && result.data?.sessionToken) {
      this.sessionToken = result.data.sessionToken;
      sessionStorage.setItem('admin_session', result.data.sessionToken);
    }
    return result;
  },

  async logout() {
    const result = await this.request('/admin/logout', {
      method: 'POST'
    });
    this.sessionToken = null;
    sessionStorage.removeItem('admin_session');
    return result;
  },

  async checkSession() {
    return this.request('/admin/session');
  },

  // Stats
  async getStats() {
    return this.request('/admin/stats');
  },

  // Submissions
  async getSubmissions(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/admin/submissions${query ? `?${query}` : ''}`);
  },

  async updateSubmissionStatus(id, status) {
    return this.request(`/admin/submissions/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status })
    });
  },

  async deleteSubmission(id) {
    return this.request(`/admin/submissions/${id}`, {
      method: 'DELETE'
    });
  },

  // API Keys
  async getApiKeys(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/admin/api-keys${query ? `?${query}` : ''}`);
  },

  async revokeApiKey(id) {
    return this.request(`/admin/api-keys/${id}/revoke`, {
      method: 'PATCH'
    });
  },

  async deleteApiKey(id) {
    return this.request(`/admin/api-keys/${id}`, {
      method: 'DELETE'
    });
  },

  // Tokens
  async getTokens(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/admin/tokens${query ? `?${query}` : ''}`);
  },

  async getTokenSubmissions(tokenMint, params = {}) {
    const queryParams = { tokenMint, ...params };
    const query = new URLSearchParams(queryParams).toString();
    return this.request(`/admin/submissions${query ? `?${query}` : ''}`);
  },

  async updateSubmission(id, updates) {
    return this.request(`/admin/submissions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates)
    });
  },

  // Settings
  async getSettings() {
    return this.request('/admin/settings');
  },

  async updateSettings(settings) {
    return this.request('/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings)
    });
  },

  // Database management
  async getDatabaseStatus() {
    return this.request('/admin/database/status');
  },

  async repairDatabase() {
    return this.request('/admin/database/repair', {
      method: 'POST'
    });
  },

  // Announcements
  async getAnnouncements() {
    return this.request('/admin/announcements');
  },

  async createAnnouncement(data) {
    return this.request('/admin/announcements', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  async updateAnnouncement(id, data) {
    return this.request(`/admin/announcements/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    });
  },

  async deleteAnnouncement(id) {
    return this.request(`/admin/announcements/${id}`, {
      method: 'DELETE'
    });
  },

  // Bug Reports
  async getBugReports(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/api/bug-reports/admin${query ? `?${query}` : ''}`);
  },

  async getBugReport(id) {
    return this.request(`/api/bug-reports/admin/${id}`);
  },

  async updateBugReport(id, data) {
    return this.request(`/api/bug-reports/admin/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    });
  },

  async deleteBugReport(id) {
    return this.request(`/api/bug-reports/admin/${id}`, {
      method: 'DELETE'
    });
  }
};

// Admin Panel Manager
const adminPanel = {
  currentTab: 'dashboard',
  pagination: {
    submissions: { page: 1, limit: 20, total: 0 },
    apikeys: { page: 1, limit: 20, total: 0 },
    tokens: { page: 1, limit: 20, total: 0 },
    bugreports: { page: 1, limit: 20, total: 0 }
  },

  // Initialize
  async init() {
    // Check for stored session
    const storedSession = sessionStorage.getItem('admin_session');
    if (storedSession) {
      adminApi.sessionToken = storedSession;
      try {
        await adminApi.checkSession();
        this.showPanel();
        this.loadDashboard();
      } catch (error) {
        // Session invalid, show login
        sessionStorage.removeItem('admin_session');
        adminApi.sessionToken = null;
        this.showLogin();
      }
    } else {
      this.showLogin();
    }

    this.bindEvents();
  },

  // Show login screen
  showLogin() {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('admin-panel').style.display = 'none';
  },

  // Show admin panel
  showPanel() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('admin-panel').style.display = 'flex';
  },

  // Bind event listeners
  bindEvents() {
    // Login form
    document.getElementById('login-form').addEventListener('submit', (e) => this.handleLogin(e));

    // Logout button
    document.getElementById('logout-btn').addEventListener('click', () => this.handleLogout());

    // Navigation tabs
    document.querySelectorAll('.admin-nav-item').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    // Refresh buttons
    document.getElementById('refresh-stats')?.addEventListener('click', () => this.loadDashboard());
    document.getElementById('refresh-submissions')?.addEventListener('click', () => this.loadSubmissions());
    document.getElementById('refresh-apikeys')?.addEventListener('click', () => this.loadApiKeys());
    document.getElementById('refresh-tokens')?.addEventListener('click', () => this.loadTokens());

    // Token search (debounced)
    let tokenSearchTimer = null;
    document.getElementById('tokens-search')?.addEventListener('input', () => {
      clearTimeout(tokenSearchTimer);
      tokenSearchTimer = setTimeout(() => {
        this.pagination.tokens.page = 1;
        this.loadTokens();
      }, 400);
    });

    // Submission filter
    document.getElementById('submission-filter')?.addEventListener('change', () => {
      this.pagination.submissions.page = 1;
      this.loadSubmissions();
    });

    // Bug report refresh and filter
    document.getElementById('refresh-bugreports')?.addEventListener('click', () => this.loadBugReports());
    document.getElementById('bugreport-filter')?.addEventListener('change', () => {
      this.pagination.bugreports.page = 1;
      this.loadBugReports();
    });

    // Pagination
    this.bindPagination('submissions');
    this.bindPagination('apikeys');
    this.bindPagination('tokens');
    this.bindPagination('bugreports');

    // Modal
    document.querySelector('#confirm-modal .modal-backdrop')?.addEventListener('click', () => this.hideModal());
    document.getElementById('confirm-cancel')?.addEventListener('click', () => this.hideModal());

    // Token edit modal
    document.querySelector('#token-edit-modal .modal-backdrop')?.addEventListener('click', () => this.hideTokenEditModal());
    document.getElementById('token-edit-close')?.addEventListener('click', () => this.hideTokenEditModal());

    // Development mode toggle
    document.getElementById('dev-mode-toggle')?.addEventListener('change', (e) => this.toggleDevMode(e.target.checked));

    // Database management buttons
    document.getElementById('check-database-btn')?.addEventListener('click', () => this.checkDatabaseStatus());
    document.getElementById('repair-database-btn')?.addEventListener('click', () => this.repairDatabase());

    // Event delegation for dynamically rendered table action buttons
    document.getElementById('submissions-table')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = parseInt(btn.dataset.id, 10);
      if (!id) return;
      if (btn.dataset.action === 'approve') this.approveSubmission(id);
      else if (btn.dataset.action === 'reject') this.rejectSubmission(id);
      else if (btn.dataset.action === 'delete-submission') this.deleteSubmission(id);
    });

    document.getElementById('apikeys-table')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = parseInt(btn.dataset.id, 10);
      if (!id) return;
      if (btn.dataset.action === 'revoke-key') this.revokeApiKey(id);
      else if (btn.dataset.action === 'delete-key') this.deleteApiKey(id);
    });
  },

  bindPagination(type) {
    document.getElementById(`${type}-prev`)?.addEventListener('click', () => {
      if (this.pagination[type].page > 1) {
        this.pagination[type].page--;
        this.loadTabData(type);
      }
    });

    document.getElementById(`${type}-next`)?.addEventListener('click', () => {
      const maxPage = Math.ceil(this.pagination[type].total / this.pagination[type].limit);
      if (this.pagination[type].page < maxPage) {
        this.pagination[type].page++;
        this.loadTabData(type);
      }
    });
  },

  loadTabData(type) {
    switch (type) {
      case 'submissions':
        this.loadSubmissions();
        break;
      case 'apikeys':
        this.loadApiKeys();
        break;
      case 'tokens':
        this.loadTokens();
        break;
      case 'bugreports':
        this.loadBugReports();
        break;
    }
  },

  // Handle login
  async handleLogin(e) {
    e.preventDefault();

    const passwordInput = document.getElementById('password');
    const errorEl = document.getElementById('login-error');
    const btnText = document.querySelector('.btn-text');
    const btnLoading = document.querySelector('.btn-loading');
    const submitBtn = document.querySelector('#login-form button[type="submit"]');

    // Show loading state
    btnText.style.display = 'none';
    btnLoading.style.display = 'flex';
    submitBtn.disabled = true;
    errorEl.style.display = 'none';

    try {
      await adminApi.login(passwordInput.value);
      this.showPanel();
      this.loadDashboard();
      passwordInput.value = '';
    } catch (error) {
      errorEl.textContent = error.message || 'Login failed';
      errorEl.style.display = 'block';
    } finally {
      btnText.style.display = 'flex';
      btnLoading.style.display = 'none';
      submitBtn.disabled = false;
    }
  },

  // Handle logout
  async handleLogout() {
    try {
      await adminApi.logout();
    } catch (error) {
      console.error('Logout error:', error);
    }
    this.showLogin();
  },

  // Switch tabs
  switchTab(tab) {
    // Update nav
    document.querySelectorAll('.admin-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // Update tabs
    document.querySelectorAll('.admin-tab').forEach(tabEl => {
      tabEl.classList.toggle('active', tabEl.id === `tab-${tab}`);
    });

    this.currentTab = tab;

    // Load data if needed
    switch (tab) {
      case 'dashboard':
        this.loadDashboard();
        break;
      case 'submissions':
        this.loadSubmissions();
        break;
      case 'api-keys':
        this.loadApiKeys();
        break;
      case 'tokens':
        this.loadTokens();
        break;
      case 'settings':
        this.loadSettings();
        break;
      case 'announcements':
        this.loadAnnouncements();
        break;
      case 'bug-reports':
        this.loadBugReports();
        break;
    }
  },

  // Load dashboard stats
  async loadDashboard() {
    try {
      const result = await adminApi.getStats();
      const stats = result.data;

      document.getElementById('stat-pending').textContent = stats.submissions.pending;
      document.getElementById('stat-approved').textContent = stats.submissions.approved;
      document.getElementById('stat-rejected').textContent = stats.submissions.rejected;
      document.getElementById('stat-total').textContent = stats.submissions.total;
      document.getElementById('stat-votes').textContent = stats.votes.toLocaleString();
      document.getElementById('stat-tokens').textContent = stats.tokens.toLocaleString();
      document.getElementById('stat-apikeys').textContent = `${stats.apiKeys.active} / ${stats.apiKeys.total}`;
      document.getElementById('stat-recent-submissions').textContent = stats.recentSubmissions;
      document.getElementById('stat-recent-votes').textContent = stats.recentVotes;

      // Update pending badge
      const pendingBadge = document.getElementById('pending-badge');
      if (stats.submissions.pending > 0) {
        pendingBadge.textContent = stats.submissions.pending;
        pendingBadge.style.display = 'inline';
      } else {
        pendingBadge.style.display = 'none';
      }

      // Update bug reports stat and badge
      document.getElementById('stat-bugreports').textContent = stats.bugReports || 0;
      const bugBadge = document.getElementById('bugreports-badge');
      if (bugBadge) {
        if (stats.bugReports > 0) {
          bugBadge.textContent = stats.bugReports;
          bugBadge.style.display = 'inline';
        } else {
          bugBadge.style.display = 'none';
        }
      }
    } catch (error) {
      console.error('Failed to load stats:', error);
      toast.error('Failed to load dashboard stats');
    }

    this.renderPerfMetrics();
  },

  // Render performance metrics table on the dashboard (API + frontend latency)
  renderPerfMetrics() {
    const container = document.getElementById('perf-metrics');
    if (!container || typeof latencyTracker === 'undefined') return;

    const summary = latencyTracker.getSummary();

    if (summary.length === 0) {
      container.innerHTML = '<p class="perf-empty">No requests recorded yet — interact with the app to populate data.</p>';
      return;
    }

    // Color-code a latency value: green <200ms, amber <800ms, red ≥800ms
    function latColor(ms) {
      if (ms < 200) return 'var(--green, #22c55e)';
      if (ms < 800) return '#f59e0b';
      return 'var(--red, #ef4444)';
    }

    // Type badge: API (blue) or FE (purple)
    function typeBadge(type) {
      if (type === 'frontend') return '<span class="perf-badge perf-badge-fe">FE</span>';
      return '<span class="perf-badge perf-badge-api">API</span>';
    }

    const rows = summary.map(s => `
      <tr>
        <td class="perf-endpoint">${typeBadge(s.type)} ${this.escapeHtml(String(s.endpoint))}</td>
        <td class="perf-num">${parseInt(s.count) || 0}${s.errors > 0 ? `<span class="perf-err"> ${parseInt(s.errors) || 0}✗</span>` : ''}</td>
        <td class="perf-num" style="color:${latColor(s.avg)}">${parseInt(s.avg) || 0}</td>
        <td class="perf-num" style="color:${latColor(s.p95)}">${parseInt(s.p95) || 0}</td>
        <td class="perf-num">${parseInt(s.min) || 0}</td>
        <td class="perf-num">${parseInt(s.max) || 0}</td>
        <td class="perf-num" style="color:${latColor(s.last)}">${parseInt(s.last) || 0}</td>
      </tr>`).join('');

    container.innerHTML = `
      <table class="perf-table">
        <thead>
          <tr>
            <th>Operation</th>
            <th>Calls</th>
            <th>Avg ms</th>
            <th>P95 ms</th>
            <th>Min ms</th>
            <th>Max ms</th>
            <th>Last ms</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="perf-legend">Rolling last 100 samples &nbsp;·&nbsp; <span class="perf-badge perf-badge-api">API</span> backend request &nbsp;·&nbsp; <span class="perf-badge perf-badge-fe">FE</span> frontend operation &nbsp;·&nbsp; <span style="color:var(--green,#22c55e)">green</span> &lt;200ms &nbsp;·&nbsp; <span style="color:#f59e0b">amber</span> &lt;800ms &nbsp;·&nbsp; <span style="color:var(--red,#ef4444)">red</span> ≥800ms</p>`;
  },

  // Load submissions
  async loadSubmissions() {
    const tbody = document.getElementById('submissions-table');
    tbody.innerHTML = `
      <tr class="loading-row">
        <td colspan="8">
          <div class="loading-state">
            <div class="loading-spinner"></div>
            <span>Loading submissions...</span>
          </div>
        </td>
      </tr>
    `;

    try {
      const status = document.getElementById('submission-filter').value;
      const { page, limit } = this.pagination.submissions;
      const offset = (page - 1) * limit;

      const result = await adminApi.getSubmissions({ status, limit, offset });
      const { submissions, total } = result.data;

      this.pagination.submissions.total = total;
      this.updatePaginationUI('submissions');

      if (submissions.length === 0) {
        tbody.innerHTML = `
          <tr class="empty-row">
            <td colspan="8">No submissions found</td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = submissions.map(sub => `
        <tr>
          <td>${sub.id}</td>
          <td>
            <div class="token-info">
              <div>
                <div class="token-name">${this.escapeHtml(sub.token_name || 'Unknown')}</div>
                <div class="token-symbol">${this.escapeHtml(sub.token_symbol || sub.token_mint.slice(0, 8) + '...')}</div>
              </div>
            </div>
          </td>
          <td><span class="type-badge">${this.escapeHtml(sub.submission_type)}</span></td>
          <td class="content-url">
            <a href="${/^https?:\/\//i.test(sub.content_url) ? this.escapeHtml(sub.content_url) : '#'}" target="_blank" rel="noopener">${this.escapeHtml(sub.content_url)}</a>
          </td>
          <td>
            <span class="score-display ${sub.score > 0 ? 'score-up' : sub.score < 0 ? 'score-down' : 'score-neutral'}">
              ${sub.score > 0 ? '+' : ''}${sub.score || 0}
            </span>
          </td>
          <td><span class="status-badge ${this.escapeHtml(sub.status)}">${this.escapeHtml(sub.status)}</span></td>
          <td>${this.formatDate(sub.created_at)}</td>
          <td>
            <div class="table-actions">
              ${sub.status === 'pending' ? `
                <button class="action-btn approve" data-action="approve" data-id="${parseInt(sub.id, 10) || 0}">Approve</button>
                <button class="action-btn reject" data-action="reject" data-id="${parseInt(sub.id, 10) || 0}">Reject</button>
              ` : ''}
              <button class="action-btn delete" data-action="delete-submission" data-id="${parseInt(sub.id, 10) || 0}">Delete</button>
            </div>
          </td>
        </tr>
      `).join('');

    } catch (error) {
      console.error('Failed to load submissions:', error);
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="8">Failed to load submissions: ${this.escapeHtml(error.message)}</td>
        </tr>
      `;
    }
  },

  // Load API keys
  async loadApiKeys() {
    const tbody = document.getElementById('apikeys-table');
    tbody.innerHTML = `
      <tr class="loading-row">
        <td colspan="9">
          <div class="loading-state">
            <div class="loading-spinner"></div>
            <span>Loading API keys...</span>
          </div>
        </td>
      </tr>
    `;

    try {
      const { page, limit } = this.pagination.apikeys;
      const offset = (page - 1) * limit;

      const result = await adminApi.getApiKeys({ limit, offset });
      const { keys, total } = result.data;

      this.pagination.apikeys.total = total;
      this.updatePaginationUI('apikeys');

      if (keys.length === 0) {
        tbody.innerHTML = `
          <tr class="empty-row">
            <td colspan="9">No API keys found</td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = keys.map(key => `
        <tr>
          <td>${key.id}</td>
          <td><code>${key.key_prefix}...</code></td>
          <td class="wallet-address">${this.truncateAddress(key.owner_wallet)}</td>
          <td>${this.escapeHtml(key.name || '-')}</td>
          <td>${key.request_count.toLocaleString()}</td>
          <td><span class="status-badge ${key.is_active ? 'active' : 'revoked'}">${key.is_active ? 'Active' : 'Revoked'}</span></td>
          <td>${this.formatDate(key.created_at)}</td>
          <td>${key.last_used_at ? this.formatDate(key.last_used_at) : '-'}</td>
          <td>
            <div class="table-actions">
              ${key.is_active ? `
                <button class="action-btn revoke" data-action="revoke-key" data-id="${parseInt(key.id, 10) || 0}">Revoke</button>
              ` : ''}
              <button class="action-btn delete" data-action="delete-key" data-id="${parseInt(key.id, 10) || 0}">Delete</button>
            </div>
          </td>
        </tr>
      `).join('');

    } catch (error) {
      console.error('Failed to load API keys:', error);
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="9">Failed to load API keys: ${this.escapeHtml(error.message)}</td>
        </tr>
      `;
    }
  },

  // Load tokens
  async loadTokens() {
    const tbody = document.getElementById('tokens-table');
    tbody.innerHTML = `
      <tr class="loading-row">
        <td colspan="7">
          <div class="loading-state">
            <div class="loading-spinner"></div>
            <span>Loading tokens...</span>
          </div>
        </td>
      </tr>
    `;

    try {
      const { page, limit } = this.pagination.tokens;
      const offset = (page - 1) * limit;
      const search = document.getElementById('tokens-search')?.value.trim() || '';

      const params = { limit, offset };
      if (search.length >= 2) params.search = search;

      const result = await adminApi.getTokens(params);
      const { tokens, total } = result.data;

      this.pagination.tokens.total = total;
      this.updatePaginationUI('tokens');

      if (tokens.length === 0) {
        tbody.innerHTML = `
          <tr class="empty-row">
            <td colspan="7">${search ? 'No tokens match your search' : 'No tokens found'}</td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = tokens.map(token => `
        <tr>
          <td>
            <div class="token-info">
              ${token.logo_uri ? `<img src="${this.escapeHtml(token.logo_uri)}" class="token-logo-small" alt="">` : ''}
              <span class="token-name">${this.escapeHtml(token.name || 'Unknown')}</span>
            </div>
          </td>
          <td>${this.escapeHtml(token.symbol || '-')}</td>
          <td class="wallet-address" title="${this.escapeHtml(token.mint_address)}">${this.truncateAddress(token.mint_address)}</td>
          <td>${token.submission_count}</td>
          <td>${token.pending_count > 0 ? `<span class="status-badge pending">${token.pending_count}</span>` : '0'}</td>
          <td>${this.formatDate(token.created_at)}</td>
          <td>
            <div class="table-actions">
              <button class="action-btn view token-edit-btn" data-mint="${this.escapeHtml(token.mint_address)}" data-name="${this.escapeHtml(token.name || 'Unknown')}">Edit</button>
            </div>
          </td>
        </tr>
      `).join('');

      // Wire edit buttons
      tbody.querySelectorAll('.token-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          this.showTokenEditModal(btn.dataset.mint, btn.dataset.name);
        });
      });

    } catch (error) {
      console.error('Failed to load tokens:', error);
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="7">Failed to load tokens: ${this.escapeHtml(error.message)}</td>
        </tr>
      `;
    }
  },

  // Token edit modal
  async showTokenEditModal(mintAddress, tokenName) {
    const modal = document.getElementById('token-edit-modal');
    const title = document.getElementById('token-edit-title');
    const body = document.getElementById('token-edit-body');

    title.textContent = `Edit: ${tokenName}`;
    body.innerHTML = `
      <div class="loading-state">
        <div class="loading-spinner"></div>
        <span>Loading submissions...</span>
      </div>
    `;
    modal.style.display = 'flex';

    try {
      const result = await adminApi.getTokenSubmissions(mintAddress, { limit: 100 });
      const submissions = result.data.submissions || [];

      if (submissions.length === 0) {
        body.innerHTML = '<div class="no-submissions-msg">No submissions for this token.</div>';
        return;
      }

      body.innerHTML = submissions.map(sub => `
        <div class="submission-edit-row" data-sub-id="${parseInt(sub.id, 10) || 0}">
          <span class="sub-type">${this.escapeHtml(sub.submission_type)}</span>
          <span class="sub-status"><span class="status-badge ${this.escapeHtml(sub.status)}">${this.escapeHtml(sub.status)}</span></span>
          <input type="text" class="sub-url-input" value="${this.escapeHtml(sub.content_url || '')}" data-field="contentUrl">
          <label class="sub-cto-label">
            <input type="checkbox" ${sub.is_cto ? 'checked' : ''} data-field="isCTO">
            CTO
          </label>
          <button class="btn btn-primary btn-sm sub-save-btn">Save</button>
        </div>
      `).join('');

      // Wire save buttons
      body.querySelectorAll('.sub-save-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('.submission-edit-row');
          const id = parseInt(row.dataset.subId);
          const contentUrl = row.querySelector('[data-field="contentUrl"]').value.trim();
          const isCTO = row.querySelector('[data-field="isCTO"]').checked;

          if (!contentUrl) {
            toast.error('URL cannot be empty');
            return;
          }

          btn.disabled = true;
          btn.textContent = 'Saving...';

          try {
            await adminApi.updateSubmission(id, { contentUrl, isCTO });
            toast.success('Submission updated');
            btn.textContent = 'Saved';
            setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500);
            this.loadTokens();
          } catch (error) {
            toast.error(`Failed to save: ${error.message}`);
            btn.textContent = 'Save';
            btn.disabled = false;
          }
        });
      });

    } catch (error) {
      body.innerHTML = `<div class="no-submissions-msg">Failed to load submissions: ${this.escapeHtml(error.message)}</div>`;
    }
  },

  hideTokenEditModal() {
    document.getElementById('token-edit-modal').style.display = 'none';
    document.getElementById('token-edit-body').innerHTML = '';
  },

  // Update pagination UI
  updatePaginationUI(type) {
    const { page, limit, total } = this.pagination[type];
    const maxPage = Math.ceil(total / limit) || 1;
    const start = (page - 1) * limit + 1;
    const end = Math.min(page * limit, total);

    document.getElementById(`${type}-info`).textContent = total > 0
      ? `Showing ${start}-${end} of ${total}`
      : 'Showing 0 of 0';
    document.getElementById(`${type}-page`).textContent = `Page ${page} of ${maxPage}`;
    document.getElementById(`${type}-prev`).disabled = page <= 1;
    document.getElementById(`${type}-next`).disabled = page >= maxPage;
  },

  // Submission actions
  async approveSubmission(id) {
    try {
      await adminApi.updateSubmissionStatus(id, 'approved');
      toast.success('Submission approved');
      this.loadSubmissions();
      this.loadDashboard();
    } catch (error) {
      toast.error(`Failed to approve: ${error.message}`);
    }
  },

  async rejectSubmission(id) {
    try {
      await adminApi.updateSubmissionStatus(id, 'rejected');
      toast.success('Submission rejected');
      this.loadSubmissions();
      this.loadDashboard();
    } catch (error) {
      toast.error(`Failed to reject: ${error.message}`);
    }
  },

  async deleteSubmission(id) {
    this.showConfirmModal(
      'Delete Submission',
      'Are you sure you want to permanently delete this submission? This action cannot be undone.',
      async () => {
        try {
          await adminApi.deleteSubmission(id);
          toast.success('Submission deleted');
          this.loadSubmissions();
          this.loadDashboard();
        } catch (error) {
          toast.error(`Failed to delete: ${error.message}`);
        }
      }
    );
  },

  // API key actions
  async revokeApiKey(id) {
    this.showConfirmModal(
      'Revoke API Key',
      'Are you sure you want to revoke this API key? The user will no longer be able to access the API with this key.',
      async () => {
        try {
          await adminApi.revokeApiKey(id);
          toast.success('API key revoked');
          this.loadApiKeys();
          this.loadDashboard();
        } catch (error) {
          toast.error(`Failed to revoke: ${error.message}`);
        }
      }
    );
  },

  async deleteApiKey(id) {
    this.showConfirmModal(
      'Delete API Key',
      'Are you sure you want to permanently delete this API key? The user will be able to register a new key.',
      async () => {
        try {
          await adminApi.deleteApiKey(id);
          toast.success('API key deleted');
          this.loadApiKeys();
          this.loadDashboard();
        } catch (error) {
          toast.error(`Failed to delete: ${error.message}`);
        }
      }
    );
  },

  // Modal
  showConfirmModal(title, message, onConfirm) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    document.getElementById('confirm-modal').style.display = 'flex';

    // Set up confirm button
    const confirmBtn = document.getElementById('confirm-ok');
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

    newConfirmBtn.addEventListener('click', async () => {
      this.hideModal();
      await onConfirm();
    });
  },

  hideModal() {
    document.getElementById('confirm-modal').style.display = 'none';
  },

  // Utility functions
  escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  truncateAddress(address) {
    if (!address) return '';
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  },

  formatDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '-';
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  },

  // Load settings
  async loadSettings() {
    try {
      const result = await adminApi.getSettings();
      const { developmentMode } = result.data;

      // Update toggle state
      const toggle = document.getElementById('dev-mode-toggle');
      if (toggle) {
        toggle.checked = developmentMode;
      }

      // Update warning visibility
      this.updateDevModeWarning(developmentMode);

      // Also load database status when settings tab is opened
      this.checkDatabaseStatus();
    } catch (error) {
      console.error('Failed to load settings:', error);
      toast.error('Failed to load settings');
    }
  },

  // Toggle development mode
  async toggleDevMode(enabled) {
    try {
      const result = await adminApi.updateSettings({ developmentMode: enabled });
      const { developmentMode } = result.data;

      // Update warning visibility
      this.updateDevModeWarning(developmentMode);

      toast.success(`Development mode ${developmentMode ? 'enabled' : 'disabled'}`);
    } catch (error) {
      console.error('Failed to update development mode:', error);
      toast.error('Failed to update development mode');

      // Revert toggle on error
      const toggle = document.getElementById('dev-mode-toggle');
      if (toggle) {
        toggle.checked = !enabled;
      }
    }
  },

  // Update development mode warning display
  updateDevModeWarning(enabled) {
    const warning = document.getElementById('dev-mode-warning');
    if (warning) {
      warning.style.display = enabled ? 'flex' : 'none';
    }
  },

  // Check database schema status
  async checkDatabaseStatus() {
    const statusEl = document.getElementById('database-status');
    if (!statusEl) return;

    statusEl.innerHTML = `
      <div class="loading-state">
        <div class="loading-spinner small"></div>
        <span>Checking database status...</span>
      </div>
    `;

    try {
      const result = await adminApi.getDatabaseStatus();
      const status = result.data;

      if (status.healthy) {
        statusEl.innerHTML = `
          <div class="database-status-card healthy">
            <div class="status-header">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
              <span>Database Healthy</span>
            </div>
            <p class="status-message">All schema checks passed. No repairs needed.</p>
            <div class="status-checks">
              ${status.checks.map(check => `
                <div class="check-item ${check.passed ? 'passed' : 'failed'}">
                  <span>${check.passed ? '✓' : '✗'}</span>
                  <span>${this.escapeHtml(check.name.replace(/_/g, ' '))}</span>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      } else {
        statusEl.innerHTML = `
          <div class="database-status-card unhealthy">
            <div class="status-header">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <span>Issues Found (${status.issues.length})</span>
            </div>
            <p class="status-message">Click "Repair Database" to fix the following issues:</p>
            <div class="status-issues">
              ${status.issues.map(issue => `
                <div class="issue-item ${issue.severity}">
                  <span class="issue-type">${this.escapeHtml(issue.type.replace(/_/g, ' '))}</span>
                  ${issue.constraint ? `<span class="issue-detail">Constraint: ${this.escapeHtml(issue.constraint)}</span>` : ''}
                  ${issue.missingTypes ? `<span class="issue-detail">Missing types: ${issue.missingTypes.map(t => this.escapeHtml(t)).join(', ')}</span>` : ''}
                  ${issue.table ? `<span class="issue-detail">Table: ${this.escapeHtml(issue.table)}</span>` : ''}
                  ${issue.column ? `<span class="issue-detail">Column: ${this.escapeHtml(issue.column)}</span>` : ''}
                  ${issue.columns ? `<span class="issue-detail">Columns: ${issue.columns.map(c => this.escapeHtml(c)).join(', ')}</span>` : ''}
                  <span class="issue-severity">${this.escapeHtml(String(issue.severity))}</span>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }
    } catch (error) {
      console.error('Failed to check database status:', error);
      statusEl.innerHTML = `
        <div class="database-status-card error">
          <div class="status-header">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="15" y1="9" x2="9" y2="15"/>
              <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
            <span>Error</span>
          </div>
          <p class="status-message">${this.escapeHtml(error.message)}</p>
        </div>
      `;
    }
  },

  // Repair database schema
  async repairDatabase() {
    const btn = document.getElementById('repair-database-btn');
    if (!btn) return;

    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `
      <div class="loading-spinner small"></div>
      <span>Repairing...</span>
    `;

    try {
      const result = await adminApi.repairDatabase();
      const data = result.data;

      if (data.success) {
        toast.success(`Database repaired! ${data.repairs.length} fixes applied.`);
      } else if (data.repairs.length > 0) {
        toast.warning(`Partial repair: ${data.repairs.length} fixes applied, ${data.errors.length} errors.`);
      } else {
        toast.error('Repair failed. Check console for details.');
        console.error('Database repair errors:', data.errors);
      }

      // Refresh status
      this.checkDatabaseStatus();
    } catch (error) {
      console.error('Failed to repair database:', error);
      toast.error(`Repair failed: ${error.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  },

  // ── Announcements ──────────────────────────────────────────────────────────

  async loadAnnouncements() {
    const tbody = document.getElementById('announcements-table');
    if (!tbody) return;

    tbody.innerHTML = '<tr class="loading-row"><td colspan="7">Loading…</td></tr>';

    try {
      const result = await adminApi.getAnnouncements();
      const list = result.data.announcements;

      if (list.length === 0) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No announcements yet. Create one above.</td></tr>';
        return;
      }

      tbody.innerHTML = list.map(ann => `
        <tr>
          <td>${ann.id}</td>
          <td class="ann-title-cell" title="${this.escapeHtml(ann.title)}">${this.escapeHtml(ann.title)}</td>
          <td><span class="type-badge ann-type-${this.escapeHtml(ann.type)}">${this.escapeHtml(ann.type)}</span></td>
          <td>
            <span class="status-badge ${ann.is_active ? 'approved' : 'rejected'}">
              ${ann.is_active ? 'Active' : 'Inactive'}
            </span>
          </td>
          <td>${this.formatDate(ann.created_at)}</td>
          <td>${ann.expires_at ? this.formatDate(ann.expires_at) : '—'}</td>
          <td class="action-buttons">
            <button class="btn btn-secondary btn-sm ann-toggle-btn"
              data-id="${ann.id}" data-active="${ann.is_active}">
              ${ann.is_active ? 'Deactivate' : 'Activate'}
            </button>
            <button class="btn btn-danger btn-sm ann-delete-btn" data-id="${ann.id}">
              Delete
            </button>
          </td>
        </tr>
      `).join('');

      // Wire toggle buttons
      tbody.querySelectorAll('.ann-toggle-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = parseInt(btn.dataset.id);
          const currentlyActive = btn.dataset.active === 'true';
          try {
            await adminApi.updateAnnouncement(id, { isActive: !currentlyActive });
            toast.success(`Announcement ${currentlyActive ? 'deactivated' : 'activated'}`);
            this.loadAnnouncements();
          } catch (err) {
            toast.error(`Failed: ${err.message}`);
          }
        });
      });

      // Wire delete buttons
      tbody.querySelectorAll('.ann-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = parseInt(btn.dataset.id);
          this.showConfirmModal(
            'Delete Announcement',
            'This will permanently remove the announcement. Users will no longer see it.',
            async () => {
              try {
                await adminApi.deleteAnnouncement(id);
                toast.success('Announcement deleted');
                this.loadAnnouncements();
              } catch (err) {
                toast.error(`Failed: ${err.message}`);
              }
            }
          );
        });
      });

    } catch (error) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="7">Failed to load: ${this.escapeHtml(error.message)}</td></tr>`;
    }
  },

  async createAnnouncementFromForm() {
    const title   = document.getElementById('ann-title')?.value.trim();
    const message = document.getElementById('ann-message')?.value.trim();
    const type    = document.getElementById('ann-type')?.value || 'info';
    const expires = document.getElementById('ann-expires')?.value;

    if (!title) { toast.error('Title is required'); return; }
    if (!message) { toast.error('Message is required'); return; }

    const btn = document.getElementById('ann-create-btn');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<div class="loading-spinner small"></div> Broadcasting…';

    try {
      await adminApi.createAnnouncement({
        title,
        message,
        type,
        expiresAt: expires || null
      });

      // Clear form
      document.getElementById('ann-title').value = '';
      document.getElementById('ann-message').value = '';
      document.getElementById('ann-type').value = 'info';
      document.getElementById('ann-expires').value = '';

      toast.success('Announcement broadcast successfully');
      this.loadAnnouncements();
    } catch (error) {
      toast.error(`Failed to broadcast: ${error.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  },

  // ── Bug Reports ──────────────────────────────────────────────

  async loadBugReports() {
    const tbody = document.getElementById('bugreports-table');
    if (!tbody) return;

    tbody.innerHTML = `
      <tr class="loading-row">
        <td colspan="7">
          <div class="loading-state">
            <div class="loading-spinner"></div>
            <span>Loading bug reports...</span>
          </div>
        </td>
      </tr>
    `;

    try {
      const status = document.getElementById('bugreport-filter')?.value || '';
      const { page, limit } = this.pagination.bugreports;
      const offset = (page - 1) * limit;

      const result = await adminApi.getBugReports({ status, limit, offset });
      const { reports, total } = result.data;

      this.pagination.bugreports.total = total;
      this.updatePaginationUI('bugreports');

      if (reports.length === 0) {
        tbody.innerHTML = `
          <tr class="empty-row">
            <td colspan="7">No bug reports found</td>
          </tr>
        `;
        return;
      }

      const categoryLabels = {
        ui_bug: 'UI Bug',
        data_error: 'Data Error',
        broken_link: 'Broken Link',
        performance: 'Performance',
        feature_request: 'Feature Request',
        other: 'Other'
      };

      tbody.innerHTML = reports.map(report => `
        <tr>
          <td>${report.id}</td>
          <td><span class="type-badge">${this.escapeHtml(categoryLabels[report.category] || report.category)}</span></td>
          <td class="bug-desc-cell" title="${this.escapeHtml(report.description)}">${this.escapeHtml(report.description.length > 80 ? report.description.slice(0, 80) + '...' : report.description)}</td>
          <td class="content-url">${report.page_url && /^https?:\/\//i.test(report.page_url) ? `<a href="${this.escapeHtml(report.page_url)}" target="_blank" rel="noopener">${this.escapeHtml(report.page_url.replace(/^https?:\/\/[^/]+/, ''))}</a>` : this.escapeHtml(report.page_url || '-')}</td>
          <td><span class="status-badge ${this.escapeHtml(report.status)}">${this.escapeHtml(report.status)}</span></td>
          <td>${this.formatDate(report.created_at)}</td>
          <td>
            <div class="table-actions">
              <button class="action-btn view" data-bug-id="${report.id}">View</button>
              ${report.status === 'new' ? `<button class="action-btn approve" data-bug-id="${report.id}" data-bug-action="acknowledged">Ack</button>` : ''}
              ${report.status !== 'resolved' ? `<button class="action-btn approve" data-bug-id="${report.id}" data-bug-action="resolved">Resolve</button>` : ''}
              ${report.status !== 'dismissed' ? `<button class="action-btn reject" data-bug-id="${report.id}" data-bug-action="dismissed">Dismiss</button>` : ''}
              <button class="action-btn delete" data-bug-id="${report.id}" data-bug-delete="true">Delete</button>
            </div>
          </td>
        </tr>
      `).join('');

      // Wire status action buttons
      tbody.querySelectorAll('.action-btn[data-bug-action]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = parseInt(btn.dataset.bugId);
          const action = btn.dataset.bugAction;
          try {
            await adminApi.updateBugReport(id, { status: action });
            toast.success(`Bug report marked as ${action}`);
            this.loadBugReports();
          } catch (err) {
            toast.error(`Failed: ${err.message}`);
          }
        });
      });

      // Wire view buttons
      tbody.querySelectorAll('.action-btn.view[data-bug-id]').forEach(btn => {
        btn.addEventListener('click', () => this.viewBugReport(parseInt(btn.dataset.bugId)));
      });

      // Wire delete buttons
      tbody.querySelectorAll('.action-btn[data-bug-delete]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = parseInt(btn.dataset.bugId);
          this.showConfirmModal(
            'Delete Bug Report',
            'Are you sure you want to permanently delete this bug report?',
            async () => {
              try {
                await adminApi.deleteBugReport(id);
                toast.success('Bug report deleted');
                this.loadBugReports();
              } catch (err) {
                toast.error(`Failed: ${err.message}`);
              }
            }
          );
        });
      });

    } catch (error) {
      console.error('Failed to load bug reports:', error);
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="7">Failed to load bug reports: ${this.escapeHtml(error.message)}</td>
        </tr>
      `;
    }
  },

  async viewBugReport(id) {
    try {
      const result = await adminApi.getBugReport(id);
      const report = result.data.report;

      const categoryLabels = {
        ui_bug: 'UI Bug', data_error: 'Data Error', broken_link: 'Broken Link',
        performance: 'Performance', feature_request: 'Feature Request', other: 'Other'
      };

      const modal = document.getElementById('confirm-modal');
      document.getElementById('confirm-title').textContent = `Bug Report #${report.id}`;
      document.getElementById('confirm-message').innerHTML = `
        <div style="text-align: left; font-size: 0.875rem; line-height: 1.6;">
          <p><strong>Category:</strong> ${this.escapeHtml(categoryLabels[report.category] || report.category)}</p>
          <p><strong>Status:</strong> <span class="status-badge ${this.escapeHtml(report.status)}">${this.escapeHtml(report.status)}</span></p>
          <p><strong>Page:</strong> ${report.page_url && /^https?:\/\//i.test(report.page_url) ? `<a href="${this.escapeHtml(report.page_url)}" target="_blank" rel="noopener">${this.escapeHtml(report.page_url)}</a>` : this.escapeHtml(report.page_url || 'N/A')}</p>
          <p><strong>Contact:</strong> ${this.escapeHtml(report.contact_info || 'N/A')}</p>
          <p><strong>Submitted:</strong> ${this.formatDate(report.created_at)}</p>
          <hr style="border-color: var(--border-color); margin: 0.75rem 0;">
          <p><strong>Description:</strong></p>
          <p style="white-space: pre-wrap; color: var(--text-primary);">${this.escapeHtml(report.description)}</p>
          ${report.admin_notes ? `<hr style="border-color: var(--border-color); margin: 0.75rem 0;"><p><strong>Admin Notes:</strong></p><p style="white-space: pre-wrap;">${this.escapeHtml(report.admin_notes)}</p>` : ''}
        </div>
      `;

      // Show modal with just a Close button
      const confirmBtn = document.getElementById('confirm-ok');
      const cancelBtn = document.getElementById('confirm-cancel');
      confirmBtn.textContent = 'Close';
      confirmBtn.className = 'btn btn-ghost';
      cancelBtn.style.display = 'none';

      const restoreModal = () => {
        const btn = document.getElementById('confirm-ok');
        if (btn) {
          btn.textContent = 'Confirm';
          btn.className = 'btn btn-danger';
        }
        cancelBtn.style.display = '';
      };

      // Clone to remove old listeners
      const newBtn = confirmBtn.cloneNode(true);
      confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);
      newBtn.id = 'confirm-ok';
      newBtn.addEventListener('click', () => {
        this.hideModal();
        restoreModal();
      });

      // Also restore when backdrop/cancel closes the modal
      const backdropHandler = () => {
        restoreModal();
        document.querySelector('.modal-backdrop')?.removeEventListener('click', backdropHandler);
      };
      document.querySelector('.modal-backdrop')?.addEventListener('click', backdropHandler);

      modal.style.display = 'flex';
    } catch (error) {
      toast.error(`Failed to load report: ${error.message}`);
    }
  }
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  adminPanel.init();

  // Broadcast button
  document.getElementById('ann-create-btn')?.addEventListener('click', () => {
    adminPanel.createAnnouncementFromForm();
  });
});
