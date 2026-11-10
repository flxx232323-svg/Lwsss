'use strict';
/**
 * 🚀 handlers/group_pro_features.js
 * ──────────────────────────────────────────────────────────────
 * ميزات احترافية تجعل البوت أقوى من Rose و ComBot:
 *
 * 1. 👮 /admins          — قائمة المشرفين (TG + رتب البوت)
 * 2. ✅ /approve          — استثناء عضو من الحماية
 *    ❌ /unapprove        — إلغاء الاستثناء
 *    📋 /approved         — قائمة المستثنين
 * 3. ⚠️ /setwarnlimit [n] — تحديد عدد التحذيرات قبل الحظر
 * 4. 📊 /topactive        — أكثر الأعضاء إرسالاً (msg_count حقيقي)
 * 5. 🐌 /slowmode [s]     — وضع بطيء (API صحيح)
 * 6. 🛑 /gban /ungban     — حظر عالمي (عبر قاعدة البيانات)
 * 7. 🔍 /whois            — معلومات مستخدم خارج القروب
 * 8. 🧹 /purgeto          — حذف من رسالة لأخرى
 * 9. 📣 /setjoin          — رسالة ترحيب مع متغيرات {name}/{count}
 */

const { run, get, all } = require('../database/db');
const proDb = require('../database/group_pro_db');
const { cacheGet, cacheSet, cacheClear } = require('../utils/cache');
const logger = require('../utils/logger');

function isGroup(ctx) { return ['group', 'supergroup'].includes(ctx.chat?.type); }
function _del(ctx) { setTimeout(() => ctx.deleteMessage().catch(() => {}), 1000); }
function _tmp(ctx, txt, secs = 8) {
  ctx.reply(txt, { parse_mode: 'Markdown', disable_web_page_preview: true })
    .then(m => { if (m) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), secs * 1000); })
    .catch(() => {});
}
async function isTgAdmin(ctx, chatId, uid) {
  if (ctx.isOwner || ctx.isAdmin) return true;
  const cid = chatId || ctx.chat?.id;
  const id  = uid || ctx.from?.id;
  const ck = 'tgadm_' + cid + '_' + id;
  let v = cacheGet(ck);
  if (v !== null) return !!v;
  try {
    const m = await ctx.telegram.getChatMember(cid, id);
    v = ['administrator', 'creator'].includes(m?.status);
  } catch (_) { v = false; }
  cacheSet(ck, v, 300000);
  return v;
}
async function getTarget(ctx) {
  const rep = ctx.message?.reply_to_message?.from;
  if (rep) return { id: rep.id, name: rep.first_name || 'عضو', username: rep.username || '' };
  const args = (ctx.message?.text || '').split(/\s+/).slice(1);
  if (!args.length) return null;
  const first = args[0];
  if (first.startsWith('@')) {
    try { const m = await ctx.telegram.getChatMember(ctx.chat.id, first); return m?.user ? { id: m.user.id, name: m.user.first_name || first, username: m.user.username || '' } : null; } catch (_) { return null; }
  }
  if (/^\d+$/.test(first)) return { id: parseInt(first), name: 'مستخدم', username: '' };
  return null;
}

