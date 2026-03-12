const tokensApi = require('../../api/tokens');
const { InlineKeyboard } = require('grammy');
const { escapeHtml, formatNumber } = require('../../utils/format');
const config = require('../../config');

function formatAge(timestamp) {
  if (!timestamp) return '--';
  const diff = Date.now() - timestamp;
  const days = Math.floor(diff / 86400000);

  if (days < 1) return 'Today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  const remMonths = Math.floor((days - years * 365) / 30);
  if (remMonths > 0) return `${years}y ${remMonths}mo ago`;
  return `${years}y ago`;
}

function formatDate(timestamp) {
  if (!timestamp) return '--';
  const d = new Date(timestamp);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

module.exports = (bot) => {
  bot.command('og', async (ctx) => {
    const query = ctx.match?.trim();
    if (!query || query.length < 1) {
      return ctx.reply(
        '<b>OG Finder</b> — Find the oldest PumpFun tokens by name or ticker.\n\n' +
        'Usage: /og &lt;name or ticker&gt;\n' +
        'Example: /og pepe',
        { parse_mode: 'HTML' }
      );
    }

    if (query.length > 50) {
      return ctx.reply('Query must be 50 characters or less.', { parse_mode: 'HTML' });
    }

    const statusMsg = await ctx.reply('\u{1F50D} Searching PumpFun for the oldest tokens...');

    try {
      const result = await tokensApi.ogfinderSearch(query);
      const tokens = result.tokens || result.data?.tokens || [];

      if (!tokens.length) {
        return ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `No PumpFun tokens found for "${escapeHtml(query)}".`,
          { parse_mode: 'HTML' }
        );
      }

      const display = tokens.slice(0, 10);
      let text = `<b>\u{1F451} OG Finder: "${escapeHtml(query)}"</b>\n`;
      text += `<i>Oldest PumpFun tokens (${tokens.length} found)</i>\n\n`;

      const keyboard = new InlineKeyboard();

      display.forEach((token, i) => {
        const rank = i + 1;
        const mint = token.mint || '';
        const name = escapeHtml(token.name || 'Unknown');
        const symbol = escapeHtml(token.symbol || '???');
        const badge = token.complete ? '\u2705' : '\u{1F7E1}';
        const age = formatAge(token.createdTimestamp);
        const date = formatDate(token.createdTimestamp);
        const mcap = formatNumber(token.marketCap, '$');

        text += `<b>${rank}.</b> ${badge} <b>${name}</b> (${symbol})\n`;
        text += `    \u{1F4C5} ${date} (${age})\n`;
        text += `    \u{1F4B0} MCap: ${mcap}\n`;
        text += `    <code>${mint}</code>\n\n`;

        if (i < 5) {
          keyboard.text(`${rank}. ${token.symbol || '???'}`, `lookup:${mint}`).row();
        }
      });

      // Add link to view full results on web
      keyboard.url('View all on OpenDEX', `${config.FRONTEND_URL}/ogfinder.html?q=${encodeURIComponent(query)}`);

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
      console.error('[OG Finder] Search failed:', error.message);
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        'OG Finder search failed. Please try again.'
      );
    }
  });
};
