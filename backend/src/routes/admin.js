/**
 * Admin panel routes
 * Password-protected admin API for site management
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const {
  asyncHandler,
  requireDatabase,
  validateAdminSession,
  verifyAdminPassword,
  generateAdminSessionToken,
  ADMIN_SESSION_DURATION_MS,
  SOLANA_ADDRESS_REGEX
} = require('../middleware/validation');
const { strictLimiter } = require('../middleware/rateLimit');

// ==========================================
// Authentication Endpoints
// ==========================================

/**
 * POST /admin/login
 * Authenticate with admin password
 */
router.post('/login',
  strictLimiter,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        error: 'Password required'
      });
    }

    // Check if admin password is configured
    if (!process.env.ADMIN_PASSWORD) {
      return res.status(503).json({
        success: false,
        error: 'Admin panel not configured'
      });
    }

    // Verify password
    if (!verifyAdminPassword(password)) {
      // Privacy: Don't log IP addresses
      return res.status(401).json({
        success: false,
        error: 'Invalid password'
      });
    }

    // Generate session
    const sessionToken = generateAdminSessionToken();
    const expiresAt = new Date(Date.now() + ADMIN_SESSION_DURATION_MS);

    // Store session
    const session = await db.createAdminSession(
      sessionToken,
      expiresAt,
      req.ip,
      req.get('User-Agent')
    );

    if (!session) {
      return res.status(500).json({
        success: false,
        error: 'Failed to create session'
      });
    }

    // Privacy: Don't log admin login details

    // Set secure cookie
    res.cookie('admin_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: ADMIN_SESSION_DURATION_MS
    });

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        expiresAt: expiresAt.toISOString(),
        sessionToken // Also return token for non-cookie clients
      }
    });
  })
);

/**
 * POST /admin/logout
 * End admin session
 */
router.post('/logout',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const sessionToken = req.cookies?.admin_session || req.header('X-Admin-Session');

    await db.deleteAdminSession(sessionToken);

    res.clearCookie('admin_session');

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  })
);

/**
 * GET /admin/session
 * Check if current session is valid
 */
router.get('/session',
  validateAdminSession,
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: {
        authenticated: true,
        expiresAt: req.adminSession.expires_at
      }
    });
  })
);

// ==========================================
// Dashboard & Statistics
// ==========================================

/**
 * GET /admin/stats
 * Get site statistics
 */
router.get('/stats',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const stats = await db.getAdminStats();

    if (!stats) {
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch statistics'
      });
    }

    res.json({
      success: true,
      data: stats
    });
  })
);

// ==========================================
// Submissions Management
// ==========================================

/**
 * GET /admin/submissions
 * List all submissions with pagination and filters
 */
router.get('/submissions',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const { status, limit = 50, offset = 0, sortBy, sortOrder } = req.query;

    // Validate status if provided
    if (status && !['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status filter'
      });
    }

    const result = await db.getAllSubmissions({
      status,
      limit: Math.min(Math.max(1, parseInt(limit) || 50), 100),
      offset: Math.max(0, parseInt(offset) || 0),
      sortBy,
      sortOrder
    });

    res.json({
      success: true,
      data: {
        submissions: result.submissions,
        total: result.total,
        limit: parseInt(limit) || 50,
        offset: parseInt(offset) || 0
      }
    });
  })
);

/**
 * PATCH /admin/submissions/:id/status
 * Update submission status (approve/reject)
 */
router.patch('/submissions/:id/status',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Valid status required (pending, approved, rejected)'
      });
    }

    const submissionId = parseInt(id);
    if (isNaN(submissionId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid submission ID'
      });
    }

    const updated = await db.updateSubmissionStatus(submissionId, status);

    if (!updated) {
      return res.status(404).json({
        success: false,
        error: 'Submission not found'
      });
    }

    // Privacy: Don't log admin actions with details

    res.json({
      success: true,
      data: updated
    });
  })
);

/**
 * DELETE /admin/submissions/:id
 * Delete a submission
 */
router.delete('/submissions/:id',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const submissionId = parseInt(id);
    if (isNaN(submissionId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid submission ID'
      });
    }

    // Get submission first to verify it exists
    const submission = await db.getSubmission(submissionId);
    if (!submission) {
      return res.status(404).json({
        success: false,
        error: 'Submission not found'
      });
    }

    // Delete submission (votes will cascade delete due to foreign key)
    await db.pool.query('DELETE FROM submissions WHERE id = $1', [submissionId]);

    res.json({
      success: true,
      message: 'Submission deleted'
    });
  })
);

