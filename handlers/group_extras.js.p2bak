'use strict';
/**
 * 🛠️ handlers/group_extras.js — ميزات متقدمة إضافية
 * ──────────────────────────────────────────────────────────────
 * 1. 🐌 Slowmode      — /slowmode [ثواني]
 * 2. 🚨 Report        — /report أو "بلاغ" من أي عضو للمشرفين
 * 3. 🌊 Anti-Raid     — كشف الانضمام الجماعي السريع (mass join)
 * 4. 📊 /topactive    — أكثر الأعضاء نشاطاً (رسائل)
 * 5. 🔇 /muteall /unmuteall — إسكات/تفعيل جميع الأعضاء
 */

const { run, get, all } = require('../database/db');
const { cacheGet, cacheSet, cacheClear } = require('../utils/cache');
const logger = require('../utils/logger');

function isGroup(ctx) { return ['group','supergroup'].includes(ctx.chat?.type); }
function _del(ctx) { setTimeout(() => ctx.deleteMessage().catch(() => {}), 1000); }
function _tmp(ctx, txt, secs = 8) {
  ctx.reply(txt, { parse_mode: 'Markdown' })
    .then(m => { if(m) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), secs * 1000); })
    .catch(() => {});
}

async function isTgAdmin(ctx) {
  if (ctx.isOwner || ctx.isAdmin) return true;
  try {
    const m = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return ['administrator','creator'].includes(m?.status);
  } catch(_) { return false; }
}

// ══════════════════════════════════════════════════════════
// 1. 🐌 SLOWMODE
// ══════════════════════════════════════════════════════════
async function handleSlowmode(ctx) {
  if (!isGroup(ctx)) return;
  if (!await isTgAdmin(ctx)) return _tmp(ctx, '🚫 للمشرفين فقط');
  _del(ctx);
  const arg = (ctx.message.text || '').split(/\s+/)[1];
  let secs = parseInt(arg) || 0;
  if (secs < 0) secs = 0;
  if (secs > 86400) secs = 86400;

  try {
    await ctx.telegram.setChatSlowMode(ctx.chat.id, secs);
    if (secs === 0) _tmp(ctx, '✅ تم *إلغاء* الوضع البطيء');
    else {
      const label = secs < 60 ? secs + ' ثانية' : secs < 3600 ? Math.floor(secs/60) + ' دقيقة' : Math.floor(secs/3600) + ' ساعة';
      _tmp(ctx, '🐌 *الوضع البطيء:* رسالة كل *' + label + '*');
    }
  } catch(e) {
    _tmp(ctx, '❌ فشل: ' + e.message);
  }
}

// ══════════════════════════════════════════════════════════
// 2. 🚨 REPORT
// ══════════════════════════════════════════════════════════
const _reportCd = new Map(); // userId → last report timestamp
const REPORT_COOLDOWN = 5 * 60 * 1000; // 5 دقائق بين كل بلاغ

async function handleReport(ctx) {
  if (!isGroup(ctx)) return;
  const uid = ctx.from.id;
  const now = Date.now();

  // تحقق Cooldown
  const last = _reportCd.get(uid);
  if (last && now - last < REPORT_COOLDOWN) {
    const remaining = Math.ceil((REPORT_COOLDOWN - (now - last)) / 60000);
    return _tmp(ctx, '⏳ انتظر *' + remaining + '* دقيقة قبل إرسال بلاغ آخر.', 5);
  }

  const replyTo = ctx.message.reply_to_message;
  if (!replyTo || !replyTo.from) {
    return _tmp(ctx, '⚠️ رُد على رسالة العضو المخالف واكتب `/report` أو «بلاغ».', 5);
  }
  if (replyTo.from.is_bot) return _tmp(ctx, '⚠️ لا يمكن الإبلاغ عن بوت.', 5);
  if (replyTo.from.id === uid) return _tmp(ctx, '⚠️ لا تستطيع الإبلاغ عن نفسك.', 5);

  const reason = (ctx.message.text || '').replace(/^\/report\s*|^بلاغ\s*/i, '').trim();
  const target = replyTo.from;
  const reporter = ctx.from;
  const chatTitle = ctx.chat.title || 'القروب';

  _reportCd.set(uid, now);
  _del(ctx);

  // إرسال البلاغ للمشرفين
  const admins = await ctx.telegram.getChatAdministrators(ctx.chat.id).catch(() => []);
  const adminIds = admins.filter(a => !a.user.is_bot && a.user.id !== target.id).map(a => a.user.id);

  const reportText =
    '🚨 *بلاغ جديد*\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '📢 القروب: ' + chatTitle + '\n' +
    '👤 المُبلِّغ: [' + (reporter.first_name||'عضو') + '](tg://user?id=' + reporter.id + ')\n' +
    '🎯 المُبلَّغ عنه: [' + (target.first_name||'عضو') + '](tg://user?id=' + target.id + ')\n' +
    (reason ? '📝 السبب: ' + reason + '\n' : '') +
    '💬 الرسالة: _' + (replyTo.text || replyTo.caption || '[وسائط]').substring(0, 100) + '_';

  const kb = {
    inline_keyboard: [[
      { text: '🚫 حظر', callback_data: 'grp_ban_confirm_' + target.id },
      { text: '🔇 كتم',  callback_data: 'grp_mute_menu_'   + target.id },
    ],[
      { text: '⚠️ تحذير', callback_data: 'grp_warn_quick_' + target.id + '_' + ctx.chat.id },
      { text: '👁 عرض',   url: 'https://t.me/c/' + String(ctx.chat.id).replace('-100','') + '/' + replyTo.message_id },
    ]]
  };

  let sentCount = 0;
  for (const adminId of adminIds.slice(0, 5)) {
    try {
      await ctx.telegram.sendMessage(adminId, reportText, { parse_mode: 'Markdown', reply_markup: kb });
      sentCount++;
    } catch(_) {}
  }

  // رسالة تأكيد للعضو
  const m = await ctx.reply(
    '✅ تم إرسال البلاغ للمشرفين' + (sentCount ? ' (' + sentCount + ')' : '') + '. شكراً على تعاونك!',
    { reply_to_message_id: ctx.message.message_id }
  ).catch(() => null);
  if (m) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 6000);
}

