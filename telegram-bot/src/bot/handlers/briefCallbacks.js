const { InlineKeyboard } = require('grammy');
const store = require('../../alerts/store');
const tokensApi = require('../../api/tokens');
const { MCAP_LABELS, VOL_LABELS, RATIO_LABELS, FREQ_LABELS, HOURS_LABELS, applyFilters, formatBriefMessage } = require('../commands/brief');

// Temporary in-memory state for the subscription wizard (keyed by `userId:chatId`)
// Cleared once the subscription is saved.
const wizardState = new Map();

function getKey(ctx) {
  return `${ctx.from.id}:${ctx.chat.id}`;
}

module.exports = (bot) => {
  // ── Brief menu buttons ─────────────────────────────────────────────
  bot.callbackQuery('brief:now', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Fetching...' });

    const sub = await store.getBriefSub(ctx.from.id, ctx.chat.id);
    const filterMcap = sub?.filter_mcap || 'all';
    const filterVol = sub?.filter_vol || 0;
    const filterRatio = sub?.filter_ratio || 1;
    const hours = sub?.hours_window || 24;

    try {
      const data = await tokensApi.getDailyBrief({ hours, limit: 100 });
      const filtered = applyFilters(data.tokens || [], filterMcap, filterVol, filterRatio);
      const { text, keyboard } = formatBriefMessage(filtered, hours, filterMcap, filterVol, filterRatio);

      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      console.error('[Brief] Callback fetch failed:', err.message);
      await ctx.reply('Failed to fetch Daily Brief. Try again later.');
    }
  });

  bot.callbackQuery('brief:freq', async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text('Every 3h', 'bsub:freq:3')
      .text('Every 6h', 'bsub:freq:6')
      .row()
      .text('Every 12h', 'bsub:freq:12')
      .text('Every 24h', 'bsub:freq:24');

    await ctx.editMessageText(
      '<b>Step 1/5 \u2014 Push Frequency</b>\n\nHow often should I send you the brief?',
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  bot.callbackQuery('brief:unsub', async (ctx) => {
    await ctx.answerCallbackQuery();
    const removed = await store.removeBriefSub(ctx.from.id, ctx.chat.id);
    await ctx.editMessageText(removed
      ? 'Daily Brief subscription cancelled.'
      : 'You don\'t have an active subscription.');
  });

  // ── Step 1: Frequency ──────────────────────────────────────────────
  bot.callbackQuery(/^bsub:freq:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const freq = parseInt(ctx.match[1]);
    const key = getKey(ctx);
    wizardState.set(key, { freq });

    const kb = new InlineKeyboard()
      .text('6h', 'bsub:hours:6')
      .text('12h', 'bsub:hours:12')
      .row()
      .text('24h', 'bsub:hours:24')
      .text('48h', 'bsub:hours:48');

    await ctx.editMessageText(
      `<b>Step 2/5 \u2014 Time Window</b>\n\n` +
      `Frequency: <b>${FREQ_LABELS[freq]}</b>\n\n` +
      `How far back should the brief look for graduated tokens?`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  // ── Step 2: Hours window ───────────────────────────────────────────
  bot.callbackQuery(/^bsub:hours:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const hours = parseInt(ctx.match[1]);
    const key = getKey(ctx);
    const state = wizardState.get(key);
    if (!state) return ctx.reply('Session expired. Use /brief setup to start again.');
    state.hours = hours;

    const kb = new InlineKeyboard()
      .text('All', 'bsub:mcap:all')
      .text('< $50K', 'bsub:mcap:micro')
      .row()
      .text('$50K–$250K', 'bsub:mcap:small')
      .text('$250K–$1M', 'bsub:mcap:mid')
      .row()
      .text('> $1M', 'bsub:mcap:large');

    await ctx.editMessageText(
      `<b>Step 3/5 \u2014 Market Cap Filter</b>\n\n` +
      `Frequency: <b>${FREQ_LABELS[state.freq]}</b>\n` +
      `Window: <b>${HOURS_LABELS[hours]}</b>\n\n` +
      `Filter tokens by market cap range:`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  // ── Step 3: MCap filter ────────────────────────────────────────────
  bot.callbackQuery(/^bsub:mcap:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const mcap = ctx.match[1];
    const key = getKey(ctx);
    const state = wizardState.get(key);
    if (!state) return ctx.reply('Session expired. Use /brief setup to start again.');
    state.mcap = mcap;

    const kb = new InlineKeyboard()
      .text('Any', 'bsub:vol:0')
      .text('> $1K', 'bsub:vol:1000')
      .row()
      .text('> $10K', 'bsub:vol:10000')
      .text('> $50K', 'bsub:vol:50000')
      .row()
      .text('> $100K', 'bsub:vol:100000');

    await ctx.editMessageText(
      `<b>Step 4/5 \u2014 Minimum 24h Volume</b>\n\n` +
      `Frequency: <b>${FREQ_LABELS[state.freq]}</b>\n` +
      `Window: <b>${HOURS_LABELS[state.hours]}</b>\n` +
      `MCap: <b>${MCAP_LABELS[mcap]}</b>\n\n` +
      `Minimum 24h trading volume:`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  // ── Step 4: Volume filter ──────────────────────────────────────────
  bot.callbackQuery(/^bsub:vol:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const vol = parseInt(ctx.match[1]);
    const key = getKey(ctx);
    const state = wizardState.get(key);
    if (!state) return ctx.reply('Session expired. Use /brief setup to start again.');
    state.vol = vol;

    const kb = new InlineKeyboard()
      .text('Any', 'bsub:ratio:0')
      .text('>= 0.5x', 'bsub:ratio:0.5')
      .row()
      .text('>= 1x', 'bsub:ratio:1')
      .text('>= 2x', 'bsub:ratio:2')
      .row()
      .text('>= 5x', 'bsub:ratio:5');

    await ctx.editMessageText(
      `<b>Step 5/5 \u2014 Min Vol/MCap Ratio</b>\n\n` +
      `Frequency: <b>${FREQ_LABELS[state.freq]}</b>\n` +
      `Window: <b>${HOURS_LABELS[state.hours]}</b>\n` +
      `MCap: <b>${MCAP_LABELS[state.mcap]}</b>\n` +
      `Min Volume: <b>${VOL_LABELS[String(vol)]}</b>\n\n` +
      `Minimum volume-to-market-cap ratio (higher = more active trading):`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  // ── Step 5: Ratio filter → save subscription ──────────────────────
  bot.callbackQuery(/^bsub:ratio:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const ratio = parseFloat(ctx.match[1]);
    const key = getKey(ctx);
    const state = wizardState.get(key);
    if (!state) return ctx.reply('Session expired. Use /brief setup to start again.');

    // Save subscription
    const sub = await store.upsertBriefSub({
      userId: ctx.from.id,
      chatId: ctx.chat.id,
      frequencyHrs: state.freq,
      filterMcap: state.mcap,
      filterVol: state.vol,
      filterRatio: ratio,
      hoursWindow: state.hours,
    });

    // Clean up wizard state
    wizardState.delete(key);

    await ctx.editMessageText(
      `<b>\u2705 Daily Brief Subscription Active!</b>\n\n` +
      `<b>Settings:</b>\n` +
      `Frequency: ${FREQ_LABELS[state.freq]}\n` +
      `Time window: ${HOURS_LABELS[state.hours]}\n` +
      `MCap: ${MCAP_LABELS[state.mcap]}\n` +
      `Min Volume: ${VOL_LABELS[String(state.vol)]}\n` +
      `Min Vol/MCap: ${RATIO_LABELS[String(ratio)]}\n\n` +
      `I'll send your first brief soon. Use /brief now for an instant one.\n` +
      `Use /brief stop to unsubscribe.`,
      { parse_mode: 'HTML' }
    );
  });

  // ── Wizard state cleanup — prune entries older than 30 minutes ─────
  setInterval(() => {
    // Wizard state entries are tiny, but prevent unbounded growth
    if (wizardState.size > 1000) {
      wizardState.clear();
    }
  }, 30 * 60 * 1000).unref();
};
