/**
 * Admin panel routes
 * Password-protected admin API for site management
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const jupiterService = require('../services/jupiter');
const {
  asyncHandler,
  requireDatabase,
  validateAdminSession,
  verifyAdminPassword,
  generateAdminSessionToken,
  ADMIN_SESSION_DURATION_MS,
  SOLANA_ADDRESS_REGEX,
  sanitizeString
} = require('../middleware/validation');
const { strictLimiter } = require('../middleware/rateLimit');
const { cache, keys } = require('../services/cache');

// Login attempt tracking for account lockout
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const MAX_LOGIN_ATTEMPT_ENTRIES = 1000; // Hard cap — prevents memory growth under distributed brute-force

// Cleanup stale login attempt records every 2 minutes (was 5 — faster eviction under attack)
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of loginAttempts) {
    if (now - data.lastAttempt > LOCKOUT_DURATION_MS) {
      loginAttempts.delete(ip);
    }
  }
  // Hard cap: if still over limit, evict oldest entries
  if (loginAttempts.size > MAX_LOGIN_ATTEMPT_ENTRIES) {
    const entries = [...loginAttempts.entries()].sort((a, b) => a[1].lastAttempt - b[1].lastAttempt);
    const toRemove = entries.slice(0, loginAttempts.size - MAX_LOGIN_ATTEMPT_ENTRIES);
    for (const [ip] of toRemove) loginAttempts.delete(ip);
  }
}, 2 * 60 * 1000);

// ==========================================
// Authentication Endpoints
// ==========================================

/**
 * POST /admin/login
 * Authenticate with admin password
 */
router.post('/login',
  strictLimiter,  // IP-based rate limiting on login endpoint
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

    // Check account lockout
    const clientIp = req.ip;
    const attempts = loginAttempts.get(clientIp);
    if (attempts && attempts.count >= MAX_LOGIN_ATTEMPTS && Date.now() - attempts.lastAttempt < LOCKOUT_DURATION_MS) {
      const remainingMinutes = Math.ceil((LOCKOUT_DURATION_MS - (Date.now() - attempts.lastAttempt)) / 60000);
      return res.status(429).json({
        success: false,
        error: `Too many failed attempts. Try again in ${remainingMinutes} minutes.`
      });
    }

    // Verify password (async - supports scrypt hash or legacy plaintext)
    if (!await verifyAdminPassword(password)) {
      // Track failed attempt
      const current = loginAttempts.get(clientIp) || { count: 0, lastAttempt: 0 };
      loginAttempts.set(clientIp, { count: current.count + 1, lastAttempt: Date.now() });

      // Privacy: Don't log IP addresses
      return res.status(401).json({
        success: false,
        error: 'Invalid password'
      });
    }

    // Clear login attempts on success
    loginAttempts.delete(clientIp);

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

    // Set secure cookie — use 'none' + secure for cross-origin deployment (frontend/backend on different origins)
    res.cookie('admin_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: ADMIN_SESSION_DURATION_MS
    });

    // Session token is transmitted via httpOnly cookie only.
    // The frontend uses cookie-based auth; no token in response body.
    res.json({
      success: true,
      message: 'Login successful',
      data: {
        expiresAt: expiresAt.toISOString()
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
    const { status, tokenMint, limit = 50, offset = 0, sortBy, sortOrder } = req.query;

    // Validate status if provided
    if (status && !['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status filter'
      });
    }

    // Validate tokenMint if provided
    if (tokenMint && !SOLANA_ADDRESS_REGEX.test(tokenMint)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid token mint address'
      });
    }

    // Validate sort parameters at the route layer (defence-in-depth; database layer also validates)
    const VALID_SORT_COLUMNS = ['created_at', 'score', 'weighted_score', 'status'];
    const validatedSortBy = VALID_SORT_COLUMNS.includes(sortBy) ? sortBy : 'created_at';
    const validatedSortOrder = sortOrder === 'ASC' ? 'ASC' : 'DESC';

    const result = await db.getAllSubmissions({
      status,
      tokenMint,
      limit: Math.min(Math.max(1, parseInt(limit) || 50), 100),
      offset: Math.max(0, parseInt(offset) || 0),
      sortBy: validatedSortBy,
      sortOrder: validatedSortOrder
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

    // Invalidate submission cache for this token
    if (updated.token_mint) {
      await cache.clearPattern(keys.submissions(updated.token_mint) + '*');
    }

    res.json({
      success: true,
      data: updated
    });
  })
);

