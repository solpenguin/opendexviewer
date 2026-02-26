// Solana base58 address: 32-44 characters, no 0/O/I/l
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

module.exports = {
  isValidSolanaAddress(address) {
    return SOLANA_ADDRESS_REGEX.test(address);
  },
  SOLANA_ADDRESS_REGEX
};
