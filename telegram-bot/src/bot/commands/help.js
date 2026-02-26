module.exports = (bot) => {
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `<b>OpenDEX Bot Commands</b>\n\n` +
      `<b>Token Lookup</b>\n` +
      `/token &lt;CA&gt; - Look up a token by contract address\n` +
      `Or just paste a CA directly — I'll detect it automatically\n\n` +
      `<b>Search</b>\n` +
      `/search &lt;query&gt; - Search tokens by name or symbol\n\n` +
      `<b>Price Alerts</b>\n` +
      `/alert &lt;CA&gt; above &lt;price&gt; - Alert when price goes above\n` +
      `/alert &lt;CA&gt; below &lt;price&gt; - Alert when price goes below\n` +
      `/alert &lt;CA&gt; change &lt;percent&gt; - Alert on % change\n` +
      `/alerts - List your active alerts\n` +
      `/removealert &lt;id&gt; - Remove an alert\n\n` +
      `<b>Other</b>\n` +
      `/stats - Bot statistics\n` +
      `/help - This message`,
      { parse_mode: 'HTML' }
    );
  });
};
