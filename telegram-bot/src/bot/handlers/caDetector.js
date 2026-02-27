const tokensApi = require('../../api/tokens');
const { formatTokenMessage } = require('../../utils/format');
const { sendTokenMessage } = require('../../utils/sendToken');
const { enrichWithPrice } = require('../../utils/enrichToken');

// Match a message that is ONLY a Solana address (32-44 base58 chars)
const SOLANA_CA_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

module.exports = (bot) => {
  bot.hears(SOLANA_CA_REGEX, async (ctx) => {
    // Only auto-detect CAs in private chats to avoid being spammy in groups
    if (ctx.chat.type !== 'private') return;

    const mint = ctx.message.text.trim();
    const statusMsg = await ctx.reply('Looking up token...');

    try {
      let token = await tokensApi.getToken(mint);
      // Ensure fresh market data (price, marketCap) if stale or missing
      token = await enrichWithPrice(token);
      const message = formatTokenMessage(token);
      await sendTokenMessage(ctx, statusMsg, message);
    } catch (error) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        'Could not find this token. The address may be invalid or the token may not have trading data yet.'
      );
    }
  });
};