/**
 * PATCH /admin/submissions/:id
 * Update submission content (content_url, is_cto)
 */
router.patch('/submissions/:id',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const submissionId = parseInt(req.params.id);
    if (isNaN(submissionId)) {
      return res.status(400).json({ success: false, error: 'Invalid submission ID' });
    }

    const { contentUrl, isCTO } = req.body;
    const updates = [];
    const params = [];

    if (contentUrl !== undefined) {
      if (typeof contentUrl !== 'string' || contentUrl.trim().length === 0) {
        return res.status(400).json({ success: false, error: 'contentUrl must be a non-empty string' });
      }
      if (contentUrl.trim().length > 2000) {
        return res.status(400).json({ success: false, error: 'contentUrl exceeds maximum length (2000)' });
      }
      try {
        const parsed = new URL(contentUrl.trim());
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return res.status(400).json({ success: false, error: 'contentUrl must use http or https protocol' });
        }
      } catch {
        return res.status(400).json({ success: false, error: 'contentUrl must be a valid URL' });
      }
      params.push(contentUrl.trim());
      updates.push(`content_url = $${params.length}`);
    }

    if (isCTO !== undefined) {
      if (typeof isCTO !== 'boolean') {
        return res.status(400).json({ success: false, error: 'isCTO must be a boolean' });
      }
      params.push(isCTO);
      updates.push(`is_cto = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    params.push(submissionId);
    const result = await db.pool.query(
      `UPDATE submissions SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Submission not found' });
    }

    // Invalidate cache for this token
    if (result.rows[0].token_mint) {
      await cache.clearPattern(keys.submissions(result.rows[0].token_mint) + '*');
    }

    res.json({ success: true, data: result.rows[0] });
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

    // Delete vote tally and submission atomically in a transaction
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM vote_tallies WHERE submission_id = $1', [submissionId]);
      await client.query('DELETE FROM submissions WHERE id = $1', [submissionId]);
      await client.query('COMMIT');
    } catch (txError) {
      await client.query('ROLLBACK');
      throw txError;
    } finally {
      client.release();
    }

    // Invalidate submission cache for this token
    if (submission.token_mint) {
      await cache.clearPattern(keys.submissions(submission.token_mint) + '*');
    }

    // Invalidate admin stats cache
    db.invalidateAdminStatsCache();

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
    const { limit = 50, offset = 0, search } = req.query;

    const parsedLimit = Math.min(parseInt(limit) || 50, 100);
    const parsedOffset = parseInt(offset) || 0;

    // Build WHERE clause for optional search by mint address, name, or symbol
    // Escape LIKE metacharacters to prevent wildcard injection
    let whereClause = '';
    let countWhereClause = '';
    const queryParams = [parsedLimit, parsedOffset];
    let searchParam = null;
    if (search && search.trim().length >= 2) {
      const term = search.trim().slice(0, 100).replace(/[%_\\]/g, '\\$&');
      searchParam = `%${term}%`;
      queryParams.push(searchParam);
      whereClause = `WHERE t.mint_address ILIKE $3 OR t.name ILIKE $3 OR t.symbol ILIKE $3`;
      countWhereClause = `WHERE t.mint_address ILIKE $1 OR t.name ILIKE $1 OR t.symbol ILIKE $1`;
    }

    const [result, countResult] = await Promise.all([
      db.pool.query(`
        SELECT t.*,
               COUNT(s.id) as submission_count,
               COUNT(s.id) FILTER (WHERE s.status = 'pending') as pending_count
        FROM tokens t
        LEFT JOIN submissions s ON t.mint_address = s.token_mint
        ${whereClause}
        GROUP BY t.id
        ORDER BY submission_count DESC, t.created_at DESC
        LIMIT $1 OFFSET $2
      `, queryParams),
      db.pool.query(
        searchParam
          ? `SELECT COUNT(*) FROM tokens t ${countWhereClause}`
          : 'SELECT COUNT(*) FROM tokens',
        searchParam ? [searchParam] : []
      )
    ]);

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
 * GET /admin/settings/development-mode
 * Public (unauthenticated) endpoint for frontend to check if development mode is active.
 * Read-only, returns only the boolean flag -- no sensitive data exposed.
 */
