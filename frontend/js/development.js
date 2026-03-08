// GitHub Commit Tracker for Development page
const githubTracker = {
  REPO: 'solpenguin/opendexviewer',
  CACHE_KEY: 'opendex_github_commits',
  CACHE_TTL: 10 * 60 * 1000, // 10 minutes
  PER_PAGE: 20,

  async init() {
    const container = document.getElementById('github-commits');
    if (!container) return;

    const _t0 = performance.now();
    let _ok = true;

    try {
      const commits = await this.fetchCommits();
      this.render(container, commits);
    } catch (err) {
      _ok = false;
      console.error('[GitHub] Failed to load commits:', err);
      this.renderError(container);
    } finally {
      if (typeof latencyTracker !== 'undefined') {
        latencyTracker.record('github.commits', performance.now() - _t0, _ok, 'frontend');
      }
    }
  },

  async fetchCommits() {
    // Check sessionStorage cache
    try {
      const cached = sessionStorage.getItem(this.CACHE_KEY);
      if (cached) {
        const { data, ts } = JSON.parse(cached);
        if (Date.now() - ts < this.CACHE_TTL && Array.isArray(data) && data.length > 0) {
          return data;
        }
      }
    } catch (_) {}

    const url = `https://api.github.com/repos/${this.REPO}/commits?per_page=${this.PER_PAGE}`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/vnd.github.v3+json' }
    });

    if (response.status === 403) {
      throw new Error('GitHub API rate limit exceeded. Please try again later.');
    }
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}`);
    }

    const commits = await response.json();

    // Cache the result
    try {
      sessionStorage.setItem(this.CACHE_KEY, JSON.stringify({ data: commits, ts: Date.now() }));
    } catch (_) {}

    return commits;
  },

  render(container, commits) {
    if (!commits || commits.length === 0) {
      container.innerHTML = `
        <div class="github-empty">
          <p>No commits found.</p>
        </div>`;
      return;
    }

    const items = commits.map(c => {
      const sha = c.sha ? c.sha.slice(0, 7) : '-------';
      const message = c.commit?.message || '';
      const firstLine = message.split('\n')[0];
      const body = message.split('\n').slice(1).join('\n').trim();
      const date = c.commit?.author?.date;
      const commitUrl = c.html_url || (c.sha ? `https://github.com/${this.REPO}/commit/${c.sha}` : `https://github.com/${this.REPO}`);

      return `<div class="commit-item">
          <div class="commit-content">
            <div class="commit-header">
              <a href="${this.escapeAttr(commitUrl)}" target="_blank" rel="noopener noreferrer" class="commit-sha">${sha}</a>
              <span class="commit-date">${date ? this.timeAgo(date) : ''}</span>
            </div>
            <div class="commit-title">${this.escapeHtml(firstLine)}</div>
            ${body ? `<div class="commit-body">${this.escapeHtml(body)}</div>` : ''}
          </div>
        </div>`;
    }).join('');

    container.innerHTML = items + `
      <div class="github-footer">
        <a href="https://github.com/${this.REPO}/commits" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm">
          View all commits on GitHub
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </a>
      </div>`;
  },

  renderError(container) {
    container.innerHTML = `
      <div class="github-error">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--text-muted); margin-bottom: 0.75rem;">
          <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22"/>
        </svg>
        <p style="color: var(--text-secondary); margin-bottom: 1rem;">Could not load recent commits.</p>
        <a href="https://github.com/${this.REPO}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm">
          View on GitHub
        </a>
      </div>`;
  },

  timeAgo(dateStr) {
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  },

  escapeHtml(str) {
    if (typeof utils !== 'undefined' && utils.escapeHtml) return utils.escapeHtml(str);
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
};

document.addEventListener('DOMContentLoaded', () => githubTracker.init());
