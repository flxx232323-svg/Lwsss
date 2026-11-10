'use strict';
// ══════════════════════════════════════════════════════════
// 🧵 إدارة المواضيع (Topics) — ملف مستقل، لا يلمس group_protection.js
// ══════════════════════════════════════════════════════════
const { run: dbRun, all: dbAll } = require('../database/db');

let _tableReady = false;
async function ensureTopicsTable() {
  if (_tableReady) return;
  try {
    await dbRun(`CREATE TABLE IF NOT EXISTS group_known_topics(
      chat_id BIGINT NOT NULL,
      thread_id BIGINT NOT NULL,
      name TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(chat_id, thread_id)
    )`);
  } catch (e) { /* موجود أصلاً غالباً */ }
  _tableReady = true;
}

// 📡 تتبّع خفيف: كل رسالة توصل جوّا Topic نسجّل الـ thread_id تاعو
// (Telegram Bot API ما عندهاش method ترجّع كل المواضيع دفعة وحدة — نبنيها بأنفسنا)
function trackTopicMiddleware(bot) {
  bot.on('message', (ctx, next) => {
    try {
      const threadId = ctx.message?.message_thread_id;
      if (threadId && isGroup(ctx)) {
        const name = ctx.message?.reply_to_message?.forum_topic_created?.name || null;
        dbRun(
          `INSERT INTO group_known_topics(chat_id,thread_id,name,updated_at) VALUES($1,$2,$3,NOW())
           ON CONFLICT(chat_id,thread_id) DO UPDATE SET
             name=COALESCE(EXCLUDED.name, group_known_topics.name), updated_at=NOW()`,
          [ctx.chat.id, threadId, name]
        ).catch(() => {});
      }
    } catch (e) { /* silent */ }
    return next();
  });
}

function isGroup(ctx) { return ['group', 'supergroup'].includes(ctx.chat?.type); }

async function isTgAdminOrOwner(ctx) {
  const uid = ctx.from?.id;
  if (Number(uid) === Number(process.env.OWNER_ID)) return true;
  try {
    const m = await ctx.telegram.getChatMember(ctx.chat.id, uid);
    return ['administrator', 'creator'].includes(m?.status);
  } catch (e) { return false; }
}

function getThreadId(ctx) {
  return ctx.message?.message_thread_id || null;
}

function reply(ctx, text, delay = 10000) {
  const threadId = getThreadId(ctx);
  ctx.reply(text, { parse_mode: 'Markdown', ...(threadId ? { message_thread_id: threadId } : {}) })
    .then(m => { if (m && delay) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), delay); })
    .catch(() => {});
}

async function ensureForum(ctx) {
  try {
    const chat = await ctx.telegram.getChat(ctx.chat.id);
    if (!chat.is_forum) {
      reply(ctx, '⚠️ نظام "المواضيع" (Topics) غير مفعّل بهذا القروب من إعدادات تيليجرام.');
      return false;
    }
    return true;
  } catch (e) {
    reply(ctx, '❌ تعذر التحقق من إعدادات القروب.');
    return false;
  }
}

