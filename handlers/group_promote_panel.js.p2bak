'use strict';
// ══════════════════════════════════════════════════════════
// 👑 نظام الترقية الاحترافي — ترقية عضو لأدمن حقيقي بتيليجرام
// + لوحة صلاحيات تفاعلية تعرض الحالة الحية الحقيقية دايماً
// ملف مستقل تماماً — لا يلمس group_protection.js
// ══════════════════════════════════════════════════════════

function isGroup(ctx) { return ['group', 'supergroup'].includes(ctx.chat?.type); }

async function isTgAdminOrOwner(ctx) {
  const uid = ctx.from?.id;
  if (Number(uid) === Number(process.env.OWNER_ID)) return true;
  try {
    const m = await ctx.telegram.getChatMember(ctx.chat.id, uid);
    return ['administrator', 'creator'].includes(m?.status);
  } catch (e) { return false; }
}

// 🔑 كل صلاحيات promoteChatMember القابلة للتبديل (can_manage_chat أساس دائم)
const PERM_LIST = [
  ['can_change_info',       '✏️ تعديل معلومات القروب'],
  ['can_delete_messages',   '🗑 حذف الرسائل'],
  ['can_invite_users',      '🔗 دعوة أعضاء'],
  ['can_restrict_members',  '🚫 تقييد/حظر الأعضاء'],
  ['can_pin_messages',      '📌 تثبيت الرسائل'],
  ['can_promote_members',   '👑 ترقية أعضاء آخرين'],
  ['can_manage_video_chats','🎥 إدارة المكالمات الجماعية'],
  ['can_manage_topics',     '🧵 إدارة المواضيع'],
  ['can_post_stories',      '📖 نشر Stories'],
  ['can_edit_stories',      '✏️ تعديل Stories'],
  ['can_delete_stories',    '🗑 حذف Stories'],
  ['is_anonymous',          '🕵️ إخفاء هوية الأدمن'],
];

async function getTarget(ctx) {
  const msg = ctx.message;
  if (msg.reply_to_message?.from) {
    const u = msg.reply_to_message.from;
    return { id: u.id, name: u.first_name || 'عضو' };
  }
  const args = (msg.text || '').split(/\s+/).slice(1);
  const raw = args[0];
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return { id: parseInt(raw), name: 'ID:' + raw };
  if (raw.startsWith('@')) {
    try {
      const { get } = require('../database/db');
      const uname = raw.replace('@', '');
      const row = await get(
        'SELECT user_id, first_name FROM group_members WHERE chat_id=$1 AND username ILIKE $2 LIMIT 1',
        [ctx.chat.id, uname]
      );
      if (row) return { id: row.user_id, name: row.first_name || raw };
    } catch (e) { /* ignore */ }
  }
  return null;
}

// 📡 يجيب الحالة الحقيقية الحية من تيليجرام مباشرة (بلا اعتماد على أي قيمة محسوبة محلياً)
async function getLiveFlags(ctx, chatId, targetId) {
  const m = await ctx.telegram.getChatMember(chatId, targetId);
  const flags = {};
  for (const [key] of PERM_LIST) flags[key] = !!(m && m[key]);
  return { member: m, flags };
}

function buildPanelKb(chatId, targetId, flags) {
  const rows = PERM_LIST.map(([key, label]) =>
    [{ text: (flags[key] ? '🟢 ' : '🔴 ') + label, callback_data: 'gp_promo_tog_' + key + '_' + chatId + '_' + targetId }]
  );
  rows.push([{ text: 'إغلاق', callback_data: 'gp_promo_close' }]);
  return { inline_keyboard: rows };
}

function panelText(target, notice) {
  return '👑 *لوحة صلاحيات الأدمن*\n━━━━━━━━━━━━━━━━━━\n👤 ' + target.name + '\n🆔 `' + target.id + '`\n\n' +
    (notice ? notice + '\n\n' : '') +
    '🟢/🔴 = الحالة الحقيقية الحالية على تيليجرام (يُحدَّث حياً بعد كل ضغطة):';
}

