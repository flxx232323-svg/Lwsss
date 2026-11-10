'use strict';
/**
 * ⌨️ handlers/group_commands_pro.js — الأوامر الاحترافية الجديدة
 * ──────────────────────────────────────────────────────────────
 * أوامر عربية وإنجليزية قصيرة لكل ميزات النظام الاحترافي + شرح مدمج.
 */

const db = require('../database/group_pro_db');
const protection = require('./group_protection');
const proPanel = require('./group_pro_panel');
const roles = require('./group_roles');
const logsMod = require('./group_logs');
const aiAdmin = require('./group_ai_admin');
const funCmds = require('./fun_commands');
const { build: kbBuild, btn: kbBtn } = require('../utils/keyboard');

// ── مساعدات ──────────────────────────────────────────────
function isGroup(ctx) { return ['group', 'supergroup'].includes(ctx.chat?.type); }

async function isTgAdmin(ctx) {
  if (ctx.isOwner || ctx.isAdmin) return true;
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return ['administrator', 'creator'].includes(member?.status);
  } catch (_) { return false; }
}

async function canAccessPanel(ctx, chatId) {
  if (await isTgAdmin(ctx)) return true;
  const role = await roles.getEffectiveRole(ctx, chatId, ctx.from.id);
  return !!role;
}

function delCmd(ctx) { setTimeout(() => ctx.deleteMessage().catch(() => {}), 1500); }

function tempReply(ctx, text, opts = {}, delay = 8000) {
  const threadId = ctx.message?.message_thread_id;
  ctx.reply(text, { parse_mode: 'Markdown', ...(threadId ? { message_thread_id: threadId } : {}), ...opts })
    .then(m => { if (m && delay) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), delay); })
    .catch(() => {});
}

async function getTextArg(ctx) {
  const args = (ctx.message.text || '').split(' ').slice(1).join(' ').trim();
  if (args) return args;
  const rep = ctx.message.reply_to_message;
  return (rep?.text || rep?.caption || '').trim();
}

// ── أقفال: أسماء عربية/إنجليزية ──────────────────────────
const LOCK_ALIASES = {
  sticker: ['sticker', 'stickers', 'ملصق', 'ملصقات', 'استيكر'],
  gif:     ['gif', 'gifs', 'animation', 'متحركة', 'صور متحركة', 'جيف'],
  link:    ['link', 'links', 'رابط', 'روابط'],
  forward: ['forward', 'forwards', 'توجيه', 'تحويل', 'إعادة توجيه'],
  photo:   ['photo', 'photos', 'صورة', 'صور'],
  video:   ['video', 'videos', 'فيديو', 'فيديوهات'],
  voice:   ['voice', 'audio', 'صوت', 'صوتي', 'صوتيات'],
  poll:    ['poll', 'polls', 'استطلاع', 'استطلاعات', 'تصويت'],
  file:    ['file', 'files', 'document', 'documents', 'ملف', 'ملفات', 'مستند', 'مستندات'],
  chat:    ['chat', 'دردشة', 'شات'],
  invite:  ['invite', 'دعوة', 'اضافة اعضاء', 'إضافة أعضاء'],
  pin:     ['pin', 'تثبيت'],
  info:    ['info', 'تعديل معلومات', 'معلومات القروب'],
};
function resolveLockType(arg) {
  arg = (arg || '').toLowerCase().trim();
  const argNoAl = arg.startsWith('ال') ? arg.slice(2) : arg; // ✅ يتجاهل "ال" التعريف (مثلاً "التصويت" == "تصويت")
  for (const [type, aliases] of Object.entries(LOCK_ALIASES)) {
    if (aliases.some(a => { const al = a.toLowerCase(); return al === arg || al === argNoAl; })) return type;
  }
  return null;
}

