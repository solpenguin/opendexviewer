const { InlineKeyboard } = require('grammy');
const config = require('../config');

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPrice(price) {
  if (!price || price === 0) return '$0.00';
  const num = Number(price);
  if (isNaN(num)) return '$0.00';
  if (num < 0.000001) return `$${num.toExponential(2)}`;
  if (num < 0.0001) return `$${num.toFixed(8)}`;
  if (num < 0.01) return `$${num.toFixed(6)}`;
  if (num < 1) return `$${num.toFixed(4)}`;
  if (num < 1000) return `$${num.toFixed(2)}`;
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatNumber(num, prefix = '$') {
  if (num === null || num === undefined) return '--';
  const n = Number(num);
  if (isNaN(n)) return '--';
  if (n >= 1e12) return `${prefix}${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${prefix}${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${prefix}${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${prefix}${(n / 1e3).toFixed(2)}K`;
  return `${prefix}${n.toFixed(2)}`;
}

function formatChange(change) {
  if (change === null || change === undefined) return '--';
  const num = Number(change);
  if (isNaN(num)) return '--';
  const arrow = num >= 0 ? '\u2B06' : '\u2B07';
  const prefix = num >= 0 ? '+' : '';
  return `${arrow} ${prefix}${num.toFixed(2)}%`;
}

function formatTokenMessage(token) {
  const mint = token.mintAddress || token.address;
  const name = escapeHtml(token.name || 'Unknown');
  const symbol = escapeHtml(token.symbol || '???');

  // Extract banner URL from approved banner submissions
  let bannerUrl = null;
  if (token.submissions?.banners?.length > 0) {
    const approvedBanner = token.submissions.banners.find(b => b.status === 'approved');
    if (approvedBanner) {
      bannerUrl = approvedBanner.content_url;
    }
  }

  // Build community links from approved submissions
  let communityLinks = '';
  if (token.submissions?.socials) {
    const linkMap = {};
    for (const sub of token.submissions.socials) {
      if (sub.status === 'approved' && !linkMap[sub.submission_type]) {
        linkMap[sub.submission_type] = sub.content_url;
      }
    }

    const parts = [];
    if (linkMap.twitter) parts.push(`<a href="${linkMap.twitter}">Twitter</a>`);
    if (linkMap.telegram) parts.push(`<a href="${linkMap.telegram}">Telegram</a>`);
    if (linkMap.discord) parts.push(`<a href="${linkMap.discord}">Discord</a>`);
    if (linkMap.website) parts.push(`<a href="${linkMap.website}">Website</a>`);
    if (linkMap.tiktok) parts.push(`<a href="${linkMap.tiktok}">TikTok</a>`);

    if (parts.length > 0) {
      communityLinks = `\n<b>Community:</b> ${parts.join(' | ')}\n`;
    }
  }

  const text =
    `<b>${name}</b> (${symbol})\n` +
    `<code>${mint}</code>\n\n` +
    `<b>Price:</b> ${formatPrice(token.price)} ${formatChange(token.priceChange24h)}\n` +
    `<b>Market Cap:</b> ${formatNumber(token.marketCap)}\n` +
    `<b>FDV:</b> ${formatNumber(token.fdv)}\n` +
    `<b>24h Volume:</b> ${formatNumber(token.volume24h)}\n` +
    `<b>Liquidity:</b> ${formatNumber(token.liquidity)}\n` +
    (token.holders ? `<b>Holders:</b> ${Number(token.holders).toLocaleString('en-US')}\n` : '') +
    communityLinks;

  const keyboard = new InlineKeyboard()
    .url('View on OpenDEX', `${config.FRONTEND_URL}/token.html?mint=${mint}`)
    .url('Solscan', `https://solscan.io/token/${mint}`)
    .row()
    .url('Trade on Jupiter', `https://jup.ag/swap/SOL-${mint}`);

  return { text, replyMarkup: keyboard, bannerUrl };
}

module.exports = { escapeHtml, formatPrice, formatNumber, formatChange, formatTokenMessage };