router.get('/settings/development-mode',
  asyncHandler(async (req, res) => {
    res.json({
      developmentMode: adminSettings.developmentMode
    });
  })
);

/**
 * GET /admin/settings
 * Get current admin settings including development mode
 */
router.get('/settings',
  validateAdminSession,
  asyncHandler(async (req, res) => {
    // Load burn config from database
    let burnConfig = { conversionRate: 1000, aiAnalysisCost: 25 };
    try {
      burnConfig.conversionRate = await db.getBurnConversionRate();
      burnConfig.aiAnalysisCost = await db.getAIAnalysisCost();
    } catch (e) {
      console.error('[Admin] Failed to load burn config:', e.message);
    }

    res.json({
      success: true,
      data: {
        developmentMode: adminSettings.developmentMode,
        burnConfig
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
    const { developmentMode, burnConfig } = req.body;

    if (typeof developmentMode === 'boolean') {
      const previous = adminSettings.developmentMode;
      adminSettings.developmentMode = developmentMode;
      if (previous !== developmentMode) {
        console.warn(`[Admin] Development mode ${developmentMode ? 'ENABLED' : 'DISABLED'} by admin session at ${new Date().toISOString()} (env: ${process.env.NODE_ENV || 'unset'})`);
      }
    }

    // Update burn config if provided
    if (burnConfig) {
      if (typeof burnConfig.conversionRate === 'number' && burnConfig.conversionRate > 0) {
        await db.setBurnConversionRate(burnConfig.conversionRate);
        console.log(`[Admin] Burn conversion rate updated to ${burnConfig.conversionRate}`);
      }
      if (typeof burnConfig.aiAnalysisCost === 'number' && burnConfig.aiAnalysisCost >= 0) {
        await db.setAIAnalysisCost(burnConfig.aiAnalysisCost);
        console.log(`[Admin] AI analysis cost updated to ${burnConfig.aiAnalysisCost}`);
      }
      if (typeof burnConfig.aiAdvancedAnalysisCost === 'number' && burnConfig.aiAdvancedAnalysisCost >= 0) {
        await db.setAdvancedAIAnalysisCost(burnConfig.aiAdvancedAnalysisCost);
        console.log(`[Admin] Advanced AI analysis cost updated to ${burnConfig.aiAdvancedAnalysisCost}`);
      }
    }

    // Reload current values
    let currentBurnConfig = { conversionRate: 1000, aiAnalysisCost: 25, aiAdvancedAnalysisCost: 75 };
    try {
      currentBurnConfig.conversionRate = await db.getBurnConversionRate();
      currentBurnConfig.aiAnalysisCost = await db.getAIAnalysisCost();
      currentBurnConfig.aiAdvancedAnalysisCost = await db.getAdvancedAIAnalysisCost();
    } catch (e) { /* use defaults */ }

    res.json({
      success: true,
      data: {
        developmentMode: adminSettings.developmentMode,
        burnConfig: currentBurnConfig
      }
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

/**
 * GET /admin/database/status
 * Check database schema status and show what migrations are needed
 */
router.get('/database/status',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const status = await db.getDatabaseSchemaStatus();

    res.json({
      success: true,
      data: status
    });
  })
);

/**
 * POST /admin/database/repair
 * Apply all pending database migrations/repairs
 */
router.post('/database/repair',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const result = await db.repairDatabaseSchema();

    res.json({
      success: true,
      data: result
    });
  })
);

/**
 * GET /admin/database/unknown-tokens
 * Count tokens with placeholder names
 */
router.get('/database/unknown-tokens',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const count = await db.getUnknownTokenCount();
    res.json({ success: true, data: { count } });
  })
);

/**
 * POST /admin/database/fix-unknown-tokens
 * Resolve real names for unknown tokens via Jupiter API.
 * Tokens that resolve get updated; tokens that don't resolve get deleted.
 */
router.post('/database/fix-unknown-tokens',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const PLACEHOLDER_NAMES = new Set(['unknown token', 'unknown']);

    const mints = await db.getUnknownTokenMints();
    if (mints.length === 0) {
      return res.json({ success: true, data: { resolved: 0, deleted: 0, failed: 0, total: 0 } });
    }

    let resolved = 0;
    let deleted = 0;
    let failed = 0;
    const toDelete = [];

    // Process in batches of 5 to avoid rate limits
    for (let i = 0; i < mints.length; i += 5) {
      const batch = mints.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(async (mint) => {
          try {
            const info = await jupiterService.getTokenInfo(mint);
            const hasRealName = info && info.name &&
              !PLACEHOLDER_NAMES.has(info.name.toLowerCase()) &&
              info.name !== 'Unknown';
            if (hasRealName) {
              await db.updateTokenMetadata(mint, info.name, info.symbol, info.logoUri);
              return 'resolved';
            }
            return 'unresolved';
          } catch {
            return 'unresolved';
          }
        })
      );

      for (let j = 0; j < results.length; j++) {
        const val = results[j].status === 'fulfilled' ? results[j].value : 'unresolved';
        if (val === 'resolved') {
          resolved++;
        } else {
          toDelete.push(batch[j]);
        }
      }
    }

    // Delete tokens that couldn't be resolved
    deleted = await db.deleteTokens(toDelete);
    failed = toDelete.length - deleted;

    console.log(`[Admin] Fixed unknown tokens: ${resolved} resolved, ${deleted} deleted, ${failed} failed, ${mints.length} total`);
    res.json({ success: true, data: { resolved, deleted, failed, total: mints.length } });
  })
);