// ══════════════════════════════════════════════════════════
// 📜 نص المساعدة
// ══════════════════════════════════════════════════════════
const HELP_TEXT =
`🛡 *النظام الاحترافي لإدارة القروب*
━━━━━━━━━━━━━━━━━━

*🎯 أوامر الإدارة السريعة (رد على عضو)*
\`حظر [سبب]\` — حظر العضو
\`فك حظر\` — رفع الحظر
\`طرد [سبب]\` — طرد العضو
\`كتم [1h]\` — كتم (افتراضي 10د)
\`فك كتم\` — رفع الكتم
\`تحذير [سبب]\` — تحذير
\`تحذيراته\` — عرض تحذيراته
\`فك تحذير\` — مسح كل تحذيراته
\`حذف\` — حذف الرسالة المردود عليها
\`تثبيت\` — تثبيت الرسالة المردود عليها
\`فك تثبيت\` — إلغاء تثبيت كل الرسائل
_كل أمر يخضع لصلاحيات رتبتك (🎭 الرتب)._

*🖥 اللوحة الشاملة*
\`/protection\` أو «الحماية» — فتح لوحة الإدارة الكاملة

*🚷 الكلمات المحظورة*
\`/setword كلمة\` أو «حظر كلمة ...» — إضافة
\`/delword كلمة\` أو «حذف كلمة ...» — إزالة
\`/words\` أو «الكلمات المحظورة» — عرض القائمة

*🔒 الأقفال السريعة*
\`/lock نوع\` و \`/unlock نوع\`
الأنواع: sticker, gif, link, forward, photo, video, voice, poll
بالعربي: «قفل روابط»، «فتح صور»…

*🎭 الرتب*
رُد على عضو واكتب: \`/setrole [رتبة]\`
الرتب: manager, super_admin, protection_admin, content_admin, assistant
\`/removerole\` (رد على عضو) — إزالة الرتبة
\`/roles\` أو «الرتب» — عرض الرتب الحالية

*📋 السجلات والمخالفات*
\`/logs\` أو «السجلات» — سجلات القروب
\`/violations\` (رد على عضو) — سجل مخالفاته
\`/resetviolations\` (رد على عضو) — تصفير عدّاد مخالفاته

*✅ التحقق من الأعضاء*
\`/verify\` أو «التحقق» — إعدادات التحقق من الأعضاء الجدد

*🤖 تحليل ذكي*
\`/summary\` أو «تحليل» — تحليل نشاط القروب بالذكاء الاصطناعي

*🗒 أدوات يومية*
\`/afk [سبب]\` — وضع غياب
\`/save اسم محتوى\` (أو رد) — حفظ ملاحظة
\`#اسم\` — استدعاء الملاحظة
\`/notes\` — كل الملاحظات
\`/delnote اسم\` — حذف ملاحظة`;

