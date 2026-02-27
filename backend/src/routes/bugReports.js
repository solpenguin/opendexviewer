/**
 * Bug report routes
 * Public POST endpoint for submitting reports
 * Admin GET/PATCH/DELETE endpoints for managing reports
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const {
  asyncHandler,
  requireDatabase,
  validateAdminSession,
  sanitizeString
} = require('../middleware/validation');
const { strictLimiter } = require('../middleware/rateLimit');

// All routes require database
router.use(requireDatabase);

// Valid categories and statuses
const VALID_CATEGORIES = ['ui_bug', 'data_error', 'broken_link', 'performance', 'feature_request', 'other'];
const VALID_STATUSES = ['new', 'acknowledged', 'resolved', 'dismissed'];

/**
 * POST /api/bug-reports
 * Public endpoint - anyone can submit a bug report
 * Rate limited via strictLimiter (10 per minute per IP)
 */
router.post('/',
  strictLimiter,
  asyncHandler(async (req, res) => {
    const { category, description, contactInfo, pageUrl } = req.body;

    // Validate category
    if (!category || !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`
      });
    }

    // Validate description
    if (!description || typeof description !== 'string') {
      return res.status(400).json({ error: 'Description is required' });
    }

    const cleanDescription = sanitizeString(description, 2000);
    if (!cleanDescription || cleanDescription.length < 10) {
      return res.status(400).json({
        error: 'Description must be at least 10 characters'
      });
    }

    // Sanitize optional fields
    const cleanContact = contactInfo && typeof contactInfo === 'string' ? sanitizeString(contactInfo, 255) : null;
    const cleanPageUrl = pageUrl && typeof pageUrl === 'string' && /^https?:\/\//i.test(pageUrl)
      ? sanitizeString(pageUrl, 500)
      : null;

    const report = await db.createBugReport({
      category,
      description: cleanDescription,
      contactInfo: cleanContact,
      pageUrl: cleanPageUrl,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    });

    res.status(201).json({
      success: true,
      message: 'Bug report submitted successfully',
      data: { id: report.id }
    });
  })
);

// ==========================================
// Admin endpoints (require authentication)
// ==========================================

/**
 * GET /api/bug-reports/admin
 * List all bug reports with pagination and optional status filter
 */
router.get('/admin',
  validateAdminSession,
  asyncHandler(async (req, res) => {
    const { status, limit = 50, offset = 0 } = req.query;

    if (status && status !== 'all' && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status filter' });
    }

    const result = await db.getAllBugReports({
      status,
      limit: Math.min(Math.max(1, parseInt(limit) || 50), 100),
      offset: Math.max(0, parseInt(offset) || 0)
    });

    res.json({
      success: true,
      data: {
        reports: result.reports,
        total: result.total,
        limit: parseInt(limit) || 50,
        offset: parseInt(offset) || 0
      }
    });
  })
);

/**
 * GET /api/bug-reports/admin/:id
 * Get full details of a single bug report
 */
router.get('/admin/:id',
  validateAdminSession,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid report ID' });
    }

    const report = await db.getBugReport(id);
    if (!report) {
      return res.status(404).json({ error: 'Bug report not found' });
    }

    res.json({ success: true, data: { report } });
  })
);

/**
 * PATCH /api/bug-reports/admin/:id
 * Update bug report status and/or admin notes
 */
router.patch('/admin/:id',
  validateAdminSession,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid report ID' });
    }

    const { status, adminNotes } = req.body;

    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`
      });
    }

    if (status === undefined && adminNotes === undefined) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const cleanNotes = adminNotes !== undefined ? sanitizeString(adminNotes, 1000) : undefined;

    const updated = await db.updateBugReportStatus(id, {
      status,
      adminNotes: cleanNotes
    });

    if (!updated) {
      return res.status(404).json({ error: 'Bug report not found' });
    }

    db.invalidateAdminStatsCache();

    res.json({ success: true, data: { report: updated } });
  })
);

/**
 * DELETE /api/bug-reports/admin/:id
 * Permanently delete a bug report
 */
router.delete('/admin/:id',
  validateAdminSession,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid report ID' });
    }

    const deleted = await db.deleteBugReport(id);
    if (!deleted) {
      return res.status(404).json({ error: 'Bug report not found' });
    }

    db.invalidateAdminStatsCache();

    res.json({ success: true, message: 'Bug report deleted' });
  })
);

module.exports = router;
