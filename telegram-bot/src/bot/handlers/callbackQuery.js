const tokensApi = require('../../api/tokens');
const { formatTokenMessage } = require('../../utils/format');

module.exports = (bot) => {
  bot.callbackQuery(/^lookup:(.+)$/, async (ctx) => {
    const mint = ctx.match[1];

    await ctx.answerCallbackQuery({ text: 'Loading token...' });

    try {
      const token = await tokensApi.getToken(mint);
      const message = formatTokenMessage(token);

      await ctx.reply(message.text, {
        parse_mode: 'HTML',
        reply_markup: message.replyMarkup,
        link_preview_options: { is_disabled: true }
      });
    } catch (error) {
      await ctx.reply('Failed to load token details.');
    }
  });
};
