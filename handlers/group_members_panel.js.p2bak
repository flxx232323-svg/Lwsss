'use strict';
/**
 * 👥 handlers/group_members_panel.js
 * ──────────────────────────────────────────────────────────────
 * لوحة إدارة أعضاء احترافية بالكامل عبر أزرار Inline — بلا أي
 * قائمة نصية. مبنية لتتحمل قروبات ضخمة (آلاف/مئات آلاف الأعضاء):
 *   - Pagination حقيقي (8 بالصفحة، بلا تحميل كل الأعضاء دفعة وحدة)
 *   - بحث بالاسم / اليوزر / الـ ID
 *   - أقسام: الكل، المشرفين، الأعضاء الجدد، الأكثر نشاطاً، غير النشيطين
 *   - بطاقة عضو كاملة + أزرار إدارة حقيقية (ترقية/تنزيل/كتم/حظر/طرد/مراسلة)
 *   - كل التنقل عبر editMessageText — رسالة واحدة فقط تتحدث باستمرار
 * ──────────────────────────────────────────────────────────────
 */
const { run, get, all } = require('../database/db');
const logger = require('../utils/logger');

// ✅ يتحقق من صلاحية المستخدم فـ القروب المستهدف بالذات (chatId)،
//    وليس فـ ctx.chat.id (اللي يكون المحادثة الخاصة عند الدخول من لوحة الإدارة عن بعد)
async function isTgAdmin(ctx, chatId) {
  if (ctx.isOwner || ctx.isAdmin) return true;
  try {
    const member = await ctx.telegram.getChatMember(chatId, ctx.from.id);
    return ['administrator', 'creator'].includes(member?.status);
  } catch { return false; }
}

const PAGE_SIZE = 8;

// ── تجهيز العمود الإضافي joined_at (تاريخ انضمام حقيقي، لا يُلمس عند كل رسالة) ──
(async () => {
  try {
    await run('ALTER TABLE group_members ADD COLUMN IF NOT EXISTS joined_at TIMESTAMP DEFAULT NOW()');
  } catch (_) {}
})();

function esc(t) {
  return String(t || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}
function truncName(n, max = 28) {
  n = String(n || 'مجهول').replace(/[\r\n]/g, ' ').trim();
  return n.length > max ? n.slice(0, max - 1) + '…' : n;
}
function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return '—'; }
}
function fmtAgo(d) {
  if (!d) return 'لا يوجد نشاط مسجّل';
  const diffMin = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (diffMin < 1) return 'الآن';
  if (diffMin < 60) return `منذ ${diffMin} دقيقة`;
  if (diffMin < 1440) return `منذ ${Math.floor(diffMin / 60)} ساعة`;
  return `منذ ${Math.floor(diffMin / 1440)} يوم`;
}

