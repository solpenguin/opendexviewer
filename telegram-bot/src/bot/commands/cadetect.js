const alertStore = require('../../alerts/store');

module.exports = (bot) => {
  bot.command('cadetect', async (ctx) => {
    // Only works in group/supergroup chats
    if (ctx.chat.type === 'private') {
      return ctx.reply('CA auto-detection is always active in DMs. This command is for group chats.');
    }

    // Only admins can toggle this setting
    try {
      const member = await ctx.getChatMember(ctx.from.id);
      if (!['creator', 'administrator'].includes(member.status)) {
        return ctx.reply('Only group admins can toggle CA auto-detection.');
      }
    } catch {
      return ctx.reply('Could not verify admin status. Please make sure the bot has the right permissions.');
    }

    const chatId = ctx.chat.id;
    const current = await alertStore.getGroupSetting(chatId);
    const newState = !current.ca_detect;

    await alertStore.setGroupCaDetect(chatId, newState);

    const stateText = newState ? 'enabled' : 'disabled';
    await ctx.reply(
      `CA auto-detection <b>${stateText}</b> for this group.\n\n` +
      (newState
        ? 'I will now automatically look up any Solana contract address posted in this chat.'
        : 'I will no longer auto-detect contract addresses in this chat. Use /token to look up tokens.'),
      { parse_mode: 'HTML' }
    );
  });
};