function setupTopicCommands(bot) {
  // 🧵 موضوع → معلومات الموضوع الحالي
  const infoHandler = async ctx => {
    if (!isGroup(ctx)) return;
    const threadId = getThreadId(ctx);
    if (!threadId) return reply(ctx, 'ℹ️ أنت الآن في المحادثة العامة، مش داخل موضوع (Topic).');
    reply(ctx, '🧵 *الموضوع الحالي*\n━━━━━━━━━━━━━━━━━━\n🆔 `' + threadId + '`');
  };
  bot.command('topic', infoHandler);
  bot.hears(/^موضوع$/i, infoHandler);

  // 🆕 موضوع انشاء <اسم>
  const createHandler = async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await isTgAdminOrOwner(ctx))) return reply(ctx, '🚫 للمشرفين فقط.');
    if (!(await ensureForum(ctx))) return;
    const text = ctx.message.text || '';
    const name = text.replace(/^\/?topic\s+create\s*/i, '').replace(/^موضوع\s+انشاء\s*/i, '').trim();
    if (!name) return reply(ctx, '⚠️ اكتب: موضوع انشاء <الاسم>');
    try {
      const topic = await ctx.telegram.callApi('createForumTopic', { chat_id: ctx.chat.id, name });
      reply(ctx, '✅ تم إنشاء الموضوع: *' + name + '*\n🆔 `' + topic.message_thread_id + '`');
    } catch (e) {
      reply(ctx, '❌ تعذر الإنشاء: ' + (e.description || e.message) + '\n⚠️ تأكد أن البوت أدمن بصلاحية "إدارة المواضيع"');
    }
  };
  bot.hears(/^موضوع\s+انشاء\s+(.+)$/i, createHandler);
  bot.hears(/^\/?topic\s+create\s+(.+)$/i, createHandler);

  // 🔒 موضوع اغلاق (يغلق الموضوع الحالي)
  const closeHandler = async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await isTgAdminOrOwner(ctx))) return reply(ctx, '🚫 للمشرفين فقط.');
    const threadId = getThreadId(ctx);
    if (!threadId) return reply(ctx, '⚠️ هذا الأمر يُستخدم داخل الموضوع المراد إغلاقه.');
    try {
      await ctx.telegram.callApi('closeForumTopic', { chat_id: ctx.chat.id, message_thread_id: threadId });
      reply(ctx, '🔒 تم إغلاق الموضوع.');
    } catch (e) {
      reply(ctx, '❌ تعذر الإغلاق: ' + (e.description || e.message));
    }
  };
  bot.hears(/^موضوع\s+اغلاق$/i, closeHandler);

  // 🔓 موضوع فتح (يعيد فتح الموضوع الحالي)
  const reopenHandler = async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await isTgAdminOrOwner(ctx))) return reply(ctx, '🚫 للمشرفين فقط.');
    const threadId = getThreadId(ctx);
    if (!threadId) return reply(ctx, '⚠️ هذا الأمر يُستخدم داخل الموضوع المراد فتحه.');
    try {
      await ctx.telegram.callApi('reopenForumTopic', { chat_id: ctx.chat.id, message_thread_id: threadId });
      reply(ctx, '🔓 تم إعادة فتح الموضوع.');
    } catch (e) {
      reply(ctx, '❌ تعذر الفتح: ' + (e.description || e.message));
    }
  };
  bot.hears(/^موضوع\s+فتح$/i, reopenHandler);

  // ✏️ موضوع تسمية <اسم جديد>
  const renameHandler = async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await isTgAdminOrOwner(ctx))) return reply(ctx, '🚫 للمشرفين فقط.');
    const threadId = getThreadId(ctx);
    if (!threadId) return reply(ctx, '⚠️ هذا الأمر يُستخدم داخل الموضوع المراد تسميته.');
    const text = ctx.message.text || '';
    const name = text.replace(/^موضوع\s+تسمية\s*/i, '').trim();
    if (!name) return reply(ctx, '⚠️ اكتب: موضوع تسمية <الاسم الجديد>');
    try {
      await ctx.telegram.callApi('editForumTopic', { chat_id: ctx.chat.id, message_thread_id: threadId, name });
      reply(ctx, '✏️ تم تعديل اسم الموضوع إلى: *' + name + '*');
    } catch (e) {
      reply(ctx, '❌ تعذر التعديل: ' + (e.description || e.message));
    }
  };
  bot.hears(/^موضوع\s+تسمية\s+(.+)$/i, renameHandler);

  // 🗑 موضوع حذف — يطلب تأكيد قبل التنفيذ (عملية بلا رجعة)
  const deleteHandler = async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await isTgAdminOrOwner(ctx))) return reply(ctx, '🚫 للمشرفين فقط.');
    const threadId = getThreadId(ctx);
    if (!threadId) return reply(ctx, '⚠️ هذا الأمر يُستخدم داخل الموضوع المراد حذفه.');
    const kb = {
      inline_keyboard: [[
        { text: '🗑 نعم، احذف نهائياً', callback_data: 'gp_topicdel_yes_' + ctx.chat.id + '_' + threadId },
        { text: '❌ إلغاء',            callback_data: 'gp_topicdel_no_'  + ctx.chat.id + '_' + threadId },
      ]],
    };
    ctx.reply('⚠️ *تأكيد حذف الموضوع*\nهذا الإجراء *نهائي ولا يمكن التراجع عنه* — سيُحذف الموضوع وكل رسائله.\nمتأكد؟',
      { parse_mode: 'Markdown', reply_markup: kb, message_thread_id: threadId }).catch(() => {});
  };
  bot.hears(/^موضوع\s+حذف$/i, deleteHandler);

  // 🔒🔓 إغلاق/فتح كل المواضيع المعروفة دفعة واحدة
  bot.hears(/^(قفل التوبيكات|قفل توبيكات|اغلاق كل المواضيع|قفل المواضيع|اغلاق المواضيع|اغلقهم|قفلهم)$/i, ctx => closeOrOpenAll(ctx, true));
  bot.hears(/^(فتح التوبيكات|فتح توبيكات|فتح كل المواضيع|فتح المواضيع|افتحهم|افتحوهم)$/i, ctx => closeOrOpenAll(ctx, false));
}

