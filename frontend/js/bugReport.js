/**
 * Bug Report Module
 * Adds a floating bug report button and modal to all pages
 * No wallet connection required
 */
const bugReport = {
  isOpen: false,
  isSubmitting: false,

  init() {
    this.createFloatingButton();
    this.createModal();
    this.bindEvents();
  },

  createFloatingButton() {
    const btn = document.createElement('button');
    btn.id = 'bug-report-btn';
    btn.className = 'bug-report-fab';
    btn.title = 'Report a Bug';
    btn.setAttribute('aria-label', 'Report a bug');
    btn.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 2l1.88 1.88"/>
        <path d="M14.12 3.88L16 2"/>
        <path d="M9 7.13v-1a3.003 3.003 0 116 0v1"/>
        <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 014-4h4a4 4 0 014 4v3c0 3.3-2.7 6-6 6"/>
        <path d="M12 20v-9"/>
        <path d="M6.53 9C4.6 8.8 3 7.1 3 5"/>
        <path d="M6 13H2"/>
        <path d="M3 21c0-2.1 1.7-3.9 3.8-4"/>
        <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/>
        <path d="M22 13h-4"/>
        <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>
      </svg>
    `;
    document.body.appendChild(btn);
  },

  createModal() {
    const overlay = document.createElement('div');
    overlay.id = 'bug-report-modal';
    overlay.className = 'bug-report-overlay';
    overlay.style.display = 'none';

    overlay.innerHTML = `
      <div class="bug-report-backdrop"></div>
      <div class="bug-report-modal-content">
        <div class="bug-report-header">
          <h3>Report a Bug</h3>
          <button class="bug-report-close" aria-label="Close">&times;</button>
        </div>
        <form id="bug-report-form" class="bug-report-form">
          <div class="form-group">
            <label class="form-label" for="bug-category">Category</label>
            <select id="bug-category" class="form-select" required>
              <option value="">Select a category...</option>
              <option value="ui_bug">UI / Display Bug</option>
              <option value="data_error">Incorrect Data</option>
              <option value="broken_link">Broken Link</option>
              <option value="performance">Performance Issue</option>
              <option value="feature_request">Feature Request</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="bug-description">Description</label>
            <textarea id="bug-description" class="form-input" rows="4" maxlength="2000"
              placeholder="Please describe the issue you encountered..." required></textarea>
            <span class="form-hint"><span id="bug-char-count">0</span>/2000</span>
          </div>
          <div class="form-group">
            <label class="form-label" for="bug-contact">Contact Info <span class="form-hint">(optional)</span></label>
            <input id="bug-contact" type="text" class="form-input" maxlength="255"
              placeholder="Email, Discord, or Twitter handle (optional)">
          </div>
          <input type="hidden" id="bug-page-url" value="">
          <div class="bug-report-actions">
            <button type="button" class="btn btn-ghost bug-report-cancel-btn">Cancel</button>
            <button type="submit" class="btn btn-primary" id="bug-submit-btn">
              <span class="btn-text">Submit Report</span>
              <span class="btn-loading" style="display: none;">Submitting...</span>
            </button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
  },

  bindEvents() {
    document.getElementById('bug-report-btn').addEventListener('click', () => this.open());

    document.querySelector('.bug-report-close').addEventListener('click', () => this.close());
    document.querySelector('.bug-report-cancel-btn').addEventListener('click', () => this.close());
    document.querySelector('.bug-report-backdrop').addEventListener('click', () => this.close());

    document.getElementById('bug-report-form').addEventListener('submit', (e) => this.handleSubmit(e));

    document.getElementById('bug-description').addEventListener('input', (e) => {
      document.getElementById('bug-char-count').textContent = e.target.value.length;
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    });
  },

  open() {
    document.getElementById('bug-page-url').value = window.location.href;
    document.getElementById('bug-report-modal').style.display = 'flex';
    this.isOpen = true;
    setTimeout(() => document.getElementById('bug-category').focus(), 100);
  },

  close() {
    document.getElementById('bug-report-modal').style.display = 'none';
    this.isOpen = false;
    document.getElementById('bug-report-form').reset();
    document.getElementById('bug-char-count').textContent = '0';
  },

  async handleSubmit(e) {
    e.preventDefault();
    if (this.isSubmitting) return;

    const category = document.getElementById('bug-category').value;
    const description = document.getElementById('bug-description').value.trim();
    const contactInfo = document.getElementById('bug-contact').value.trim();
    const pageUrl = document.getElementById('bug-page-url').value;

    if (!category) {
      toast.error('Please select a category');
      return;
    }
    if (description.length < 10) {
      toast.error('Description must be at least 10 characters');
      return;
    }

    this.isSubmitting = true;
    const submitBtn = document.getElementById('bug-submit-btn');
    submitBtn.querySelector('.btn-text').style.display = 'none';
    submitBtn.querySelector('.btn-loading').style.display = 'inline';
    submitBtn.disabled = true;

    try {
      await api.bugReports.submit({ category, description, contactInfo, pageUrl });
      toast.success('Bug report submitted! Thank you for your feedback.');
      this.close();
    } catch (error) {
      toast.error(error.message || 'Failed to submit bug report. Please try again.');
    } finally {
      this.isSubmitting = false;
      submitBtn.querySelector('.btn-text').style.display = 'inline';
      submitBtn.querySelector('.btn-loading').style.display = 'none';
      submitBtn.disabled = false;
    }
  }
};

document.addEventListener('DOMContentLoaded', () => {
  bugReport.init();
});
