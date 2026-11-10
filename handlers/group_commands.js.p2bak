'use strict';

const { showAllMembers, tagAll, muteAll, unmuteAll,
        warnMember, banMember, unbanMember,
        muteMember, unmuteMember } = require('./group_admin');
const million = require('./million_battle');
const infoPanel = require('./group_info_panel');
const { get, all, run } = require('../database/db');
const { build } = require('../utils/keyboard');

// ── مساعدات ──────────────────────────────────────────────
function isGroup(ctx) {
  return ['supergroup', 'group'].includes(ctx.chat?.type);
}
function isAdmin(ctx) {
  return ctx.isOwner || ctx.isAdmin;
}

async function isTgAdmin(ctx) {
  if (ctx.isOwner || ctx.isAdmin) return true;
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return ['administrator', 'creator'].includes(member?.status);
  } catch { return false; }
}
// استخرج المستخدم المستهدف (reply أو mention أو ID)
async function getTarget(ctx) {
  const msg = ctx.message;
  // من الرد
  if (msg.reply_to_message?.from) {
    const u = msg.reply_to_message.from;
    return { id: u.id, name: u.first_name || 'مستخدم', fromReply: true };
  }
  // من النص: /ban @username أو /ban 123456
  const args = msg.text?.split(' ').slice(1) || [];
  if (!args.length) return null;
  const raw = args[0];
  if (/^\d+$/.test(raw)) return { id: parseInt(raw), name: 'ID:' + raw, fromReply: false };
  if (raw.startsWith('@')) {
    // ✅ Telegram API ما يدعمش تحويل @username لـ ID مباشرة عبر getChatMember
    // (لازم رقم ID). نبحث بدلها فـ قاعدة بياناتنا (الأعضاء اللي البوت شافهم مسبقاً)
    try {
      const { get } = require('../database/db');
      const uname = raw.replace('@', '');
      const row = await get(
        'SELECT user_id, first_name FROM group_members WHERE chat_id=$1 AND username ILIKE $2 LIMIT 1',
        [ctx.chat.id, uname]
      );
      if (row) return { id: row.user_id, name: row.first_name || raw, fromReply: false };
    } catch { /* ignore */ }
    return null;
  }
  return null;
}
// استخرج مدة الإسكات: /mute @user 10m أو 1h أو 1d
function parseDuration(arg) {
  if (!arg) return 10; // 10 دقائق افتراضي
  const m = arg.match(/^(\d+)(m|h|d)?$/i);
  if (!m) return 10;
  const n = parseInt(m[1]);
  const u = (m[2] || 'm').toLowerCase();
  if (u === 'h') return n * 60;
  if (u === 'd') return n * 1440;
  return n;
}
// حذف أمر المشرف بعد ثانية
function delCmd(ctx) {
  setTimeout(() => ctx.deleteMessage().catch(() => {}), 1000);
}

