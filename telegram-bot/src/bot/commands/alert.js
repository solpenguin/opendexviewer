const alertStore = require('../../alerts/store');
const tokensApi = require('../../api/tokens');
const { isValidSolanaAddress } = require('../../utils/solana');
const { formatPrice } = require('../../utils/format');
const config = require('../../config');

module.exports = (bot) => {
  bot.command('alert', async (ctx) => {
    const args = ctx.match?.trim().split(/\s+/);

    if (!args || args.length < 3) {
      return ctx.reply(
        'Usage:\n' +
        '/alert &lt;CA&gt; above &lt;price&gt;\n' +
        '/alert &lt;CA&gt; below &lt;price&gt;\n' +
        '/alert &lt;CA&gt; change &lt;percent&gt;',
        { parse_mode: 'HTML' }
      );
    }

    const [mint, condition, valueStr] = args;

    if (!isValidSolanaAddress(mint)) {
      return ctx.reply('Invalid Solana contract address.');
    }

    if (!['above', 'below', 'change'].includes(condition)) {
      return ctx.reply('Condition must be: above, below, or change');
    }

    const value = parseFloat(valueStr);
    if (isNaN(value) || value <= 0) {
      return ctx.reply('Value must be a positive number.');
    }

    const userId = ctx.from.id;
    const existingAlerts = alertStore.listByUser(userId);
    if (existingAlerts.length >= config.MAX_ALERTS_PER_USER) {
      return ctx.reply(
        `You have reached the maximum of ${config.MAX_ALERTS_PER_USER} active alerts.\n` +
        `Remove one first with /removealert &lt;id&gt;.`,
        { parse_mode: 'HTML' }
      );
    }

    const statusMsg = await ctx.reply('Verifying token...');

    try {
      const token = await tokensApi.getToken(mint);
      const currentPrice = token.price || 0;

      if (currentPrice === 0) {
        return ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          'This token has no price data available. Cannot set alert.'
        );
      }

      const alert = alertStore.create({
        userId,
        chatId: ctx.chat.id,
        mint,
        tokenName: token.name || 'Unknown',
        tokenSymbol: token.symbol || '???',
        condition,
        targetValue: value,
        priceAtCreation: currentPrice
      });

      let description;
      if (condition === 'above') {
        description = `price goes above ${formatPrice(value)}`;
      } else if (condition === 'below') {
        description = `price goes below ${formatPrice(value)}`;
      } else {
        description = `price changes by ${value}%`;
      }

      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `Alert #${alert.id} created!\n\n` +
        `Token: ${token.name || 'Unknown'} (${token.symbol || '???'})\n` +
        `Current price: ${formatPrice(currentPrice)}\n` +
        `Alert when: ${description}`
      );
    } catch (error) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        'Failed to create alert. Could not verify token.'
      );
    }
  });
};