// ══════════════════════════════════════════════════════════
// 🏠 الصفحة الرئيسية للوحة الأعضاء
// ══════════════════════════════════════════════════════════
async function showMembersHub(ctx, chatId) {
  if (!await isTgAdmin(ctx, chatId)) {
    return ctx.answerCbQuery('🚫 هذا القسم للمشرفين فقط', { show_alert: true }).catch(() => {});
  }
  const tgTotal = await ctx.telegram.getChatMembersCount(chatId).catch(() => 0);
  const dbTotal = await get('SELECT COUNT(*) c FROM group_members WHERE chat_id=$1', [chatId]).catch(() => ({ c: 0 }));

  const text =
    `👥 <b>لوحة إدارة الأعضاء</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📊 مسجّلون فـ البوت: <b>${dbTotal?.c || 0}</b>\n` +
    `📈 إجمالي القروب (تيليجرام): <b>${tgTotal}</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `اختر القسم اللي تحب تتصفحو 👇`;

  const kb = {
    inline_keyboard: [
      [{ text: '🔎 بحث عن عضو', callback_data: `gm_search_${chatId}` }],
      [{ text: '📋 كل الأعضاء', callback_data: `gm_list_all_${chatId}_0` },
       { text: '👑 المشرفين', callback_data: `gm_list_admins_${chatId}_0` }],
      [{ text: '🆕 الأعضاء الجدد', callback_data: `gm_list_new_${chatId}_0` },
       { text: '🔥 الأكثر نشاطاً', callback_data: `gm_list_active_${chatId}_0` }],
      [{ text: '😴 غير نشيطين', callback_data: `gm_list_inactive_${chatId}_0` }],
      [{ text: '◀️ رجوع', callback_data: `gp_view_${chatId}` }],
    ],
  };

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
    return ctx.answerCbQuery().catch(() => {});
  }
  return ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 📋 قائمة مُقسّمة على صفحات — أزرار فقط، بلا نص أسماء فالرسالة
// ══════════════════════════════════════════════════════════
const MODE_LABELS = {
  all: '📋 كل الأعضاء', admins: '👑 المشرفين', new: '🆕 الأعضاء الجدد',
  active: '🔥 الأكثر نشاطاً', inactive: '😴 غير نشيطين', search: '🔎 نتائج البحث',
};

async function fetchPage(chatId, mode, page, ctx, query) {
  const offset = page * PAGE_SIZE;
  if (mode === 'admins') {
    const admins = await ctx.telegram.getChatAdministrators(chatId).catch(() => []);
    const list = admins.filter(a => !a.user.is_bot).map(a => ({
      user_id: a.user.id, first_name: a.user.first_name, username: a.user.username,
    }));
    return { rows: list.slice(offset, offset + PAGE_SIZE), total: list.length };
  }
  if (mode === 'search') {
    const q = `%${query}%`;
    const isNum = /^\d+$/.test(query);
    const rows = await all(
      `SELECT user_id, first_name, username FROM group_members
        WHERE chat_id=$1 AND (first_name ILIKE $2 OR username ILIKE $2 ${isNum ? 'OR user_id::text = $3' : ''})
        ORDER BY msg_count DESC NULLS LAST LIMIT $4 OFFSET $5`,
      isNum ? [chatId, q, query, PAGE_SIZE, offset] : [chatId, q, PAGE_SIZE, offset]
    ).catch(() => []);
    const cnt = await get(
      `SELECT COUNT(*) c FROM group_members WHERE chat_id=$1 AND (first_name ILIKE $2 OR username ILIKE $2 ${isNum ? 'OR user_id::text = $3' : ''})`,
      isNum ? [chatId, q, query] : [chatId, q]
    ).catch(() => ({ c: 0 }));
    return { rows, total: cnt?.c || 0 };
  }

  const orderMap = {
    all: 'updated_at DESC',
    new: 'joined_at DESC NULLS LAST',
    active: 'msg_count DESC NULLS LAST',
    inactive: 'last_active ASC NULLS FIRST',
  };
  const order = orderMap[mode] || 'updated_at DESC';
  const rows = await all(
    `SELECT user_id, first_name, username FROM group_members WHERE chat_id=$1 ORDER BY ${order} LIMIT $2 OFFSET $3`,
    [chatId, PAGE_SIZE, offset]
  ).catch(() => []);
  const cnt = await get('SELECT COUNT(*) c FROM group_members WHERE chat_id=$1', [chatId]).catch(() => ({ c: 0 }));
  return { rows, total: cnt?.c || 0 };
}

async function showMembersList(ctx, chatId, mode, page, query) {
  if (!await isTgAdmin(ctx, chatId)) {
    return ctx.answerCbQuery('🚫 للمشرفين فقط', { show_alert: true }).catch(() => {});
  }
  const { rows, total } = await fetchPage(chatId, mode, page, ctx, query);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (!rows.length) {
    const emptyKb = { inline_keyboard: [[{ text: '◀️ رجوع', callback_data: `gm_home_${chatId}` }]] };
    const emptyTxt = `📭 لا يوجد أعضاء فـ هذا القسم${query ? ` لـ "${esc(query)}"` : ''}.`;
    if (ctx.callbackQuery) { await ctx.editMessageText(emptyTxt, { reply_markup: emptyKb }).catch(() => {}); return ctx.answerCbQuery().catch(() => {}); }
    return ctx.reply(emptyTxt, { reply_markup: emptyKb }).catch(() => {});
  }

  const label = MODE_LABELS[mode] || '📋 الأعضاء';
  const header = `${label}\n━━━━━━━━━━━━━━━━━━\nصفحة ${page + 1} من ${totalPages} • الإجمالي: ${total}${query ? `\n🔎 "${esc(query)}"` : ''}\n\nاضغط على أي عضو لعرض بطاقته:`;

  const memberBtns = rows.map(m => ([{
    text: `👤 ${truncName(m.first_name)}${m.username ? ' (@' + m.username + ')' : ''}`,
    callback_data: `gm_card_${chatId}_${m.user_id}`,
  }]));

  const navRow = [];
  const encQ = query ? '_' + encodeURIComponent(query).slice(0, 20) : '';
  if (page > 0) navRow.push({ text: '◀ السابق', callback_data: `gm_list_${mode}_${chatId}_${page - 1}${encQ}` });
  if ((page + 1) * PAGE_SIZE < total) navRow.push({ text: 'التالي ▶', callback_data: `gm_list_${mode}_${chatId}_${page + 1}${encQ}` });

  const kb = { inline_keyboard: [...memberBtns, ...(navRow.length ? [navRow] : []), [{ text: '◀️ رجوع للوحة', callback_data: `gm_home_${chatId}` }]] };

  if (ctx.callbackQuery) {
    await ctx.editMessageText(header, { reply_markup: kb }).catch(() => {});
    return ctx.answerCbQuery().catch(() => {});
  }
  return ctx.reply(header, { reply_markup: kb }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 🪪 بطاقة عضو كاملة + أزرار إدارة حقيقية
// ══════════════════════════════════════════════════════════
async function showMemberCard(ctx, chatId, targetUserId) {
  if (!await isTgAdmin(ctx, chatId)) {
    return ctx.answerCbQuery('🚫 للمشرفين فقط', { show_alert: true }).catch(() => {});
  }
  const [row, tgMember] = await Promise.all([
    get('SELECT * FROM group_members WHERE chat_id=$1 AND user_id=$2', [chatId, targetUserId]).catch(() => null),
    ctx.telegram.getChatMember(chatId, targetUserId).catch(() => null),
  ]);

  if (!row && !tgMember) {
    return ctx.answerCbQuery('❌ العضو غير موجود', { show_alert: true }).catch(() => {});
  }

  const name = tgMember?.user?.first_name || row?.first_name || 'مجهول';
  const username = tgMember?.user?.username || row?.username;
  const status = tgMember?.status;
  const statusLabel = { creator: '👑 مالك', administrator: '🛡️ مشرف', member: '👤 عضو', restricted: '🔇 مقيّد', left: '🚪 غادر', kicked: '🚫 محظور' }[status] || '❓';

  const text =
    `🪪 <b>بطاقة العضو</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `👤 الاسم: <b>${esc(name)}</b>\n` +
    (username ? `🔗 اليوزر: @${esc(username)}\n` : '') +
    `🆔 المعرّف: <code>${targetUserId}</code>\n` +
    `🎖️ الرتبة: ${statusLabel}\n` +
    `💬 عدد الرسائل: <b>${row?.msg_count || 0}</b>\n` +
    `📅 انضم: ${fmtDate(row?.joined_at)}\n` +
    `🕓 آخر نشاط: ${fmtAgo(row?.last_active)}`;

  const rows = [];
  if (status === 'member' || status === 'restricted') {
    rows.push([
      { text: '⬆️ ترقية لمشرف', callback_data: `gm_act_promote_${chatId}_${targetUserId}` },
      { text: '🔇 كتم', callback_data: `gm_act_mute_${chatId}_${targetUserId}` },
    ]);
    rows.push([
      { text: '👢 طرد', callback_data: `gm_act_kick_${chatId}_${targetUserId}` },
      { text: '⛔ حظر', callback_data: `gm_act_ban_${chatId}_${targetUserId}` },
    ]);
  } else if (status === 'administrator') {
    rows.push([{ text: '⬇️ تنزيل رتبة', callback_data: `gm_act_demote_${chatId}_${targetUserId}` }]);
  } else if (status === 'kicked') {
    rows.push([{ text: '✅ فك الحظر', callback_data: `gm_act_unban_${chatId}_${targetUserId}` }]);
  }
  rows.push([{ text: '✉️ مراسلة العضو', callback_data: `gm_act_msg_${chatId}_${targetUserId}` }]);
  rows.push([{ text: '◀️ رجوع', callback_data: `gm_home_${chatId}` }]);

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }).catch(() => {});
  return ctx.answerCbQuery().catch(() => {});
}