// ══════════════════════════════════════════════════════════
// 🗄️ Migration
// ══════════════════════════════════════════════════════════
async function migrate() {
  await run(`CREATE TABLE IF NOT EXISTS grp_approved (
    chat_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    approved_by BIGINT,
    approved_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(chat_id, user_id)
  )`).catch(() => {});
  await run(`CREATE TABLE IF NOT EXISTS grp_gbans (
    user_id BIGINT PRIMARY KEY,
    reason  TEXT DEFAULT '',
    banned_by BIGINT,
    banned_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => {});
  // msg_count على group_members
  await run('ALTER TABLE group_members ADD COLUMN IF NOT EXISTS msg_count INTEGER DEFAULT 0').catch(() => {});
  await run('ALTER TABLE group_members ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ DEFAULT NOW()').catch(() => {});
  // warn_limit على group_pro settings
  logger.info('✅ [GroupProFeatures] Migration done');
}

// ══════════════════════════════════════════════════════════
// 👮 1. /admins — قائمة المشرفين
// ══════════════════════════════════════════════════════════
async function handleAdmins(ctx) {
  if (!isGroup(ctx)) return;
  _del(ctx);
  const chatId = ctx.chat.id;
  try {
    const admins = await ctx.telegram.getChatAdministrators(chatId);
    const botRoles = await proDb.listRoles(chatId);
    const roleMap = {};
    for (const r of botRoles) roleMap[r.user_id] = r.role_key;

    const creator = admins.find(a => a.status === 'creator');
    const others  = admins.filter(a => a.status !== 'creator' && !a.user.is_bot);
    const bots    = admins.filter(a => a.user.is_bot);

    let text = '👮 *مشرفو القروب*\n━━━━━━━━━━━━━━━━\n\n';

    if (creator) {
      text += '👑 *المالك*\n';
      text += '• [' + (creator.user.first_name || 'مالك') + '](tg://user?id=' + creator.user.id + ')';
      if (creator.custom_title) text += ' _(' + creator.custom_title + ')_';
      text += '\n\n';
    }

    if (others.length) {
      text += '🛡 *المشرفون* (' + others.length + ')\n';
      for (const a of others) {
        const name = a.user.first_name || 'مشرف';
        const role = roleMap[a.user.id];
        text += '• [' + name + '](tg://user?id=' + a.user.id + ')';
        if (a.custom_title) text += ' _(' + a.custom_title + ')_';
        if (role) text += ' `' + require('./group_roles').roleLabel(role) + '`';
        text += '\n';
      }
      text += '\n';
    }

    if (bots.length) {
      text += '🤖 *البوتات* (' + bots.length + ')\n';
      for (const b of bots) text += '• @' + (b.user.username || b.user.first_name) + '\n';
    }

    text += '\n📊 الإجمالي: *' + (others.length + (creator ? 1 : 0)) + '* مشرف';

    cacheClear('tgadm_' + chatId + '_');
    await ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(() => {});
  } catch (e) {
    _tmp(ctx, '❌ فشل جلب قائمة المشرفين: ' + e.message, 5);
  }
}

// ══════════════════════════════════════════════════════════
// ✅ 2. نظام الاستثناء (Approval)
// ══════════════════════════════════════════════════════════
const _approvedCache = new Map(); // chatId → Set<userId>

async function loadApproved(chatId) {
  const ck = 'appv_' + chatId;
  let s = cacheGet(ck);
  if (s) return s;
  const rows = await all('SELECT user_id FROM grp_approved WHERE chat_id=$1', [chatId]).catch(() => []);
  s = new Set(rows.map(r => parseInt(r.user_id)));
  cacheSet(ck, s, 300000);
  return s;
}
async function isApproved(chatId, userId) {
  const s = await loadApproved(chatId).catch(() => new Set());
  return s.has(parseInt(userId));
}
function clearApprovedCache(chatId) { cacheClear('appv_' + chatId); }

async function handleApprove(ctx) {
  if (!isGroup(ctx) || !await isTgAdmin(ctx)) return;
  const target = await getTarget(ctx);
  _del(ctx);
  if (!target) return _tmp(ctx, '⚠️ رُد على رسالة العضو أو اكتب: `/approve @username`', 6);
  await run('INSERT INTO grp_approved(chat_id,user_id,approved_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [ctx.chat.id, target.id, ctx.from.id]).catch(() => {});
  clearApprovedCache(ctx.chat.id);
  _tmp(ctx, '✅ [' + target.name + '](tg://user?id=' + target.id + ') مستثنى من الحماية الآن.', 8);
}

async function handleUnapprove(ctx) {
  if (!isGroup(ctx) || !await isTgAdmin(ctx)) return;
  const target = await getTarget(ctx);
  _del(ctx);
  if (!target) return _tmp(ctx, '⚠️ رُد على رسالة العضو أو اكتب: `/unapprove @username`', 6);
  await run('DELETE FROM grp_approved WHERE chat_id=$1 AND user_id=$2', [ctx.chat.id, target.id]).catch(() => {});
  clearApprovedCache(ctx.chat.id);
  _tmp(ctx, '❌ تم إلغاء استثناء [' + target.name + '](tg://user?id=' + target.id + ').', 8);
}

async function handleApprovedList(ctx) {
  if (!isGroup(ctx)) return;
  _del(ctx);
  const rows = await all('SELECT user_id FROM grp_approved WHERE chat_id=$1', [ctx.chat.id]).catch(() => []);
  if (!rows.length) return _tmp(ctx, '📭 لا يوجد أعضاء مستثنون حالياً.', 6);
  let text = '✅ *الأعضاء المستثنون من الحماية*\n━━━━━━━━━━━━━━━━\n\n';
  for (const r of rows) text += '• [مستخدم](tg://user?id=' + r.user_id + ') `' + r.user_id + '`\n';
  text += '\n_عدد المستثنين: ' + rows.length + '_';
  ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// ⚠️ 3. /setwarnlimit — تحديد حد التحذيرات
// ══════════════════════════════════════════════════════════
async function getWarnLimit(chatId) {
  const s = await proDb.getRawSettings(chatId).catch(() => null);
  return parseInt(s?.warn_limit) || 3;
}

async function handleSetWarnLimit(ctx) {
  if (!isGroup(ctx) || !await isTgAdmin(ctx)) return;
  _del(ctx);
  const n = parseInt((ctx.message?.text || '').split(/\s+/)[1]);
  if (isNaN(n) || n < 1 || n > 10) return _tmp(ctx, '⚠️ `/setwarnlimit [1-10]` — مثال: `/setwarnlimit 5`', 6);
  await proDb.updateSettings(ctx.chat.id, { warn_limit: n });
  _tmp(ctx, '✅ حد التحذيرات الآن: *' + n + '* تحذير → حظر تلقائي.', 8);
}

// ══════════════════════════════════════════════════════════
// 📊 4. /topactive — أكثر الأعضاء إرسالاً (msg_count حقيقي)
// ══════════════════════════════════════════════════════════
// ⚡ PERF FIX: صار الاستعلام يشيل username كمان (كان index.js يسوي INSERT/UPDATE منفصل
// بنفس الجدول group_members على *كل* رسالة فقط عشان يحفظ username — دُمج هنا بستعلام
// واحد بدل استعلامين على كل رسالة. username تُحفظ عند أول INSERT فقط (نفس سلوك الكود
// القديم بالضبط)، و msg_count/last_active/updated_at تتحدّث بكل رسالة كما كانت.
async function trackMsg(chatId, userId, firstName, username) {
  run(
    `INSERT INTO group_members(chat_id,user_id,username,first_name,msg_count,last_active,updated_at)
     VALUES($1,$2,$3,$4,1,NOW(),NOW())
     ON CONFLICT(chat_id,user_id) DO UPDATE
       SET msg_count=group_members.msg_count+1, last_active=NOW(), updated_at=NOW()`,
    [chatId, userId, username || '', firstName || '']
  ).catch(() => {});
}

async function handleTopActive(ctx) {
  if (!isGroup(ctx)) return;
  _del(ctx);
  const chatId = ctx.chat.id;

  const top = await all(
    `SELECT user_id, first_name, msg_count FROM group_members
      WHERE chat_id=$1 AND msg_count > 0
      ORDER BY msg_count DESC LIMIT 10`,
    [chatId]
  ).catch(() => []);

  let total = 0;
  try { total = await ctx.telegram.getChatMembersCount(chatId); } catch (_) {}

  const RANK = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
  let text = '📊 *أكثر الأعضاء نشاطاً*\n━━━━━━━━━━━━━━━━\n\n';
  text += '👥 الأعضاء: *' + total.toLocaleString('en') + '*\n\n';

  if (!top.length) {
    text += '_لا توجد بيانات بعد. ابدأ المحادثة!_';
  } else {
    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      const name = r.first_name || ('مستخدم ' + r.user_id);
      text += RANK[i] + ' [' + name + '](tg://user?id=' + r.user_id + ') — *' + r.msg_count.toLocaleString('en') + '* رسالة\n';
    }
  }

  ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 🐌 5. /slowmode — وضع بطيء (API صحيح بدون setChatSlowMode)
// ══════════════════════════════════════════════════════════
async function handleSlowmode(ctx) {
  if (!isGroup(ctx) || !await isTgAdmin(ctx)) return _tmp(ctx, '🚫 للمشرفين فقط');
  _del(ctx);
  const arg = (ctx.message?.text || '').split(/\s+/)[1];
  let secs = parseInt(arg) || 0;
  if (secs < 0) secs = 0;
  if (secs > 86400) secs = 86400;

  try {
    // Telegraf 4.x يدعم callApi مباشرة
    await ctx.telegram.callApi('setChatSlowModeDelay', { chat_id: ctx.chat.id, slow_mode_delay: secs });
    if (secs === 0) _tmp(ctx, '✅ تم *إلغاء* الوضع البطيء.');
    else {
      const label = secs < 60 ? secs + ' ث' : secs < 3600 ? Math.floor(secs / 60) + ' د' : Math.floor(secs / 3600) + ' س';
      _tmp(ctx, '🐌 *الوضع البطيء:* رسالة كل *' + label + '*');
    }
  } catch (e) {
    // fallback: try alternate method name
    try {
      await ctx.telegram.callApi('setChatPermissions', {
        chat_id: ctx.chat.id,
        permissions: {},
        // Some API versions support slow_mode_delay here too
      });
    } catch (_) {}
    _tmp(ctx, '❌ يحتاج البوت لصلاحية "تعديل معلومات القروب": ' + e.message, 8);
  }
}

// ══════════════════════════════════════════════════════════
// 🛑 6. نظام الحظر العالمي (GBan)
// ══════════════════════════════════════════════════════════
async function handleGban(ctx) {
  if (!ctx.isOwner) return;
  const target = await getTarget(ctx);
  _del(ctx);
  if (!target) return _tmp(ctx, '⚠️ رُد على رسالة العضو أو: `/gban @username سبب`', 6);
  const reason = (ctx.message?.text || '').split(/\s+/).slice(target.username ? 2 : 2).join(' ').trim() || 'بدون سبب';

  await run('INSERT INTO grp_gbans(user_id,reason,banned_by) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET reason=$2',
    [target.id, reason, ctx.from.id]).catch(() => {});

  // حظر من كل قروبات البوت
  const groups = await all('SELECT chat_id FROM group_chats WHERE is_active=1').catch(() => []);
  let count = 0;
  for (const g of groups) {
    try { await ctx.telegram.banChatMember(g.chat_id, target.id); count++; } catch (_) {}
  }

  _tmp(ctx, '🛑 *حظر عالمي*\n👤 ID: `' + target.id + '`\n📝 ' + reason + '\n🔢 تم الحظر من *' + count + '* قروب.', 12);
}

async function handleUngban(ctx) {
  if (!ctx.isOwner) return;
  const target = await getTarget(ctx);
  _del(ctx);
  if (!target) return _tmp(ctx, '⚠️ رُد أو اكتب: `/ungban @username`', 6);
  await run('DELETE FROM grp_gbans WHERE user_id=$1', [target.id]).catch(() => {});
  _tmp(ctx, '✅ تم رفع الحظر العالمي عن `' + target.id + '`', 8);
}

// ── تحقق GBan عند الانضمام ──
async function checkGban(bot, chatId, userId) {
  try {
    const row = await get('SELECT reason FROM grp_gbans WHERE user_id=$1', [userId]);
    if (!row) return false;
    await bot.telegram.banChatMember(chatId, userId);
    return true;
  } catch (_) { return false; }
}

// ══════════════════════════════════════════════════════════
// 🔍 7. /whois — معلومات عضو
// ══════════════════════════════════════════════════════════
async function handleWhois(ctx) {
  _del(ctx);
  const target = await getTarget(ctx);
  if (!target) return _tmp(ctx, '⚠️ رُد على رسالة أو: `/whois @username`', 6);

  let tgInfo = null;
  try { tgInfo = await ctx.telegram.getChat(target.id); } catch (_) {}

  const chatId = ctx.chat?.id;
  const [memberRow, warnCount, gban] = await Promise.all([
    chatId ? get('SELECT msg_count, last_active FROM group_members WHERE chat_id=$1 AND user_id=$2', [chatId, target.id]).catch(() => null) : null,
    chatId ? get('SELECT COUNT(*)::int AS cnt FROM group_warns WHERE chat_id=$1 AND user_id=$2', [chatId, target.id]).catch(() => ({ cnt: 0 })) : null,
    get('SELECT reason FROM grp_gbans WHERE user_id=$1', [target.id]).catch(() => null),
  ]);

  const role = chatId ? await proDb.getRole(chatId, target.id).catch(() => null) : null;

  let text = '🔍 *معلومات المستخدم*\n━━━━━━━━━━━━━━━━\n\n';
  text += '👤 الاسم: [' + (tgInfo?.first_name || target.name) + '](tg://user?id=' + target.id + ')\n';
  if (tgInfo?.username) text += '🔗 المعرف: @' + tgInfo.username + '\n';
  text += '🆔 الرقم: `' + target.id + '`\n';
  if (tgInfo?.bio) text += '📝 البيو: _' + tgInfo.bio.substring(0, 80) + '_\n';
  if (role) text += '🎭 الرتبة: ' + require('./group_roles').roleLabel(role) + '\n';
  if (warnCount) text += '⚠️ التحذيرات: *' + warnCount.cnt + '*\n';
  if (memberRow?.msg_count) text += '💬 الرسائل: *' + memberRow.msg_count.toLocaleString('en') + '*\n';
  if (gban) text += '🛑 *محظور عالمياً:* ' + gban.reason + '\n';

  ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 🧹 8. /purgeto — حذف من رسالة معيّنة لأخرى
// ══════════════════════════════════════════════════════════
async function handlePurgeTo(ctx) {
  if (!isGroup(ctx) || !await isTgAdmin(ctx)) return;
  const replyTo = ctx.message?.reply_to_message;
  const current = ctx.message?.message_id;
  _del(ctx);
  if (!replyTo) return _tmp(ctx, '⚠️ رُد على الرسالة الأولى واكتب `/purgeto`', 6);

  const from = replyTo.message_id;
  const to   = current - 1; // الرسالة الأمر نفسها
  const count = to - from + 1;

  if (count > 100) return _tmp(ctx, '⚠️ الحد الأقصى 100 رسالة في المرة.', 6);

  const ids = Array.from({ length: count }, (_, i) => from + i);
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    try { await ctx.telegram.deleteMessages(ctx.chat.id, chunk); deleted += chunk.length; }
    catch (_) {
      for (const id of chunk) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, id); deleted++; } catch (_) {}
      }
    }
  }

  const m = await ctx.reply('🧹 تم حذف *' + deleted + '* رسالة.', { parse_mode: 'Markdown' }).catch(() => null);
  if (m) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 4000);
}

// ══════════════════════════════════════════════════════════
// 📣 9. /setjoin — رسالة ترحيب مخصصة بمتغيرات
// ══════════════════════════════════════════════════════════
async function handleSetJoin(ctx) {
  if (!isGroup(ctx) || !await isTgAdmin(ctx)) return;
  _del(ctx);
  const text = (ctx.message?.text || '').replace(/^\/setjoin\s*/i, '').trim();
  if (!text) return _tmp(ctx,
    '📖 *متغيرات رسالة الترحيب:*\n' +
    '`{name}` — اسم العضو\n`{mention}` — منشن\n`{count}` — عدد الأعضاء\n`{id}` — رقم العضو\n`{group}` — اسم القروب\n\n' +
    'مثال:\n`/setjoin أهلاً {mention} 👋\nعدد أعضاء {group}: {count}`', 15);

  await require('../database/db').run(
    'UPDATE group_chats SET welcome_message=$1 WHERE chat_id=$2',
    [text, ctx.chat.id]
  ).catch(() => {});
  cacheClear('welcome_' + ctx.chat.id);

  _tmp(ctx, '✅ تم تحديث رسالة الترحيب!\n\n_معاينة:_\n' + formatJoinMsg(text, {
    name: ctx.from?.first_name || 'عضو', id: ctx.from?.id || 0, count: '100', group: ctx.chat?.title || 'القروب',
  }), 12);
}

function formatJoinMsg(template, data) {
  return template
    .replace(/{name}/g,    data.name    || '')
    .replace(/{mention}/g, '[' + (data.name || 'عضو') + '](tg://user?id=' + (data.id || 0) + ')')
    .replace(/{count}/g,   data.count   || '')
    .replace(/{id}/g,      data.id      || '')
    .replace(/{group}/g,   data.group   || '');
}

// ══════════════════════════════════════════════════════════
// 🎛 واجهة أوامر الإدارة السريعة /cmds
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
// 🆘 لوحة المساعدة التفاعلية
// ══════════════════════════════════════════════════════════
const HELP_SECTIONS = {
  mod: {
    label: '🛡 الأعضاء',
    text: '🛡 *إدارة الأعضاء*\n━━━━━━━━━━━━━━━━\n_رد على رسالة العضو أو @username_\n\n`/ban [سبب]` أو `حظر` — حظر دائم\n`/unban` أو `فك حظر` — رفع حظر\n`/kick` أو `طرد` — طرد\n`/tempban 1h [سبب]` — حظر مؤقت\n`/mute [1h]` أو `كتم` — كتم\n`/unmute` أو `فك كتم` — رفع كتم\n`/warn [سبب]` أو `تحذير` — إنذار\n`/unwarn` أو `فك تحذير` — مسح إنذارات\n`/warns` أو `تحذيراته` — إنذاراته\n`/setwarnlimit [1-10]` — حد الإنذارات\n`ادارة` (رد) — لوحة أدمن سريعة',
  },
  content: {
    label: '📝 المحتوى',
    text: '📝 *إدارة المحتوى*\n━━━━━━━━━━━━━━━━\n`/pin` (رد) أو `تثبيت` — تثبيت\n`/unpin` أو `فك تثبيت` — إلغاء تثبيت\n`/del` (رد) أو `حذف` — حذف رسالة\n`/purge [n]` — حذف n رسالة\n`/purgeto` (رد) — حذف من-لحد\n`/save [اسم]` (رد) — حفظ ملاحظة\n`#اسم` — استدعاء ملاحظة\n`/notes` — كل الملاحظات\n`/delnote [اسم]` — حذف ملاحظة\n`/filter [trigger] [رد]` — فلتر تلقائي\n`/filters` — عرض الفلاتر\n`/delfilter [trigger]` — حذف فلتر',
  },
  protection: {
    label: '🔰 الحماية',
    text: '🔰 *نظام الحماية*\n━━━━━━━━━━━━━━━━\n`/protection` أو `الحماية` — اللوحة الكاملة\n\nأنواع الحماية (من اللوحة):\n• anti_spam • anti_link • anti_flood\n• anti_forward • anti_mention • anti_words\n• anti_caps • anti_duplicate • anti_edit\n• anti_bot • anti_raid\n• anti_short_link • anti_invite\n• anti_media • anti_file\n\n`/lock [نوع]` أو `قفل` — قفل وسائط\n`/unlock [نوع]` أو `فتح` — فتح وسائط\nالأنواع: sticker gif link forward photo video voice poll file chat\nمثال: `قفل شات` يمنع الكل من الكتابة إلا الأدمن\n`/setword [كلمة]` — إضافة كلمة محظورة\n`/delword [كلمة]` — حذف كلمة\n`/words` — القائمة',
  },
  roles: {
    label: '🎭 الرتب',
    text: '🎭 *الرتب والصلاحيات*\n━━━━━━━━━━━━━━━━\n`/setrole [رتبة]` (رد) — تعيين رتبة\n`/removerole` (رد) — إزالة رتبة\n`/roles` — عرض الرتب\n`رتبة +` (رد) — ترقية درجة\n`رتبة -` (رد) — تخفيض درجة\n\nالرتب:\n👑 manager — مدير\n🛡 super_admin — مشرف عام\n🔰 protection_admin — مشرف حماية\n📚 content_admin — مشرف محتوى\n🤝 assistant — مساعد\n\n`/approve` (رد) — استثناء من الحماية\n`/unapprove` (رد) — إلغاء استثناء\n`/approved` — قائمة المستثنين',
  },
  stats: {
    label: '📊 إحصائيات',
    text: '📊 *الإحصائيات والسجلات*\n━━━━━━━━━━━━━━━━\n`/stats` — إحصائيات القروب\n`/topactive` أو `الأنشط` — أنشط الأعضاء\n`/admins` أو `المشرفون` — قائمة المشرفين\n`/info` (رد) — معلومات عضو\n`/whois` (رد) — معلومات + gban\n`/logs` أو `السجلات` — سجلات القروب\n`/violations` (رد) — مخالفات الحماية\n`/summary` أو `تحليل` — تحليل AI',
  },
  tools: {
    label: '🔧 أدوات',
    text: '🔧 *الأدوات المتقدمة*\n━━━━━━━━━━━━━━━━\n`/schedule HH:MM رسالة` — جدولة رسالة\n`/watching @user` — مراقبة عضو\n`/unwatch @user` — إيقاف المراقبة\n`/slowmode [ثواني]` — وضع بطيء\n`/setjoin [رسالة]` — ترحيب مخصص\n  متغيرات: {name} {mention} {count} {group}\n`/rules` — قواعد القروب\n`/all [رسالة]` — منشن الكل\n`/verify` أو `التحقق` — التحقق من الأعضاء\n`/report` (رد) — بلاغ للمشرفين\n\n🚪 *طلبات الانضمام* — تلقائي بالكامل: فعّل "الموافقة على الأعضاء" من إعدادات القروب، وتطلع بطاقة بزري ✅ قبول / ❌ رفض لكل طلب',
  },
  topics: {
    label: '🧵 المواضيع',
    text: '🧵 *إدارة المواضيع (Topics)*\n━━━━━━━━━━━━━━━━\n_تحتاج تفعيل Topics من إعدادات القروب + صلاحية "إدارة المواضيع" للبوت_\n\n`موضوع` أو `/topic` — معلومات الموضوع الحالي\n`موضوع انشاء [اسم]` — إنشاء موضوع جديد\n`موضوع تسمية [اسم]` — تعديل اسم الموضوع الحالي\n`موضوع اغلاق` — إغلاق الموضوع الحالي\n`موضوع فتح` — إعادة فتح الموضوع الحالي\n\nℹ️ أوامر الإدارة العادية (تحذير/كتم/حظر...) تشتغل عادي جوّا أي موضوع وتحافظ على مكانها',
  },
  games: {
    label: '🎮 الألعاب',
    text: '🎮 *الألعاب والاقتصاد*\n━━━━━━━━━━━━━━━━\n`مليون` — من سيربح المليون\n`خمن` — لعبة التخمين\n`سلوت` — لعبة السلوت\n`زوج` — زوج اليوم\n`صح / حقيقة` — سؤال الحقيقة\n`جرأة` — تحدي الجرأة\n\n`يومي` أو `/daily` — المكافأة اليومية\n`عملة` أو `/flip` — رمي عملة\n`سرقة @user` — سرقة عضو\n`متصدرين` أو `/lb` — قائمة الأثرياء\n`بنكي` أو `/bank` — رصيد بنكي',
  },
};

