/**
 * Burn Credits routes
 * Allows users to burn $OD tokens and receive Burn Credits (BC)
 *
 * Security model:
 * - Transaction verified on-chain via Solana RPC (jsonParsed encoding)
 * - Only SPL Token burn/burnChecked instructions for the exact $OD mint are accepted
 * - Signer of the on-chain tx must match the submitting wallet (proves ownership)
 * - UNIQUE constraint on tx_signature prevents double-crediting
 * - Rate limited: 10/min (strict) + 50/hr (very strict)
 */
const express = require('express');
const router = express.Router();
const db = require('../services/database');
const solana = require('../services/solana');
const { defaultLimiter, strictLimiter, veryStrictLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/validation');
// Wallet signature verification not needed — on-chain tx signer check is sufficient

// $OD token mint address
const OD_TOKEN_MINT = '8pNbASzvHB19Skw1zK9rb97QnAVSmenrgvqpRNbppump';

// Solana address validation
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Transaction signature validation (base58, 64-128 chars)
const TX_SIGNATURE_REGEX = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;

/**
 * GET /api/burn-credits/od-balance/:wallet
 * Returns the $OD token balance for a wallet (uses backend Helius RPC)
 * This avoids the frontend hitting the rate-limited public Solana RPC
 */
router.get('/od-balance/:wallet', defaultLimiter, asyncHandler(async (req, res) => {
  const { wallet } = req.params;

  if (!SOLANA_ADDRESS_REGEX.test(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  try {
    const accounts = await solana.getTokenAccountsByOwner(wallet, OD_TOKEN_MINT);

    if (!accounts || !accounts.value || accounts.value.length === 0) {
      return res.json({ balance: 0 });
    }

    // Sum balances across all token accounts for this mint (usually just 1 ATA)
    let totalBalance = 0;
    for (const account of accounts.value) {
      const parsed = account.account?.data?.parsed?.info;
      if (parsed && parsed.mint === OD_TOKEN_MINT) {
        totalBalance += parseFloat(parsed.tokenAmount?.uiAmountString || '0');
      }
    }

    res.json({ balance: totalBalance });
  } catch (error) {
    console.error('[BurnCredits] OD balance error:', error.message);
    res.status(502).json({ error: 'Failed to fetch token balance' });
  }
}));

/**
 * GET /api/burn-credits/blockhash
 * Returns the latest blockhash (proxied through backend Helius RPC)
 */
router.get('/blockhash', defaultLimiter, asyncHandler(async (req, res) => {
  try {
    const result = await solana.rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    if (!result || !result.value) {
      return res.status(502).json({ error: 'Failed to get blockhash' });
    }
    res.json({
      blockhash: result.value.blockhash,
      lastValidBlockHeight: result.value.lastValidBlockHeight
    });
  } catch (error) {
    console.error('[BurnCredits] Blockhash error:', error.message);
    res.status(502).json({ error: 'Failed to get blockhash' });
  }
}));

/**
 * POST /api/burn-credits/send-tx
 * Sends a signed transaction via backend Helius RPC (fallback for wallets without signAndSendTransaction)
 * Body: { transaction: base64-encoded serialized transaction }
 */
router.post('/send-tx', strictLimiter, veryStrictLimiter, asyncHandler(async (req, res) => {
  const { transaction } = req.body;

  if (!transaction || typeof transaction !== 'string') {
    return res.status(400).json({ error: 'Transaction data is required' });
  }

  // Basic length check (base64 transactions are typically < 2KB)
  if (transaction.length > 5000) {
    return res.status(400).json({ error: 'Transaction data too large' });
  }

  try {
    const txSignature = await solana.rpcCall('sendTransaction', [
      transaction,
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }
    ]);
    res.json({ signature: txSignature });
  } catch (error) {
    console.error('[BurnCredits] Send tx error:', error.message);
    res.status(502).json({ error: 'Failed to send transaction' });
  }
}));

/**
 * GET /api/burn-credits/tx-status/:signature
 * Checks transaction confirmation status via backend Helius RPC
 */
router.get('/tx-status/:signature', defaultLimiter, asyncHandler(async (req, res) => {
  const { signature } = req.params;

  if (!TX_SIGNATURE_REGEX.test(signature)) {
    return res.status(400).json({ error: 'Invalid transaction signature' });
  }

  try {
    const result = await solana.rpcCall('getSignatureStatuses', [[signature]]);
    if (!result || !result.value || !result.value[0]) {
      return res.json({ confirmed: false, status: null });
    }

    const status = result.value[0];
    res.json({
      confirmed: status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized',
      confirmationStatus: status.confirmationStatus,
      err: status.err
    });
  } catch (error) {
    console.error('[BurnCredits] Tx status error:', error.message);
    res.status(502).json({ error: 'Failed to check transaction status' });
  }
}));

/**
 * GET /api/burn-credits/config
 * Returns the current conversion rate and token info
 */
router.get('/config', defaultLimiter, asyncHandler(async (req, res) => {
  try {
    const conversionRate = await db.getBurnConversionRate();
    const aiAnalysisCost = await db.getAIAnalysisCost();
    res.json({
      tokenMint: OD_TOKEN_MINT,
      tokenSymbol: '$OD',
      conversionRate,
      aiAnalysisCost,
      description: `${conversionRate.toLocaleString()} $OD = 1 Burn Credit`
    });
  } catch (error) {
    console.error('[BurnCredits] Config error:', error.message);
    res.status(500).json({ error: 'Failed to load burn credits configuration' });
  }
}));

/**
 * GET /api/burn-credits/platform-stats
 * Returns platform-wide burn statistics (public, no wallet needed)
 */
router.get('/platform-stats', defaultLimiter, asyncHandler(async (req, res) => {
  try {
    const stats = await db.getPlatformBurnStats();
    res.json(stats);
  } catch (error) {
    console.error('[BurnCredits] Platform stats error:', error.message);
    res.status(500).json({ error: 'Failed to load platform burn stats' });
  }
}));

/**
 * GET /api/burn-credits/balance/:wallet
 * Returns the burn credit balance for a wallet
 */
router.get('/balance/:wallet', defaultLimiter, asyncHandler(async (req, res) => {
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
}));

/**
 * GET /api/burn-credits/history/:wallet
 * Returns the burn credit history for a wallet
 */
router.get('/history/:wallet', defaultLimiter, asyncHandler(async (req, res) => {
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
}));

/**
 * GET /api/burn-credits/spend-history/:wallet
 * Returns the burn credit spending history for a wallet
 */
router.get('/spend-history/:wallet', defaultLimiter, asyncHandler(async (req, res) => {
  const { wallet } = req.params;

  if (!SOLANA_ADDRESS_REGEX.test(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  try {
    const history = await db.getBurnCreditSpendHistory(wallet);
    res.json({ history });
  } catch (error) {
    console.error('[BurnCredits] Spend history error:', error.message);
    res.status(500).json({ error: 'Failed to load spend history' });
  }
}));

/**
 * POST /api/burn-credits/submit
 * Submit a burn transaction for verification and credit
 *
 * Required body fields:
 * - txSignature: Solana transaction signature or explorer URL
 * - walletAddress: Submitter's wallet address
 *
 * Security measures:
 * 1. Rate limited (strict + very strict)
 * 2. Transaction fetched and verified on-chain via Solana RPC
 * 3. Only explicit SPL Token burn/burnChecked instructions for $OD mint accepted
 * 4. On-chain tx signer must match the submitting wallet (proves ownership)
 * 5. UNIQUE DB constraint on tx_signature prevents double-crediting
 * 7. Race condition handled via DB constraint error catch
 */
router.post('/submit', strictLimiter, veryStrictLimiter, asyncHandler(async (req, res) => {
  const { txSignature, walletAddress } = req.body;

  // --- Input validation ---
  if (!txSignature || !walletAddress) {
    return res.status(400).json({ error: 'Transaction signature and wallet address are required' });
  }

  if (!SOLANA_ADDRESS_REGEX.test(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  // No separate wallet signature needed — analyzeBurnTransaction verifies
  // the submitting wallet is the on-chain signer of the burn transaction.

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
    //    getTransaction (jsonParsed) may return null briefly after confirmation
    //    while the RPC node indexes the full transaction data, so retry.
    //    Frontend submit timeout is 30s, so we have room for aggressive retries.
    let tx;
    const TX_FETCH_RETRIES = 4;
    const TX_FETCH_DELAY_MS = 2000;
    for (let attempt = 0; attempt < TX_FETCH_RETRIES; attempt++) {
      // Abort early if the client disconnected (no point retrying)
      if (req.socket.destroyed) return;
      try {
        tx = await solana.getTransaction(cleanSignature);
      } catch (rpcError) {
        console.error(`[BurnCredits] RPC error fetching tx (attempt ${attempt + 1}/${TX_FETCH_RETRIES}):`, rpcError.message);
        if (attempt === TX_FETCH_RETRIES - 1) {
          return res.status(502).json({ error: 'Failed to verify transaction on-chain. Please try again.' });
        }
      }
      if (tx) break;
      console.log(`[BurnCredits] getTransaction returned null (attempt ${attempt + 1}/${TX_FETCH_RETRIES}), retrying...`);
      await new Promise(resolve => setTimeout(resolve, TX_FETCH_DELAY_MS));
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

    // 5. Enforce minimum burn amount (prevents dust spam and rounding exploits)
    const MIN_BURN_AMOUNT = 1; // Minimum 1 $OD token
    if (burnResult.amount < MIN_BURN_AMOUNT) {
      return res.status(400).json({
        error: `Minimum burn amount is ${MIN_BURN_AMOUNT} $OD`,
        code: 'AMOUNT_TOO_SMALL'
      });
    }

    // 6. Verify transaction is not too old (prevents retroactive submission at changed rates)
    const MAX_TX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    if (!tx.blockTime) {
      return res.status(400).json({
        error: 'Transaction has no block time. Please try again later.',
        code: 'NO_BLOCK_TIME'
      });
    }
    const txAge = Date.now() - (tx.blockTime * 1000);
    if (txAge > MAX_TX_AGE_MS) {
      return res.status(400).json({
        error: 'Transaction is too old. Burns must be submitted within 7 days.',
        code: 'TX_TOO_OLD'
      });
    }

    // 7. Calculate burn credits (floor to whole number — BC are always integers)
    const conversionRate = await db.getBurnConversionRate();
    const creditsAwarded = Math.floor(burnResult.amount / conversionRate);

    if (creditsAwarded <= 0) {
      return res.status(400).json({
        error: 'Burn amount too small to earn credits',
        code: 'AMOUNT_TOO_SMALL'
      });
    }

    // 8. Record the burn credit (UNIQUE constraint on tx_signature prevents race conditions)
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

    // 9. Get updated balance
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
}));

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

  // Build a map of token account address → mint for resolving plain `burn` instructions
  // (which don't include the mint field, only the token account address)
  const tokenAccountMints = {};
  if (tx.meta?.preTokenBalances) {
    for (const bal of tx.meta.preTokenBalances) {
      if (bal.mint && accountKeys[bal.accountIndex]) {
        tokenAccountMints[accountKeys[bal.accountIndex].pubkey] = bal.mint;
      }
    }
  }

  for (const ix of allInstructions) {
    const parsed = ix.parsed;
    if (!parsed) continue;

    const program = ix.program || ix.programId;
    // Accept both legacy SPL Token and Token-2022
    if (program !== 'spl-token' && program !== 'spl-token-2022') continue;

    // Only accept burn and burnChecked instructions
    if (parsed.type !== 'burn' && parsed.type !== 'burnChecked') continue;

    const info = parsed.info;
    if (!info) continue;

    // Verify this is the $OD token mint
    // burnChecked includes info.mint; plain burn does not — resolve from token account
    const mint = info.mint || tokenAccountMints[info.account];
    if (mint !== OD_TOKEN_MINT) continue;

    // Verify the authority is the expected wallet
    if (info.authority !== expectedWallet && info.multisigAuthority !== expectedWallet) continue;

    // Extract the UI amount (human-readable, decimal-adjusted)
    // burnChecked: info.tokenAmount.uiAmount is always present
    // plain burn: only info.amount (raw integer) — convert using OD decimals (6)
    let uiAmount;
    if (info.tokenAmount?.uiAmount !== undefined) {
      uiAmount = parseFloat(info.tokenAmount.uiAmount);
    } else if (info.amount) {
      uiAmount = parseFloat(info.amount) / 1e6; // OD_DECIMALS = 6
    } else {
      continue;
    }

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
