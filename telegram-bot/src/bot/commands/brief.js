const { InlineKeyboard } = require('grammy');
const tokensApi = require('../../api/tokens');
const store = require('../../alerts/store');
const { escapeHtml, formatNumber, formatChange, formatPrice } = require('../../utils/format');
const config = require('../../config');

// ── Filter / frequency labels (HTML-safe — used in parse_mode HTML) ──
const MCAP_LABELS = {
  all: 'All',
  micro: '&lt; $50K',
  small: '$50K\u2013$250K',
  mid: '$250K\u2013$1M',
  large: '&gt; $1M',
};
const VOL_LABELS = {
  '0': 'Any',
  '1000': '&gt; $1K',
  '10000': '&gt; $10K',
  '50000': '&gt; $50K',
  '100000': '&gt; $100K',
};
const RATIO_LABELS = {
  '0': 'Any',
  '0.5': '&gt;= 0.5x',
  '1': '&gt;= 1x',
  '2': '&gt;= 2x',
  '5': '&gt;= 5x',
};
const FREQ_LABELS = {
  '3': 'Every 3h',
  '6': 'Every 6h',
  '12': 'Every 12h',
  '24': 'Every 24h',
};
const HOURS_LABELS = {
  '6': '6h',
  '12': '12h',
  '24': '24h',
  '48': '48h',
};

// ── Mcap filter logic (client-side, mirrors frontend) ────────────────
const MCAP_RANGES = {
  all:   { min: 0, max: Infinity },
  micro: { min: 0, max: 50000 },
  small: { min: 50000, max: 250000 },
  mid:   { min: 250000, max: 1000000 },
  large: { min: 1000000, max: Infinity },
};

function applyFilters(tokens, filterMcap, filterVol, filterRatio) {
  const range = MCAP_RANGES[filterMcap] || MCAP_RANGES.all;
  return tokens.filter(t => {
    const mcap = t.marketCap || t.market_cap || 0;
    const vol = t.volume24h || t.volume_24h || 0;
    const ratio = t.volMcapRatio || t.vol_mcap_ratio || 0;
    return mcap >= range.min && mcap < range.max
      && vol >= filterVol
      && ratio >= filterRatio;
  });
}

// ── Format a brief message ───────────────────────────────────────────
function formatBriefMessage(tokens, hours, filterMcap, filterVol, filterRatio) {
  // Sort by vol/mcap ratio descending
  tokens.sort((a, b) => {
    const ra = a.volMcapRatio || a.vol_mcap_ratio || 0;
    const rb = b.volMcapRatio || b.vol_mcap_ratio || 0;
    return rb - ra;
  });

  const display = tokens.slice(0, 10);

  let text = `<b>\u{1F4CB} Daily Brief</b> \u2014 last ${hours}h\n`;
  text += `<i>Filters: MCap ${MCAP_LABELS[filterMcap] || 'All'} \u2022 Vol ${VOL_LABELS[String(filterVol)] || 'Any'} \u2022 Ratio ${RATIO_LABELS[String(filterRatio)] || 'Any'}</i>\n`;
  text += `<i>${tokens.length} graduated tokens match \u2022 top 10 by vol/mcap</i>\n\n`;

  if (display.length === 0) {
    text += 'No tokens match your filters for this time window.\n';
    return { text, keyboard: null };
  }

  const keyboard = new InlineKeyboard();

  display.forEach((t, i) => {
    const rank = i + 1;
    const name = escapeHtml(t.name || 'Unknown');
    const symbol = escapeHtml(t.symbol || '???');
    const mint = t.mintAddress || t.mint_address || t.address || '';
    const mcap = formatNumber(t.marketCap || t.market_cap);
    const vol = formatNumber(t.volume24h || t.volume_24h);
    const ratio = (t.volMcapRatio || t.vol_mcap_ratio || 0).toFixed(2);
    const change = formatChange(t.priceChange24h || t.price_change_24h);

    const ratioEmoji = ratio > 2 ? '\u{1F525}' : ratio > 0.5 ? '\u{1F7E0}' : '\u26AA';

    text += `<b>${rank}.</b> <b>${name}</b> (${symbol})\n`;
    text += `   MCap ${mcap} \u2022 Vol ${vol} \u2022 ${ratioEmoji} ${ratio}x\n`;
    text += `   ${change} \u2022 <code>${mint}</code>\n\n`;

    if (i < 5 && mint) {
      keyboard.text(`${rank}. ${t.symbol || '???'}`, `lookup:${mint}`).row();
    }
  });

  keyboard.url('Full Brief on OpenDEX', `${config.FRONTEND_URL}/dailybrief.html`);

  return { text, keyboard };
}

// ── Helpers ──────────────────────────────────────────────────────────

function isGroup(ctx) {
  return ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
}

async function isAdmin(ctx) {
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    return ['creator', 'administrator'].includes(member.status);
  } catch {
    return false;
  }
}

// Check admin for group chats; always allow in DMs
async function requireAdminIfGroup(ctx) {
  if (!isGroup(ctx)) return true;
  if (await isAdmin(ctx)) return true;
  await ctx.reply('Only group admins can manage the Daily Brief subscription.');
  return false;
}

