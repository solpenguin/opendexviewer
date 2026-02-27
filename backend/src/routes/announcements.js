/**
 * Public announcements route
 * No authentication required — used by all frontend pages to fetch active announcements
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { asyncHandler, requireDatabase } = require('../middleware/validation');
const { defaultLimiter } = require('../middleware/rateLimit');

/**
 * GET /api/announcements/active
 * Returns all currently active, non-expired announcements ordered newest-first.
 * The frontend displays the first item as the sticky banner.
 */
router.get('/active',
  defaultLimiter,
  requireDatabase,
  asyncHandler(async (req, res) => {
    const announcements = await db.getActiveAnnouncements();
    res.json({ announcements });
  })
);

module.exports = router;
