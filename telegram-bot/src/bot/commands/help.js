module.exports = (bot) => {
  bot.command('help', async (ctx) => {
    const isGroup = ctx.chat.type !== 'private';

    let text =
      `<b>OpenDEX Bot Commands</b>\n\n` +
      `<b>Token Lookup</b>\n` +
      `/token &lt;CA&gt; - Look up a token by contract address\n` +
      `Paste a CA directly and I'll detect it automatically\n` +
      `Tap the \u{1F504} Refresh button on any token card to update prices\n\n` +
      `<b>Search</b>\n` +
      `/search &lt;query&gt; - Search tokens by name or symbol\n\n`;

    if (!isGroup) {
      text +=
        `<b>Market Cap Alerts</b>\n` +
        `/alert &lt;CA&gt; above &lt;mcap&gt; - Alert when market cap goes above\n` +
        `/alert &lt;CA&gt; below &lt;mcap&gt; - Alert when market cap goes below\n` +
        `/alert &lt;CA&gt; change &lt;percent&gt; - Alert on market cap % change\n` +
        `/alerts - List your active alerts\n` +
        `/removealert &lt;id&gt; - Remove an alert\n\n` +
        `<b>Daily Brief</b>\n` +
        `/brief - Graduated PumpFun tokens sorted by vol/mcap ratio\n` +
        `/brief now - One-shot brief with your saved filters\n` +
        `/brief setup - Subscribe with custom filters &amp; frequency\n` +
        `/brief status - View your subscription settings\n` +
        `/brief stop - Unsubscribe\n\n`;
    }

    text +=
      `<b>Anti-Spoofing</b>\n` +
      `/pvp &lt;CA&gt; - Find tokens with similar names/tickers\n\n` +
      `<b>OG Finder</b>\n` +
      `/og &lt;query&gt; - Find the oldest PumpFun tokens by name or ticker\n\n` +
      `<b>Community</b>\n` +
      `/community - Leaderboards &amp; highlights (watchlisted, sentiment, calls)\n\n`;

    if (isGroup) {
      text +=
        `<b>Group Settings</b> (admin only)\n` +
        `/cadetect - Toggle automatic CA detection in this group\n\n`;
    }

    text +=
      `<b>Other</b>\n` +
      `/stats - Bot statistics\n` +
      `/help - This message`;

    await ctx.reply(text, { parse_mode: 'HTML' });
  });
};