// ══════════════════════════════════════════════════════════
// 3. 🌊 ANTI-RAID (كشف الانضمام الجماعي السريع)
// ══════════════════════════════════════════════════════════
const _joinTrack = new Map(); // chatId → [timestamps]
const RAID_THRESHOLD = 10;   // عدد انضمامات
const RAID_WINDOW    = 30000; // خلال 30 ثانية
const RAID_COOLDOWN  = new Map(); // chatId → last raid time

async function checkAntiRaid(bot, chatId, userId) {
  const settings = await require('./group_protection').getSettings(chatId).catch(() => null);
  if (!settings?.anti_raid) return false;

  const now = Date.now();
  let joins = _joinTrack.get(chatId) || [];
  joins.push(now);
  // احتفظ بالانضمامات خلال آخر 30 ثانية فقط
  joins = joins.filter(t => now - t < RAID_WINDOW);
  _joinTrack.set(chatId, joins);

  if (joins.length < RAID_THRESHOLD) return false;

  // تحقق Cooldown للإشعار (لا نرسل تنبيهاً كل ثانية)
  const lastRaid = RAID_COOLDOWN?.get?.(chatId) || 0;
  const alerted = now - lastRaid < 60000;
  RAID_COOLDOWN.set(chatId, now);
  _joinTrack.delete(chatId);

  if (!alerted) {
    // قفل القروب مؤقتاً
    try {
      await bot.telegram.setChatPermissions(chatId, { can_send_messages: false });
      const m = await bot.telegram.sendMessage(chatId,
        '🌊 *تحذير: هجوم Raid مكتشف!*\n\n' +
        '⚡ ' + joins.length + ' انضمام في أقل من 30 ثانية.\n' +
        '🔒 تم قفل القروب مؤقتاً لمدة 5 دقائق.',
        { parse_mode: 'Markdown' }
      ).catch(() => null);

      // فتح القروب بعد 5 دقائق
      setTimeout(async () => {
        try {
          await bot.telegram.setChatPermissions(chatId, {
            can_send_messages: true, can_send_media_messages: true,
            can_send_polls: true, can_send_other_messages: true,
          });
          if (m) await bot.telegram.sendMessage(chatId, '✅ تم رفع القفل بعد انتهاء تنبيه الـ Raid.').catch(() => {});
        } catch(_) {}
      }, 5 * 60 * 1000);
    } catch(e) { logger.debug('[anti-raid]', e.message); }
  }
  return true;
}