async function promoteHandler(ctx) {
  if (!isGroup(ctx)) return;
  if (!(await isTgAdminOrOwner(ctx))) return ctx.reply('🚫 للمشرفين فقط.').catch(() => {});
  const target = await getTarget(ctx);
  if (!target) return ctx.reply('⚠️ رُد على رسالة العضو، أو اكتب: ترقية @username').catch(() => {});

  const chatId = ctx.chat.id;

  // ✅ نتحقق أولاً: هل هو أدمن أصلاً؟ إذا لا، نرقّيه بأساس can_manage_chat فقط
  let already;
  try { already = await ctx.telegram.getChatMember(chatId, target.id); } catch (e) { already = null; }

  if (!already || already.status !== 'administrator') {
    try {
      await ctx.telegram.promoteChatMember(chatId, target.id, { can_manage_chat: true });
    } catch (e) {
      return ctx.reply('❌ تعذّرت الترقية: ' + (e.description || e.message) + '\n⚠️ تأكد أن البوت أدمن بصلاحية "تعيين مشرفين".').catch(() => {});
    }
  }

  // 📡 نجيب الحالة الحقيقية بعد الترقية مباشرة (لا نخمّن)
  let live;
  try { live = await getLiveFlags(ctx, chatId, target.id); }
  catch (e) { return ctx.reply('❌ تعذر جلب حالة العضو بعد الترقية: ' + (e.description || e.message)).catch(() => {}); }

  ctx.reply(panelText(target), {
    parse_mode: 'Markdown',
    reply_markup: buildPanelKb(chatId, target.id, live.flags),
  }).catch(() => {});
}

async function handleCallback(ctx, data) {
  if (data === 'gp_promo_close') {
    return ctx.deleteMessage().catch(() => {});
  }

  const rest = data.replace('gp_promo_tog_', '');
  const parts = rest.split('_');
  const targetId = Number(parts.pop());
  const chatId = Number(parts.pop());
  const permKey = parts.join('_');

  if (!(await isTgAdminOrOwner(ctx))) {
    return ctx.answerCbQuery('🚫 ليس لديك صلاحية', { show_alert: true }).catch(() => {});
  }

  // 1) نجيب الحالة الحية الحقيقية الحالية (المصدر الوحيد للحقيقة)
  let live;
  try { live = await getLiveFlags(ctx, chatId, targetId); }
  catch (e) { return ctx.answerCbQuery('❌ تعذر جلب حالة العضو', { show_alert: true }).catch(() => {}); }

  if (!live.member || live.member.status !== 'administrator') {
    return ctx.answerCbQuery('⚠️ العضو لم يعد أدمن', { show_alert: true }).catch(() => {});
  }
  if (!(permKey in live.flags)) {
    return ctx.answerCbQuery('❌ صلاحية غير معروفة: ' + permKey, { show_alert: true }).catch(() => {});
  }

  // 2) نبدّل الصلاحية المطلوبة بس، ونبقي الباقي كيفما هو حقيقياً
  const newFlags = { ...live.flags, can_manage_chat: true };
  newFlags[permKey] = !live.flags[permKey];

  let applyError = null;
  try {
    await ctx.telegram.promoteChatMember(chatId, targetId, newFlags);
  } catch (e) {
    applyError = e.description || e.message;
  }

  // 3) نعيد الجلب الحي بعد التعديل — إذا ما تغيّرش، هذا دليل قاطع إن تيليجرام رفض التغيير (نوريه صراحة)
  let after;
  try { after = await getLiveFlags(ctx, chatId, targetId); }
  catch (e) { after = live; }

  const target = { id: targetId, name: live.member.user?.first_name || 'عضو' };
  let notice = null;
  if (applyError) {
    notice = '⚠️ فشل التحديث: ' + applyError;
  } else if (after.flags[permKey] === live.flags[permKey]) {
    notice = '⚠️ تيليجرام لم يطبّق هذا التغيير (تأكد أن البوت نفسه يملك هذه الصلاحية).';
  }

  await ctx.editMessageText(panelText(target, notice), {
    parse_mode: 'Markdown',
    reply_markup: buildPanelKb(chatId, targetId, after.flags),
  }).catch(() => {});
  ctx.answerCbQuery(notice ? '⚠️ راجع الرسالة' : '✅ تم التحديث فعلياً').catch(() => {});
}

function setupPromoteCommands(bot) {
  bot.hears(/^ترقية(?:\s+.+)?$/i, promoteHandler);
}

module.exports = { setupPromoteCommands, handleCallback };
