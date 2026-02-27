const { InlineKeyboard } = require('grammy');
const tokensApi = require('../../api/tokens');
const { escapeHtml, formatPrice, formatNumber } = require('../../utils/format');
const config = require('../../config');

const PAGE_SIZE = 10;

// Format the top-3 highlight cards (top called, top sentiment, most watched)
async function formatHighlights() {
  const [calls, sentiment, watchlist] = await Promise.allSettled([
    tokensApi.leaderboardCalls({ limit: 1, offset: 0 }),
    tokensApi.leaderboardSentiment({ limit: 1, offset: 0 }),
    tokensApi.leaderboardWatchlist({ limit: 1, offset: 0 }),
  ]);

  let text = '<b>Community Highlights</b>\n\n';

  // Top Called
  const callToken = calls.status === 'fulfilled' && calls.value.tokens?.[0];
  if (callToken) {
    const name = escapeHtml(callToken.name || 'Unknown');
    const symbol = escapeHtml(callToken.symbol || '???');
    const count = callToken.callCount || 0;
    text += `\u{1F4E2} <b>Top Called:</b> ${name} (${symbol}) \u2014 ${count} call${count !== 1 ? 's' : ''}\n`;
  } else {
    text += `\u{1F4E2} <b>Top Called:</b> No data yet\n`;
  }

  // Top Sentiment
  const sentToken = sentiment.status === 'fulfilled' && sentiment.value.tokens?.[0];
  if (sentToken) {
    const name = escapeHtml(sentToken.name || 'Unknown');
    const symbol = escapeHtml(sentToken.symbol || '???');
    const score = sentToken.sentimentScore || 0;
    const sign = score > 0 ? '+' : '';
    text += `\u{1F4C8} <b>Top Sentiment:</b> ${name} (${symbol}) \u2014 ${sign}${score} score\n`;
  } else {
    text += `\u{1F4C8} <b>Top Sentiment:</b> No data yet\n`;
  }

  // Most Watched
  const watchToken = watchlist.status === 'fulfilled' && watchlist.value.tokens?.[0];
  if (watchToken) {
    const name = escapeHtml(watchToken.name || 'Unknown');
    const symbol = escapeHtml(watchToken.symbol || '???');
    const count = watchToken.watchlistCount || 0;
    text += `\u2B50 <b>Most Watched:</b> ${name} (${symbol}) \u2014 ${count} watchlist${count !== 1 ? 's' : ''}\n`;
  } else {
    text += `\u2B50 <b>Most Watched:</b> No data yet\n`;
  }

  return text;
}

// Format a leaderboard page
function formatLeaderboard(tab, tokens, total, page) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const offset = (page - 1) * PAGE_SIZE;

  const titles = {
    watchlist: '\u2B50 Most Watched Tokens',
    sentiment: '\u{1F4C8} Top Sentiment Tokens',
    calls: '\u{1F4E2} Most Called Tokens (24h)',
  };

  let text = `<b>${titles[tab]}</b>\n`;
  text += `<i>Page ${page} of ${totalPages}</i>\n\n`;

  if (!tokens || tokens.length === 0) {
    text += 'No tokens found.\n';
    return text;
  }

  tokens.forEach((token, i) => {
    const rank = offset + i + 1;
    const name = escapeHtml(token.name || 'Unknown');
    const symbol = escapeHtml(token.symbol || '???');
    const mint = token.mintAddress || token.address || '';
    const safeMint = encodeURIComponent(mint);

    let metric;
    if (tab === 'watchlist') {
      const count = token.watchlistCount || 0;
      metric = `${count} watchlist${count !== 1 ? 's' : ''}`;
    } else if (tab === 'sentiment') {
      const score = token.sentimentScore || 0;
      const bull = token.sentimentBullish || 0;
      const bear = token.sentimentBearish || 0;
      const sign = score > 0 ? '+' : '';
      metric = `${sign}${score} (${bull}\u2191 ${bear}\u2193)`;
    } else {
      const count = token.callCount || 0;
      metric = `${count} call${count !== 1 ? 's' : ''}`;
    }

    const price = formatPrice(token.price);
    const mcap = formatNumber(token.marketCap);

    text += `<b>${rank}.</b> <a href="${config.FRONTEND_URL}/token.html?mint=${safeMint}">${name}</a> (${symbol})\n`;
    text += `    ${price} \u2022 MCap: ${mcap} \u2022 ${metric}\n`;
  });

  return text;
}

// Build inline keyboard for leaderboard navigation
function buildKeyboard(tab, page, total) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const kb = new InlineKeyboard();

  // Tab switcher row
  const tabs = [
    { id: 'watchlist', label: '\u2B50 Watched' },
    { id: 'sentiment', label: '\u{1F4C8} Sentiment' },
    { id: 'calls', label: '\u{1F4E2} Called' },
  ];

  tabs.forEach(t => {
    const label = t.id === tab ? `\u2022 ${t.label} \u2022` : t.label;
    kb.text(label, `lb:${t.id}:1`);
  });

  kb.row();

  // Pagination row
  if (totalPages > 1) {
    if (page > 1) {
      kb.text('\u25C0 Prev', `lb:${tab}:${page - 1}`);
    }
    kb.text(`${page}/${totalPages}`, `lb:noop:0`);
    if (page < totalPages) {
      kb.text('Next \u25B6', `lb:${tab}:${page + 1}`);
    }
    kb.row();
  }

  // Link to full community page
  kb.url('View on OpenDEX', `${config.FRONTEND_URL}/community.html`);

  return kb;
}

module.exports = (bot) => {
  // /community command — shows highlights + watchlist leaderboard page 1
  bot.command('community', async (ctx) => {
    const statusMsg = await ctx.reply('Loading community data...');

    try {
      const [highlights, leaderboard] = await Promise.all([
        formatHighlights(),
        tokensApi.leaderboardWatchlist({ limit: PAGE_SIZE, offset: 0 }),
      ]);

      const tokens = leaderboard.tokens || [];
      const total = leaderboard.total || 0;
      const boardText = formatLeaderboard('watchlist', tokens, total, 1);

      const text = highlights + '\n' + boardText;
      const keyboard = buildKeyboard('watchlist', 1, total);

      await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      await ctx.api.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        'Failed to load community data. Please try again.'
      );
    }
  });

  // Callback handler for leaderboard tab switching and pagination
  bot.callbackQuery(/^lb:(\w+):(\d+)$/, async (ctx) => {
    const tab = ctx.match[1];
    const page = parseInt(ctx.match[2]);

    // No-op button (page indicator)
    if (tab === 'noop') {
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Loading...' });

    try {
      const offset = (page - 1) * PAGE_SIZE;
      let result;

      if (tab === 'watchlist') {
        result = await tokensApi.leaderboardWatchlist({ limit: PAGE_SIZE, offset });
      } else if (tab === 'sentiment') {
        result = await tokensApi.leaderboardSentiment({ limit: PAGE_SIZE, offset });
      } else if (tab === 'calls') {
        result = await tokensApi.leaderboardCalls({ limit: PAGE_SIZE, offset });
      } else {
        return;
      }

      const tokens = result.tokens || [];
      const total = result.total || 0;

      const highlights = await formatHighlights();
      const boardText = formatLeaderboard(tab, tokens, total, page);
      const text = highlights + '\n' + boardText;
      const keyboard = buildKeyboard(tab, page, total);

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      // If message didn't change (same page clicked), Telegram throws — silently ignore
      if (error.description?.includes('message is not modified')) return;
      await ctx.answerCallbackQuery({ text: 'Failed to load. Try again.' });
    }
  });
};
