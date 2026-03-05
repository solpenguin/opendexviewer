/**
 * Device authentication routes
 * Allows mobile devices to link to a desktop-connected wallet via QR code
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const {
  asyncHandler,
  requireDatabase,
  verifyWalletSignature,
  generateDeviceSessionToken,
  SOLANA_ADDRESS_REGEX,
  SIGNATURE_EXPIRY_MS
} = require('../middleware/validation');
const { strictLimiter } = require('../middleware/rateLimit');

/**
 * POST / — Create a device session
 * Requires wallet signature to prove ownership.
 * Returns a session token with a 5-minute activation window.
 */
router.post('/', strictLimiter, requireDatabase, asyncHandler(async (req, res) => {
  const { walletAddress, signature, signatureTimestamp } = req.body;

  // Validate wallet address
  if (!walletAddress || !SOLANA_ADDRESS_REGEX.test(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  // Signature is MANDATORY for device linking
  if (!signature || !signatureTimestamp) {
    return res.status(400).json({
      error: 'Signature required',
      message: 'Wallet signature is required to link a mobile device'
    });
  }

  // Validate timestamp (within 2 minutes)
  const timestamp = parseInt(signatureTimestamp);
  if (isNaN(timestamp) || Math.abs(Date.now() - timestamp) > SIGNATURE_EXPIRY_MS) {
    return res.status(400).json({
      error: 'Signature expired',
      message: 'Please try again'
    });
  }

  // Verify Ed25519 signature
  const message = `Link mobile device to ${walletAddress} at ${signatureTimestamp}`;
  const isValid = verifyWalletSignature(message, signature, walletAddress);
  if (!isValid) {
    return res.status(401).json({
      error: 'Invalid signature',
      message: 'Wallet signature verification failed'
    });
  }

  // Rate limit: max 5 active sessions per wallet
  const existing = await db.getDeviceSessionsByWallet(walletAddress);
  if (existing.length >= 5) {
    return res.status(429).json({
      error: 'Too many linked devices',
      message: 'Maximum 5 linked devices per wallet. Unlink a device first.'
    });
  }

  // Generate token with 5-minute activation window
  const sessionToken = generateDeviceSessionToken();
  const activationExpires = new Date(Date.now() + db.DEVICE_SESSION_ACTIVATION_WINDOW_MS);

  await db.createDeviceSession(
    sessionToken, walletAddress, activationExpires, req.ip, req.get('User-Agent')
  );

  // Build link URL from request origin or fallback
  const origin = req.get('Origin') || req.get('Referer') || 'https://opendex.online';
  const baseUrl = origin.replace(/\/+$/, '');
  const linkUrl = `${baseUrl}/link.html?token=${sessionToken}`;

  res.json({
    success: true,
    data: {
      sessionToken,
      linkUrl,
      expiresAt: activationExpires.toISOString()
    }
  });
}));

/**
 * GET /verify — Verify and activate a device session
 * Called when mobile user opens the QR code link.
 * Activates the token (extends to 30 days) on first access.
 */
router.get('/verify', requireDatabase, asyncHandler(async (req, res) => {
  const { token } = req.query;

  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    return res.status(400).json({ error: 'Invalid token format' });
  }

  const session = await db.getDeviceSession(token);
  if (!session) {
    return res.status(404).json({
      error: 'Session not found or expired',
      message: 'This link has expired. Please generate a new one from your desktop.'
    });
  }

  // Activate on first access (extends expiry to 30 days)
  if (!session.activated) {
    const activated = await db.activateDeviceSession(token);
    if (!activated) {
      return res.status(410).json({
        error: 'Activation window expired',
        message: 'This link has expired. Please generate a new one from your desktop.'
      });
    }
    // Re-fetch to get updated expiry
    const updated = await db.getDeviceSession(token);
    return res.json({
      success: true,
      data: {
        walletAddress: updated.wallet_address,
        expiresAt: updated.expires_at
      }
    });
  }

  res.json({
    success: true,
    data: {
      walletAddress: session.wallet_address,
      expiresAt: session.expires_at
    }
  });
}));

/**
 * DELETE / — Revoke a device session
 * Called when user "unlinks" their mobile device.
 */
router.delete('/', requireDatabase, asyncHandler(async (req, res) => {
  const token = req.header('X-Device-Session');

  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    return res.status(400).json({ error: 'Invalid or missing device session token' });
  }

  await db.deleteDeviceSession(token);
  res.json({ success: true, message: 'Device session revoked' });
}));

module.exports = router;