// ══════════════════════════════════════════════════════════
// ⚡ تنفيذ إجراءات الإدارة (تستخدم دوال group_admin الموجودة فعلاً)
// ══════════════════════════════════════════════════════════
async function handleMemberAction(ctx, action, chatId, targetUserId) {
  if (!await isTgAdmin(ctx, chatId)) {
    return ctx.answerCbQuery('🚫 للمشرفين فقط', { show_alert: true }).catch(() => {});
  }
  const admin = require('./group_admin');

  try {
    if (action === 'promote') {
      await ctx.telegram.promoteChatMember(chatId, targetUserId, {
        can_delete_messages: true, can_restrict_members: true,
        can_pin_messages: true, can_invite_users: true, can_manage_chat: true,
      });
      await ctx.answerCbQuery('✅ تمت الترقية').catch(() => {});
    } else if (action === 'demote') {
      await ctx.telegram.promoteChatMember(chatId, targetUserId, {
        can_delete_messages: false, can_restrict_members: false,
        can_pin_messages: false, can_invite_users: false, can_manage_chat: false,
      });
      await ctx.answerCbQuery('✅ تم تنزيل الرتبة').catch(() => {});
    } else if (action === 'mute') {
      await ctx.telegram.restrictChatMember(chatId, targetUserId, {
        permissions: { can_send_messages: false },
        until_date: Math.floor(Date.now() / 1000) + 3600, // ساعة واحدة افتراضياً
      });
      await ctx.answerCbQuery('🔇 تم الكتم لمدة ساعة').catch(() => {});
    } else if (action === 'kick') {
      await ctx.telegram.banChatMember(chatId, targetUserId);
      await ctx.telegram.unbanChatMember(chatId, targetUserId, { only_if_banned: true });
      await ctx.answerCbQuery('👢 تم الطرد').catch(() => {});
    } else if (action === 'ban') {
      await ctx.telegram.banChatMember(chatId, targetUserId);
      await ctx.answerCbQuery('⛔ تم الحظر').catch(() => {});
    } else if (action === 'unban') {
      await ctx.telegram.unbanChatMember(chatId, targetUserId, { only_if_banned: true });
      await ctx.answerCbQuery('✅ تم فك الحظر').catch(() => {});
    } else if (action === 'msg') {
      await require('../utils/stateManager').setState(ctx.uid, { type: 'gm_dm', chatId, targetUserId });
      await ctx.answerCbQuery().catch(() => {});
      return ctx.reply('✉️ اكتب أو ابعت (نص/ستيكر/صورة/فيديو/فويس) اللي تحب تبعتو لهذا العضو:\n_(أو /cancel)_', { parse_mode: 'Markdown' }).catch(() => {});
    }
  } catch (e) {
    logger.error('[gm_act] ' + action + ' failed: ' + e.message);
    let hint = e.description || e.message || '';
    if (/not enough rights|CHAT_ADMIN_REQUIRED/i.test(hint)) {
      hint = 'البوت ما عندوش صلاحية كافية فهذا القروب (تأكد إنه Admin بصلاحية "تعيين مشرفين")';
    } else if (/user is an administrator of the chat/i.test(hint)) {
      hint = 'ما تقدرش تدير هذا الإجراء على مشرف آخر رتبتو أعلى من البوت';
    }
    return ctx.answerCbQuery('❌ فشل الإجراء: ' + hint, { show_alert: true }).catch(() => {});
  }

  return showMemberCard(ctx, chatId, targetUserId);
}