// ==========================================
// Announcements
// ==========================================

const VALID_ANNOUNCEMENT_TYPES = ['info', 'warning', 'success', 'error'];

/**
 * GET /admin/announcements
 * List all announcements (active and inactive)
 */
router.get('/announcements',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const announcements = await db.getAllAnnouncements();
    res.json({ success: true, data: { announcements } });
  })
);

/**
 * POST /admin/announcements
 * Create and immediately broadcast a new announcement
 */
router.post('/announcements',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const { title, message, type = 'info', expiresAt } = req.body;

    if (!title || !message) {
      return res.status(400).json({ success: false, error: 'title and message are required' });
    }

    const cleanTitle = sanitizeString(title, 200);
    const cleanMessage = sanitizeString(message, 2000);

    if (!cleanTitle) {
      return res.status(400).json({ success: false, error: 'title cannot be empty' });
    }
    if (!VALID_ANNOUNCEMENT_TYPES.includes(type)) {
      return res.status(400).json({ success: false, error: `type must be one of: ${VALID_ANNOUNCEMENT_TYPES.join(', ')}` });
    }

    let parsedExpiry = null;
    if (expiresAt) {
      parsedExpiry = new Date(expiresAt);
      if (isNaN(parsedExpiry.getTime())) {
        return res.status(400).json({ success: false, error: 'expiresAt is not a valid date' });
      }
      if (parsedExpiry <= new Date()) {
        return res.status(400).json({ success: false, error: 'expiresAt must be in the future' });
      }
    }

    const announcement = await db.createAnnouncement({
      title: cleanTitle,
      message: cleanMessage,
      type,
      expiresAt: parsedExpiry
    });

    res.status(201).json({ success: true, data: { announcement } });
  })
);

/**
 * PATCH /admin/announcements/:id
 * Update an announcement (toggle active, edit fields)
 */