// ══════════════════════════════════════════════════════════
// 🚀 التسجيل
// ══════════════════════════════════════════════════════════
function setupProCommands(bot) {
  // ── 🖥 اللوحة الشاملة ──
  const openPanel = async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await canAccessPanel(ctx, ctx.chat.id))) {
      return tempReply(ctx, '🚫 هذا الأمر للمشرفين فقط.');
    }
    return proPanel.showHome(ctx, ctx.chat.id);
  };
  bot.command(['protection', 'proadmin'], openPanel);
  bot.hears('الحماية', openPanel);

  // ── 📜 المساعدة ──
  const showHelp = ctx => ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' }).catch(() => {});
  bot.command('prohelp', showHelp);
  bot.hears('مساعدة الحماية', showHelp);

  // ── ⚡ تفعيل/تعطيل سريع (حماية / تحقق / ترحيب / وداع / اشعارات) ──
  const { run: _run, get: _get } = require('../database/db');

  async function quickToggle(ctx, on, kind) {
    if (!isGroup(ctx)) return;
    if (!(await canAccessPanel(ctx, ctx.chat.id))) return tempReply(ctx, '🚫 هذا الأمر للمشرفين فقط.');
    const chatId = ctx.chat.id;
    try {
      if (kind === 'protection') {
        // ما فيه مفتاح واحد موحّد — نفعّل/نعطّل الأنواع الأساسية الثلاثة دفعة وحدة
        await _run('UPDATE group_chats SET anti_spam=$1, anti_link=$1, anti_flood=$1 WHERE chat_id=$2', [on ? 1 : 0, chatId]);
      } else if (kind === 'verify') {
        await protection.updateSettings(chatId, { verify_enabled: on });
      } else if (kind === 'welcome') {
        await _run('UPDATE group_chats SET welcome_enabled=$1 WHERE chat_id=$2', [on ? 1 : 0, chatId]);
      } else if (kind === 'goodbye') {
        await _run('UPDATE group_chats SET goodbye_enabled=$1 WHERE chat_id=$2', [on ? 1 : 0, chatId]);
      } else if (kind === 'notify') {
        await _run('UPDATE group_chats SET notify_new_files=$1 WHERE chat_id=$2', [on ? 1 : 0, chatId]);
      }
      return ctx.reply((on ? '✅ تم التفعيل' : '❌ تم التعطيل')).catch(() => {});
    } catch (e) {
      return ctx.reply('❌ فشل: ' + e.message).catch(() => {});
    }
  }

  bot.hears(/^تفعيل\s+حماية$/i,  ctx => quickToggle(ctx, true,  'protection'));
  bot.hears(/^تعطيل\s+حماية$/i,  ctx => quickToggle(ctx, false, 'protection'));
  bot.hears(/^تفعيل\s+تحقق$/i,   ctx => quickToggle(ctx, true,  'verify'));
  bot.hears(/^تعطيل\s+تحقق$/i,   ctx => quickToggle(ctx, false, 'verify'));
  bot.hears(/^تفعيل\s+ترحيب$/i,  ctx => quickToggle(ctx, true,  'welcome'));
  bot.hears(/^تعطيل\s+ترحيب$/i,  ctx => quickToggle(ctx, false, 'welcome'));
  bot.hears(/^تفعيل\s+وداع$/i,   ctx => quickToggle(ctx, true,  'goodbye'));
  bot.hears(/^تعطيل\s+وداع$/i,   ctx => quickToggle(ctx, false, 'goodbye'));
  bot.hears(/^تفعيل\s+اشعارات$/i, ctx => quickToggle(ctx, true,  'notify'));
  bot.hears(/^تعطيل\s+اشعارات$/i, ctx => quickToggle(ctx, false, 'notify'));

  // ── 🚷 الكلمات المحظورة ──
  const addWordHandler = async ctx => {
    if (!isGroup(ctx) || !(await isTgAdmin(ctx))) return;
    const word = await getTextArg(ctx);
    if (!word) return tempReply(ctx, '⚠️ استخدم: `/setword كلمة` أو رد على رسالة تحتوي الكلمة.', {});
    if (word.length > 50) return tempReply(ctx, '⚠️ الكلمة طويلة جداً (الحد 50 حرفاً).');
    await db.addWord(ctx.chat.id, word, ctx.from.id);
    protection.clearWordsCache(ctx.chat.id);
    logsMod.logAction({ telegram: ctx.telegram }, ctx.chat.id, 'word_change', {
      actorId: ctx.from.id, actorName: ctx.from.first_name || '', details: '➕ إضافة كلمة محظورة: ' + word,
    }).catch(() => {});
    tempReply(ctx, '✅ تمت إضافة «' + word + '» إلى الكلمات المحظورة.');
    delCmd(ctx);
  };
  bot.command('setword', addWordHandler);
  bot.hears(/^حظر\s+كلمة\s+(.+)$/i, addWordHandler);

  const delWordHandler = async ctx => {
    if (!isGroup(ctx) || !(await isTgAdmin(ctx))) return;
    const word = await getTextArg(ctx);
    if (!word) return tempReply(ctx, '⚠️ استخدم: `/delword كلمة`');
    await db.removeWord(ctx.chat.id, word.toLowerCase());
    protection.clearWordsCache(ctx.chat.id);
    logsMod.logAction({ telegram: ctx.telegram }, ctx.chat.id, 'word_change', {
      actorId: ctx.from.id, actorName: ctx.from.first_name || '', details: '🗑 حذف كلمة محظورة: ' + word,
    }).catch(() => {});
    tempReply(ctx, '🗑 تم حذف «' + word + '» من الكلمات المحظورة (إن وُجدت).');
    delCmd(ctx);
  };
  bot.command('delword', delWordHandler);
  bot.hears(/^حذف\s+كلمة\s+(.+)$/i, delWordHandler);

  const showWordsHandler = async ctx => {
    if (!isGroup(ctx)) return;
    return proPanel.showWords(ctx, ctx.chat.id);
  };
  // ⚠️ أُزيل الظهور بالقروب بناءً على طلب صريح — متاحة فقط عبر لوحة الحماية (🚷 الكلمات المحظورة)

  // ── 🔒 الأقفال السريعة ──
  const lockHandler = (unlock) => async ctx => {
    if (!isGroup(ctx) || !(await isTgAdmin(ctx))) return;
    const arg = (ctx.message.text || '').split(/\s+/).slice(1).join(' ');
    const type = resolveLockType(arg);
    if (!type) {
      return tempReply(ctx, '❌ نوع غير معروف.\nالأنواع المتاحة:\n🖼 صور | 🎬 فيديو | 🎤 صوت | 📊 تصويت | 🎭 ملصقات | 🎞 متحركة | 🔗 روابط | ↪️ توجيه\n\nمثال: قفل فيديو', {}, 12000);
    }
    await db.setLock(ctx.chat.id, type, !unlock);
    protection.clearLocksCache(ctx.chat.id);
    logsMod.logAction({ telegram: ctx.telegram }, ctx.chat.id, 'lock_change', {
      actorId: ctx.from.id, actorName: ctx.from.first_name || '',
      details: (unlock ? '🔓 فتح ' : '🔒 قفل ') + (proPanel.LOCK_LABELS[type] || type),
    }).catch(() => {});

    let msg = (unlock ? '🔓 تم فتح: ' : '🔒 تم قفل: ') + (proPanel.LOCK_LABELS[type] || type);
    if (protection.PERMISSION_LOCK_MAP[type]) {
      const res = await protection.applyLockPermissions(ctx, ctx.chat.id);
      msg += res.ok
        ? (unlock ? '\n✅ فُتح على مستوى تيليجرام' : '\n✅ قُفل على مستوى تيليجرام')
        : '\n⚠️ تم في البوت فقط — أعط البوت صلاحية "تقييد الأعضاء" لتطبيق ذلك على تيليجرام مباشرة.';
    }
    tempReply(ctx, msg, {}, 8000);
    delCmd(ctx);
  };
  // ── 🔒🔓 قفل الكل / فتح الكل — لازم قبل الأمر العام 'قفل/فتح <نوع>' وإلا 'الكل' تتفسر كنوع مجهول ──
  const lockAllHandler = (lockAll) => async ctx => {
    if (!isGroup(ctx) || !(await isTgAdmin(ctx))) return;
    await proPanel.toggleAllLocks(ctx, ctx.chat.id, lockAll);
    delCmd(ctx);
  };
  bot.hears(/^(قفل الكل|قفل كل شي)$/i, lockAllHandler(true));
  bot.hears(/^(فتح الكل|فتح كل شي)$/i, lockAllHandler(false));

  bot.command('lock', lockHandler(false));
  bot.command('unlock', lockHandler(true));
  bot.hears(/^قفل\s+(.+)$/i, lockHandler(false));
  bot.hears(/^فتح\s+(.+)$/i, lockHandler(true));

  // ── 🎛 أنماط جاهزة (Presets) — تطبق مجموعة أقفال دفعة واحدة ──
  const presetHandler = (activeTypes, label) => async ctx => {
    if (!isGroup(ctx) || !(await isTgAdmin(ctx))) return;
    const res = await proPanel.applyPreset(ctx, ctx.chat.id, activeTypes);
    const msg = res.ok
      ? ('✅ تم تفعيل ' + label + ' على مستوى تيليجرام')
      : ('✅ تم تفعيل ' + label + ' في البوت — أعط البوت صلاحية "تقييد الأعضاء" للتطبيق الكامل');
    tempReply(ctx, msg, {}, 8000);
    delCmd(ctx);
  };
  bot.hears(/^وضع الدراسة$/i, presetHandler(['sticker', 'gif', 'poll'], '📚 وضع الدراسة (منع: ملصقات/متحركة/تصويت)'));
  bot.hears(/^وضع الوسائط$/i, presetHandler(['photo', 'video', 'voice', 'file', 'sticker', 'gif'], '🎥 وضع تقييد الوسائط (نص وروابط فقط)'));


  // ── 🎭 الرتب ──
  bot.command('setrole', async ctx => {
    if (!isGroup(ctx) || !(await isTgAdmin(ctx))) return;
    return roles.handleSetRoleCommand(ctx);
  });
  bot.command('removerole', async ctx => {
    if (!isGroup(ctx) || !(await isTgAdmin(ctx))) return;
    return roles.handleRemoveRoleCommand(ctx);
  });
  const showRolesHandler = async ctx => {
    if (!isGroup(ctx)) return;
    return roles.showRolesMenu(ctx, ctx.chat.id);
  };
  bot.command('roles', showRolesHandler);
  bot.hears('الرتب', showRolesHandler);

  // ── 📋 السجلات ──
  const showLogsHandler = async ctx => {
    if (!isGroup(ctx) || !(await canAccessPanel(ctx, ctx.chat.id))) return;
    return logsMod.showLogsMenu(ctx, ctx.chat.id);
  };
  bot.command('logs', showLogsHandler);
  bot.hears('السجلات', showLogsHandler);

  // ── ⚠️ مخالفات عضو ──
  const showViolationsHandler = async ctx => {
    if (!isGroup(ctx) || !(await isTgAdmin(ctx))) return;
    const target = ctx.message.reply_to_message?.from;
    if (!target) return tempReply(ctx, '⚠️ رُد على رسالة العضو بهذا الأمر.');
    const settings = await protection.getSettings(ctx.chat.id);
    const count = await db.getViolationCount(ctx.chat.id, target.id, settings.violation_window_hours || 24);
    const history = await db.getViolationHistory(ctx.chat.id, target.id, 10);
    let text = '🛡 *سجل مخالفات* [' + (target.first_name || 'العضو') + '](tg://user?id=' + target.id + ')\n━━━━━━━━━━━━━━━━━━\n\n';
    text += '🔢 العدد الحالي (' + (settings.violation_window_hours || 24) + 'س): *' + count + '*\n\n';
    if (!history.length) text += '_لا توجد مخالفات مسجّلة._';
    else {
      text += '*آخر المخالفات:*\n';
      for (const h of history) {
        const time = new Date(h.created_at).toLocaleString('ar-DZ', { hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        text += '• ' + protection.violationLabel(h.type) + ' — _' + time + '_\n';
      }
    }
    const rows = [[kbBtn('♻️ تصفير المخالفات', 'gpx_resetviol_' + target.id + '_' + ctx.chat.id)]];
    return ctx.reply(text, { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id, ...kbBuild(rows) }).catch(() => {});
  };
  bot.command('violations', showViolationsHandler);
  bot.hears(/^(مخالفاته|المخالفات)$/, showViolationsHandler);

  bot.command('resetviolations', async ctx => {
    if (!isGroup(ctx) || !(await isTgAdmin(ctx))) return;
    const target = ctx.message.reply_to_message?.from;
    if (!target) return tempReply(ctx, '⚠️ رُد على رسالة العضو بهذا الأمر.');
    await db.resetViolations(ctx.chat.id, target.id);
    tempReply(ctx, '♻️ تم تصفير عدّاد مخالفات [' + (target.first_name || 'العضو') + '](tg://user?id=' + target.id + ')', {});
    delCmd(ctx);
  });

  // ── ✅ التحقق من الأعضاء ──
  const showVerifyHandler = async ctx => {
    if (!isGroup(ctx) || !(await isTgAdmin(ctx))) return;
    return proPanel.showVerifyConfig(ctx, ctx.chat.id);
  };
  bot.command('verify', showVerifyHandler);
  bot.hears('التحقق', showVerifyHandler);

  // ── 🤖 تحليل ذكي ──
  const showSummaryHandler = async ctx => {
    if (!isGroup(ctx) || !(await isTgAdmin(ctx))) return;
    return aiAdmin.showSummary(ctx, ctx.chat.id);
  };
  bot.command('summary', showSummaryHandler);
  bot.hears('تحليل', showSummaryHandler);

  // ── 🌙 AFK ──
  bot.command('afk', ctx => { if (isGroup(ctx)) return funCmds.handleAfk(ctx); });

  // ── 📝 الملاحظات ──
  bot.command(['save', 'note'], ctx => funCmds.saveNote(ctx));
  bot.command('notes', ctx => funCmds.listNotes(ctx));
  bot.command('delnote', ctx => funCmds.delNote(ctx));
  bot.hears(/^#([\w\u0600-\u06FF]{1,32})$/, ctx => {
    if (!isGroup(ctx)) return;
    return funCmds.getNote(ctx, ctx.match[1]);
  });
}

// ══════════════════════════════════════════════════════════
// 🔁 Callback: تصفير المخالفات من زر /violations
// ══════════════════════════════════════════════════════════
async function handleResetViolationCallback(ctx, data) {
  // gpx_resetviol_<uid>_<chatId>
  const rest = data.replace('gpx_resetviol_', '');
  const m = rest.match(/^(\d+)_(-?\d+)$/);
  if (!m) return false;
  const targetUid = parseInt(m[1]);
  const chatId = parseInt(m[2]);
  if (!(await isTgAdmin(ctx))) {
    return ctx.answerCbQuery('🚫 للمشرفين فقط', { show_alert: true }).catch(() => {});
  }
  await db.resetViolations(chatId, targetUid);
  await ctx.answerCbQuery('♻️ تم التصفير').catch(() => {});
  return ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
}

module.exports = {
  setupProCommands,
  handleResetViolationCallback,
  canAccessPanel, isTgAdmin,
  HELP_TEXT,
};
