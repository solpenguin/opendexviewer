/**
 * Burn Credits routes
 * Allows users to burn $OD tokens and receive Burn Credits (BC)
 *
 * Security model:
 * - Wallet ownership proved via signed message (same pattern as votes/submissions)
 * - Signature replay protection via Redis/in-memory map
 * - Transaction verified on-chain via Solana RPC (jsonParsed encoding)
 * - Only SPL Token burn/burnChecked instructions for the exact $OD mint are accepted
 * - Signer of the on-chain tx must match the submitting wallet
 * - UNIQUE constraint on tx_signature prevents double-crediting
 * - Rate limited: 10/min (strict) + 50/hr (very strict)
 */
const express = require('express');
const router = express.Router();
const db = require('../services/database');
const solana = require('../services/solana');
const { strictLimiter, veryStrictLimiter } = require('../middleware/rateLimit');
const {
  verifyWalletSignature,
  isSignatureUsed,
  markSignatureUsed,
  SIGNATURE_EXPIRY_MS
} = require('../middleware/validation');

// $OD token mint address
const OD_TOKEN_MINT = '8pNbASzvHB19Skw1zK9rb97QnAVSmenrgvqpRNbppump';

// Solana address validation
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Transaction signature validation (base58, 64-128 chars)
const TX_SIGNATURE_REGEX = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;

/**
 * GET /api/burn-credits/config
 * Returns the current conversion rate and token info
 */
router.get('/config', async (req, res) => {
  try {
    const conversionRate = await db.getBurnConversionRate();
    res.json({
      tokenMint: OD_TOKEN_MINT,
      tokenSymbol: '$OD',
      conversionRate,
      description: `${conversionRate.toLocaleString()} $OD = 1 Burn Credit`
    });
  } catch (error) {
    console.error('[BurnCredits] Config error:', error.message);
    res.status(500).json({ error: 'Failed to load burn credits configuration' });
  }
});

/**
 * GET /api/burn-credits/balance/:wallet
 * Returns the burn credit balance for a wallet
 */