router.patch('/announcements/:id',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id || id < 1) {
      return res.status(400).json({ success: false, error: 'Invalid announcement id' });
    }

    const { isActive, title, message, type, expiresAt } = req.body;
    const updates = {};

    if (isActive !== undefined) {
      if (typeof isActive !== 'boolean') {
        return res.status(400).json({ success: false, error: 'isActive must be a boolean' });
      }
      updates.isActive = isActive;
    }
    if (title !== undefined)   updates.title   = sanitizeString(title, 200);
    if (message !== undefined) updates.message = sanitizeString(message, 2000);
    if (type !== undefined) {
      if (!VALID_ANNOUNCEMENT_TYPES.includes(type)) {
        return res.status(400).json({ success: false, error: `type must be one of: ${VALID_ANNOUNCEMENT_TYPES.join(', ')}` });
      }
      updates.type = type;
    }
    if (expiresAt !== undefined) {
      if (expiresAt === null) {
        updates.expiresAt = null;
      } else {
        const parsed = new Date(expiresAt);
        if (isNaN(parsed.getTime())) {
          return res.status(400).json({ success: false, error: 'expiresAt is not a valid date' });
        }
        updates.expiresAt = parsed;
      }
    }

    const announcement = await db.updateAnnouncement(id, updates);
    if (!announcement) {
      return res.status(404).json({ success: false, error: 'Announcement not found' });
    }

    res.json({ success: true, data: { announcement } });
  })
);

/**
 * DELETE /admin/announcements/:id
 * Permanently remove an announcement
 */
router.delete('/announcements/:id',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id || id < 1) {
      return res.status(400).json({ success: false, error: 'Invalid announcement id' });
    }

    const deleted = await db.deleteAnnouncement(id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Announcement not found' });
    }

    res.json({ success: true });
  })
);

// ==========================================
// Burn Credit Management
// ==========================================

/**
 * POST /admin/burn-credits/grant
 * Grant burn credits to a wallet address (admin only).
 * Body: { walletAddress: string, amount: number, reason?: string }
 */
router.post('/burn-credits/grant',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const { walletAddress, amount, reason } = req.body;

    // Validate wallet address
    if (!walletAddress || typeof walletAddress !== 'string' || !SOLANA_ADDRESS_REGEX.test(walletAddress)) {
      return res.status(400).json({ success: false, error: 'Valid Solana wallet address required' });
    }

    // Validate amount
    const parsedAmount = parseInt(amount, 10);
    if (!parsedAmount || parsedAmount < 1 || parsedAmount > 100000) {
      return res.status(400).json({ success: false, error: 'Amount must be an integer between 1 and 100,000' });
    }

    // Sanitize reason (optional, max 200 chars, strip control chars)
    const safeReason = typeof reason === 'string'
      ? reason.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 200)
      : '';

    try {
      const record = await db.adminGrantBurnCredits(walletAddress, parsedAmount, safeReason);
      const balance = await db.getBurnCreditBalance(walletAddress);

      res.json({
        success: true,
        data: {
          credited: parsedAmount,
          walletAddress,
          reason: safeReason,
          newBalance: balance.balance,
          txSignature: record.tx_signature
        }
      });
    } catch (error) {
      console.error('[Admin] Failed to grant burn credits:', error.message);
      res.status(500).json({ success: false, error: 'Failed to grant burn credits' });
    }
  })
);

/**
 * GET /admin/burn-credits/lookup/:wallet
 * Look up a wallet's burn credit balance (admin only).
 */
router.get('/burn-credits/lookup/:wallet',
  validateAdminSession,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const { wallet } = req.params;
    if (!wallet || !SOLANA_ADDRESS_REGEX.test(wallet)) {
      return res.status(400).json({ success: false, error: 'Valid Solana wallet address required' });
    }

    const balance = await db.getBurnCreditBalance(wallet);
    const history = await db.getBurnCreditSpendHistory(wallet, 10);

    res.json({
      success: true,
      data: {
        walletAddress: wallet,
        ...balance,
        recentSpends: history
      }
    });
  })
);

// ==========================================
// AI Cache Management
// ==========================================

/**
 * GET /admin/ai-cache
 * List all cached AI analysis entries grouped by type.
 */