function buildHelpHomeKb() {
  return { inline_keyboard: [
    [{ text: HELP_SECTIONS.mod.label,        callback_data: 'help_mod'        },
     { text: HELP_SECTIONS.content.label,    callback_data: 'help_content'    }],
    [{ text: HELP_SECTIONS.protection.label, callback_data: 'help_protection' },
     { text: HELP_SECTIONS.roles.label,      callback_data: 'help_roles'      }],
    [{ text: HELP_SECTIONS.stats.label,      callback_data: 'help_stats'      },
     { text: HELP_SECTIONS.tools.label,      callback_data: 'help_tools'      }],
    [{ text: HELP_SECTIONS.topics.label,     callback_data: 'help_topics'     },
     { text: HELP_SECTIONS.games.label,      callback_data: 'help_games'      }],
  ]};
}
function buildBackKb() {
  return { inline_keyboard: [[{ text: '◀️ رجوع', callback_data: 'help_home' }]] };
}
async function showHelpHome(ctx) {
  // ✅ فالخاص: قائمة خاصة بالمستخدم العادي (بحث/ألعاب/بنك/AI)
  if (ctx.chat?.type === 'private') return showPrivateHelpHome(ctx);
  const isCallback = !!ctx.callbackQuery;

  // ✅ إذا المالك عيّن ملف عام (تعيين الاوامر من الخاص)، نرسله مباشرة بدل لوحة الأزرار
  // (بس عند الكتابة المباشرة بقروب، مو أثناء التنقل بالأزرار داخل اللوحة نفسها)
  if (!isCallback && ['group', 'supergroup'].includes(ctx.chat?.type)) {
    const fileId = await require('./group_help_pdf').getGlobalHelpFileId().catch(() => null);
    if (fileId) {
      // ✅ رد حقيقي على رسالة "اوامر" نفسها (بلا حذفها، وإلا يضيع سياق الرد)
      return ctx.replyWithDocument(fileId, { reply_to_message_id: ctx.message.message_id }).catch(() => {});
    }
  }

  const txt = '🤖 *مركز المساعدة*\n━━━━━━━━━━━━━━━━\nاختر القسم:';
  if (isCallback) {
    await ctx.editMessageText(txt, { parse_mode: 'Markdown', reply_markup: buildHelpHomeKb() }).catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
  } else {
    if (['group','supergroup'].includes(ctx.chat?.type)) setTimeout(() => ctx.deleteMessage().catch(() => {}), 1000);
    await ctx.reply(txt, { parse_mode: 'Markdown', reply_markup: buildHelpHomeKb() }).catch(() => {});
  }
}
async function showHelpSection(ctx, key) {
  const sec = HELP_SECTIONS[key];
  if (!sec) return;
  await ctx.editMessageText(sec.text, { parse_mode: 'Markdown', reply_markup: buildBackKb() }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
}
function handleHelpCallback(ctx, data) {
  if (data.startsWith('phelp_')) return handlePrivateHelpCallback(ctx, data);
  if (data === 'help_home') return showHelpHome(ctx);
  const key = data.replace('help_', '');
  if (HELP_SECTIONS[key]) return showHelpSection(ctx, key);
  return false;
}
const CMDS_TEXT = Object.values(HELP_SECTIONS).map(s => s.text).join('\n\n');

// ══════════════════════════════════════════════════════════
// 🆘 لوحة المساعدة — نسخة المحادثة الخاصة
// ══════════════════════════════════════════════════════════
const PRIVATE_HELP_SECTIONS = {
  content: {
    label: '📚 المحتوى',
    text: '📚 *تصفح المحتوى*\n━━━━━━━━━━━━━━━━\n`/start` — القائمة الرئيسية\n`بحث [اسم]` — بحث سريع\n`جديد` — آخر الملفات المضافة\n`مفضلاتي` — ملفاتك المحفوظة\n`سجلي` — الملفات اللي حملتها\n`ملفي` — بروفايلك',
  },
  topics: {
    label: '🧵 المواضيع',
    text: '🧵 *إدارة المواضيع (Topics)*\n━━━━━━━━━━━━━━━━\n_تحتاج تفعيل Topics من إعدادات القروب + صلاحية "إدارة المواضيع" للبوت_\n\n`موضوع` أو `/topic` — معلومات الموضوع الحالي\n`موضوع انشاء [اسم]` — إنشاء موضوع جديد\n`موضوع تسمية [اسم]` — تعديل اسم الموضوع الحالي\n`موضوع اغلاق` — إغلاق الموضوع الحالي\n`موضوع فتح` — إعادة فتح الموضوع الحالي\n\nℹ️ أوامر الإدارة العادية (تحذير/كتم/حظر...) تشتغل عادي جوّا أي موضوع وتحافظ على مكانها',
  },
  games: {
    label: '🎮 الألعاب',
    text: '🎮 *الألعاب*\n━━━━━━━━━━━━━━━━\n`مليون` — من سيربح المليون\n`خمن` — لعبة التخمين\n`انا` — الانضمام للعبة جارية\n`صح` أو `/truth` — سؤال صراحة\n`جرأة` أو `/dare` — تحدي جرأة\n`زوج` أو `/couple` — زوج اليوم\n`سلوت` أو `/slot` — ماكينة القمار\n`/gamestatus` — حالة الألعاب الجارية',
  },
  bank: {
    label: '💰 البنك',
    text: '💰 *النظام البنكي*\n━━━━━━━━━━━━━━━━\n`انشاء حساب` — فتح حساب بنكي\n`فلوسي` — رصيدك الحالي\n`فارسي [مبلغ]` (رد) — تحويل لشخص\n`rip [مبلغ]` (رد) — إقراض شخص\n`يومي` أو `/daily` — مكافأة يومية\n`عملة` أو `/flip` — قلب عملة\n`سرقة` أو `/rob` (رد) — سرقة\n`متصدرين` أو `/leaderboard` — الأثرياء\n`متجر` أو `/market` — متجر البوت',
  },
  ai: {
    label: '🤖 الذكاء الاصطناعي',
    text: '🤖 *مساعد AI*\n━━━━━━━━━━━━━━━━\nتحدث مباشرة مع البوت فالخاص\n`/summarize` أو `لخص` (رد على ملف) — تلخيص',
  },
};

function buildPrivateHelpHomeKb() {
  return { inline_keyboard: [
    [{ text: PRIVATE_HELP_SECTIONS.content.label, callback_data: 'phelp_content' },
     { text: PRIVATE_HELP_SECTIONS.games.label,   callback_data: 'phelp_games'   }],
    [{ text: PRIVATE_HELP_SECTIONS.bank.label,    callback_data: 'phelp_bank'    },
     { text: PRIVATE_HELP_SECTIONS.ai.label,      callback_data: 'phelp_ai'      }],
  ]};
}
function buildPrivateBackKb() {
  return { inline_keyboard: [[{ text: '◀️ رجوع', callback_data: 'phelp_home' }]] };
}
async function showPrivateHelpHome(ctx) {
  const isCallback = !!ctx.callbackQuery;
  const txt = '🤖 *مركز المساعدة*\n━━━━━━━━━━━━━━━━\nاختر القسم:\n\n💡 _إذا رغبت بأوامر إدارة قروب معين، اكتب اوامر داخل ذاك القروب مباشرة._';
  if (isCallback) {
    await ctx.editMessageText(txt, { parse_mode: 'Markdown', reply_markup: buildPrivateHelpHomeKb() }).catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
  } else {
    await ctx.reply(txt, { parse_mode: 'Markdown', reply_markup: buildPrivateHelpHomeKb() }).catch(() => {});
  }
}
async function showPrivateHelpSection(ctx, key) {
  const sec = PRIVATE_HELP_SECTIONS[key];
  if (!sec) return;
  await ctx.editMessageText(sec.text, { parse_mode: 'Markdown', reply_markup: buildPrivateBackKb() }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
}
function handlePrivateHelpCallback(ctx, data) {
  if (data === 'phelp_home') return showPrivateHelpHome(ctx);
  const key = data.replace('phelp_', '');
  if (PRIVATE_HELP_SECTIONS[key]) return showPrivateHelpSection(ctx, key);
  return false;
}

// ══════════════════════════════════════════════════════════
// 🔁 تسجيل الأوامر
// ══════════════════════════════════════════════════════════
function setupProFeatures(bot) {
  migrate().catch(() => {});

  // 👮 مشرفون
  bot.command(['admins', 'admin', 'مشرفون', 'المشرفين', 'المشرفون'], handleAdmins);
  bot.hears(/^(المشرفون|مشرفون|المشرفين)$/, handleAdmins);

  // ✅ استثناء
  bot.command(['approve', 'استثناء'],  handleApprove);
  bot.hears(/^(موافقة|استثناء)(?:\s+.+)?$/, handleApprove);
  bot.command(['unapprove', 'الغاء_استثناء'], handleUnapprove);
  bot.command(['approved',  'المستثنون'],  handleApprovedList);

  // ⚠️ حد التحذيرات
  bot.command(['setwarnlimit', 'حد_التحذيرات'], handleSetWarnLimit);
  bot.hears(/^حد_التحذيرات(?:\s+\d+)?$/, handleSetWarnLimit);

  // 📊 الأنشط
  bot.command(['topactive', 'الأنشط', 'نشاط', 'topusers'], handleTopActive);
  bot.hears(/^(الأنشط|نشاط)$/, handleTopActive);

  // 🐌 وضع بطيء
  bot.command(['slowmode', 'slow', 'بطيء'], handleSlowmode);
  bot.hears(/^وضع بطيء (\d+)$/, async ctx => {
    ctx.message.text = '/slowmode ' + ctx.match[1];
    return handleSlowmode(ctx);
  });

  // 🛑 حظر عالمي
  bot.command(['gban', 'حظرعالمي'],       handleGban);
  bot.command(['ungban', 'رفع_حظرعالمي'], handleUngban);

  // 🔍 معلومات
  bot.command(['whois', 'معلومات_مستخدم'], handleWhois);
  bot.hears(/^معلومات_مستخدم(?:\s+.+)?$/, handleWhois);

  // 🧹 purgeto
  bot.command(['purgeto', 'حذف_لحد'], handlePurgeTo);

  // 📣 setjoin
  bot.command(['setjoin', 'رسالة_ترحيب'], handleSetJoin);

  // 🆘 help — لوحة تفاعلية بالأزرار
  bot.command(['help', 'مساعدة', 'cmds', 'commands', 'اوامر', 'أوامر'], showHelpHome);
  bot.hears(/^(مساعدة|اوامر|الاوامر)$/, showHelpHome);
  bot.action(/^phelp_/, ctx => handlePrivateHelpCallback(ctx, ctx.callbackQuery.data));
}

module.exports = {
  setupProFeatures, migrate,
  isApproved, checkGban, trackMsg, formatJoinMsg,
  handleAdmins, handleApprove, handleUnapprove, handleApprovedList,
  handleSetWarnLimit, getWarnLimit, handleTopActive, handleSlowmode,
  handleGban, handleUngban, handleWhois, handlePurgeTo, handleSetJoin,
  showHelpHome, handleHelpCallback, HELP_SECTIONS, CMDS_TEXT,
};
