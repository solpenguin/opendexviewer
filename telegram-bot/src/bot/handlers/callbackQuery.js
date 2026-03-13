const tokensApi = require('../../api/tokens');
const { formatTokenMessage } = require('../../utils/format');
const { downloadImage } = require('../../utils/sendToken');
const { enrichWithPrice } = require('../../utils/enrichToken');
const { isValidSolanaAddress } = require('../../utils/solana');

module.exports = (bot) => {
  // ── Lookup callback (from search results, OG finder, PVP) ─────────
  bot.callbackQuery(/^lookup:(.+)$/, async (ctx) => {
    const mint = ctx.match[1];
    if (!isValidSolanaAddress(mint)) {
      return ctx.answerCallbackQuery({ text: 'Invalid token address' });
    }

    await ctx.answerCallbackQuery({ text: 'Loading token...' });

    try {
      let token = await tokensApi.getToken(mint);
      token = await enrichWithPrice(token);
      const message = formatTokenMessage(token);

      if (message.bannerUrl) {
        try {
          const photo = await downloadImage(message.bannerUrl);
          await ctx.replyWithPhoto(photo, {
            caption: message.text,
            parse_mode: 'HTML',
            reply_markup: message.replyMarkup
          });
          return;
        } catch {
          // Banner download failed — fall back to text
        }
      }

      await ctx.reply(message.text, {
        parse_mode: 'HTML',
        reply_markup: message.replyMarkup,
        link_preview_options: { is_disabled: true }
      });
    } catch (error) {
      await ctx.answerCallbackQuery();
      await ctx.reply('Failed to load token details.');
    }
  });

  // ── Refresh callback (update price data in-place) ──────────────────
  bot.callbackQuery(/^refresh:(.+)$/, async (ctx) => {
    const mint = ctx.match[1];
    if (!isValidSolanaAddress(mint)) {
      return ctx.answerCallbackQuery({ text: 'Invalid token address' });
    }

    await ctx.answerCallbackQuery({ text: 'Refreshing...' });

    try {
      let token = await tokensApi.getToken(mint);
      token = await enrichWithPrice(token);
      const message = formatTokenMessage(token);

      // If the original message was a photo (banner), update caption
      if (ctx.callbackQuery.message?.photo) {
        await ctx.editMessageCaption({
          caption: message.text,
          parse_mode: 'HTML',
          reply_markup: message.replyMarkup
        });
      } else {
        await ctx.editMessageText(message.text, {
          parse_mode: 'HTML',
          reply_markup: message.replyMarkup,
          link_preview_options: { is_disabled: true }
        });
      }
    } catch (error) {
      // If message didn't change (same data), Telegram throws — silently ignore
      if (error.description?.includes('message is not modified')) {
        return ctx.answerCallbackQuery({ text: 'Data is already up to date' }).catch(() => {});
      }
      await ctx.answerCallbackQuery({ text: 'Refresh failed. Try again.' }).catch(() => {});
    }
  });
};
