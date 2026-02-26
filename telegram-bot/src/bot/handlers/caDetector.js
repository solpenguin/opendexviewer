const tokensApi = require('../../api/tokens');
const { formatTokenMessage } = require('../../utils/format');

// Match a message that is ONLY a Solana address (32-44 base58 chars)
const SOLANA_CA_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

module.exports = (bot) => {
  bot.hears(SOLANA_CA_REGEX, async (ctx) => {
    const mint = ctx.message.text.trim();
    const statusMsg = await ctx.reply('Looking up token...');

    try {
      const token = await tokensApi.getToken(mint);
      const message = formatTokenMessage(token);

      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        message.text,
        {
          parse_mode: 'HTML',
          reply_markup: message.replyMarkup,
          link_preview_options: { is_disabled: true }
        }
      );
    } catch (error) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        'Could not find this token. The address may be invalid or the token may not have trading data yet.'
      );
    }
  });
};