router.get('/ai-cache', validateAdminSession, asyncHandler(async (req, res) => {
  const [holderKeys, advancedKeys, folioKeys] = await Promise.all([
    cache.scanKeys('ai-analysis:*'),
    cache.scanKeys('ai-adv:*'),
    cache.scanKeys('ai-folio:*')
  ]);

  // Build entries with metadata extracted from cache keys
  const toEntry = (key, type) => {
    const parts = key.split(':');
    let details = {};
    if (type === 'holder') {
      details = { mint: parts[1] || '' };
    } else if (type === 'advanced') {
      details = { mint: parts[1] || '', promptHash: parts[2] || '' };
    } else if (type === 'folio') {
      details = { folioId: parts[1] || '' };
    }
    return { key, type, ...details };
  };

  const entries = [
    ...holderKeys.map(k => toEntry(k, 'holder')),
    ...advancedKeys.map(k => toEntry(k, 'advanced')),
    ...folioKeys.map(k => toEntry(k, 'folio'))
  ];

  res.json({
    success: true,
    data: {
      entries,
      counts: {
        holder: holderKeys.length,
        advanced: advancedKeys.length,
        folio: folioKeys.length,
        total: entries.length
      }
    }
  });
}));

/**
 * DELETE /admin/ai-cache
 * Clear all cached AI analysis entries (or a specific type via ?type=holder|advanced|folio).
 */
router.delete('/ai-cache', validateAdminSession, asyncHandler(async (req, res) => {
  const type = req.query.type;

  const patterns = {
    holder: 'ai-analysis:*',
    advanced: 'ai-adv:*',
    folio: 'ai-folio:*'
  };

  if (type && patterns[type]) {
    await cache.clearPattern(patterns[type]);
  } else {
    // Clear all AI cache
    await Promise.all([
      cache.clearPattern('ai-analysis:*'),
      cache.clearPattern('ai-adv:*'),
      cache.clearPattern('ai-folio:*')
    ]);
  }

  res.json({ success: true });
}));

/**
 * POST /admin/ai-cache/delete-entry
 * Delete a single cached AI analysis entry by its full cache key.
 * Uses POST+body instead of DELETE with URL params to avoid encoding issues with colons.
 */
router.post('/ai-cache/delete-entry', validateAdminSession, asyncHandler(async (req, res) => {
  const { key } = req.body;
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ success: false, error: 'Cache key is required' });
  }

  // Only allow deleting AI cache keys
  if (!key.startsWith('ai-analysis:') && !key.startsWith('ai-adv:') && !key.startsWith('ai-folio:')) {
    return res.status(400).json({ success: false, error: 'Invalid AI cache key' });
  }

  await cache.delete(key);
  res.json({ success: true });
}));

// ==========================================
// Diamond Hands Cache Management
// ==========================================

/**
 * POST /admin/diamond-hands/reset
 * Clear diamond hands cache for a specific token mint address.
 * Clears: diamond-hands:{mint}, diamond-hands-wallets:{mint}, diamond-hands-pending:{mint}
 */
router.post('/diamond-hands/reset',
  validateAdminSession,
  asyncHandler(async (req, res) => {
    const { mint } = req.body;

    if (!mint || typeof mint !== 'string' || !SOLANA_ADDRESS_REGEX.test(mint)) {
      return res.status(400).json({ success: false, error: 'Valid token mint address required' });
    }

    const keysToDelete = [
      `diamond-hands:${mint}`,
      `diamond-hands-wallets:${mint}`,
      `diamond-hands-pending:${mint}`
    ];

    let deleted = 0;
    for (const key of keysToDelete) {
      const existed = await cache.get(key);
      if (existed !== null && existed !== undefined) {
        await cache.delete(key);
        deleted++;
      }
    }

    console.log(`[Admin] Diamond hands cache reset for ${mint.slice(0, 8)}... (${deleted} keys cleared)`);

    res.json({
      success: true,
      data: { mint, keysCleared: deleted }
    });
  })
);

// Export both the router and adminSettings for use by other routes
module.exports = router;
module.exports.adminSettings = adminSettings;
