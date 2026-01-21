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
    const url = `${API_BASE_URL}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: this.getHeaders(),
      credentials: 'include' // Include cookies
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    return data;
  },

  // Auth endpoints
  async login(password) {
    const result = await this.request('/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password })
    });
    if (result.success && result.data?.sessionToken) {
      this.sessionToken = result.data.sessionToken;
      localStorage.setItem('admin_session', result.data.sessionToken);
    }
    return result;
  },

  async logout() {
    const result = await this.request('/admin/logout', {
      method: 'POST'
    });
    this.sessionToken = null;
    localStorage.removeItem('admin_session');
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
  }
};

// Admin Panel Manager
const adminPanel = {
  currentTab: 'dashboard',
  pagination: {
    submissions: { page: 1, limit: 20, total: 0 },
    apikeys: { page: 1, limit: 20, total: 0 },
    tokens: { page: 1, limit: 20, total: 0 }
  },

  // Initialize
  async init() {
    // Check for stored session
    const storedSession = localStorage.getItem('admin_session');
    if (storedSession) {
      adminApi.sessionToken = storedSession;
      try {
        await adminApi.checkSession();
        this.showPanel();
        this.loadDashboard();
      } catch (error) {
        // Session invalid, show login
        localStorage.removeItem('admin_session');
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

    // Submission filter
    document.getElementById('submission-filter')?.addEventListener('change', () => {
      this.pagination.submissions.page = 1;
      this.loadSubmissions();
    });

    // Pagination
    this.bindPagination('submissions');
    this.bindPagination('apikeys');
    this.bindPagination('tokens');

    // Modal
    document.querySelector('.modal-backdrop')?.addEventListener('click', () => this.hideModal());
    document.getElementById('confirm-cancel')?.addEventListener('click', () => this.hideModal());
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
    } catch (error) {
      console.error('Failed to load stats:', error);
      toast.error('Failed to load dashboard stats');
    }
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
          <td><span class="type-badge">${sub.submission_type}</span></td>
          <td class="content-url">
            <a href="${this.escapeHtml(sub.content_url)}" target="_blank" rel="noopener">${this.escapeHtml(sub.content_url)}</a>
          </td>
          <td>
            <span class="score-display ${sub.score > 0 ? 'score-up' : sub.score < 0 ? 'score-down' : 'score-neutral'}">
              ${sub.score > 0 ? '+' : ''}${sub.score || 0}
            </span>
          </td>
          <td><span class="status-badge ${sub.status}">${sub.status}</span></td>
          <td>${this.formatDate(sub.created_at)}</td>
          <td>
            <div class="table-actions">
              ${sub.status === 'pending' ? `
                <button class="action-btn approve" onclick="adminPanel.approveSubmission(${sub.id})">Approve</button>
                <button class="action-btn reject" onclick="adminPanel.rejectSubmission(${sub.id})">Reject</button>
              ` : ''}
              <button class="action-btn delete" onclick="adminPanel.deleteSubmission(${sub.id})">Delete</button>
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
                <button class="action-btn revoke" onclick="adminPanel.revokeApiKey(${key.id})">Revoke</button>
              ` : ''}
              <button class="action-btn delete" onclick="adminPanel.deleteApiKey(${key.id})">Delete</button>
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
        <td colspan="6">
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

      const result = await adminApi.getTokens({ limit, offset });
      const { tokens, total } = result.data;

      this.pagination.tokens.total = total;
      this.updatePaginationUI('tokens');

      if (tokens.length === 0) {
        tbody.innerHTML = `
          <tr class="empty-row">
            <td colspan="6">No tokens found</td>
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
          <td class="wallet-address">${this.truncateAddress(token.mint_address)}</td>
          <td>${token.submission_count}</td>
          <td>${token.pending_count > 0 ? `<span class="status-badge pending">${token.pending_count}</span>` : '0'}</td>
          <td>${this.formatDate(token.created_at)}</td>
        </tr>
      `).join('');

    } catch (error) {
      console.error('Failed to load tokens:', error);
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">Failed to load tokens: ${this.escapeHtml(error.message)}</td>
        </tr>
      `;
    }
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
    return div.innerHTML;
  },

  truncateAddress(address) {
    if (!address) return '';
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  },

  formatDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  adminPanel.init();
});
