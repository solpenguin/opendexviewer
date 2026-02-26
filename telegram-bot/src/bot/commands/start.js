module.exports = (bot) => {
  bot.command('start', async (ctx) => {
    await ctx.reply(
      `<b>Welcome to OpenDEX Bot</b>\n\n` +
      `I help you look up Solana tokens, search by name, and set price alerts.\n\n` +
      `<b>Quick Start:</b>\n` +
      `- Paste any Solana contract address and I'll fetch the token info\n` +
      `- Use /search to find tokens by name or symbol\n` +
      `- Use /alert to set price alerts\n\n` +
      `Type /help for all commands.`,
      { parse_mode: 'HTML' }
    );
  });
};
