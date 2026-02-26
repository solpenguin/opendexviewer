const { InputFile } = require('grammy');

/**
 * Send a formatted token message, using a photo with caption if a banner exists,
 * otherwise a plain text message. Deletes the "Looking up..." status message.
 */
async function sendTokenMessage(ctx, statusMsg, message) {
  // Delete the "Looking up..." placeholder
  await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

  if (message.bannerUrl) {
    // Send as photo with caption (banner at the top)
    try {
      await ctx.replyWithPhoto(message.bannerUrl, {
        caption: message.text,
        parse_mode: 'HTML',
        reply_markup: message.replyMarkup
      });
      return;
    } catch {
      // Banner URL may be broken/expired — fall back to text only
    }
  }

  await ctx.reply(message.text, {
    parse_mode: 'HTML',
    reply_markup: message.replyMarkup,
    link_preview_options: { is_disabled: true }
  });
}

module.exports = { sendTokenMessage };