function setupGroupCommands(bot) {

  // ══════════════════════════════════════════
  // 🚫 /ban — حظر عضو
  // ══════════════════════════════════════════
  // ══ /ban ══
  bot.command('ban', async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return;
    delCmd(ctx);
    const target = await getTarget(ctx);
    if (!target) return _reply(ctx, '⚠️ رد على رسالة المستخدم', 5000);
    const reason = ctx.message.text.split(' ').slice(2).join(' ') || 'مخالفة القواعد';
    try {
      await ctx.telegram.banChatMember(ctx.chat.id, target.id);
      await run(`INSERT INTO group_bans(chat_id,user_id,banned_by,reason) VALUES($1,$2,$3,$4) ON CONFLICT(chat_id,user_id) DO UPDATE SET reason=$4,banned_by=$3`, [ctx.chat.id, target.id, ctx.from.id, reason]).catch(() => {});
      const m = await ctx.reply(`🚫 *${target.name}* محظور\n📝 ${reason}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔓 رفع الحظر', callback_data: 'grp_unban_' + target.id }]] }
      }).catch(() => null);
      if (m) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 20000);
    } catch(e) { _reply(ctx, '❌ ' + e.message, 5000); }
  });

  // ══ /unban ══
  bot.command('unban', async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return;
    delCmd(ctx);
    const target = await getTarget(ctx);
    if (!target) return _reply(ctx, '⚠️ `/unban @username`', 5000);
    try {
      await ctx.telegram.unbanChatMember(ctx.chat.id, target.id);
      await run('DELETE FROM group_bans WHERE chat_id=$1 AND user_id=$2', [ctx.chat.id, target.id]).catch(() => {});
      _reply(ctx, `✅ رُفع الحظر عن *${target.name}*`, 8000);
    } catch(e) { _reply(ctx, '❌ ' + e.message, 5000); }
  });

  // ══ /kick ══
  bot.command('kick', async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return;
    delCmd(ctx);
    const target = await getTarget(ctx);
    if (!target) return _reply(ctx, '⚠️ رد على رسالة المستخدم', 5000);
    try {
      await ctx.telegram.banChatMember(ctx.chat.id, target.id);
      await ctx.telegram.unbanChatMember(ctx.chat.id, target.id);
      _reply(ctx, `🦵 *${target.name}* طُرد من المجموعة`, 8000);
    } catch(e) { _reply(ctx, '❌ ' + e.message, 5000); }
  });

  // ══ /mute ══
  bot.command('mute', async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return;
    delCmd(ctx);
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length || args[0] === 'all') return muteAll(ctx, ctx.chat.id);
    const target = await getTarget(ctx);
    if (!target) return _reply(ctx, '⚠️ `/mute @user 10m` — m=دقائق h=ساعات d=أيام', 8000);
    const lastArg = args[args.length - 1];
    const minutes = parseDuration(/^\d/.test(lastArg) ? lastArg : null);
    const durText = minutes < 60 ? minutes + 'د' : minutes < 1440 ? (minutes/60) + 'س' : (minutes/1440) + 'ي';
    try {
      await muteMember(ctx, ctx.chat.id, target.id, minutes);
      const m = await ctx.reply(`🔇 *${target.name}* — كُتم ${durText}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔊 رفع الكتم', callback_data: 'grp_unmute_' + target.id }]] }
      }).catch(() => null);
      if (m) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 20000);
    } catch(e) { _reply(ctx, '❌ ' + e.message, 5000); }
  });

  // ══ /unmute ══
  bot.command('unmute', async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return;
    delCmd(ctx);
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length || args[0] === 'all') return unmuteAll(ctx, ctx.chat.id);
    const target = await getTarget(ctx);
    if (!target) return _reply(ctx, '⚠️ `/unmute @user`', 5000);
    try {
      await unmuteMember(ctx, ctx.chat.id, target.id);
      _reply(ctx, `🔊 رُفع الكتم عن *${target.name}*`, 8000);
    } catch(e) { _reply(ctx, '❌ ' + e.message, 5000); }
  });


  // ══════════════════════════════════════════
  // ⚠️ /warn — تحذير عضو
  // ══════════════════════════════════════════

  // ══════════════════════════════════════════
  // 👤 /info — معلومات مستخدم
  // ══════════════════════════════════════════


    bot.command('warn', async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return ctx.reply('🚫 للمشرفين فقط').catch(() => {});
    delCmd(ctx);
    const target = await getTarget(ctx);
    if (!target) return ctx.reply('⚠️ رد على رسالة المستخدم أو اكتب /warn @username [سبب]', { reply_to_message_id: ctx.message?.message_id }).catch(() => {});
    const args = ctx.message.text.split(' ').slice(target.fromReply ? 1 : 2);
    const reason = args.join(' ').trim() || 'مخالفة القواعد';

    // إضافة التحذير
    await run(
      'INSERT INTO group_warns(chat_id,user_id,reason,warned_by) VALUES($1,$2,$3,$4)',
      [ctx.chat.id, target.id, reason, ctx.from?.id]
    ).catch(()=>{});

    const warns = await all(
      'SELECT id FROM group_warns WHERE chat_id=$1 AND user_id=$2',
      [ctx.chat.id, target.id]
    ).catch(()=>[]);
    const count = warns.length;
    const MAX = 3;

    const warnText =
      '⚠️ *تحذير!*\n━━━━━━━━━━━━━━━\n\n' +
      '👤 المستخدم: [' + target.name + '](tg://user?id=' + target.id + ')\n' +
      '📝 السبب: ' + reason + '\n' +
      '🔢 التحذيرات: *' + count + '/' + MAX + '*\n\n' +
      (count >= MAX ? '🚫 *تم الحظر تلقائياً بعد ' + MAX + ' تحذيرات!*' : '_تحذير ' + count + ' من ' + MAX + '_');

    const rows = [[
      { text: '＋ تحذير',      callback_data: 'grp_warn1_'     + target.id },
      { text: '－ تحذير',      callback_data: 'grp_unwarn1_'   + target.id },
      { text: '🗑 مسح الكل',   callback_data: 'grp_clearwarn_' + target.id },
    ],[
      { text: '🚫 حظر',        callback_data: 'grp_ban_'        + target.id },
      { text: '🔇 كتم',        callback_data: 'grp_mute_1h_'    + target.id },
    ]];

    await ctx.reply(warnText, {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message?.reply_to_message?.message_id || ctx.message?.message_id,
      reply_markup: { inline_keyboard: rows }
    }).catch(() => {});

    // حظر تلقائي بعد MAX تحذيرات
    if (count >= MAX) {
      await ctx.telegram.banChatMember(ctx.chat.id, target.id).catch(() => {});
      await run('DELETE FROM group_warns WHERE chat_id=$1 AND user_id=$2', [ctx.chat.id, target.id]).catch(() => {});
    }
  });

  // ══════════════════════════════════════════
  // 🗑 /unwarn — إزالة تحذيرات
  // ══════════════════════════════════════════
  bot.command('unwarn', async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return ctx.reply('🚫 للمشرفين فقط').catch(() => {});
    delCmd(ctx);
    const target = await getTarget(ctx);
    if (!target) return ctx.reply('⚠️ رد على رسالة المستخدم').catch(() => {});
    await run('DELETE FROM group_warns WHERE chat_id=$1 AND user_id=$2', [ctx.chat.id, target.id]).catch(() => {});
    const msg = await ctx.reply(`✅ *مُسحت تحذيرات ${target.name}*`, { parse_mode: 'Markdown' }).catch(() => {});
    if (msg) setTimeout(() => ctx.deleteMessage(msg.message_id).catch(() => {}), 8000);
  });

  // ══════════════════════════════════════════
  // 📋 /warns — عرض تحذيرات عضو
  // ══════════════════════════════════════════
  bot.command('warns', async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return ctx.reply('🚫 للمشرفين فقط').catch(() => {});
    delCmd(ctx);
    const target = await getTarget(ctx);
    if (!target) return ctx.reply('⚠️ رد على رسالة المستخدم').catch(() => {});
    const warns = await all(
      'SELECT reason, warned_by, created_at FROM group_warns WHERE chat_id=$1 AND user_id=$2 ORDER BY created_at DESC',
      [ctx.chat.id, target.id]
    ).catch(() => []);
    let text = '📋 *سجل تحذيرات* [' + target.name + '](tg://user?id=' + target.id + ')\n';
    text += '━━━━━━━━━━━━━━━\n\n';
    text += '🔢 المجموع: *' + warns.length + '/3*\n\n';
    if (warns.length) {
      warns.forEach((w, i) => {
        const date = new Date(w.created_at).toLocaleDateString('ar');
        text += (i+1) + '. ' + (w.reason||'مخالفة') + ' — _' + date + '_\n';
      });
    } else {
      text += '✅ _لا توجد تحذيرات_';
    }
    const rows = warns.length ? [[
      { text: '🗑 مسح الكل', callback_data: 'grp_clearwarn_' + target.id },
    ]] : [];
    return ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: rows.length ? { inline_keyboard: rows } : undefined
    }).catch(() => {});
  });

  // ══════════════════════════════════════════
  // 📌 /pin — تثبيت رسالة
  // ══════════════════════════════════════════
  bot.command('pin', async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return ctx.reply('🚫 للمشرفين فقط').catch(() => {});
    delCmd(ctx);
    const replyMsg = ctx.message.reply_to_message;
    if (!replyMsg) return ctx.reply('⚠️ رد على الرسالة اللي تبغي تثبتها').catch(() => {});
    try {
      await ctx.telegram.pinChatMessage(ctx.chat.id, replyMsg.message_id, { disable_notification: false });
    } catch(e) { ctx.reply('❌ فشل التثبيت: ' + e.message).catch(() => {}); }
  });

  // ══════════════════════════════════════════
  // 📌 /unpin — إلغاء تثبيت
  // ══════════════════════════════════════════
  bot.command('unpin', async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return ctx.reply('🚫 للمشرفين فقط').catch(() => {});
    delCmd(ctx);
    try {
      await ctx.telegram.unpinAllChatMessages(ctx.chat.id);
      const msg = await ctx.reply('✅ تم إلغاء تثبيت كل الرسائل').catch(() => {});
      if (msg) setTimeout(() => ctx.deleteMessage(msg.message_id).catch(() => {}), 5000);
    } catch(e) { ctx.reply('❌ ' + e.message).catch(() => {}); }
  });

  // ══════════════════════════════════════════
  // 👥 /all — منشن الكل
  // ══════════════════════════════════════════
  bot.command('all', async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return ctx.reply('🚫 للمشرفين فقط').catch(() => {});
    const args = ctx.message.text.split(' ').slice(1).join(' ');
    delCmd(ctx);
    try { await tagAll(ctx, ctx.chat.id, args || null); }
    catch(e) { ctx.reply('❌ ' + e.message).catch(() => {}); }
  });

  bot.command('tag', async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return ctx.reply('🚫 للمشرفين فقط').catch(() => {});
    const args = ctx.message.text.split(' ').slice(1).join(' ');
    delCmd(ctx);
    try { await tagAll(ctx, ctx.chat.id, args || null); }
    catch(e) { ctx.reply('❌ ' + e.message).catch(() => {}); }
  });

  // ══════════════════════════════════════════
  // ⚙️ /settings — لوحة إعدادات القروب
  // ══════════════════════════════════════════

  bot.command('stats', async ctx => {
    if (!isGroup(ctx)) return;
    const { showGroupStats } = require('./group_admin');
    return showGroupStats(ctx, ctx.chat.id);
  });

  // ══════════════════════════════════════════
  // 📜 /rules — قواعد القروب
  // ══════════════════════════════════════════
  bot.command(['rules', 'قواعد'], async ctx => {
    if (!isGroup(ctx)) return;
    // احذف أمر /rules
    ctx.deleteMessage().catch(() => {});
    const { showGroupRules } = require('./group_admin');
    return showGroupRules(ctx, ctx.chat.id);
  });

  // ══════════════════════════════════════════
  // ℹ️ /adminhelp — مساعدة المشرفين
  // ══════════════════════════════════════════
  bot.command('adminhelp', async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return;
    delCmd(ctx);
    const text =
      '🛡 *أوامر الإدارة*\n' +
      '━━━━━━━━━━━━━━━\n\n' +
      '🚫 *الحظر والطرد:*\n' +
      '`/ban` — حظر عضو (رد أو @user)\n' +
      '`/unban` — رفع الحظر\n' +
      '`/kick` — طرد بدون حظر\n\n' +
      '🔇 *الإسكات:*\n' +
      '`/mute` — إسكات عضو (رد أو @user)\n' +
      '`/mute all` — إسكات الكل\n' +
      '`/unmute` — رفع الإسكات\n' +
      '`/unmute all` — رفع إسكات الكل\n\n' +
      '⚠️ *التحذيرات:*\n' +
      '`/warn` — تحذير (3 تحذيرات = حظر)\n' +
      '`/unwarn` — مسح التحذيرات\n' +
      '`/warns` — عرض التحذيرات\n\n' +
      '📌 *التثبيت:*\n' +
      '`/pin` — تثبيت رسالة (رد)\n' +
      '`/unpin` — إلغاء كل التثبيتات\n\n' +
      '👥 *المنشن:*\n' +
      '`/all [رسالة]` — منشن الكل\n\n' +
      '⚙️ *الإعدادات:*\n' +
      '`/settings` — لوحة الإعدادات\n' +
      '`/stats` — إحصائيات\n' +
      '`/rules` — القواعد';
    const msg = await ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => {});
    if (msg) setTimeout(() => ctx.deleteMessage(msg.message_id).catch(() => {}), 30000);
  });

  // ══════════════════════════════════════════
  // 🎮 كومند الألعاب
  // ══════════════════════════════════════════
  bot.command(["العاب", "games", "العبوا", "الالعاب"], async ctx => {
    if (!isGroup(ctx)) return;
    delCmd(ctx);
    return showGamesMenu(ctx);
  });


  // ══════════════════════════════════════════
  // 🎮 Million Battle
  // ══════════════════════════════════════════
  bot.command('million', async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return ctx.reply('🚫 للمشرفين فقط').catch(() => {});
    return million.showQuestionsPanel(ctx);
  });
  bot.command('stopmillion', async ctx => {
    if (!isGroup(ctx)) return;
    return million.stopGame(ctx);
  });

  // ══════════════════════════════════════════
  // Callbacks من القروب (ban/unban/mute من الأزرار)
  // ══════════════════════════════════════════

  // ══════════════════════════════════════════
  // 💰 أوامر البنك في القروب
  // ══════════════════════════════════════════
  bot.command(['daily','يومي'], async ctx => { if(!isGroup(ctx)) return; const {handleDaily}=require('./bank_games'); return handleDaily(ctx).catch(()=>{}); });
  bot.command(['flip','عملة'], async ctx => { if(!isGroup(ctx)) return; const {handleFlip}=require('./bank_games'); return handleFlip(ctx).catch(()=>{}); });
  bot.command(['rob','سرقة'], async ctx => { if(!isGroup(ctx)) return; const {handleRob}=require('./bank_games'); return handleRob(ctx).catch(()=>{}); });
  bot.command(['leaderboard','متصدرين','lb'], async ctx => { if(!isGroup(ctx)) return; const {handleLeaderboard}=require('./bank_games'); return handleLeaderboard(ctx).catch(()=>{}); });

    bot.action(/^grp_clearwarn_(\d+)$/, async ctx => {
    if (!await isTgAdmin(ctx)) return ctx.answerCbQuery('🚫').catch(() => {});
    const userId = parseInt(ctx.match[1]);
    await run('DELETE FROM group_warns WHERE chat_id=$1 AND user_id=$2', [ctx.chat.id, userId]).catch(() => {});
    ctx.answerCbQuery('✅ تم مسح كل التحذيرات').catch(() => {});
    ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  });

  bot.action(/^grp_unban_(\d+)$/, async ctx => {
    if (!await isTgAdmin(ctx)) return ctx.answerCbQuery('🚫').catch(() => {});
    const userId = parseInt(ctx.match[1]);
    try {
      await ctx.telegram.unbanChatMember(ctx.chat.id, userId);
      await run('DELETE FROM group_bans WHERE chat_id=$1 AND user_id=$2', [ctx.chat.id, userId]).catch(() => {});
      ctx.answerCbQuery('✅ رُفع الحظر').catch(() => {});
      ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    } catch(e) { ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
  });

  bot.action(/^grp_unmute_(\d+)$/, async ctx => {
    if (!await isTgAdmin(ctx)) return ctx.answerCbQuery('🚫').catch(() => {});
    const userId = parseInt(ctx.match[1]);
    try {
      await unmuteMember(ctx, ctx.chat.id, userId);
      ctx.answerCbQuery('✅ رُفع الإسكات').catch(() => {});
      ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    } catch(e) { ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
  });

  // ══ /promote ══
  bot.command("promote", async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return ctx.reply("🚫 للمشرفين فقط").catch(() => {});
    delCmd(ctx);
    const target = await getTarget(ctx);
    if (!target) return ctx.reply("⚠️ رد على رسالة العضو").catch(() => {});
    try {
      await ctx.telegram.promoteChatMember(ctx.chat.id, target.id, {
        can_delete_messages: true, can_restrict_members: true,
        can_pin_messages: true, can_manage_chat: true, can_invite_users: true,
      });
      const m = await ctx.reply("👑 *تم ترقية " + target.name + " لمشرف*", { parse_mode: "Markdown" }).catch(() => null);
      if (m) setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), 8000);
    } catch(e) { ctx.reply("❌ فشل: " + e.message).catch(() => {}); }
  });

  // ══ /demote ══
  bot.command("demote", async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return ctx.reply("🚫 للمشرفين فقط").catch(() => {});
    delCmd(ctx);
    const target = await getTarget(ctx);
    if (!target) return ctx.reply("⚠️ رد على رسالة المشرف").catch(() => {});
    try {
      await ctx.telegram.promoteChatMember(ctx.chat.id, target.id, {
        can_delete_messages: false, can_restrict_members: false,
        can_pin_messages: false, can_manage_chat: false,
      });
      const m = await ctx.reply("🔽 *تم سحب صلاحيات " + target.name + "*", { parse_mode: "Markdown" }).catch(() => null);
      if (m) setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), 8000);
    } catch(e) { ctx.reply("❌ فشل: " + e.message).catch(() => {}); }
  });

  // ══ /info ══
  bot.command('info', async ctx => {
    if (!isGroup(ctx)) return;
    delCmd(ctx);
    const _isGrpAdmin = ctx.isAdmin || ctx.isOwner || await isTgAdmin(ctx);
    if (!_isGrpAdmin) return;
    const target = ctx.message.reply_to_message?.from;
    if (!target) {
      return ctx.reply('↩️ رد على رسالة العضو لعرض معلوماته', {
        reply_to_message_id: ctx.message.message_id
      }).catch(() => {});
    }
    if (target.is_bot) return ctx.reply('🤖 هذا بوت').catch(() => {});
    const { sendInfoPanel } = require('../handlers/group_info_panel');
    await sendInfoPanel(ctx, target, ctx.chat.id, ctx.from.id);
  });

  // ── /cmds و اوامر انتقلوا لـ handlers/group_pro_features.js (مصدر واحد موحّد) ──


  // ══════════════════════════════════════════
  // 🗑 /purge — حذف رسائل بالجملة
  // ══════════════════════════════════════════
  const purgeHandler = async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return ctx.reply("🚫 للمشرفين فقط").catch(() => {});
    delCmd(ctx);
    const replyTo = ctx.message.reply_to_message;
    let fromId, toId;
    if (replyTo) {
      fromId = replyTo.message_id;
      toId   = ctx.message.message_id - 1;
    } else {
      const n = parseInt((ctx.message.text || '').split(/\s+/)[1]);
      if (!n || n < 1) return ctx.reply("↩️ رد على أول رسالة تريد حذفها، أو اكتب: مسح 50").catch(() => {});
      toId   = ctx.message.message_id - 1;
      fromId = Math.max(1, toId - Math.min(n, 1000) + 1);
    }
    if (toId < fromId) return ctx.reply("⚠️ ما في رسائل للحذف").catch(() => {});
    const total = toId - fromId + 1;
    if (total > 1000) return ctx.reply("⚠️ الحد الأقصى 1000 رسالة").catch(() => {});

    const ids = [];
    for (let i = fromId; i <= toId; i++) ids.push(i);

    let deleted = 0;
    const BATCH = 100; // حد تيليجرام لـ deleteMessages
    for (let b = 0; b < ids.length; b += BATCH) {
      const chunk = ids.slice(b, b + BATCH);
      try {
        await ctx.telegram.deleteMessages(ctx.chat.id, chunk);
        deleted += chunk.length;
      } catch(_) {
        // fallback واحدة واحدة لو الـ batch فشل (رسائل قديمة جداً مثلاً)
        for (const id of chunk) {
          try { await ctx.telegram.deleteMessage(ctx.chat.id, id); deleted++; } catch(_) {}
        }
      }
      if (b + BATCH < ids.length) await new Promise(r => setTimeout(r, 150));
    }

    const done = await ctx.reply("✅ تم حذف " + deleted + " رسالة").catch(() => null);
    if (done) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, done.message_id).catch(() => {}), 4000);
  };
  bot.command(['purge', 'مسح'], purgeHandler);
  bot.hears(/^مسح(?:\s+\d+)?$/, purgeHandler);

  // ══════════════════════════════════════════
  // 🗑 /del — حذف رسالة واحدة (رد عليها)
  // ══════════════════════════════════════════
  bot.command(["del", "حذف"], async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return ctx.reply("🚫 للمشرفين فقط").catch(() => {});
    const replyTo = ctx.message.reply_to_message;
    delCmd(ctx);
    if (!replyTo) return;
    ctx.telegram.deleteMessage(ctx.chat.id, replyTo.message_id).catch(() => {});
  });


  // ══════════════════════════════════════════
  // 🎭 /truth و /dare — صح أو جرأة
  // ══════════════════════════════════════════
  const _truths = [
    "ما هو أكبر كذبة قلتها في حياتك؟",
    "من هو الشخص الذي تحبه سراً في هذا القروب؟",
    "ما هو أحرج موقف مررت به؟",
    "ما هو الشيء الذي تخجل من الاعتراف به؟",
    "هل سبق أن تجسست على شخص ما؟",
    "ما هو أغبى شيء فعلته في حياتك؟",
    "من هو الشخص الذي تتمنى لو لم تقابله؟",
    "ما هو سرك الذي لم تخبر به أحداً؟",
    "هل سبق أن كذبت على أحد قريب منك؟ وماذا قلت؟",
    "ما هو الشيء الذي تفعله سراً ولا تريد أحداً أن يعرف؟",
    "من هو أكثر شخص تغار منه؟",
    "ما هو أسوأ قرار اتخذته في حياتك؟",
    "هل سبق أن بكيت بسبب فيلم أو مسلسل؟ أي واحد؟",
    "ما هو الشيء الذي تتمنى تغييره في نفسك؟",
    "من هو الشخص الذي تعتذر منه لو قدرت؟",
  ];

  const _dares = [
    "أرسل آخر صورة في هاتفك! 📸",
    "اكتب رسالة محرجة لآخر شخص تحدثت معه!",
    "غير اسمك في القروب لشيء مضحك لمدة ساعة!",
    "أرسل صوت تقلد فيه شخصاً مشهوراً! 🎤",
    "اكتب 10 أشياء تحبها في نفسك!",
    "أرسل أغرب إيموجي تعرفه وفسره!",
    "اكتب قصيدة قصيرة عن شخص في القروب!",
    "قلد أسلوب كتابة شخص في القروب لرسالة كاملة!",
    "اعترف بشيء محرج حدث معك هذا الأسبوع!",
    "أرسل ميم يعبر عن مزاجك الآن!",
    "اكتب رسالة بالكامل بدون حروف العلة!",
    "غني مقطع من أغنية تحبها (نص الكلمات)!",
    "أرسل أول شيء تجده في بحث Google الآن!",
    "اكتب رأيك الحقيقي في آخر شخص تكلم في القروب!",
    "تحدى شخصاً آخر في القروب على شيء!",
  ];

  bot.command(["truth", "صح", "حقيقة"], async ctx => {
    if (!isGroup(ctx)) return;
    const target = ctx.message.reply_to_message?.from || ctx.from;
    const name = target.first_name || "أنت";
    const q = _truths[Math.floor(Math.random() * _truths.length)];
    const kb = [[
      { text: "🎭 جرأة بدل", callback_data: "tnd_dare_" + target.id },
      { text: "🔄 سؤال آخر",  callback_data: "tnd_truth_" + target.id },
    ]];
    ctx.reply(
      "🤔 *سؤال صح لـ " + name + ":*\n\n" + q,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: kb } }
    ).catch(() => {});
  });

  bot.command(["dare", "جرأة"], async ctx => {
    if (!isGroup(ctx)) return;
    const target = ctx.message.reply_to_message?.from || ctx.from;
    const name = target.first_name || "أنت";
    const d = _dares[Math.floor(Math.random() * _dares.length)];
    const kb = [[
      { text: "🤔 صح بدل",   callback_data: "tnd_truth_" + target.id },
      { text: "🔄 تحدي آخر", callback_data: "tnd_dare_"  + target.id },
    ]];
    ctx.reply(
      "😈 *تحدي جرأة لـ " + name + ":*\n\n" + d,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: kb } }
    ).catch(() => {});
  });


  // ══════════════════════════════════════════
  // 🎰 /slot — ماكينة القمار
  // ══════════════════════════════════════════
  bot.command(["slot", "سلوت", "قمار"], async ctx => {
    if (!isGroup(ctx)) return;
    delCmd(ctx);
    const { get: dbGet, run: dbRun } = require("../database/db");
    const uid = ctx.from.id;
    const name = ctx.from.first_name || "لاعب";
    const BET = 50;

    const acc = await dbGet("SELECT balance FROM pro_bank_accounts WHERE user_id=$1", [uid]).catch(() => null);
    if (!acc) return ctx.reply("❌ ليس لديك حساب بنكي! اكتب *انشاء حساب*", { parse_mode: "Markdown" }).catch(() => {});
    if (parseFloat(acc.balance) < BET) return ctx.reply("❌ رصيدك غير كافٍ! تحتاج *" + BET + " DA* للعب.", { parse_mode: "Markdown" }).catch(() => {});

    // خصم الرهان
    await dbRun("UPDATE pro_bank_accounts SET balance=balance-$1 WHERE user_id=$2", [BET, uid]).catch(() => {});
    await dbRun("INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES($1,0,$2,0,'slot_bet','رهان سلوت')", [uid, BET]).catch(() => {});

    const symbols = ["🍎", "🍊", "🍋", "🍒", "🍇", "⭐", "💎", "7️⃣"];
    const r1 = symbols[Math.floor(Math.random() * symbols.length)];
    const r2 = symbols[Math.floor(Math.random() * symbols.length)];
    const r3 = symbols[Math.floor(Math.random() * symbols.length)];

    const spinning = await ctx.reply("🎰 *جاري الدوران...*\n\n[ 🔄 | 🔄 | 🔄 ]", { parse_mode: "Markdown" }).catch(() => null);

    let win = 0;
    let resultTxt = "";
    if (r1 === r2 && r2 === r3) {
      if (r1 === "💎") { win = BET * 10; resultTxt = "💎 *جاكبوت!! ×10*"; }
      else if (r1 === "7️⃣") { win = BET * 7; resultTxt = "7️⃣ *سبعة ×7*"; }
      else if (r1 === "⭐") { win = BET * 5; resultTxt = "⭐ *نجوم ×5*"; }
      else { win = BET * 3; resultTxt = "🎉 *ثلاثة متشابهة ×3*"; }
    } else if (r1 === r2 || r2 === r3 || r1 === r3) {
      win = Math.floor(BET * 1.5);
      resultTxt = "✅ *اثنان متشابهان ×1.5*";
    } else {
      resultTxt = "❌ *خسرت!*";
    }

    if (win > 0) {
      await dbRun("UPDATE pro_bank_accounts SET balance=balance+$1 WHERE user_id=$2", [win, uid]).catch(() => {});
      await dbRun("INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES(0,$1,$2,0,'slot_win','ربح سلوت')", [uid, win]).catch(() => {});
    }

    const newBal = await dbGet("SELECT balance FROM pro_bank_accounts WHERE user_id=$1", [uid]).then(r => r?.balance || 0).catch(() => 0);

    setTimeout(async () => {
      if (spinning) {
        await ctx.telegram.editMessageText(ctx.chat.id, spinning.message_id, null,
          "🎰 *ماكينة القمار*\n\n" +
          "[ " + r1 + " | " + r2 + " | " + r3 + " ]\n\n" +
          resultTxt + "\n" +
          (win > 0 ? "💰 ربحت: *" + win + " DA*" : "💸 خسرت: *" + BET + " DA*") + "\n" +
          "👛 رصيدك: *" + parseFloat(newBal).toFixed(0) + " DA*",
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[
            { text: "🎰 العب مجدداً", callback_data: "slot_play_" + uid },
            { text: "💰 رصيدي", callback_data: "slot_bal_" + uid },
          ]]}}
        ).catch(() => {});
      }
    }, 2000);
  });

  // ══════════════════════════════════════════
  // 🏪 /market — متجر البوت
  // ══════════════════════════════════════════
  bot.command(["market", "متجر", "shop"], async ctx => {
    if (!isGroup(ctx)) return;
    delCmd(ctx);
    const { get: dbGet } = require("../database/db");
    const uid = ctx.from.id;
    const acc = await dbGet("SELECT balance FROM pro_bank_accounts WHERE user_id=$1", [uid]).catch(() => null);
    const bal = acc ? parseFloat(acc.balance).toFixed(0) : 0;

    const items = [
      { id: 1, name: "🛡️ درع الحماية",    desc: "حمايتك من السبام يوم كامل", price: 500,   emoji: "🛡️" },
      { id: 2, name: "⭐ نجمة VIP",        desc: "لقب VIP في القروب أسبوع",   price: 1000,  emoji: "⭐" },
      { id: 3, name: "🎯 تذكرة مليون",     desc: "دخول مجاني للعبة المليون",  price: 300,   emoji: "🎯" },
      { id: 4, name: "🎰 رمز سلوت ×2",     desc: "ضاعف أرباح السلوت مرة",     price: 200,   emoji: "🎰" },
      { id: 5, name: "📦 صندوق مفاجأة",    desc: "ربح عشوائي 100-2000 DA",   price: 150,   emoji: "📦" },
    ];

    let txt = "🏪 *متجر البوت*\n";
    txt += "━━━━━━━━━━━━━━━━━━\n";
    txt += "👛 رصيدك: *" + bal + " دج*\n\n";
    for (const item of items) {
      txt += item.emoji + " *" + item.name + "* — " + item.price + " دج\n";
      txt += "   _" + item.desc + "_\n\n";
    }

    const kb = items.map(item => [{ text: item.emoji + " " + item.name + " (" + item.price + " دج)", callback_data: "shop_buy_" + item.id + "_" + uid }]);
    kb.push([{ text: "❌ إغلاق", callback_data: "shop_close" }]);

    ctx.reply(txt, { parse_mode: "Markdown", reply_markup: { inline_keyboard: kb } }).catch(() => {});
  });




  // ══════════════════════════════════════════
  // 📋 /setlog — تعيين قناة السجل
  // ══════════════════════════════════════════
  bot.command(["setlog", "سجل"], async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return ctx.reply("🚫 للمشرفين فقط").catch(() => {});
    delCmd(ctx);
    const args = ctx.message.text.split(" ").slice(1);
    if (!args.length) {
      const { get: dbGet } = require("../database/db");
      const g = await dbGet("SELECT log_channel FROM group_chats WHERE chat_id=$1", [ctx.chat.id]).catch(() => null);
      return ctx.reply(
        "📋 *قناة السجل*\n\n" +
        "الحالية: " + (g?.log_channel ? "*" + g.log_channel + "*" : "_غير محددة_") + "\n\n" +
        "لتعيين قناة:\n`/setlog @username_channel`\n\nلإلغاء:\n`/setlog off`",
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
    const { run: dbRun } = require("../database/db");
    if (args[0] === "off") {
      await dbRun("UPDATE group_chats SET log_channel=NULL WHERE chat_id=$1", [ctx.chat.id]).catch(() => {});
      return ctx.reply("✅ تم إلغاء قناة السجل").catch(() => {});
    }
    const channel = args[0];
    try {
      await ctx.telegram.sendMessage(channel, "✅ *تم ربط هذه القناة كسجل لـ " + (ctx.chat.title||"القروب") + "*", { parse_mode: "Markdown" });
      await dbRun("UPDATE group_chats SET log_channel=$1 WHERE chat_id=$2", [channel, ctx.chat.id]).catch(() => {});
      ctx.reply("✅ تم تعيين " + channel + " كقناة سجل!", { parse_mode: "Markdown" }).catch(() => {});
    } catch(e) {
      ctx.reply("❌ فشل — تأكد أن البوت ادمين في القناة\n" + e.message).catch(() => {});
    }
  });




  // 💑 Couple of the Day
  bot.command(['couple','زوج'], async ctx => {
    if (!isGroup(ctx)) return;
    const cid = ctx.chat?.id;
    const today = new Date().toISOString().split('T')[0];
    const ck = 'couple_' + cid + '_' + today;
    let saved = require('../utils/cache').cacheGet ? null : null;
    const existing = await require('../database/db').get(
      'SELECT * FROM couple_of_day WHERE chat_id=$1 AND date=$2', [cid, today]
    ).catch(()=>null);
    if (existing) {
      const hearts = ['💕','💖','💗','💝','💓'];
      const h = hearts[Math.floor(Math.random()*hearts.length)];
      return ctx.reply(
        h + ' *زوج اليوم*\n━━━━━━━━━━━━━━━\n\n' +
        '[' + existing.name1 + '](tg://user?id=' + existing.user1_id + ') ' + h + ' [' + existing.name2 + '](tg://user?id=' + existing.user2_id + ')\n\n_يتجدد غداً!_ 🌅',
        { parse_mode:'Markdown', reply_to_message_id: ctx.message?.message_id }
      ).catch(()=>{});
    }
    const members = await require('../database/db').all(
      'SELECT user_id, first_name FROM group_members WHERE chat_id=$1 AND (is_bot=0 OR is_bot IS NULL) ORDER BY RANDOM() LIMIT 20', [cid]
    ).catch(()=>[]);
    if (!members || members.length < 2) return ctx.reply('❌ ما في أعضاء كافيين!', { reply_to_message_id: ctx.message?.message_id }).catch(()=>{});
    const u1 = members[0], u2 = members[1];
    await require('../database/db').run(
      'INSERT INTO couple_of_day(chat_id,date,user1_id,user2_id,name1,name2) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
      [cid, today, u1.user_id, u2.user_id, u1.first_name||'؟', u2.first_name||'؟']
    ).catch(()=>{});
    const hearts = ['💕','💖','💗','💝','💓'];
    const h = hearts[Math.floor(Math.random()*hearts.length)];
    return ctx.reply(
      h + ' *زوج اليوم*\n━━━━━━━━━━━━━━━\n\n' +
      '[' + (u1.first_name||'؟') + '](tg://user?id=' + u1.user_id + ') ' + h + ' [' + (u2.first_name||'؟') + '](tg://user?id=' + u2.user_id + ')\n\n_يتجدد غداً!_ 🌅',
      { parse_mode:'Markdown', reply_to_message_id: ctx.message?.message_id }
    ).catch(()=>{});
  });



  // ══════════════════════════════════════════
  // 🔍 + اسم الملف — بحث سريع في القروب
  // ══════════════════════════════════════════
  // ══════════════════════════════════════════
  // 💳 البطاقة الشخصية — ضف ردك
  // ══════════════════════════════════════════
  bot.hears(/^امحي ردي$/i, async ctx => {
    if (!isGroup(ctx)) return;
    run("DELETE FROM member_cards WHERE chat_id=$1 AND user_id=$2", [ctx.chat.id, ctx.from.id]).catch(() => {});
    run("DELETE FROM member_card_triggers WHERE chat_id=$1 AND user_id=$2", [ctx.chat.id, ctx.from.id]).catch(() => {});
    ctx.reply("🗑 تم حذف بطاقتك", { reply_to_message_id: ctx.message.message_id }).catch(() => {});
  });

  bot.command('check_cards', async ctx => {
    if (!ctx.isOwner) return;
    const { all: _all } = require('../database/db');
    const rows = await _all('SELECT chat_id, user_id, trigger_word, first_name FROM member_card_triggers LIMIT 20').catch(() => []);
    const text = rows.length ? rows.map(r => `chat:${r.chat_id} | user:${r.user_id} | word:${r.trigger_word} | name:${r.first_name}`).join('\n') : 'لا يوجد';
    ctx.reply('📋 البطاقات:\n' + text).catch(() => {});
  });

  // وقف/فعل الردود التلقائية في القروب
  bot.hears(/^(وقف رد|فعل رد)$/i, async ctx => {
    if (!isGroup(ctx)) return;
    if (!await isTgAdmin(ctx)) return;
    const { run: _r } = require('../database/db');
    const { cacheGet, cacheSet, cacheClear } = require('../utils/cache');
    const chatId = ctx.chat.id;
    const isStop = /وقف/.test(ctx.message.text);
    const key = 'auto_reply_disabled_' + chatId;
    if (isStop) {
      cacheSet(key, 1, 86400000);
      await _r('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',
        ['auto_reply_disabled_' + chatId, '1']).catch(() => {});
      return ctx.reply('🔇 *تم إيقاف الردود التلقائية في هذا القروب*', { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }).catch(() => {});
    } else {
      cacheClear(key);
      await _r('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',
        ['auto_reply_disabled_' + chatId, '0']).catch(() => {});
      return ctx.reply('🔔 *تم تفعيل الردود التلقائية في هذا القروب*', { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }).catch(() => {});
    }
  });

  bot.hears(/^ضف رد$/i, async ctx => {
    if (!isGroup(ctx)) return;
    await require('../utils/stateManager').setState(ctx.from.id, {
      type: 'member_card_word', chatId: ctx.chat.id
    });
    ctx.reply(
      '💳 *إنشاء ردك الشخصي*\n━━━━━━━━━━━━\n\n' +
      '✏️ اكتب الكلمة هنا في القروب مباشرة:\n\n' +
      '_مثال: هبة، Hiba، papa_',
      { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
    ).catch(() => {});
  });

  // استقبال الكلمة مباشرة في القروب
  bot.on('message', async (ctx, next) => {
    if (!isGroup(ctx)) return next();
    const s = require('../utils/stateManager').getState(ctx.from?.id);
    if (s?.type !== 'member_card_word') return next();
    if (s.chatId !== ctx.chat.id) return next();
    const txt = ctx.message?.text?.trim();
    if (!txt || txt.length < 1 || txt.length > 25) {
      return ctx.reply('⚠️ الكلمة بين 1 و25 حرف').catch(() => {});
    }
    if (txt.startsWith('/') || txt.startsWith('@')) {
      return ctx.reply('⚠️ الكلمة لا تبدأ بـ / أو @').catch(() => {});
    }
    const uid = ctx.from.id;
    const firstName = ctx.from.first_name || 'عضو';
    const username = ctx.from.username || null;
    let photoFileId = null;
    try {
      const photos = await ctx.telegram.getUserProfilePhotos(uid, { limit: 1 });
      if (photos?.total_count > 0) {
        const arr = photos.photos[0];
        photoFileId = arr[arr.length - 1].file_id;
      }
    } catch(_) {}
    let bio = null;
    try {
      const userChat = await ctx.telegram.getChat(uid);
      bio = userChat.bio || null;
    } catch(_) {}
    const { run: _run } = require('../database/db');
    // احذف الكلمة القديمة أولاً — كل مستخدم رد واحد فقط
    await _run('DELETE FROM member_card_triggers WHERE chat_id=$1 AND user_id=$2', [ctx.chat.id, uid]).catch(() => {});
    await _run(
      `INSERT INTO member_cards(chat_id,user_id,trigger_word,photo_file_id,bio,username,first_name)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(chat_id,user_id) DO UPDATE SET
       trigger_word=$3,photo_file_id=$4,bio=$5,username=$6,first_name=$7,updated_at=NOW()`,
      [ctx.chat.id, uid, txt.toLowerCase(), photoFileId, bio, username, firstName]
    ).catch(() => {});
    await _run(
      `INSERT INTO member_card_triggers(chat_id,user_id,trigger_word) VALUES($1,$2,$3)
       ON CONFLICT(chat_id,trigger_word) DO UPDATE SET user_id=$2`,
      [ctx.chat.id, uid, txt.toLowerCase()]
    ).catch(() => {});
    await require('../utils/stateManager').delState(uid);
    const confirmText =
      '✅ *تم حفظ بطاقتك!*\n\n' +
      '🔑 الكلمة: *' + txt + '*\n' +
      (bio ? '📝 Bio: ' + bio + '\n' : '') +
      (photoFileId ? '📸 الصورة: محفوظة\n' : '') +
      '\nلما أحد يكتب *' + txt + '* ستظهر بطاقتك!';
    if (photoFileId) {
      return ctx.replyWithPhoto(photoFileId, { caption: confirmText, parse_mode: 'Markdown' }).catch(() => {});
    }
    return ctx.reply(confirmText, { parse_mode: 'Markdown' }).catch(() => {});
  });


  bot.hears(/^[+＋]\s*(.+)/, async ctx => {
    if (!isGroup(ctx)) return;
    const query = ctx.match[1]?.trim();
    if (!query || query.length < 2) return;
    const { smartSearch } = require('./group');
    // رسالة loading فورية
    const loadMsg = await ctx.reply('🔍 *جاري البحث...*', { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }).catch(() => null);
    const results = await smartSearch(query, 8).catch(() => []);
    if (loadMsg) ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
    if (!results.length) {
      const m = await ctx.reply('❌ ما وجدنا نتائج لـ *' + query + '*', { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }).catch(() => null);
      if (m) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 5000);
      return;
    }
    const kb = results.slice(0, 8).map(f => {
      const label = (f.specialty_name ? f.specialty_name + ' › ' : '') +
                    (f.sub_name ? f.sub_name + ' — ' : '') +
                    (f.title || f.name || 'ملف');
      return [{
        text: label.substring(0, 64),
        callback_data: 'gsf-' + f.id + '-' + ctx.from.id
      }];
    });
    kb.push([{ text: '❌ إلغاء', callback_data: 'grp_search_close' }]);
    ctx.reply(
      '🔍 *نتائج البحث عن:* ' + query + '\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      '📁 وجدنا *' + results.length + '* نتيجة — اضغط لإرسال الملف:',
      {
        parse_mode: 'Markdown',
        reply_to_message_id: ctx.message.message_id,
        reply_markup: { inline_keyboard: kb }
      }
    ).catch(() => {});
  });

}

