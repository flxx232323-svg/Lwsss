'use strict';
/**
 * 🆕 handlers/group_schedule.js
 * ميزات جديدة كلياً من group_advanced.js:
 *  1. ⏰ /tempban @user 1h [سبب]    — حظر مؤقت بمدة محددة
 *  2. 📅 /schedule HH:MM رسالة      — جدولة رسالة
 *  3. 👁 /watching @user             — مراقبة عضو (رسائله للأدمن)
 *     /unwatch @user
 *  4. 💬 "ادارة" (رد على عضو)        — لوحة الأدمن السريعة (Quick Panel)
 */

const { run, get, all } = require('../database/db');
const logger = require('../utils/logger');

// ══════════════════════════════════════════════════════════
// 🗄️ Migration
// ══════════════════════════════════════════════════════════
async function migrate() {
  await Promise.all([
    run(`CREATE TABLE IF NOT EXISTS group_tempbans (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      unban_at TIMESTAMPTZ NOT NULL,
      reason TEXT DEFAULT '',
      UNIQUE(chat_id, user_id)
    )`),
    run(`CREATE TABLE IF NOT EXISTS group_schedules (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      message TEXT NOT NULL,
      send_at TIMESTAMPTZ NOT NULL,
      created_by BIGINT,
      sent BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`),
    run('CREATE INDEX IF NOT EXISTS idx_schedules ON group_schedules(sent, send_at)'),
    run(`CREATE TABLE IF NOT EXISTS group_watching (
      chat_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      admin_id BIGINT NOT NULL,
      PRIMARY KEY(chat_id, user_id)
    )`),
  ]).catch(e => logger.debug('[GroupSchedule migrate]', e.message));
  logger.info('✅ [GroupSchedule] Migration done');
}

// ══════════════════════════════════════════════════════════
// 🔧 مساعدات
// ══════════════════════════════════════════════════════════
function isGroup(ctx) { return ['group','supergroup'].includes(ctx.chat?.type); }
function delCmd(ctx) { setTimeout(() => ctx.deleteMessage().catch(() => {}), 1000); }
function tmp(ctx, text, secs = 8) {
  ctx.reply(text, { parse_mode: 'Markdown' })
    .then(m => { if (m) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), secs * 1000); })
    .catch(() => {});
}
async function isTgAdmin(ctx) {
  if (ctx.isOwner || ctx.isAdmin) return true;
  try {
    const m = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return ['administrator','creator'].includes(m?.status);
  } catch(_) { return false; }
}
async function getTarget(ctx) {
  const rep = ctx.message?.reply_to_message?.from;
  if (rep) return { id: rep.id, name: rep.first_name || 'عضو', fromReply: true };
  const args = (ctx.message?.text || '').split(/\s+/).slice(1);
  if (!args.length) return null;
  const first = args[0];
  if (/^\d+$/.test(first)) return { id: parseInt(first), name: 'ID:' + first };
  if (first.startsWith('@')) {
    try {
      const u = await ctx.telegram.getChatMember(ctx.chat.id, first);
      return { id: u.user?.id, name: u.user?.first_name || first };
    } catch(_) { return null; }
  }
  return null;
}
function parseSec(arg) {
  if (!arg) return 3600;
  const m = arg.match(/^(\d+)(s|m|h|d)?$/i);
  if (!m) return 3600;
  const n = parseInt(m[1]);
  const u = (m[2] || 'h').toLowerCase();
  if (u === 's') return n;
  if (u === 'm') return n * 60;
  if (u === 'h') return n * 3600;
  if (u === 'd') return n * 86400;
  return 3600;
}
function fmtDur(secs) {
  if (secs < 60) return secs + 'ث';
  if (secs < 3600) return Math.floor(secs / 60) + 'د';
  if (secs < 86400) return Math.floor(secs / 3600) + 'س';
  return Math.floor(secs / 86400) + 'ي';
}