// ══════════════════════════════════════════════════════════
// 4. 📊 /topactive — أكثر الأعضاء نشاطاً
// ══════════════════════════════════════════════════════════
async function handleTopActive(ctx) {
  if (!isGroup(ctx)) return;
  _del(ctx);
  const chatId = ctx.chat.id;

  // نستخدم group_violations كمصدر للنشاط (إن لم تكن group_members متاحة) أو group_members
  const topRows = await all(
    `SELECT user_id, COUNT(*)::int AS c FROM group_violations WHERE chat_id=$1
     AND created_at > NOW() - INTERVAL '7 days'
     GROUP BY user_id ORDER BY c DESC LIMIT 10`,
    [chatId]
  ).catch(() => []);

  // البديل: group_members إن كانت موجودة
  const memberStats = await all(
    `SELECT user_id, username, first_name FROM group_members WHERE chat_id=$1 LIMIT 200`,
    [chatId]
  ).catch(() => []);

  if (!memberStats.length && !topRows.length) {
    return ctx.reply('📭 لا توجد إحصائيات كافية بعد.').catch(() => {});
  }

  // جلب عدد الأعضاء الفعلي
  let total = 0;
  try { total = await ctx.telegram.getChatMembersCount(chatId); } catch(_) {}

  const RANK = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
  let txt = '📊 *إحصائيات القروب*\n━━━━━━━━━━━━━━━━\n\n';
  txt += '👥 إجمالي الأعضاء: *' + total.toLocaleString('en') + '*\n';
  txt += '📋 مسجّلون: *' + memberStats.length + '*\n\n';

  if (topRows.length) {
    txt += '⚡ *أكثر الأعضاء نشاطاً (7 أيام):*\n';
    for (let i = 0; i < Math.min(topRows.length, 10); i++) {
      const r = topRows[i];
      const mem = memberStats.find(m => m.user_id == r.user_id);
      const name = mem?.first_name || ('مستخدم ' + r.user_id);
      txt += RANK[i] + ' [' + name + '](tg://user?id=' + r.user_id + ') — ' + r.c + ' نشاط\n';
    }
  } else {
    txt += '_لا توجد بيانات نشاط كافية بعد._';
  }

  ctx.reply(txt, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 🔁 تسجيل الأوامر
// ══════════════════════════════════════════════════════════
function setupExtras(bot) {
  // 🚨 Report
  bot.command(['report', 'بلاغ'], handleReport);

  // ── 🤖 كشف وحذف البوتات + تنظيف المحظورين ──
  // ⚠️ قيد Telegram API: البوت يقدر يفحص بس الأعضاء المسجلين عندو مسبقاً فـ group_members
  // (اللي بعتو رسالة قبل)، ماشي كل أعضاء القروب — تيليجرام ما يعطيش قائمة كاملة للبوتات.
  const cleanupHandler = async ctx => {
    if (!['group', 'supergroup'].includes(ctx.chat?.type)) return;
    if (!ctx.isOwner && !ctx.isAdmin) {
      try {
        const m = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
        if (!['administrator', 'creator'].includes(m?.status)) return;
      } catch { return; }
    }
    const chatId = ctx.chat.id;
    const known = await all('SELECT user_id, first_name FROM group_members WHERE chat_id=$1', [chatId]).catch(() => []);
    if (!known.length) return ctx.reply('📭 مافيش أعضاء مسجلين عندي فهاذ القروب بعد.').catch(() => {});

    const msg = await ctx.reply('🔍 جاري فحص ' + known.length + ' عضو مسجّل...').catch(() => null);
    let removedBots = 0, removedGone = 0, checked = 0;

    for (const row of known) {
      checked++;
      try {
        const member = await ctx.telegram.getChatMember(chatId, row.user_id);
        if (member.user?.is_bot && member.user.id !== ctx.botInfo?.id) {
          await ctx.telegram.banChatMember(chatId, row.user_id).catch(() => {});
          await run('DELETE FROM group_members WHERE chat_id=$1 AND user_id=$2', [chatId, row.user_id]).catch(() => {});
          removedBots++;
        } else if (['left', 'kicked'].includes(member.status)) {
          await run('DELETE FROM group_members WHERE chat_id=$1 AND user_id=$2', [chatId, row.user_id]).catch(() => {});
          removedGone++;
        }
      } catch (e) {
        await run('DELETE FROM group_members WHERE chat_id=$1 AND user_id=$2', [chatId, row.user_id]).catch(() => {});
        removedGone++;
      }
      if (checked % 15 === 0) await new Promise(r => setTimeout(r, 300));
    }

    if (msg) await ctx.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
    return ctx.reply(
      '✅ *انتهى الفحص*\n\n' +
      '👥 فُحص: ' + checked + '\n' +
      '🤖 بوتات مطرودة: ' + removedBots + '\n' +
      '🧹 سجلات منظّفة (غادروا/محظورين): ' + removedGone,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  };
  bot.command(['cleanbots', 'حذف_بوتات', 'كشف_بوتات'], cleanupHandler);
  bot.hears(/^(حذف_بوتات|كشف_بوتات|حذف بوتات|كشف بوتات|حذف المحظورين)$/, cleanupHandler);
  bot.hears(/^بلاغ(?:\s+(.+))?$/, async ctx => {
    ctx.message.text = '/report ' + (ctx.match[1] || '');
    return handleReport(ctx);
  });
}

module.exports = {
  setupExtras,
  handleReport,
  checkAntiRaid,
};