// ══════════════════════════════════════════
// ⚙️ لوحة إعدادات القروب الشاملة
// ══════════════════════════════════════════
async function showGroupSettings(bot, ctx, chatId) {
  const [grp, protSettings] = await Promise.all([
    get(
      'SELECT welcome_enabled, goodbye_enabled, notify_new_files FROM group_chats WHERE chat_id=$1',
      [chatId]
    ).catch(() => null),
    require('./group_protection').getSettings(chatId).catch(() => null),
  ]);

  const on  = '✅';
  const off = '❌';
  const g = grp || {};

  let protLine = '';
  if (protSettings) {
    const antiKeys = Object.keys(protSettings).filter(k => k.startsWith('anti_'));
    const protCount = antiKeys.filter(k => protSettings[k]).length;
    protLine = '\n🛡 الحماية الاحترافية: *' + protCount + '/' + antiKeys.length + '* مفعّلة';
  }

  const text =
    '⚙️ *إعدادات القروب*\n' +
    '━━━━━━━━━━━━━━━\n\n' +
    '🎉 الترحيب: '        + (g.welcome_enabled  ? on : off) + '\n' +
    '👋 الوداع: '         + (g.goodbye_enabled  ? on : off) + '\n' +
    '🔔 إشعار ملفات: '   + (g.notify_new_files ? on : off) +
    protLine;

  const rows = [
    [{ text: (g.welcome_enabled  ? '🔴 إيقاف الترحيب'       : '🟢 تفعيل الترحيب'),       callback_data: 'gs_toggle_welcome_'    + chatId }],
    [{ text: (g.goodbye_enabled  ? '🔴 إيقاف الوداع'        : '🟢 تفعيل الوداع'),         callback_data: 'gs_toggle_goodbye_'    + chatId }],
    [{ text: (g.notify_new_files ? '🔕 إيقاف إشعار الملفات' : '🔔 تفعيل إشعار الملفات'), callback_data: 'gs_toggle_notify_'     + chatId }],
    [{ text: '🛡 لوحة الحماية الاحترافية', callback_data: 'gpx_home_' + chatId }],
    [{ text: '✏️ تعديل رسالة الترحيب', callback_data: 'gp_setwelcome_' + chatId }],
    [{ text: '📜 تعديل القواعد',        callback_data: 'gs_setrules_'   + chatId }],
  ];

  return ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows }
  }).catch(() => {});
}