// ══════════════════════════════════════════════════════════
// 1. ⏰ حظر مؤقت
// ══════════════════════════════════════════════════════════
async function handleTempban(ctx) {
  if (!isGroup(ctx) || !await isTgAdmin(ctx)) return;
  delCmd(ctx);
  const target = await getTarget(ctx);
  if (!target) return tmp(ctx, '⚠️ `/tempban @user 1h [سبب]`\nمثال: `30m` `2h` `1d`', 8);

  // ✅ نحسب فعلياً كم كلمة استهلكها الـ trigger نفسو (سلاش = كلمة وحدة، "حظر مؤقت" = كلمتين)
  const raw = (ctx.message?.text || '').trim();
  const triggerWords = raw.startsWith('/') ? 1 : (raw.match(/^حظر\s+مؤقت/) ? 2 : 1);
  const skip = triggerWords + (target.fromReply ? 0 : 1); // +1 كلمة زيادة إذا الهدف من النص (@user) مو من الرد
  const args = raw.split(/\s+/).slice(skip);
  const secs = parseSec(args[0] || '1h');
  const reason = args.slice(1).join(' ') || 'حظر مؤقت';
  const unbanAt = new Date(Date.now() + secs * 1000);

  try {
    await ctx.telegram.banChatMember(ctx.chat.id, target.id, {
      until_date: Math.floor(unbanAt.getTime() / 1000),
    });
    await run(
      'INSERT INTO group_tempbans(chat_id,user_id,unban_at,reason) VALUES($1,$2,$3,$4) ON CONFLICT(chat_id,user_id) DO UPDATE SET unban_at=$3,reason=$4',
      [ctx.chat.id, target.id, unbanAt, reason]
    ).catch(() => {});

    const msg = await ctx.reply(
      `⏰ *حظر مؤقت*\n━━━━━━━━━━━━━━━\n\n` +
      `👤 [${target.name}](tg://user?id=${target.id})\n` +
      `📝 السبب: ${reason}\n` +
      `⏱ المدة: *${fmtDur(secs)}*\n` +
      `🔓 يُرفع: ${unbanAt.toLocaleString('ar-DZ')}`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: '🔓 رفع الحظر الآن', callback_data: 'sch_untempban_' + target.id },
          { text: '♾️ تحويل لدائم',    callback_data: 'sch_permban_' + target.id },
        ]]}
      }
    ).catch(() => null);
    if (msg) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 30000);

    require('./group_logs').logAction({ telegram: ctx.telegram }, ctx.chat.id, 'ban', {
      actorId: ctx.from.id, actorName: ctx.from.first_name || '',
      targetId: target.id, targetName: target.name,
      details: '⏰ حظر مؤقت ' + fmtDur(secs) + ' — ' + reason,
    }).catch(() => {});
  } catch(e) { tmp(ctx, '❌ ' + e.message, 5); }
}

// ══════════════════════════════════════════════════════════
// 2. 📅 جدولة رسائل
// ══════════════════════════════════════════════════════════
async function handleSchedule(ctx) {
  if (!isGroup(ctx) || !await isTgAdmin(ctx)) return;
  delCmd(ctx);

  const args = (ctx.message?.text || '').split(' ').slice(1);
  if (args.length < 2) return tmp(ctx,
    '⏰ *جدولة رسالة*\n\n' +
    '`/schedule HH:MM رسالتك`\n' +
    'مثال: `/schedule 14:30 تذكير: اجتماع الآن!`\n\n' +
    '_التوقيت: الجزائر (UTC+1)_', 15);

  const [hh, mm] = (args[0] || '').split(':').map(Number);
  if (isNaN(hh) || isNaN(mm) || hh > 23 || mm > 59)
    return tmp(ctx, '❌ صيغة الوقت خاطئة. استخدم `HH:MM` مثل `14:30`', 5);

  const msg = args.slice(1).join(' ').trim();
  if (!msg) return tmp(ctx, '❌ أضف نص الرسالة', 5);

  // تحويل التوقيت الجزائري → UTC
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(hh - 1, mm, 0, 0);
  if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);

  await run(
    'INSERT INTO group_schedules(chat_id,message,send_at,created_by) VALUES($1,$2,$3,$4)',
    [ctx.chat.id, msg, target, ctx.from.id]
  ).catch(() => {});

  tmp(ctx,
    `✅ *تمت الجدولة!*\n\n` +
    `⏰ الإرسال في: *${args[0]}* (توقيت الجزائر)\n` +
    `📝 الرسالة: _${msg.slice(0, 80)}${msg.length > 80 ? '…' : ''}_`,
    10);
}