// ==========================================
// API Keys Management
// ==========================================

/**
 * GET /admin/api-keys
 * List all API keys
 */
router.get('/api-keys',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const { limit = 50, offset = 0 } = req.query;

    const result = await db.getAllApiKeys({
      limit: Math.min(parseInt(limit) || 50, 100),
      offset: parseInt(offset) || 0
    });

    res.json({
      success: true,
      data: {
        keys: result.keys,
        total: result.total,
        limit: parseInt(limit) || 50,
        offset: parseInt(offset) || 0
      }
    });
  })
);

/**
 * PATCH /admin/api-keys/:id/revoke
 * Revoke an API key (deactivate but keep record)
 */
router.patch('/api-keys/:id/revoke',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const keyId = parseInt(id);
    if (isNaN(keyId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid API key ID'
      });
    }

    const revoked = await db.revokeApiKeyById(keyId);

    if (!revoked) {
      return res.status(404).json({
        success: false,
        error: 'API key not found'
      });
    }

    res.json({
      success: true,
      message: 'API key revoked',
      data: revoked
    });
  })
);

/**
 * DELETE /admin/api-keys/:id
 * Delete an API key completely
 */
router.delete('/api-keys/:id',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const keyId = parseInt(id);
    if (isNaN(keyId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid API key ID'
      });
    }

    const deleted = await db.deleteApiKeyById(keyId);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'API key not found'
      });
    }

    res.json({
      success: true,
      message: 'API key deleted'
    });
  })
);

// ==========================================
// Tokens Management
// ==========================================

/**
 * GET /admin/tokens
 * List tokens with submission counts
 */
router.get('/tokens',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const { limit = 50, offset = 0 } = req.query;

    const result = await db.pool.query(`
      SELECT t.*,
             COUNT(s.id) as submission_count,
             COUNT(s.id) FILTER (WHERE s.status = 'pending') as pending_count
      FROM tokens t
      LEFT JOIN submissions s ON t.mint_address = s.token_mint
      GROUP BY t.id
      ORDER BY submission_count DESC, t.created_at DESC
      LIMIT $1 OFFSET $2
    `, [Math.min(parseInt(limit) || 50, 100), parseInt(offset) || 0]);

    const countResult = await db.pool.query('SELECT COUNT(*) FROM tokens');

    res.json({
      success: true,
      data: {
        tokens: result.rows,
        total: parseInt(countResult.rows[0].count),
        limit: parseInt(limit) || 50,
        offset: parseInt(offset) || 0
      }
    });
  })
);

// ==========================================
// Development Mode Settings
// ==========================================

// In-memory settings store (persists for server lifetime)
// In production, you'd want to store this in database
const adminSettings = {
  developmentMode: false
};

/**
 * GET /admin/settings
 * Get current admin settings including development mode
 */
router.get('/settings',
  validateAdminSession,
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: {
        developmentMode: adminSettings.developmentMode
      }
    });
  })
);

/**
 * PATCH /admin/settings
 * Update admin settings
 */
router.patch('/settings',
  validateAdminSession,
  asyncHandler(async (req, res) => {
    const { developmentMode } = req.body;

    if (typeof developmentMode === 'boolean') {
      adminSettings.developmentMode = developmentMode;
      // Privacy: Don't log admin settings changes
    }

    res.json({
      success: true,
      data: {
        developmentMode: adminSettings.developmentMode
      }
    });
  })
);

/**
 * GET /admin/settings/development-mode
 * Check if development mode is enabled (requires admin auth for security)
 * Privacy: This endpoint requires authentication to prevent information disclosure
 */
router.get('/settings/development-mode',
  validateAdminSession,
  asyncHandler(async (req, res) => {
    res.json({
      developmentMode: adminSettings.developmentMode
    });
  })
);

// ==========================================
// Maintenance
// ==========================================

/**
 * POST /admin/cleanup
 * Run cleanup tasks (expired sessions, etc.)
 */
router.post('/cleanup',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const cleanedSessions = await db.cleanupExpiredAdminSessions();

    res.json({
      success: true,
      data: {
        expiredSessionsRemoved: cleanedSessions
      }
    });
  })
);

module.exports = router;