// ── /brief command ───────────────────────────────────────────────────
module.exports = (bot) => {
  bot.command('brief', async (ctx) => {
    const arg = ctx.match?.trim().toLowerCase();
    const chatId = ctx.chat.id;

    // /brief stop — unsubscribe
    if (arg === 'stop' || arg === 'unsub' || arg === 'off') {
      if (!(await requireAdminIfGroup(ctx))) return;
      const removed = await store.removeBriefSub(chatId);
      return ctx.reply(removed
        ? 'Daily Brief subscription cancelled.'
        : 'There is no active subscription for this chat.');
    }

    // /brief status — show current sub
    if (arg === 'status') {
      const sub = await store.getBriefSub(chatId);
      if (!sub) {
        return ctx.reply('No active Daily Brief subscription.\nUse /brief to set one up, or /brief now for a one-shot.');
      }
      return ctx.reply(
        `<b>Daily Brief Subscription</b>\n\n` +
        `Frequency: ${FREQ_LABELS[sub.frequency_hrs] || sub.frequency_hrs + 'h'}\n` +
        `Time window: ${sub.hours_window}h\n` +
        `MCap: ${MCAP_LABELS[sub.filter_mcap] || sub.filter_mcap}\n` +
        `Min Volume: ${VOL_LABELS[String(sub.filter_vol)] || '$' + sub.filter_vol}\n` +
        `Min Vol/MCap: ${RATIO_LABELS[String(sub.filter_ratio)] || sub.filter_ratio + 'x'}\n` +
        `Last sent: ${sub.last_sent_at ? new Date(sub.last_sent_at).toUTCString() : 'Never'}\n\n` +
        (isGroup(ctx) ? 'Any admin can edit or stop this subscription.\n' : '') +
        `Use /brief stop to unsubscribe.`,
        { parse_mode: 'HTML' }
      );
    }

    // /brief now — instant brief with saved or default filters
    if (arg === 'now' || arg === '') {
      const sub = await store.getBriefSub(chatId);
      const filterMcap = sub?.filter_mcap || 'all';
      const filterVol = sub?.filter_vol || 0;
      const filterRatio = sub?.filter_ratio || 1;
      const hours = sub?.hours_window || 24;

      const statusMsg = await ctx.reply('Fetching Daily Brief...');

      try {
        const data = await tokensApi.getDailyBrief({ hours, limit: 100 });
        const filtered = applyFilters(data.tokens || [], filterMcap, filterVol, filterRatio);
        const { text, keyboard } = formatBriefMessage(filtered, hours, filterMcap, filterVol, filterRatio);

        await ctx.api.editMessageText(chatId, statusMsg.message_id, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
          link_preview_options: { is_disabled: true },
        });
      } catch (err) {
        console.error('[Brief] Fetch failed:', err.message);
        await ctx.api.editMessageText(chatId, statusMsg.message_id, 'Failed to fetch Daily Brief. Try again later.');
      }
      return;
    }

    // /brief setup — show the subscription wizard (frequency picker)
    if (arg === 'setup' || arg === 'subscribe' || arg === 'sub') {
      if (!(await requireAdminIfGroup(ctx))) return;
      return showFrequencyPicker(ctx);
    }

    // Default: show brief menu
    const sub = await store.getBriefSub(chatId);
    const kb = new InlineKeyboard()
      .text('\u{1F4CB} Get Brief Now', 'brief:now')
      .row()
      .text(sub ? '\u2699\uFE0F Edit Subscription' : '\u{1F514} Subscribe', 'brief:freq')
      .row();
    if (sub) {
      kb.text('\u274C Unsubscribe', 'brief:unsub');
    }

    const adminNote = isGroup(ctx) ? '\n<i>Admin-only: subscribe, edit, unsubscribe</i>' : '';

    await ctx.reply(
      `<b>\u{1F4CB} Daily Brief</b>\n\n` +
      `Get a curated list of newly graduated PumpFun tokens, sorted by volume/mcap ratio.\n\n` +
      (sub
        ? `Active subscription (${FREQ_LABELS[sub.frequency_hrs] || sub.frequency_hrs + 'h'}).\n\n`
        : 'No subscription yet.\n\n') +
      `<b>Quick commands:</b>\n` +
      `/brief now \u2014 one-shot brief\n` +
      `/brief setup \u2014 configure subscription\n` +
      `/brief status \u2014 view settings\n` +
      `/brief stop \u2014 unsubscribe` +
      adminNote,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });
};

function showFrequencyPicker(ctx) {
  const kb = new InlineKeyboard()
    .text('Every 3h', 'bsub:freq:3')
    .text('Every 6h', 'bsub:freq:6')
    .row()
    .text('Every 12h', 'bsub:freq:12')
    .text('Every 24h', 'bsub:freq:24');

  return ctx.reply(
    '<b>Step 1/5 \u2014 Push Frequency</b>\n\nHow often should I send the brief?',
    { parse_mode: 'HTML', reply_markup: kb }
  );
}

module.exports.showFrequencyPicker = showFrequencyPicker;
module.exports.applyFilters = applyFilters;
module.exports.formatBriefMessage = formatBriefMessage;
module.exports.isAdmin = isAdmin;
module.exports.isGroup = isGroup;
module.exports.MCAP_LABELS = MCAP_LABELS;
module.exports.VOL_LABELS = VOL_LABELS;
module.exports.RATIO_LABELS = RATIO_LABELS;
module.exports.FREQ_LABELS = FREQ_LABELS;
module.exports.HOURS_LABELS = HOURS_LABELS;
