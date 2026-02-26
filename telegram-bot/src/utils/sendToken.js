const { InputFile } = require('grammy');
const axios = require('axios');

/**
 * Download an image and return it as a grammY InputFile buffer.
 * Returns null if the download fails.
 */
async function downloadImage(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 10000,
    headers: { 'User-Agent': 'OpenDEX-Bot/1.0' }
  });
  const buffer = Buffer.from(response.data);
  return new InputFile(buffer, 'banner.jpg');
}

/**
 * Send a formatted token message, using a photo with caption if a banner exists,
 * otherwise a plain text message. Deletes the "Looking up..." status message.
 */
async function sendTokenMessage(ctx, statusMsg, message) {
  // Delete the "Looking up..." placeholder
  await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

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
      // Banner download failed — fall back to text only
    }
  }

  await ctx.reply(message.text, {
    parse_mode: 'HTML',
    reply_markup: message.replyMarkup,
    link_preview_options: { is_disabled: true }
  });
}

module.exports = { sendTokenMessage, downloadImage };