// ── Callbacks إعدادات القروب ─────────────────────────────
async function handleSettingsCallback(ctx, data) {
  if (!data.startsWith('gs_')) return false;

  const toggleMap = {
    'gs_toggle_welcome_':   'welcome_enabled',
    'gs_toggle_goodbye_':   'goodbye_enabled',
    'gs_toggle_notify_':    'notify_new_files',
  };

  for (const [prefix, col] of Object.entries(toggleMap)) {
    if (data.startsWith(prefix)) {
      const chatId = data.replace(prefix, '');
      if (String(chatId) !== String(ctx.chat?.id)) {
        return ctx.answerCbQuery('🚫 غير مسموح', { show_alert: true }).catch(() => {});
      }
      if (!await isTgAdmin(ctx)) {
        return ctx.answerCbQuery('🚫 للأدمن فقط', { show_alert: true }).catch(() => {});
      }
      const current = await get('SELECT ' + col + ' FROM group_chats WHERE chat_id=$1', [chatId]).catch(() => null);
      const newVal = current?.[col] ? 0 : 1;
      await run('UPDATE group_chats SET ' + col + '=$1 WHERE chat_id=$2', [newVal, chatId]).catch(() => {});
      ctx.answerCbQuery(newVal ? '✅ تم التفعيل' : '❌ تم الإيقاف').catch(() => {});
      return showGroupSettings(bot, ctx, chatId);
    }
  }

  if (data.startsWith('gs_setrules_')) {
    const chatId = data.replace('gs_setrules_', '');
    if (String(chatId) !== String(ctx.chat?.id)) {
      return ctx.answerCbQuery('🚫 غير مسموح', { show_alert: true }).catch(() => {});
    }
    if (!await isTgAdmin(ctx)) {
      return ctx.answerCbQuery('🚫 للأدمن فقط', { show_alert: true }).catch(() => {});
    }
    await require('../utils/stateManager').setState(ctx.from.id, { type: 'grp_set_rules', chatId });
    return ctx.reply('📜 أرسل قواعد القروب:').catch(() => {});
  }

  return false;
}


