const { InlineKeyboard } = require('grammy');
const tokensApi = require('../../api/tokens');
const { escapeHtml, formatPrice, formatNumber } = require('../../utils/format');
const { isValidSolanaAddress } = require('../../utils/solana');
const config = require('../../config');

function formatAge(dateStr) {
  if (!dateStr) return null;
  const now = new Date();
  const d = new Date(dateStr);
  const seconds = Math.floor((now - d) / 1000);
  if (seconds < 60) return '< 1m';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  const days = Math.floor(seconds / 86400);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  const years = Math.floor(days / 365);
  const remainingMonths = Math.floor((days % 365) / 30);
  return remainingMonths > 0 ? `${years}y ${remainingMonths}mo` : `${years}y`;
}

module.exports = (bot) => {
  bot.command('pvp', async (ctx) => {
    const mint = ctx.match?.trim();
    if (!mint || !isValidSolanaAddress(mint)) {
      return ctx.reply(
        'Please provide a valid Solana contract address.\nUsage: /pvp &lt;CA&gt;',
        { parse_mode: 'HTML' }
      );
    }

    const statusMsg = await ctx.reply('\u{1F50D} Checking for similar tokens...');

    try {
      // Fetch token info and similar tokens in parallel
      const [token, similarTokens] = await Promise.all([
        tokensApi.getToken(mint),
        tokensApi.getSimilarTokens(mint)
      ]);

      const tokenName = escapeHtml(token.name || 'Unknown');
      const tokenSymbol = escapeHtml(token.symbol || '???');

      if (!similarTokens || similarTokens.length === 0) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `<b>${tokenName}</b> (${tokenSymbol})\n<code>${mint}</code>\n\n` +
          `\u2705 <b>No similar tokens found.</b>\n` +
          `This token's name and ticker appear to be unique on Solana.`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Build the similar tokens list
      let lines = [
        `<b>\u{1F50D} Similar Tokens for ${tokenName} (${tokenSymbol})</b>`,
        `<code>${mint}</code>`,
        '',
        `\u26A0\uFE0F <b>${similarTokens.length} similar token${similarTokens.length > 1 ? 's' : ''} found</b> \u2014 verify the contract address before trading!`,
        ''
      ];

      similarTokens.forEach((t, i) => {
        const name = escapeHtml(t.name || 'Unknown');
        const symbol = escapeHtml(t.symbol || '???');
        const addr = t.address;

        let stats = [];
        if (t.marketCap) stats.push(`MCap ${formatNumber(t.marketCap)}`);
        if (t.volume24h) stats.push(`Vol ${formatNumber(t.volume24h)}`);
        const age = formatAge(t.pairCreatedAt);
        if (age) stats.push(`Age ${age}`);

        lines.push(`<b>${i + 1}. ${name}</b> (${symbol})`);
        lines.push(`<code>${addr}</code>`);
        if (stats.length > 0) {
          lines.push(stats.join(' \u2022 '));
        }
        if (t.similarityScore) {
          lines.push(`Similarity: ${(t.similarityScore * 100).toFixed(0)}%`);
        }
        lines.push(`\u{1FAE7} <a href="https://app.bubblemaps.io/sol/token/${addr}">Bubblemaps</a>`);
        lines.push('');
      });

      lines.push('<i>Always verify the contract address to avoid spoofed tokens.</i>');

      const keyboard = new InlineKeyboard()
        .url('View on OpenDEX', `${config.FRONTEND_URL}/token.html?mint=${mint}`)
        .url('Solscan', `https://solscan.io/token/${mint}`);

      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        lines.join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: keyboard,
          link_preview_options: { is_disabled: true }
        }
      );
    } catch (error) {
      const errorMsg = error.response?.status === 404
        ? 'Token not found. Please check the contract address.'
        : 'Failed to fetch similar tokens. Please try again.';
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, errorMsg);
    }
  });
};
