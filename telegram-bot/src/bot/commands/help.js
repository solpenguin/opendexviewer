module.exports = (bot) => {
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `<b>OpenDEX Bot Commands</b>\n\n` +
      `<b>Token Lookup</b>\n` +
      `/token &lt;CA&gt; - Look up a token by contract address\n` +
      `In DMs, just paste a CA directly — I'll detect it automatically\n\n` +
      `<b>Search</b>\n` +
      `/search &lt;query&gt; - Search tokens by name or symbol\n\n` +
      `<b>Market Cap Alerts</b>\n` +
      `/alert &lt;CA&gt; above &lt;mcap&gt; - Alert when market cap goes above\n` +
      `/alert &lt;CA&gt; below &lt;mcap&gt; - Alert when market cap goes below\n` +
      `/alert &lt;CA&gt; change &lt;percent&gt; - Alert on market cap % change\n` +
      `/alerts - List your active alerts\n` +
      `/removealert &lt;id&gt; - Remove an alert\n\n` +
      `<b>Anti-Spoofing</b>\n` +
      `/pvp &lt;CA&gt; - Find tokens with similar names/tickers\n\n` +
      `<b>OG Finder</b>\n` +
      `/og &lt;query&gt; - Find the oldest PumpFun tokens by name or ticker\n\n` +
      `<b>Community</b>\n` +
      `/community - Leaderboards &amp; highlights (watchlisted, sentiment, calls)\n\n` +
      `<b>Other</b>\n` +
      `/stats - Bot statistics\n` +
      `/help - This message`,
      { parse_mode: 'HTML' }
    );
  });
};