// 🎛️ المحتوى المشترك للوحة الألعاب (نص + كيبورد فقط) — تستخدمها showGamesMenu وأيضاً زر "رجوع" بـ callbacks.js
// حتى لا يصير عندنا نسختين متوازيتين تتفرقان مع الوقت
function _escHtml(t) {
  return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function buildGamesMenuContent() {
  const customGames = await require('../database/db').all(
    'SELECT id, name, keyword FROM custom_games WHERE is_active=1 ORDER BY id'
  ).catch(() => []);

  const mainKb = [
    [{ text: '🏆 من سيربح المليون', callback_data: 'grp_game_info_million' },
     { text: '📸 خمّن الصورة',      callback_data: 'grp_game_info_guess'   }],
    [{ text: '🐺 لوب غارو',         callback_data: 'grp_game_info_werewolf' },
     { text: '🎲 صحصح',             callback_data: 'grp_game_info_tod'      }],
  ];

  // ✅ نص بمحاذاة عمودين حقيقية عبر <code> (Monospace) لكل سطر — بلا Code Block كامل، فما يطلعش زر Copy
  let customBlock = '';
  if (customGames.length) {
    const lines = [];
    for (let i = 0; i < customGames.length; i += 2) {
      const left  = ('• ' + customGames[i].keyword).padEnd(18, ' ');
      const right = customGames[i + 1] ? '• ' + customGames[i + 1].keyword : '';
      lines.push('<code>' + _escHtml(left + right) + '</code>');
    }
    customBlock =
      '\n\n🎖 <b>العاب تالين</b> (اكتب الكلمة مباشرة):\n' +
      '⏞'.repeat(18) + '\n' +
      lines.join('\n') + '\n' +
      '⏟'.repeat(18);
  }

  const mainText =
    '🎮 <b>ألعاب القروب</b>\n' +
    '━━━━━━━━━━━━━━━━━━━━' +
    customBlock + '\n\n' +
    '👇 اختر لعبة لمعرفة التفاصيل، أو اكتب الكلمة مباشرة:';

  return { text: mainText, keyboard: { inline_keyboard: mainKb }, parseMode: 'HTML' };
}

async function showGamesMenu(ctx) {
  const { text, keyboard, parseMode } = await buildGamesMenuContent();
  return ctx.reply(text, {
    parse_mode: parseMode || 'Markdown',
    reply_to_message_id: ctx.message?.message_id,
    reply_markup: keyboard,
  }).catch(() => null);
}

// helper: رسالة تُحذف تلقائياً
function _reply(ctx, text, delay=10000) {
  const threadId = ctx.message?.message_thread_id;
  ctx.reply(text, { parse_mode: 'Markdown', ...(threadId ? { message_thread_id: threadId } : {}) })
    .then(m => { if (m && delay) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), delay); })
    .catch(() => {});
}

module.exports = {
  setupGroupCommands, showGamesMenu, buildGamesMenuContent, handleSettingsCallback, showGroupSettings,
  getTarget, parseDuration, isTgAdmin, _reply, delCmd,
};
