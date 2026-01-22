const axios = require('axios');
const { circuitBreakers } = require('./circuitBreaker');

// RPC endpoint configuration with failover
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// Primary and fallback RPC endpoints
const RPC_ENDPOINTS = [
  // Primary: Helius (if configured)
  HELIUS_API_KEY && `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
  // Secondary: Custom Helius RPC URL
  process.env.HELIUS_RPC_URL,
  // Tertiary: Public Solana RPC (rate limited but always available)
  'https://api.mainnet-beta.solana.com'
].filter(Boolean);

// Current RPC index for failover
let currentRpcIndex = 0;
let lastRpcFailure = null;
const RPC_FAILOVER_COOLDOWN_MS = 60000; // 1 minute before trying failed endpoint again

// Get current RPC URL with failover logic
function getCurrentRpcUrl() {
  // If primary has been failing, check if cooldown has passed
  if (currentRpcIndex > 0 && lastRpcFailure) {
    const elapsed = Date.now() - lastRpcFailure;
    if (elapsed > RPC_FAILOVER_COOLDOWN_MS) {
      // Try to recover to primary
      currentRpcIndex = 0;
      lastRpcFailure = null;
      console.log('[Solana] Attempting to recover to primary RPC endpoint');
    }
  }
  return RPC_ENDPOINTS[currentRpcIndex] || RPC_ENDPOINTS[0];
}

// Failover to next RPC endpoint
function failoverToNextRpc() {
  if (currentRpcIndex < RPC_ENDPOINTS.length - 1) {
    currentRpcIndex++;
    lastRpcFailure = Date.now();
    console.log(`[Solana] Failing over to RPC endpoint ${currentRpcIndex + 1}/${RPC_ENDPOINTS.length}`);
    return true;
  }
  return false;
}

// Legacy export for backwards compatibility
const RPC_URL = RPC_ENDPOINTS[0];

// Helius DAS API endpoint (for getTokenAccounts)
const HELIUS_DAS_URL = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : null;

// Make RPC call with circuit breaker, failover, and retry logic
async function rpcCall(method, params = [], retryCount = 0) {
  const MAX_RETRIES = 2;

  // Use circuit breaker for RPC calls
  return circuitBreakers.solanaRpc.execute(async () => {
    const rpcUrl = getCurrentRpcUrl();

    try {
      const response = await axios.post(rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method,
        params
      }, {
        timeout: 15000 // 15 second timeout (reduced from 30s for faster failover)
      });

      // Defensive check for malformed responses
      if (!response || !response.data) {
        throw new Error('Empty or malformed RPC response');
      }

      if (response.data.error) {
        const errorMsg = response.data.error.message || response.data.error.code || 'Unknown RPC error';
        throw new Error(errorMsg);
      }

      return response.data.result;
    } catch (error) {
      // Handle connection errors with failover
      const isConnectionError =
        error.code === 'ECONNABORTED' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNRESET' ||
        error.code === 'ECONNREFUSED' ||
        !error.response;

      if (isConnectionError && retryCount < MAX_RETRIES) {
        // Try failover to next endpoint
        if (failoverToNextRpc()) {
          console.log(`[Solana] Retrying ${method} with failover endpoint (attempt ${retryCount + 1})`);
          return rpcCall(method, params, retryCount + 1);
        }
      }

      // Log error for debugging
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        console.error(`[Solana] RPC timeout (${method}): Request timed out`);
      } else if (error.response) {
        console.error(`[Solana] RPC error (${method}): HTTP ${error.response.status}`);
      } else if (error.request) {
        console.error(`[Solana] RPC error (${method}): No response received`);
      }

      throw error;
    }
  });
}

// Get account info
async function getAccountInfo(address) {
  return rpcCall('getAccountInfo', [
    address,
    { encoding: 'jsonParsed' }
  ]);
}

// Get token account balance
async function getTokenAccountBalance(tokenAccount) {
  return rpcCall('getTokenAccountBalance', [tokenAccount]);
}

// Get token supply
async function getTokenSupply(mintAddress) {
  return rpcCall('getTokenSupply', [mintAddress]);
}

// Get multiple accounts
async function getMultipleAccounts(addresses) {
  return rpcCall('getMultipleAccounts', [
    addresses,
    { encoding: 'jsonParsed' }
  ]);
}

// Get token accounts by owner
async function getTokenAccountsByOwner(ownerAddress, mintAddress = null) {
  const filter = mintAddress
    ? { mint: mintAddress }
    : { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };

  return rpcCall('getTokenAccountsByOwner', [
    ownerAddress,
    filter,
    { encoding: 'jsonParsed' }
  ]);
}

// Get recent blockhash
async function getRecentBlockhash() {
  return rpcCall('getLatestBlockhash');
}

// Get transaction
async function getTransaction(signature) {
  return rpcCall('getTransaction', [
    signature,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }
  ]);
}

// Get signatures for address
async function getSignaturesForAddress(address, limit = 10) {
  return rpcCall('getSignaturesForAddress', [
    address,
    { limit }
  ]);
}

// Health check with failover status
async function checkHealth() {
  try {
    const result = await rpcCall('getHealth');
    const currentUrl = getCurrentRpcUrl();
    return {
      healthy: result === 'ok',
      rpcUrl: currentUrl.split('?')[0], // Hide API key
      currentEndpoint: currentRpcIndex + 1,
      totalEndpoints: RPC_ENDPOINTS.length,
      usingFallback: currentRpcIndex > 0,
      circuitBreakerState: circuitBreakers.solanaRpc.getStatus().state
    };
  } catch (error) {
    return {
      healthy: false,
      error: error.message,
      currentEndpoint: currentRpcIndex + 1,
      totalEndpoints: RPC_ENDPOINTS.length,
      circuitBreakerState: circuitBreakers.solanaRpc.getStatus().state
    };
  }
}

/**
 * Get token holder count using Helius DAS API
 * Uses getTokenAccounts which returns total count of token accounts in response
 * Note: This returns token account count, not unique holders (one user can have multiple accounts)
 * For most tokens, this is a reasonable approximation of holder count
 * Requires HELIUS_API_KEY environment variable
 *
 * @param {string} mintAddress - Token mint address
 * @returns {Promise<number|null>} - Token account count (approximate holders) or null if unavailable
 */
async function getTokenHolderCount(mintAddress) {
  if (!HELIUS_DAS_URL) {
    console.log('[Solana] Helius API key not configured, skipping holder count');
    return null;
  }

  try {
    console.log(`[Solana] Fetching holder count for ${mintAddress}`);

    // Use Helius DAS API getTokenAccounts method
    // The 'total' field returns the count of all matching token accounts
    // Using limit: 1 to minimize response size while still getting the total
    const response = await axios.post(HELIUS_DAS_URL, {
      jsonrpc: '2.0',
      id: 'holder-count',
      method: 'getTokenAccounts',
      params: {
        mint: mintAddress,
        page: 1,
        limit: 1 // Minimize response, we only need the total count
      }
    }, {
      timeout: 10000
    });

    if (response.data.error) {
      console.error('[Solana] Helius DAS error:', response.data.error.message);
      return null;
    }

    const result = response.data.result;
    if (!result) {
      console.error('[Solana] Helius DAS returned no result');
      return null;
    }

    // The response structure should have:
    // - total: total number of matching token accounts
    // - token_accounts: array of account data
    // - cursor: for pagination
    const total = result.total;
    const tokenAccountsCount = result.token_accounts?.length || 0;

    console.log(`[Solana] Response fields:`, {
      total: total,
      totalType: typeof total,
      tokenAccountsLength: tokenAccountsCount,
      hasTokenAccounts: Array.isArray(result.token_accounts),
      cursor: result.cursor,
      allKeys: Object.keys(result)
    });

    // If total field exists and is valid, use it
    if (typeof total === 'number' && total >= 0) {
      console.log(`[Solana] Holder count for ${mintAddress}: ${total}`);
      return total;
    }

    // Fallback: if no total field, we can't get the count without pagination
    // For now, return null to indicate unavailable
    console.log('[Solana] Total field not found or invalid in response');
    return null;
  } catch (error) {
    console.error('[Solana] getTokenHolderCount error:', error.message);
    if (error.response) {
      console.error('[Solana] Response status:', error.response.status);
      console.error('[Solana] Response data:', JSON.stringify(error.response.data, null, 2));
    }
    return null;
  }
}

/**
 * Check if Helius API is configured
 */
function isHeliusConfigured() {
  return !!HELIUS_API_KEY;
}

/**
 * Get token metadata and price using Helius DAS API (getAsset)
 * More efficient than calling GeckoTerminal for basic info
 * Price is only available for top ~10k tokens by 24h volume
 *
 * @param {string} mintAddress - Token mint address
 * @returns {Promise<Object|null>} - Token info or null if unavailable
 */
async function getTokenMetadata(mintAddress) {
  if (!HELIUS_DAS_URL) {
    return null;
  }

  try {
    console.log(`[Solana] Fetching token metadata for ${mintAddress}`);

    const response = await axios.post(HELIUS_DAS_URL, {
      jsonrpc: '2.0',
      id: 'token-metadata',
      method: 'getAsset',
      params: {
        id: mintAddress,
        displayOptions: {
          showFungible: true
        }
      }
    }, {
      timeout: 10000
    });

    if (response.data.error) {
      console.error('[Solana] Helius getAsset error:', response.data.error.message);
      return null;
    }

    const asset = response.data.result;
    if (!asset) {
      return null;
    }

    const tokenInfo = asset.token_info || {};
    const content = asset.content || {};
    const metadata = content.metadata || {};

    // Extract price info if available (only for top 10k tokens)
    const priceInfo = tokenInfo.price_info || {};
    const price = priceInfo.price_per_token || null;

    // Extract logo URI from various possible locations in the response
    // Different tokens store their image in different places
    let logoUri = null;
    if (content.links?.image) {
      logoUri = content.links.image;
    } else if (content.files && content.files.length > 0) {
      // Look for image file in files array
      const imageFile = content.files.find(f =>
        f.mime?.startsWith('image/') ||
        f.uri?.match(/\.(png|jpg|jpeg|gif|webp|svg)(\?.*)?$/i)
      );
      logoUri = imageFile?.uri || content.files[0]?.uri || null;
    } else if (metadata.image) {
      logoUri = metadata.image;
    } else if (content.json_uri && content.json_uri.includes('image')) {
      // Some tokens store image URL in json_uri
      logoUri = content.json_uri;
    }

    const result = {
      mintAddress: mintAddress,
      address: mintAddress,
      name: metadata.name || content.json_uri || 'Unknown',
      symbol: tokenInfo.symbol || metadata.symbol || '???',
      decimals: tokenInfo.decimals || 9,
      supply: tokenInfo.supply ? parseFloat(tokenInfo.supply) / Math.pow(10, tokenInfo.decimals || 9) : null,
      // Price only available for top 10k tokens by volume
      price: price,
      hasPriceData: price !== null,
      // Logo from content if available (checked multiple locations)
      logoUri: logoUri
    };

    console.log(`[Solana] Token metadata for ${mintAddress}:`, {
      name: result.name,
      symbol: result.symbol,
      hasPriceData: result.hasPriceData,
      logoUri: result.logoUri
    });

    return result;
  } catch (error) {
    console.error('[Solana] getTokenMetadata error:', error.message);
    return null;
  }
}

/**
 * Get multiple token metadata in batch using Helius DAS API
 * Supports up to 1000 tokens per request
 *
 * @param {string[]} mintAddresses - Array of token mint addresses
 * @returns {Promise<Object>} - Map of address -> token info
 */
async function getTokenMetadataBatch(mintAddresses) {
  if (!HELIUS_DAS_URL || !mintAddresses || mintAddresses.length === 0) {
    return {};
  }

  try {
    // Helius getAssetBatch supports up to 1000 assets
    const addresses = mintAddresses.slice(0, 1000);
    console.log(`[Solana] Fetching batch token metadata for ${addresses.length} tokens`);

    const response = await axios.post(HELIUS_DAS_URL, {
      jsonrpc: '2.0',
      id: 'token-metadata-batch',
      method: 'getAssetBatch',
      params: {
        ids: addresses,
        displayOptions: {
          showFungible: true
        }
      }
    }, {
      timeout: 15000
    });

    if (response.data.error) {
      console.error('[Solana] Helius getAssetBatch error:', response.data.error.message);
      return {};
    }

    const assets = response.data.result || [];
    const result = {};

    for (const asset of assets) {
      if (!asset || !asset.id) continue;

      const tokenInfo = asset.token_info || {};
      const content = asset.content || {};
      const metadata = content.metadata || {};
      const priceInfo = tokenInfo.price_info || {};

      // Extract logo URI from various possible locations
      let logoUri = null;
      if (content.links?.image) {
        logoUri = content.links.image;
      } else if (content.files && content.files.length > 0) {
        const imageFile = content.files.find(f =>
          f.mime?.startsWith('image/') ||
          f.uri?.match(/\.(png|jpg|jpeg|gif|webp|svg)(\?.*)?$/i)
        );
        logoUri = imageFile?.uri || content.files[0]?.uri || null;
      } else if (metadata.image) {
        logoUri = metadata.image;
      }

      result[asset.id] = {
        mintAddress: asset.id,
        address: asset.id,
        name: metadata.name || content.json_uri || 'Unknown',
        symbol: tokenInfo.symbol || metadata.symbol || '???',
        decimals: tokenInfo.decimals || 9,
        supply: tokenInfo.supply ? parseFloat(tokenInfo.supply) / Math.pow(10, tokenInfo.decimals || 9) : null,
        price: priceInfo.price_per_token || null,
        hasPriceData: !!priceInfo.price_per_token,
        logoUri: logoUri
      };
    }

    console.log(`[Solana] Batch metadata returned ${Object.keys(result).length} tokens`);
    return result;
  } catch (error) {
    console.error('[Solana] getTokenMetadataBatch error:', error.message);
    return {};
  }
}

module.exports = {
  rpcCall,
  getAccountInfo,
  getTokenAccountBalance,
  getTokenSupply,
  getMultipleAccounts,
  getTokenAccountsByOwner,
  getRecentBlockhash,
  getTransaction,
  getSignaturesForAddress,
  getTokenHolderCount,
  getTokenMetadata,
  getTokenMetadataBatch,
  isHeliusConfigured,
  checkHealth
};
