const { InlineKeyboard } = require('grammy');
const tokensApi = require('../../api/tokens');
const { escapeHtml, formatNumber } = require('../../utils/format');
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
        '<b>PVP — Anti-Spoofing Check</b>\n\n' +
        'Find tokens with similar names/tickers to detect copycats.\n\n' +
        'Usage: /pvp &lt;contract address&gt;\n' +
        'Example: /pvp <code>So11111111111111111111111111111111111111112</code>',
        { parse_mode: 'HTML' }
      );
    }

    const statusMsg = await ctx.reply('\u{1F50D} Checking for similar tokens...');

    try {
      // Fetch token info and similar tokens in parallel.
      // Use allSettled so a getToken 404 doesn't kill the whole command —
      // the similar-tokens endpoint resolves names via its own fallback chain.
      const [tokenResult, similarResult] = await Promise.allSettled([
        tokensApi.getToken(mint),
        tokensApi.getSimilarTokens(mint)
      ]);

      // Extract token name/symbol (best-effort — may not be in DB)
      const token = tokenResult.status === 'fulfilled' ? tokenResult.value : null;
      const tokenName = escapeHtml(token?.name || 'Unknown Token');
      const tokenSymbol = escapeHtml(token?.symbol || '???');

      // The similar-tokens endpoint returns { results: [...], enriched: boolean }
      if (similarResult.status === 'rejected') {
        throw similarResult.reason;
      }
      const response = similarResult.value;
      const results = (response && Array.isArray(response.results))
        ? response.results
        : (Array.isArray(response) ? response : []);

      if (results.length === 0) {
        const keyboard = new InlineKeyboard()
          .url('OpenDEX', `${config.FRONTEND_URL}/token.html?mint=${encodeURIComponent(mint)}`)
          .url('Solscan', `https://solscan.io/token/${encodeURIComponent(mint)}`);

        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `<b>${tokenName}</b> (${tokenSymbol})\n<code>${mint}</code>\n\n` +
          `\u2705 <b>No similar tokens found.</b>\n` +
          `This token's name and ticker appear to be unique on Solana.`,
          {
            parse_mode: 'HTML',
            reply_markup: keyboard,
            link_preview_options: { is_disabled: true }
          }
        );
        return;
      }

      // Build the similar tokens list
      const lines = [
        `<b>\u26A0\uFE0F PVP Check: ${tokenName} (${tokenSymbol})</b>`,
        `<code>${mint}</code>`,
        '',
        `<b>${results.length} similar token${results.length !== 1 ? 's' : ''} found</b> \u2014 verify the CA before trading!`,
        ''
      ];

      const keyboard = new InlineKeyboard();

      results.forEach((t, i) => {
        const name = escapeHtml(t.name || 'Unknown');
        const symbol = escapeHtml(t.symbol || '???');
        const addr = t.address || '';

        const stats = [];
        if (t.marketCap) stats.push(`MCap ${formatNumber(t.marketCap, '$')}`);
        if (t.volume24h) stats.push(`Vol ${formatNumber(t.volume24h, '$')}`);
        const age = formatAge(t.pairCreatedAt);
        if (age) stats.push(age);

        const scoreStr = t.similarityScore
          ? ` \u2022 ${(t.similarityScore * 100).toFixed(0)}% match`
          : '';

        lines.push(`<b>${i + 1}.</b> <b>${name}</b> (${symbol})${scoreStr}`);
        lines.push(`   <code>${addr}</code>`);
        if (stats.length > 0) {
          lines.push(`   ${stats.join(' \u2022 ')}`);
        }
        lines.push('');

        // Inline button: tap to view full token detail
        if (addr) {
          keyboard.text(`${i + 1}. ${t.symbol || '???'}`, `lookup:${addr}`).row();
        }
      });

      lines.push('<i>Always verify the contract address to avoid spoofed tokens.</i>');

      // Bottom row: queried token links
      keyboard
        .url('OpenDEX', `${config.FRONTEND_URL}/token.html?mint=${encodeURIComponent(mint)}`)
        .url('Solscan', `https://solscan.io/token/${encodeURIComponent(mint)}`);

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
      console.error('[PVP] Command failed:', error.message);
      const errorMsg = error.response?.status === 404
        ? 'Token not found. Please check the contract address.'
        : 'Failed to fetch similar tokens. Please try again.';
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, errorMsg);
    }
  });
};