// ── Watcher: يشتغل كل دقيقة ──
let _schedTimer = null;
function startScheduleWatcher(bot) {
  if (_schedTimer) return;
  _schedTimer = setInterval(async () => {
    try {
      const pending = await all(
        'SELECT * FROM group_schedules WHERE sent=FALSE AND send_at <= NOW() LIMIT 20'
      ).catch(() => []);
      for (const s of pending) {
        try {
          await bot.telegram.sendMessage(s.chat_id, s.message, { parse_mode: 'Markdown' });
        } catch(e) { logger.debug('[Schedule] send failed', e.message); }
        await run('UPDATE group_schedules SET sent=TRUE WHERE id=$1', [s.id]).catch(() => {});
      }
    } catch(e) { logger.error('[Schedule] watcher error', e.message); }
  }, 60000);
  _schedTimer.unref();
  logger.info('✅ [Schedule] Watcher started');
}

// ══════════════════════════════════════════════════════════
// 3. 👁 مراقبة عضو
// ══════════════════════════════════════════════════════════
async function handleWatch(ctx) {
  if (!isGroup(ctx) || !await isTgAdmin(ctx)) return;
  delCmd(ctx);
  const target = await getTarget(ctx);
  if (!target) return tmp(ctx, '⚠️ رُد على رسالة العضو أو: `/watching @user`', 5);
  await run('INSERT INTO group_watching(chat_id,user_id,admin_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [ctx.chat.id, target.id, ctx.from.id]).catch(() => {});
  tmp(ctx, `👁 *تفعيل المراقبة على [${target.name}](tg://user?id=${target.id})*\nستصلك رسائله في الخاص.`, 8);
}

async function handleUnwatch(ctx) {
  if (!isGroup(ctx) || !await isTgAdmin(ctx)) return;
  delCmd(ctx);
  const target = await getTarget(ctx);
  if (!target) return tmp(ctx, '⚠️ `/unwatch @user`', 5);
  await run('DELETE FROM group_watching WHERE chat_id=$1 AND user_id=$2', [ctx.chat.id, target.id]).catch(() => {});
  tmp(ctx, `✅ *إلغاء مراقبة [${target.name}](tg://user?id=${target.id})*`, 5);
}

// Middleware: يُرسل رسائل العضو المراقَب للأدمن — fire & forget
async function runWatchMiddleware(bot, chatId, userId, firstName, msgText, msgId) {
  try {
    const watchers = await all(
      'SELECT admin_id FROM group_watching WHERE chat_id=$1 AND user_id=$2',
      [chatId, userId]
    ).catch(() => []);
    if (!watchers.length) return;
    const text =
      `👁 *مراقبة — رسالة جديدة*\n━━━━━━━━━━━━\n\n` +
      `👤 [${firstName || 'عضو'}](tg://user?id=${userId})\n` +
      `💬 ${(msgText || '[وسائط]').slice(0, 300)}\n` +
      `🔗 [رابط الرسالة](https://t.me/c/${String(chatId).replace('-100', '')}/${msgId})`;
    for (const w of watchers) {
      bot.telegram.sendMessage(w.admin_id, text, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(() => {});
    }
  } catch(_) {}
}

// ══════════════════════════════════════════════════════════
// 4. 💬 "ادارة" — لوحة الأدمن السريعة (Quick Panel)
// ══════════════════════════════════════════════════════════
async function handleQuickPanel(ctx) {
  if (!isGroup(ctx) || !await isTgAdmin(ctx)) return;
  const rep = ctx.message?.reply_to_message?.from;
  if (!rep) return;
  delCmd(ctx);

  const chatId = ctx.chat.id;
  const targetId = rep.id;
  const name = rep.first_name || 'عضو';

  const [memberRow, warnCount, violations] = await Promise.all([
    get('SELECT msg_count FROM group_members WHERE chat_id=$1 AND user_id=$2', [chatId, targetId]).catch(() => null),
    get('SELECT COUNT(*)::int AS cnt FROM group_warns WHERE chat_id=$1 AND user_id=$2', [chatId, targetId]).catch(() => ({ cnt: 0 })),
    require('../database/group_pro_db').getViolationCount(chatId, targetId, 24).catch(() => 0),
  ]);

  const text =
    `⚡ *لوحة الأدمن السريعة*\n━━━━━━━━━━━━━━━━━━\n\n` +
    `👤 [${name}](tg://user?id=${targetId})\n` +
    `🆔 \`${targetId}\`\n\n` +
    `💬 الرسائل: *${memberRow?.msg_count || 0}*\n` +
    `⚠️ الإنذارات: *${warnCount?.cnt || 0}*\n` +
    `🛡 مخالفات الحماية (24س): *${violations}*`;

  const kb = { inline_keyboard: [
    [
      { text: '🚫 حظر',    callback_data: 'gpq_ban_'  + targetId + '_' + chatId },
      { text: '🦵 طرد',    callback_data: 'gpq_kick_' + targetId + '_' + chatId },
    ],
    [
      { text: '🔇 كتم',    callback_data: 'gpq_mute_' + targetId + '_' + chatId },
      { text: '⚠️ إنذار',  callback_data: 'gpq_warn_' + targetId + '_' + chatId },
    ],
    [
      { text: '👁 مراقبة', callback_data: 'gpq_watch_'  + targetId + '_' + chatId },
      { text: '🔄 تصفير',  callback_data: 'gpq_reset_'  + targetId + '_' + chatId },
    ],
    [
      { text: '📋 سجل العضو', callback_data: 'gpq_log_' + targetId + '_' + chatId },
    ],
  ]};

  ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb }).catch(() => {});
}