// ── معالجة رسائل الحالة (بحث / مراسلة عضو نصية) ──
async function handleText(ctx, txt, state) {
  if (state.type === 'gm_dm') {
    require('../utils/stateManager').delState(ctx.uid);
    if (txt === '/cancel') return ctx.reply('❌ تم الإلغاء.').catch(() => {});
    try {
      await ctx.telegram.sendMessage(state.targetUserId, `📩 رسالة من إدارة القروب:\n\n${txt}`);
      return ctx.reply('✅ تم إرسال الرسالة.').catch(() => {});
    } catch (e) {
      return ctx.reply('❌ ما قدرتش نبعت الرسالة (يمكن العضو ما بداش محادثة مع البوت).').catch(() => {});
    }
  }
  if (state.type === 'gm_search') {
    require('../utils/stateManager').delState(ctx.uid);
    if (txt === '/cancel') return ctx.reply('❌ تم الإلغاء.').catch(() => {});
    return showMembersList(ctx, state.chatId, 'search', 0, txt.trim().slice(0, 60));
  }
  return false;
}

async function requestSearch(ctx, chatId) {
  if (!await isTgAdmin(ctx, chatId)) return ctx.answerCbQuery('🚫 للمشرفين فقط', { show_alert: true }).catch(() => {});
  await require('../utils/stateManager').setState(ctx.uid, { type: 'gm_search', chatId });
  await ctx.answerCbQuery().catch(() => {});
  return ctx.reply('🔎 اكتب اسم العضو، اليوزر، أو الـ ID اللي تحب تبحث عليه:\n_(أو /cancel)_', { parse_mode: 'Markdown' }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 🧭 راوتر الكولباك
// ══════════════════════════════════════════════════════════
async function handleCallback(ctx, data) {
  // gm_home_<chatId>
  if (data.startsWith('gm_home_')) return showMembersHub(ctx, data.replace('gm_home_', ''));
  // gm_search_<chatId>
  if (data.startsWith('gm_search_')) return requestSearch(ctx, data.replace('gm_search_', ''));
  // gm_list_<mode>_<chatId>_<page>[_<encQuery>]
  if (data.startsWith('gm_list_')) {
    const rest = data.replace('gm_list_', '');
    const seg = rest.split('_');
    const mode = seg[0];
    const chatId = seg[1];
    const page = parseInt(seg[2] || '0');
    const query = seg[3] ? decodeURIComponent(seg.slice(3).join('_')) : undefined;
    return showMembersList(ctx, chatId, mode, page, query);
  }
  // gm_card_<chatId>_<userId>
  if (data.startsWith('gm_card_')) {
    const rest = data.replace('gm_card_', '');
    const idx = rest.lastIndexOf('_');
    return showMemberCard(ctx, rest.slice(0, idx), rest.slice(idx + 1));
  }
  // gm_act_<action>_<chatId>_<userId>
  if (data.startsWith('gm_act_')) {
    const rest = data.replace('gm_act_', '');
    const [action, chatId, userId] = rest.split('_');
    return handleMemberAction(ctx, action, chatId, userId);
  }
  return false;
}

module.exports = {
  showMembersHub, showMembersList, showMemberCard, handleMemberAction,
  handleCallback, handleText, requestSearch,
};
