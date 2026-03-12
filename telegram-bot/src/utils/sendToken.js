const { InputFile } = require('grammy');
const axios = require('axios');
const { URL } = require('url');
const dns = require('dns');
const { promisify } = require('util');

const dnsLookup = promisify(dns.lookup);

/**
 * Check if an IP address is private/internal (SSRF protection).
 */
function isPrivateIP(ip) {
  // IPv4 private/reserved ranges
  const parts = ip.split('.').map(Number);
  if (parts.length === 4) {
    if (parts[0] === 10) return true;                                   // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true;             // 192.168.0.0/16
    if (parts[0] === 127) return true;                                  // 127.0.0.0/8
    if (parts[0] === 169 && parts[1] === 254) return true;             // 169.254.0.0/16 (link-local)
    if (parts[0] === 0) return true;                                    // 0.0.0.0/8
  }
  // IPv6 loopback and link-local
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd00:')) return true;
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) — extract and check the embedded IPv4
  if (ip.startsWith('::ffff:')) {
    const embedded = ip.slice(7);
    const embeddedParts = embedded.split('.').map(Number);
    if (embeddedParts.length === 4) return isPrivateIP(embedded);
  }
  return false;
}

/**
 * Download an image and return it as a grammY InputFile buffer.
 * Returns null if the download fails.
 * Includes SSRF protection: blocks requests to private/internal IPs.
 */
async function downloadImage(url) {
  // Validate URL protocol
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only HTTP(S) URLs are allowed');
  }

  // Resolve hostname and check for private IPs
  const { address, family } = await dnsLookup(parsed.hostname);
  if (isPrivateIP(address)) {
    throw new Error('URLs pointing to private/internal addresses are not allowed');
  }

  // Use the resolved IP directly to prevent DNS rebinding (TOCTOU)
  const resolvedUrl = new URL(url);
  const originalHostname = resolvedUrl.hostname;
  resolvedUrl.hostname = address;

  const response = await axios.get(resolvedUrl.toString(), {
    responseType: 'arraybuffer',
    timeout: 10000,
    maxContentLength: 5 * 1024 * 1024, // 5MB limit
    headers: {
      'User-Agent': 'OpenDEX-Bot/1.0',
      'Host': originalHostname
    }
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