async function handleQuickCallback(ctx, data) {
  if (!data.startsWith('gpq_') && !data.startsWith('sch_')) return false;
  const isAdmin = await isTgAdmin(ctx);

  // ── tempban buttons ──
  if (data.startsWith('sch_untempban_')) {
    if (!isAdmin) return ctx.answerCbQuery('🚫').catch(() => {});
    const uid = parseInt(data.replace('sch_untempban_', ''));
    try {
      await ctx.telegram.unbanChatMember(ctx.chat.id, uid);
      await run('DELETE FROM group_tempbans WHERE chat_id=$1 AND user_id=$2', [ctx.chat.id, uid]).catch(() => {});
      ctx.answerCbQuery('✅ رُفع الحظر').catch(() => {});
      ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    } catch(e) { ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
    return true;
  }

  if (data.startsWith('sch_permban_')) {
    if (!isAdmin) return ctx.answerCbQuery('🚫').catch(() => {});
    const uid = parseInt(data.replace('sch_permban_', ''));
    try {
      await ctx.telegram.banChatMember(ctx.chat.id, uid);
      await run('DELETE FROM group_tempbans WHERE chat_id=$1 AND user_id=$2', [ctx.chat.id, uid]).catch(() => {});
      ctx.answerCbQuery('✅ تحوّل لحظر دائم').catch(() => {});
    } catch(e) { ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
    return true;
  }

  // ── quick panel buttons ──
  if (!data.startsWith('gpq_')) return false;
  if (!isAdmin) return ctx.answerCbQuery('🚫 للمشرفين فقط', { show_alert: true }).catch(() => {});

  const rest = data.replace('gpq_', '');
  const parts = rest.split('_');
  const action = parts[0];
  const uid    = parseInt(parts[1]);
  const chatId = parseInt(parts[2]);

  await ctx.answerCbQuery('').catch(() => {});

  if (action === 'ban') {
    try {
      await ctx.telegram.banChatMember(chatId, uid);
      await run('INSERT INTO group_bans(chat_id,user_id,banned_by,reason) VALUES($1,$2,$3,$4) ON CONFLICT DO UPDATE SET reason=$4',
        [chatId, uid, ctx.from.id, 'من لوحة الأدمن السريعة']).catch(() => {});
      return ctx.editMessageText(ctx.message.text + '\n\n✅ *تم الحظر*', { parse_mode: 'Markdown' }).catch(() => {});
    } catch(e) { return ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
  }

  if (action === 'kick') {
    try {
      await ctx.telegram.banChatMember(chatId, uid);
      await ctx.telegram.unbanChatMember(chatId, uid);
      return ctx.editMessageText(ctx.message.text + '\n\n✅ *تم الطرد*', { parse_mode: 'Markdown' }).catch(() => {});
    } catch(e) { return ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
  }

  if (action === 'mute') {
    try {
      await ctx.telegram.restrictChatMember(chatId, uid, {
        permissions: { can_send_messages: false },
        until_date: Math.floor(Date.now() / 1000) + 3600,
      });
      return ctx.editMessageText(ctx.message.text + '\n\n🔇 *تم الكتم (ساعة)*', { parse_mode: 'Markdown' }).catch(() => {});
    } catch(e) { return ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
  }

  if (action === 'warn') {
    try {
      const { warnMember } = require('./group_admin');
      await warnMember({ from: ctx.from, chat: { id: chatId }, telegram: ctx.telegram, callbackQuery: false, reply: (...a) => ctx.telegram.sendMessage(chatId, ...a) }, chatId, uid, 'من لوحة الأدمن السريعة');
      return ctx.editMessageText(ctx.message.text + '\n\n⚠️ *تم الإنذار*', { parse_mode: 'Markdown' }).catch(() => {});
    } catch(e) { return ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
  }

  if (action === 'watch') {
    await run('INSERT INTO group_watching(chat_id,user_id,admin_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [chatId, uid, ctx.from.id]).catch(() => {});
    return ctx.answerCbQuery('👁 بدأت المراقبة', { show_alert: true }).catch(() => {});
  }

  if (action === 'reset') {
    await require('../database/group_pro_db').resetViolations(chatId, uid);
    await run('DELETE FROM group_warns WHERE chat_id=$1 AND user_id=$2', [chatId, uid]).catch(() => {});
    return ctx.answerCbQuery('✅ تم تصفير المخالفات والإنذارات', { show_alert: true }).catch(() => {});
  }

  if (action === 'log') {
    const logs = await require('../database/group_pro_db').getViolationHistory(chatId, uid, 8);
    const warns = await all('SELECT reason, created_at FROM group_warns WHERE chat_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 5', [chatId, uid]).catch(() => []);
    let text = '📋 *سجل العضو*\n━━━━━━━━━━━━\n';
    if (logs.length) {
      text += '\n🛡 مخالفات الحماية:\n';
      logs.forEach(l => { text += '• ' + require('./group_protection').violationLabel(l.type) + ' _' + new Date(l.created_at).toLocaleString('ar-DZ', { hour12:false, day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) + '_\n'; });
    }
    if (warns.length) {
      text += '\n⚠️ الإنذارات:\n';
      warns.forEach(w => { text += '• ' + (w.reason || 'مخالفة') + '\n'; });
    }
    if (!logs.length && !warns.length) text += '\n_لا توجد سجلات_';
    return ctx.answerCbQuery(text.substring(0, 200), { show_alert: true }).catch(() => {});
  }

  return false;
}

// ══════════════════════════════════════════════════════════
// 🔌 تسجيل الأوامر
// ══════════════════════════════════════════════════════════
function setupSchedule(bot) {
  migrate().catch(() => {});

  // ⏰ tempban
  bot.command(['tempban', 'حظر_مؤقت', 'حظرمؤقت'], handleTempban);
  bot.hears(/^حظر مؤقت/, handleTempban);

  // 📅 schedule
  bot.command(['schedule', 'جدول', 'جدولة'], handleSchedule);

  // 👁 watching
  bot.command(['watching', 'watch', 'مراقبة'], handleWatch);
  bot.command(['unwatch', 'إلغاء_مراقبة'], handleUnwatch);
  bot.hears(/^(مراقبة|إلغاء مراقبة)$/, async ctx => {
    if ((ctx.message.text || '').startsWith('إلغاء')) return handleUnwatch(ctx);
    return handleWatch(ctx);
  });

  // 💬 ادارة — Quick Panel
  bot.hears(/^(ادارة|إدارة|admin panel|إدارة سريعة)$/, handleQuickPanel);
}

module.exports = {
  setupSchedule, startScheduleWatcher,
  handleTempban, handleSchedule,
  handleWatch, handleUnwatch, runWatchMiddleware,
  handleQuickPanel, handleQuickCallback,
};