// 🎛️ تأكيد/إلغاء حذف الموضوع (يُستدعى من bot/callbacks.js)
async function handleCallback(ctx, data) {
  const isYes = data.startsWith('gp_topicdel_yes_');
  const rest = data.replace(isYes ? 'gp_topicdel_yes_' : 'gp_topicdel_no_', '');
  const parts = rest.split('_');
  const chatId = Number(parts[0]);
  const threadId = Number(parts[1]);

  if (!(await isTgAdminOrOwnerFor(ctx, chatId))) {
    return ctx.answerCbQuery('🚫 ليس لديك صلاحية', { show_alert: true }).catch(() => {});
  }

  if (!isYes) {
    await ctx.editMessageText('❌ تم إلغاء الحذف.').catch(() => {});
    return ctx.answerCbQuery('تم الإلغاء').catch(() => {});
  }

  try {
    await ctx.telegram.callApi('deleteForumTopic', { chat_id: chatId, message_thread_id: threadId });
    // ✅ نشيله من قائمة المواضيع المعروفة، وإلا "قفل/فتح التوبيكات" تحاول تشتغل على موضوع محذوف
    await dbRun('DELETE FROM group_known_topics WHERE chat_id=$1 AND thread_id=$2', [chatId, threadId]).catch(() => {});
    await ctx.editMessageText('🗑 تم حذف الموضوع نهائياً.').catch(() => {});
    await ctx.answerCbQuery('🗑 تم الحذف').catch(() => {});
  } catch (e) {
    await ctx.answerCbQuery('❌ تعذر الحذف: ' + (e.description || e.message), { show_alert: true }).catch(() => {});
  }
}

// نفس فحص isTgAdminOrOwner، بس لـ chatId مررّر صراحة (مو من ctx.chat الحالي)
async function isTgAdminOrOwnerFor(ctx, chatId) {
  const uid = ctx.from?.id;
  if (Number(uid) === Number(process.env.OWNER_ID)) return true;
  try {
    const m = await ctx.telegram.getChatMember(chatId, uid);
    return ['administrator', 'creator'].includes(m?.status);
  } catch (e) { return false; }
}

async function closeOrOpenAll(ctx, close) {
  if (!isGroup(ctx)) return;
  if (!(await isTgAdminOrOwner(ctx))) return reply(ctx, '🚫 للمشرفين فقط.');
  await ensureTopicsTable();
  const chatId = ctx.chat.id;
  const topics = await dbAll('SELECT thread_id FROM group_known_topics WHERE chat_id=$1', [chatId]).catch(() => []);
  if (!topics.length) {
    return reply(ctx, '📭 ماكاينش مواضيع معروفة عندي بعد لهذا القروب.\n_(البوت يتعرف على المواضيع بس كي توصلو رسالة فيها، أو ينشئها بنفسه)_');
  }

  const msg = await ctx.reply('⏳ جارٍ ' + (close ? 'إغلاق' : 'فتح') + ' ' + topics.length + ' موضوع...').catch(() => null);
  let done = 0, failed = 0;
  for (const t of topics) {
    try {
      await ctx.telegram.callApi(close ? 'closeForumTopic' : 'reopenForumTopic', {
        chat_id: chatId, message_thread_id: t.thread_id,
      });
      done++;
    } catch (e) { failed++; }
    await new Promise(r => setTimeout(r, 200)); // احترام حدود تيليجرام
  }

  const text = (close ? '🔒 تم إغلاق ' : '🔓 تم فتح ') + done + ' موضوع' + (failed ? ' (فشل ' + failed + ')' : '');
  if (msg) await ctx.telegram.editMessageText(chatId, msg.message_id, null, text).catch(() => {});
  else ctx.reply(text).catch(() => {});
}

module.exports = { setupTopicCommands, getThreadId, handleCallback, trackTopicMiddleware, ensureTopicsTable, closeOrOpenAll };
