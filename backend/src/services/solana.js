const axios = require('axios');

// RPC endpoint - Helius recommended, fallback to public
const RPC_URL = process.env.HELIUS_RPC_URL ||
  (process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : 'https://api.mainnet-beta.solana.com');

// Helius DAS API endpoint (for getTokenAccounts)
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_DAS_URL = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : null;

// Make RPC call
async function rpcCall(method, params = []) {
  try {
    const response = await axios.post(RPC_URL, {
      jsonrpc: '2.0',
      id: 1,
      method,
      params
    });

    if (response.data.error) {
      throw new Error(response.data.error.message);
    }

    return response.data.result;
  } catch (error) {
    console.error(`RPC error (${method}):`, error.message);
    throw error;
  }
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

// Health check
async function checkHealth() {
  try {
    const result = await rpcCall('getHealth');
    return { healthy: result === 'ok', rpcUrl: RPC_URL.split('?')[0] };
  } catch (error) {
    return { healthy: false, error: error.message };
  }
}

/**
 * Get token holder count using Helius DAS API
 * Uses getTokenAccounts which returns total count in response
 * Requires HELIUS_API_KEY environment variable
 *
 * @param {string} mintAddress - Token mint address
 * @returns {Promise<number|null>} - Holder count or null if unavailable
 */
async function getTokenHolderCount(mintAddress) {
  if (!HELIUS_DAS_URL) {
    console.log('[Solana] Helius API key not configured, skipping holder count');
    return null;
  }

  try {
    console.log(`[Solana] Fetching holder count for ${mintAddress}`);

    // Use Helius DAS API getTokenAccounts method
    // This returns the total count of token accounts (unique holders)
    const response = await axios.post(HELIUS_DAS_URL, {
      jsonrpc: '2.0',
      id: 'holder-count',
      method: 'getTokenAccounts',
      params: {
        mint: mintAddress,
        page: 1,
        limit: 1, // We only need the total count, not the actual accounts
        displayOptions: {
          showZeroBalance: false // Only count accounts with balance > 0
        }
      }
    }, {
      timeout: 10000
    });

    if (response.data.error) {
      console.error('[Solana] Helius DAS error:', response.data.error.message);
      return null;
    }

    const total = response.data.result?.total;
    if (typeof total === 'number') {
      console.log(`[Solana] Holder count for ${mintAddress}: ${total}`);
      return total;
    }

    return null;
  } catch (error) {
    console.error('[Solana] getTokenHolderCount error:', error.message);
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
      // Logo from content if available
      logoUri: content.links?.image || content.files?.[0]?.uri || null
    };

    console.log(`[Solana] Token metadata for ${mintAddress}:`, {
      name: result.name,
      symbol: result.symbol,
      hasPriceData: result.hasPriceData
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

      result[asset.id] = {
        mintAddress: asset.id,
        address: asset.id,
        name: metadata.name || content.json_uri || 'Unknown',
        symbol: tokenInfo.symbol || metadata.symbol || '???',
        decimals: tokenInfo.decimals || 9,
        supply: tokenInfo.supply ? parseFloat(tokenInfo.supply) / Math.pow(10, tokenInfo.decimals || 9) : null,
        price: priceInfo.price_per_token || null,
        hasPriceData: !!priceInfo.price_per_token,
        logoUri: content.links?.image || content.files?.[0]?.uri || null
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
