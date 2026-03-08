const tokensApi = require('../../api/tokens');
const { InlineKeyboard } = require('grammy');
const { escapeHtml } = require('../../utils/format');

module.exports = (bot) => {
  bot.command('search', async (ctx) => {
    const query = ctx.match?.trim();
    if (!query || query.length < 2) {
      return ctx.reply('Usage: /search &lt;name or symbol&gt;\nMinimum 2 characters.', { parse_mode: 'HTML' });
    }
    if (query.length > 100) {
      return ctx.reply('Search query too long. Maximum 100 characters.');
    }

    const statusMsg = await ctx.reply('Searching...');

    try {
      const results = await tokensApi.searchTokens(query);

      if (!results || results.length === 0) {
        return ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `No tokens found for "${escapeHtml(query)}".`,
          { parse_mode: 'HTML' }
        );
      }

      const display = results.slice(0, 5);
      let text = `<b>Search results for "${escapeHtml(query)}":</b>\n\n`;

      const keyboard = new InlineKeyboard();

      display.forEach((token, i) => {
        const address = token.address || token.mintAddress;
        const name = token.name || 'Unknown';
        const symbol = token.symbol || '???';
        text += `${i + 1}. <b>${escapeHtml(name)}</b> (${escapeHtml(symbol)})\n`;
        text += `   <code>${address}</code>\n\n`;

        keyboard.text(`${i + 1}. ${symbol}`, `lookup:${address}`).row();
      });

      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        text,
        {
          parse_mode: 'HTML',
          reply_markup: keyboard
        }
      );
    } catch (error) {
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, 'Search failed. Please try again.');
    }
  });
};