router.get('/balance/:wallet', async (req, res) => {
  const { wallet } = req.params;

  if (!SOLANA_ADDRESS_REGEX.test(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  try {
    const balance = await db.getBurnCreditBalance(wallet);
    res.json(balance);
  } catch (error) {
    console.error('[BurnCredits] Balance error:', error.message);
    res.status(500).json({ error: 'Failed to load burn credit balance' });
  }
});

/**
 * GET /api/burn-credits/history/:wallet
 * Returns the burn credit history for a wallet
 */
router.get('/history/:wallet', async (req, res) => {
  const { wallet } = req.params;

  if (!SOLANA_ADDRESS_REGEX.test(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  try {
    const history = await db.getBurnCreditHistory(wallet);
    res.json({ history });
  } catch (error) {
    console.error('[BurnCredits] History error:', error.message);
    res.status(500).json({ error: 'Failed to load burn credit history' });
  }
});

/**
 * POST /api/burn-credits/submit
 * Submit a burn transaction for verification and credit
 *
 * Required body fields:
 * - txSignature: Solana transaction signature or explorer URL
 * - walletAddress: Submitter's wallet address
 * - signature: Wallet signature (array of 64 bytes)
 * - signatureTimestamp: Timestamp when the message was signed
 *
 * Security measures:
 * 1. Rate limited (strict + very strict)
 * 2. Wallet ownership verified via signed message + replay protection
 * 3. Transaction fetched and verified on-chain via Solana RPC
 * 4. Only explicit SPL Token burn/burnChecked instructions for $OD mint accepted
 * 5. On-chain tx signer must match the submitting wallet
 * 6. UNIQUE DB constraint on tx_signature prevents double-crediting
 * 7. Race condition handled via DB constraint error catch
 */
router.post('/submit', strictLimiter, veryStrictLimiter, async (req, res) => {
  const { txSignature, walletAddress, signature, signatureTimestamp } = req.body;

  // --- Input validation ---
  if (!txSignature || !walletAddress) {
    return res.status(400).json({ error: 'Transaction signature and wallet address are required' });
  }

  if (!SOLANA_ADDRESS_REGEX.test(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  // --- Wallet signature verification (proves wallet ownership) ---
  if (!signature || !signatureTimestamp) {
    return res.status(400).json({ error: 'Wallet signature is required to verify ownership' });
  }

  // Validate timestamp freshness
  const now = Date.now();
  const timestamp = parseInt(signatureTimestamp);
  if (isNaN(timestamp)) {
    return res.status(400).json({ error: 'Invalid timestamp', code: 'INVALID_TIMESTAMP' });
  }
  if (now - timestamp > SIGNATURE_EXPIRY_MS) {
    return res.status(400).json({
      error: 'Signature expired',
      message: 'Please sign again - signatures expire after 2 minutes',
      code: 'SIGNATURE_EXPIRED'
    });
  }
  if (timestamp > now + 10000) {
    return res.status(400).json({ error: 'Invalid timestamp', code: 'INVALID_TIMESTAMP' });
  }

  // Validate signature format (array of 64 bytes, 0-255)
  if (!Array.isArray(signature) || signature.length !== 64 ||
      !signature.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) {
    return res.status(400).json({ error: 'Invalid signature format', code: 'INVALID_SIGNATURE_FORMAT' });
  }

  // Check signature replay
  const sigKey = signature.join(',');
  if (await isSignatureUsed(sigKey)) {
    return res.status(400).json({ error: 'Signature already used', code: 'SIGNATURE_REPLAY' });
  }

  // Verify the signature against the expected message
  const expectedMessage = `OpenDex Burn: submit burn tx for ${walletAddress} at ${signatureTimestamp}`;
  const isValid = verifyWalletSignature(expectedMessage, signature, walletAddress);
  if (!isValid) {
    return res.status(403).json({ error: 'Invalid wallet signature', code: 'INVALID_SIGNATURE' });
  }

  // Mark signature as used (prevents replay)
  await markSignatureUsed(sigKey, SIGNATURE_EXPIRY_MS);

  // --- Clean up tx signature (handle Solscan/Explorer URLs) ---
  let cleanSignature = String(txSignature).trim();
  const urlPatterns = [
    /solscan\.io\/tx\/([1-9A-HJ-NP-Za-km-z]{64,128})/,
    /explorer\.solana\.com\/tx\/([1-9A-HJ-NP-Za-km-z]{64,128})/,
    /solana\.fm\/tx\/([1-9A-HJ-NP-Za-km-z]{64,128})/,
  ];
  for (const pattern of urlPatterns) {
    const match = cleanSignature.match(pattern);
    if (match) {
      cleanSignature = match[1];
      break;
    }
  }

  if (!TX_SIGNATURE_REGEX.test(cleanSignature)) {
    return res.status(400).json({ error: 'Invalid transaction signature format' });
  }

  try {
    // 1. Check if this transaction has already been submitted
    const alreadyUsed = await db.isBurnTxUsed(cleanSignature);
    if (alreadyUsed) {
      return res.status(409).json({
        error: 'This transaction has already been submitted',
        code: 'DUPLICATE_TX'
      });
    }

    // 2. Fetch the transaction from Solana RPC
    let tx;
    try {
      tx = await solana.getTransaction(cleanSignature);
    } catch (rpcError) {
      console.error('[BurnCredits] RPC error fetching tx:', rpcError.message);
      return res.status(502).json({ error: 'Failed to verify transaction on-chain. Please try again.' });
    }

    if (!tx) {
      return res.status(404).json({
        error: 'Transaction not found on-chain. Make sure the transaction is confirmed.',
        code: 'TX_NOT_FOUND'
      });
    }

    // 3. Verify transaction was successful
    if (tx.meta && tx.meta.err) {
      return res.status(400).json({
        error: 'Transaction failed on-chain',
        code: 'TX_FAILED'
      });
    }

    // 4. Analyze the transaction to find $OD token burns
    const burnResult = analyzeBurnTransaction(tx, walletAddress);

    if (!burnResult.valid) {
      return res.status(400).json({
        error: burnResult.error,
        code: burnResult.code
      });
    }

    // 5. Calculate burn credits
    const conversionRate = await db.getBurnConversionRate();
    const creditsAwarded = burnResult.amount / conversionRate;

    if (creditsAwarded <= 0) {
      return res.status(400).json({
        error: 'Burn amount too small to earn credits',
        code: 'AMOUNT_TOO_SMALL'
      });
    }

    // 6. Record the burn credit (UNIQUE constraint on tx_signature prevents race conditions)
    try {
      await db.recordBurnCredit({
        walletAddress,
        txSignature: cleanSignature,
        tokenAmount: burnResult.amount,
        creditsAwarded,
        conversionRate
      });
    } catch (dbError) {
      // Handle unique constraint violation (race condition between check and insert)
      if (dbError.code === '23505') {
        return res.status(409).json({
          error: 'This transaction has already been submitted',
          code: 'DUPLICATE_TX'
        });
      }
      throw dbError;
    }

    // 7. Get updated balance
    const balance = await db.getBurnCreditBalance(walletAddress);

    res.json({
      success: true,
      tokensBurned: burnResult.amount,
      creditsAwarded,
      conversionRate,
      newBalance: balance.balance,
      txSignature: cleanSignature
    });

  } catch (error) {
    console.error('[BurnCredits] Submit error:', error.message);
    res.status(500).json({ error: 'Failed to process burn credit submission' });
  }
});

/**
 * Analyze a parsed Solana transaction to verify it burns $OD tokens.
 *
 * ONLY accepts explicit SPL Token burn/burnChecked instructions for the $OD mint.
 * Does NOT accept transfers (even to "burn addresses") because:
 * - Transfer destinations are token accounts, not wallet addresses
 * - Verifying a transfer is truly a "burn" requires trusting the destination
 * - The SPL burn instruction is the canonical way to destroy tokens
 *
 * Sol Incinerator uses the SPL Token burn instruction under the hood,
 * so this correctly handles Sol Incinerator burns.
 *
 * @param {Object} tx - Parsed transaction from Solana RPC (jsonParsed encoding)
 * @param {string} expectedWallet - The wallet address that should be the signer
 * @returns {{ valid: boolean, amount?: number, error?: string, code?: string }}
 */
function analyzeBurnTransaction(tx, expectedWallet) {
  if (!tx || !tx.transaction || !tx.meta) {
    return { valid: false, error: 'Invalid transaction data', code: 'INVALID_TX' };
  }

  const message = tx.transaction.message;
  const accountKeys = message.accountKeys || [];

  // Verify the expected wallet is a signer on this transaction
  const signerKeys = accountKeys
    .filter(k => k.signer === true)
    .map(k => k.pubkey);

  if (!signerKeys.includes(expectedWallet)) {
    return {
      valid: false,
      error: 'Your wallet is not the signer of this transaction',
      code: 'WRONG_SIGNER'
    };
  }

  let totalBurnAmount = 0;

  // Collect all instructions (outer + inner/CPI)
  const allInstructions = [];
  if (message.instructions) {
    allInstructions.push(...message.instructions);
  }
  if (tx.meta.innerInstructions) {
    for (const inner of tx.meta.innerInstructions) {
      if (inner.instructions) {
        allInstructions.push(...inner.instructions);
      }
    }
  }

  for (const ix of allInstructions) {
    const parsed = ix.parsed;
    if (!parsed) continue;

    const program = ix.program || ix.programId;
    if (program !== 'spl-token') continue;

    // Only accept burn and burnChecked instructions
    if (parsed.type !== 'burn' && parsed.type !== 'burnChecked') continue;

    const info = parsed.info;
    if (!info) continue;

    // Verify this is the $OD token mint
    if (info.mint !== OD_TOKEN_MINT) continue;

    // Verify the authority is the expected wallet
    if (info.authority !== expectedWallet && info.multisigAuthority !== expectedWallet) continue;

    // Extract the UI amount (human-readable, decimal-adjusted)
    // For burn: tokenAmount.uiAmount is present when parsed
    // For burnChecked: tokenAmount.uiAmount is always present
    const uiAmount = parseFloat(info.tokenAmount?.uiAmount || 0);

    if (uiAmount > 0) {
      totalBurnAmount += uiAmount;
    }
  }

  if (totalBurnAmount <= 0) {
    return {
      valid: false,
      error: 'No $OD token burns found in this transaction. Make sure you burned $OD tokens using Sol Incinerator or an SPL token burn.',
      code: 'NO_BURN_FOUND'
    };
  }

  return { valid: true, amount: totalBurnAmount };
}

module.exports = router;
