const tokensApi = require('../../api/tokens');
const { formatTokenMessage } = require('../../utils/format');
const { sendTokenMessage } = require('../../utils/sendToken');
const { isValidSolanaAddress } = require('../../utils/solana');
const { enrichWithPrice } = require('../../utils/enrichToken');

module.exports = (bot) => {
  bot.command('token', async (ctx) => {
    const mint = ctx.match?.trim();
    if (!mint || !isValidSolanaAddress(mint)) {
      return ctx.reply('Please provide a valid Solana contract address.\nUsage: /token &lt;CA&gt;', { parse_mode: 'HTML' });
    }

    const statusMsg = await ctx.reply('Looking up token...');

    try {
      let token = await tokensApi.getToken(mint);
      // Ensure fresh market data (price, marketCap) if stale or missing
      token = await enrichWithPrice(token);
      const message = formatTokenMessage(token);
      await sendTokenMessage(ctx, statusMsg, message);
    } catch (error) {
      const errorMsg = error.response?.status === 404
        ? 'Token not found. Please check the contract address.'
        : 'Failed to fetch token data. Please try again.';
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, errorMsg);
    }
  });
};
