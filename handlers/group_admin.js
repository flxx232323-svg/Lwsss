'use strict';

// ── dedup: منع تكرار رسالة الترحيب ──────────────────
const _welcomeDedup = new Map();
function _isWelcomeDupe(chatId, userId) {
  const key = chatId + '_' + userId;
  if (_welcomeDedup.has(key)) return true;
  _welcomeDedup.set(key, true);
  setTimeout(() => _welcomeDedup.delete(key), 8000);
  return false;
}
const { run, all, get } = require('../database/db');
const { cacheGet, cacheSet, cacheClear } = require('../utils/cache');

// ══════════════════════════════════════════════════════════
// 🔧 Utility — MarkdownV2 escape (Telegram strict)
// ══════════════════════════════════════════════════════════
const escV2 = t => String(t || '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

// الساعة الجزائرية UTC+1
function algeriaTime() {
  const now = new Date(Date.now() + 3600000);
  const date = now.toLocaleDateString('ar-DZ', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return { date, time };
}

// ══════════════════════════════════════════════════════════
// 🎉 ترحيب احترافي بالأعضاء الجدد
// ══════════════════════════════════════════════════════════
async function handleNewMember(bot, chatId, userId, firstName) {
  try {
    if (_isWelcomeDupe(chatId, userId)) return;

    await run(
      `INSERT INTO group_members(chat_id,user_id,username,first_name,updated_at)
       VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)
       ON CONFLICT(chat_id,user_id) DO UPDATE
         SET first_name=EXCLUDED.first_name, updated_at=CURRENT_TIMESTAMP`,
      [chatId, userId, '', firstName || 'عضو']
    ).catch(() => {});

    cacheClear('grp_members_' + chatId);
    cacheClear('grp_count_'   + chatId);

    const welcomeCheck = await get('SELECT welcome_enabled FROM group_chats WHERE chat_id=$1', [chatId]).catch(() => null);
    if (welcomeCheck && !welcomeCheck.welcome_enabled) return;

    const [grp, grpWelcome] = await Promise.all([
      get('SELECT specialty_id, welcome_msg, welcome_photo FROM group_chats WHERE chat_id=$1', [chatId]).catch(() => null),
      get('SELECT message, image_file_id FROM group_welcome WHERE chat_id=$1', [chatId]).catch(() => null)
    ]);
    if (grp) {
      if (grpWelcome?.message)        grp.welcome_msg   = grpWelcome.message;
      if (grpWelcome?.image_file_id)  grp.welcome_photo = grpWelcome.image_file_id;
    }

    const spec = grp?.specialty_id
      ? await get('SELECT name FROM specialties WHERE id=$1', [grp.specialty_id]).catch(() => null)
      : null;

    const { date, time } = algeriaTime();
    const name     = firstName || 'عضو';
    const specName = spec?.name || '';
    const specLine = specName ? '\n🎓 التخصص: *' + specName + '*' : '';

    let memberCount = '';
    try { const c = await bot.telegram.getChatMembersCount(chatId); memberCount = String(c); } catch(_) {}

    let groupTitle = '';
    try { const gc = await bot.telegram.getChat(chatId); groupTitle = gc.title || ''; } catch(_) {}

    // حذف رسالة الترحيب القديمة
    try {
      const lastWelcome = await get('SELECT msg_id FROM group_last_welcome WHERE chat_id=$1', [chatId]).catch(() => null);
      if (lastWelcome?.msg_id) {
        await bot.telegram.deleteMessage(chatId, lastWelcome.msg_id).catch(() => {});
      }
    } catch(_) {}

    // الرسالة الأساسية (fallback نهائي) — ID واضح كنص عادي، مو رابط مخفي
    const hardcodedMsg =
`🎉 أهلاً وسهلاً بـ *${name}*!

┌─────────────────────┐
│ 🆔 المعرّف: \`${userId}\`
│ 📅 ${date}  🕐 ${time}${specLine}
│ 👥 العضو رقم: *${memberCount}*
└─────────────────────┘

🔹 احترم الجميع وتعاون مع الأعضاء
🔹 شارك ملفاتك وأسئلتك بحرية
🔹 استخدم /help لمعرفة أوامر البوت
━━━━━━━━━━━━━━━━━━━━`;

    // الإعدادات الافتراضية العامة التي ضبطها الـ Owner (تُستخدم لو القروب بدون رسالة مخصصة)
    let ownerDefaultMsg = null, ownerDefaultPhoto = null;
    if (!grp?.welcome_msg) {
      try {
        const defs = await all("SELECT key, value FROM bot_defaults WHERE key IN ('default_welcome_msg','default_welcome_photo')").catch(() => []);
        defs.forEach(d => {
          if (d.key === 'default_welcome_msg') ownerDefaultMsg = d.value;
          if (d.key === 'default_welcome_photo') ownerDefaultPhoto = d.value;
        });
      } catch(_) {}
    }
    if (ownerDefaultPhoto && !grp?.welcome_photo) grp.welcome_photo = ownerDefaultPhoto;

    const rawTemplate = grp?.welcome_msg || ownerDefaultMsg;
    const customMsg = rawTemplate
      ? rawTemplate
          .replace(/{name}/g,    name)
          .replace(/{mention}/g, '[' + name + '](tg://user?id=' + userId + ')')
          .replace(/{id}/g,      '`' + userId + '`')
          .replace(/{spec}/g,    specName)
          .replace(/{date}/g,    date)
          .replace(/{time}/g,    time)
          .replace(/{count}/g,   memberCount)
          .replace(/{group}/g,   groupTitle)
      : hardcodedMsg;

    // أزرار الترحيب
    const welcomeKb = {
      inline_keyboard: [[
        { text: '👤 ملفّي', url: 'tg://user?id=' + userId },
      ],[
        { text: '📢 قناتنا', url: 'https://t.me/lwx23' },
      ]]
    };

    let sentMsg = null;

    if (grp?.welcome_photo && grp.welcome_photo.startsWith('CAA')) {
      await bot.telegram.sendSticker(chatId, grp.welcome_photo).catch(() => {});
    } else if (grp?.welcome_photo) {
      sentMsg = await bot.telegram.sendPhoto(chatId, grp.welcome_photo, {
        caption:      customMsg,
        parse_mode:   'Markdown',
        reply_markup: JSON.stringify(welcomeKb),
      }).catch(() => null);
    } else {
      sentMsg = await bot.telegram.sendMessage(chatId, customMsg, {
        parse_mode:               'Markdown',
        disable_web_page_preview: true,
        reply_markup: JSON.stringify(welcomeKb),
      }).catch(() => null);
    }

    // حفظ ID الرسالة لحذفها عند العضو القادم
    if (sentMsg) {
      await run(
        `INSERT INTO group_last_welcome(chat_id, msg_id) VALUES($1,$2)
         ON CONFLICT(chat_id) DO UPDATE SET msg_id=$2`,
        [chatId, sentMsg.message_id]
      ).catch(() => {});
    }

  } catch(e) {
    console.error('[Welcome]', e.message);
  }
}


// ══════════════════════════════════════════════════════════
// 👋 رسالة وداع عند مغادرة عضو
// ══════════════════════════════════════════════════════════
async function handleMemberLeft(bot, chatId, userId, firstName) {
  try {
    cacheClear('grp_members_' + chatId);
    cacheClear('grp_count_'   + chatId);
    await run('DELETE FROM group_members WHERE chat_id=$1 AND user_id=$2', [chatId, userId]).catch(() => {});

    const grp = await get('SELECT goodbye_enabled FROM group_chats WHERE chat_id=$1', [chatId]).catch(() => null);
    if (!grp?.goodbye_enabled) return;

    let memberCount = '';
    try { const cnt = await bot.telegram.getChatMembersCount(chatId); memberCount = String(cnt); } catch(_) {}

    const name = firstName || 'عضو';
    const msg =
`👋 وداعاً *${name}*

نتمنى لك التوفيق دائماً 🌟
👥 تبقّى في المجموعة: *${memberCount}* عضو`;

    await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown' }).catch(() => {});
  } catch(e) {
    console.error('[Left]', e.message);
  }
}


// ══════════════════════════════════════════════════════════
// ⚙️ إعدادات الترحيب
// ══════════════════════════════════════════════════════════
async function setWelcomeImage(ctx, chatId, fileId) {
  await run(
    `INSERT INTO group_welcome(chat_id, image_file_id, updated_at)
     VALUES($1,$2,CURRENT_TIMESTAMP)
     ON CONFLICT(chat_id) DO UPDATE
       SET image_file_id=$2, updated_at=CURRENT_TIMESTAMP`,
    [chatId, fileId]
  );
  return ctx.reply('✅ تم حفظ صورة الترحيب').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
}

async function setWelcomeMessage(ctx, chatId, message) {
  await run(
    `INSERT INTO group_welcome(chat_id, message, updated_at)
     VALUES($1,$2,CURRENT_TIMESTAMP)
     ON CONFLICT(chat_id) DO UPDATE
       SET message=$2, updated_at=CURRENT_TIMESTAMP`,
    [chatId, message]
  );
  return ctx.reply(
    '✅ تم حفظ رسالة الترحيب\n\n📝 المتغيرات المتاحة:\n`{name}` - اسم العضو\n`{spec}` - التخصص\n`{id}` - المعرّف\n`{date}` - التاريخ\n`{time}` - الساعة',
    { parse_mode: 'Markdown' }
  ).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
}

async function clearWelcome(chatId) {
  await run('DELETE FROM group_welcome WHERE chat_id=$1', [chatId]);
}

// ══════════════════════════════════════════════════════════
// 👥 عرض الأعضاء
// ══════════════════════════════════════════════════════════
async function showAllMembers(ctx, chatId) {
  try {
    const cacheKey = 'grp_members_' + chatId;
    let members = cacheGet(cacheKey);

    if (!members) {
      // 1. جلب المسجلين في DB
      members = await all(
        'SELECT user_id, first_name FROM group_members WHERE chat_id=$1 ORDER BY updated_at DESC LIMIT 500',
        [chatId]
      ).catch(() => []);

      // 2. جلب الأدمنز من Telegram وإضافتهم
      try {
        const admins = await ctx.telegram.getChatAdministrators(chatId).catch(() => []);
        for (const a of admins) {
          if (!a?.user || a.user.is_bot) continue;
          if (!members.find(m => String(m.user_id) === String(a.user.id))) {
            members.push({ user_id: a.user.id, first_name: (a.user.first_name||'Admin')+' 👑' });
          }
          run(
            `INSERT INTO group_members(chat_id,user_id,username,first_name,updated_at)
             VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)
             ON CONFLICT(chat_id,user_id) DO UPDATE SET first_name=EXCLUDED.first_name, updated_at=CURRENT_TIMESTAMP`,
            [chatId, a.user.id, a.user.username||'', a.user.first_name||'Admin']
          ).catch(() => {});
        }
      } catch (_) {}

      cacheSet(cacheKey, members, 120000); // كاش دقيقتين فقط
    }

    const tgTotal = await ctx.telegram.getChatMembersCount(chatId).catch(() => 0);

    if (!members.length) {
      return ctx.reply(
        `📭 *لا يوجد أعضاء مسجلين بعد*\n\n` +
        `💡 الأعضاء يُسجَّلون تلقائياً عند إرسال أي رسالة\n` +
        `👥 إجمالي القروب حسب Telegram: *${tgTotal}*`,
        { parse_mode: 'Markdown' }
      ).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
    }

    let text = `👥 *قائمة الأعضاء*\n`;
    text += `━━━━━━━━━━━━━━━━━━\n`;
    text += `📊 مسجلون: *${members.length}* | إجمالي TG: *${tgTotal}*\n`;
    text += `━━━━━━━━━━━━━━━━━━\n\n`;

    members.slice(0, 50).forEach((m, i) => {
      const icon = (m.first_name || '').includes('👑') ? '' : '👤 ';
      text += `${i + 1}. ${icon}${m.first_name || 'مجهول'}\n`;
    });

    if (members.length > 50) {
      text += `\n_…و ${members.length - 50} عضو آخر_`;
    }

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🏷️ منشن الكل',   callback_data: 'tag_all_'   + chatId },
          { text: '📊 إحصائيات',    callback_data: 'grp_stats_' + chatId },
        ],
        [
          { text: '🔇 إسكات الكل',  callback_data: 'mute_all_'   + chatId },
          { text: '🔊 تفعيل الكل',  callback_data: 'unmute_all_' + chatId },
        ],
        [
          { text: '📥 تسجيل الأعضاء', callback_data: 'grp_reg_btn_' + chatId },
        ],
        [
          { text: '🗑 إغلاق',       callback_data: 'close_list_' + chatId },
        ],
      ],
    };

    const sentMsg = await ctx.reply(text, {
      parse_mode:   'Markdown',
      reply_markup: keyboard,
    }).catch(() => null);

    // حذف القائمة بعد 30 ثانية تلقائياً
    if (sentMsg) {
      setTimeout(() => ctx.deleteMessage(sentMsg.message_id).catch(err => { require('../utils/logger').debug("[silent]", err.message); }), 30000);
    }
    return sentMsg;
  } catch (e) {
    console.error('[/all]', e.message);
    return ctx.reply('❌ خطأ: ' + e.message).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
  }
}

// ══════════════════════════════════════════════════════════
// 🏷️ منشن الكل — مع رسالة مخصصة
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════
// 📥 تسجيل الأعضاء — يطلب من الكل يضغط زر
// ══════════════════════════════════════════
async function registerMembers(ctx, chatId) {
  try {
    ctx.answerCbQuery('📤 جاري الإرسال...').catch(() => {});
    ctx.deleteMessage().catch(() => {});

    const text =
      '📋 *تسجيل الأعضاء*\n\n' +
      '👋 اضغط الزر أدناه لتسجيل نفسك في قائمة الأعضاء\n' +
      '_هذا يساعد البوت على منشنك عند الحاجة_';

    const msg = await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{
          text: '✅ سجّل نفسي',
          callback_data: 'grp_register_' + chatId
        }]]
      }
    }).catch(() => null);

    // احذف الرسالة بعد 5 دقائق
    if (msg) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 300000);
  } catch(e) {
    console.error('[registerMembers]', e.message);
  }
}

// ── cooldown: دقيقة بين كل استخدام لنفس القروب لمنع إساءة الاستخدام ──
const _tagAllCooldown = new Map();
const TAGALL_COOLDOWN_MS = 60000;

async function tagAll(ctx, chatId, customMessage) {
  try {
    const isCb = !!ctx.callbackQuery;
    if (isCb) ctx.answerCbQuery('⏳ جاري التحضير…').catch(() => {});

    // فحص cooldown
    const lastUse = _tagAllCooldown.get(chatId) || 0;
    const remaining = TAGALL_COOLDOWN_MS - (Date.now() - lastUse);
    if (remaining > 0) {
      const sec = Math.ceil(remaining / 1000);
      const warn = await ctx.reply(`⏳ انتظر ${sec} ثانية قبل استخدام منشن الكل مجدداً.`).catch(() => null);
      if (warn) setTimeout(() => ctx.telegram.deleteMessage(chatId, warn.message_id).catch(() => {}), 6000);
      return;
    }
    _tagAllCooldown.set(chatId, Date.now());

    const members = await all(
      'SELECT user_id, first_name FROM group_members WHERE chat_id=$1 AND is_bot=0 LIMIT 400',
      [chatId]
    ).catch(() => []);

    if (!members.length) {
      const msg = '📭 لا يوجد أعضاء مسجلون بعد.';
      if (isCb) return ctx.answerCbQuery(msg, { show_alert: true }).catch(() => {});
      const m = await ctx.reply(msg).catch(() => null);
      if (m) setTimeout(() => ctx.telegram.deleteMessage(chatId, m.message_id).catch(() => {}), 6000);
      return;
    }

    const total = members.length;
    const header = customMessage ? `📢 *${customMessage}*\n\n` : '👥 *تنبيه لجميع الأعضاء*\n\n';

    // رسالة تقدّم للأعداد الكبيرة
    const progressMsg = total > 40
      ? await ctx.reply(`${header}⏳ جارٍ منشن *${total}* عضو...`, { parse_mode: 'Markdown' }).catch(() => null)
      : null;

    // تقسيم ذكي حسب ميزانية الأحرف (يقلل عدد الرسائل)
    const CHAR_BUDGET = 3600;
    const batches = [];
    let cur = [], curLen = header.length;
    for (const m of members) {
      const name = (m.first_name || '👤').replace(/[[\]()~`>#+\-=|{}.!]/g, '').slice(0, 15);
      const mention = `[${name}](tg://user?id=${m.user_id})`;
      const addLen = mention.length + 1;
      if (curLen + addLen > CHAR_BUDGET && cur.length) {
        batches.push(cur); cur = []; curLen = 0;
      }
      cur.push(mention); curLen += addLen;
    }
    if (cur.length) batches.push(cur);

    let sentTotal = 0;
    for (let i = 0; i < batches.length; i++) {
      const text = (i === 0 ? header : '') + batches[i].join(' ');
      let retries = 0;
      while (retries < 3) {
        try {
          await ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true });
          sentTotal += batches[i].length;
          break;
        } catch (e) {
          const wait = parseInt(e.message?.match(/retry after (\d+)/i)?.[1] || '5');
          if (e.message?.includes('429') || e.message?.includes('Too Many')) {
            await sleep((wait + 1) * 1000);
            retries++;
          } else { break; }
        }
      }
      // تحديث رسالة التقدّم كل 5 دفعات
      if (progressMsg && (i + 1) % 5 === 0 && sentTotal < total) {
        ctx.telegram.editMessageText(chatId, progressMsg.message_id, null,
          `${header}⏳ *${sentTotal}/${total}* عضو تم منشنهم...`, { parse_mode: 'Markdown' }).catch(() => {});
      }
      if (i + 1 < batches.length) await sleep(1300);
    }

    // ملخص نهائي على رسالة التقدّم
    const summary = `✅ تم منشن *${sentTotal}* عضو`;
    if (progressMsg) {
      await ctx.telegram.editMessageText(chatId, progressMsg.message_id, null, summary, { parse_mode: 'Markdown' }).catch(() => {});
      setTimeout(() => ctx.telegram.deleteMessage(chatId, progressMsg.message_id).catch(() => {}), 10000);
    }

  } catch (e) {
    console.error('[tagAll]', e.message);
  }
}

// ══════════════════════════════════════════════════════════
// 🔇 إسكات الكل
// ══════════════════════════════════════════════════════════
async function muteAll(ctx, chatId) {
  try {
    ctx.answerCbQuery('⏳ جاري الإسكات…').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
    ctx.deleteMessage().catch(err => { require('../utils/logger').debug("[silent]", err.message); }); // مرة واحدة فقط ← BUG FIX

    const members = await all(
      'SELECT user_id FROM group_members WHERE chat_id=$1 LIMIT 100',
      [chatId]
    ).catch(() => []);

    if (!members.length) {
      return ctx.answerCbQuery('📭 لا يوجد أعضاء', { show_alert: true }).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
    }

    let ok = 0, fail = 0;
    const until = Math.floor(Date.now() / 1000) + 3600; // ساعة واحدة

    for (const m of members) {
      try {
        await ctx.telegram.restrictChatMember(chatId, m.user_id, {
          permissions: {
            can_send_messages:       false,
            can_send_media_messages: false,
            can_send_polls:          false,
            can_send_other_messages: false,
          },
          until_date: until,
        });
        ok++;
      } catch (_) { fail++; }
      await sleep(60); // max ~16 req/s — آمن من rate-limit
    }

    const sent = await ctx.reply(
      `🔇 *تم إسكات الأعضاء*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `✅ نجح: *${ok}* عضو\n` +
      `❌ فشل: *${fail}*\n` +
      `⏱ المدة: ساعة واحدة`,
      {
        parse_mode: 'Markdown',
        reply_to_message_id: ctx.message?.reply_to_message?.message_id,
      }
    ).catch(() => null);

    if (sent) setTimeout(() => ctx.deleteMessage(sent.message_id).catch(err => { require('../utils/logger').debug("[silent]", err.message); }), 8000);
  } catch (e) {
    console.error('[muteAll]', e.message);
  }
}

// ══════════════════════════════════════════════════════════
// 🔊 تفعيل الكل
// ══════════════════════════════════════════════════════════
async function unmuteAll(ctx, chatId) {
  try {
    ctx.answerCbQuery('⏳ جاري التفعيل…').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
    ctx.deleteMessage().catch(err => { require('../utils/logger').debug("[silent]", err.message); }); // مرة واحدة فقط ← BUG FIX

    const members = await all(
      'SELECT user_id FROM group_members WHERE chat_id=$1 LIMIT 100',
      [chatId]
    ).catch(() => []);

    if (!members.length) {
      return ctx.answerCbQuery('📭 لا يوجد أعضاء', { show_alert: true }).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
    }

    let ok = 0, fail = 0;
    for (const m of members) {
      try {
        await ctx.telegram.restrictChatMember(chatId, m.user_id, {
          permissions: {
            can_send_messages:         true,
            can_send_media_messages:   true,
            can_send_polls:            true,
            can_add_web_page_previews: true,
            can_send_other_messages:   true,
            can_change_info:           false,
            can_invite_users:          true,
            can_pin_messages:          false,
          },
        });
        ok++;
      } catch (_) { fail++; }
      await sleep(60);
    }

    const sent = await ctx.reply(
      `🔊 *تم تفعيل الكل*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `✅ نجح: *${ok}* عضو\n` +
      `❌ فشل: *${fail}*`,
      {
        parse_mode: 'Markdown',
        reply_to_message_id: ctx.message?.reply_to_message?.message_id,
      }
    ).catch(() => null);

    if (sent) setTimeout(() => ctx.deleteMessage(sent.message_id).catch(err => { require('../utils/logger').debug("[silent]", err.message); }), 8000);
  } catch (e) {
    console.error('[unmuteAll]', e.message);
  }
}

// ══════════════════════════════════════════════════════════
// 📊 إحصائيات القروب
// ══════════════════════════════════════════════════════════
async function showGroupStats(ctx, chatId) {
  try {
    ctx.answerCbQuery('📊 جاري التحميل…').catch(err => { require('../utils/logger').debug("[silent]", err.message); });

    const [tgCount, dbMembers, grp] = await Promise.all([
      ctx.telegram.getChatMembersCount(chatId).catch(() => 0),
      all('SELECT COUNT(*) AS cnt FROM group_members WHERE chat_id=$1', [chatId]).catch(() => [{ cnt: 0 }]),
      get('SELECT title, specialty_id, notify_new_files FROM group_chats WHERE chat_id=$1', [chatId]).catch(() => null),
    ]);

    const spec = grp?.specialty_id
      ? await get('SELECT name FROM specialties WHERE id=$1', [grp.specialty_id]).catch(() => null)
      : null;

    const dbCount   = dbMembers[0]?.cnt || 0;
    const notifyOn  = grp?.notify_new_files ? '🟢 مفعّل' : '🔴 معطّل';
    const specName  = spec?.name || 'غير محدد';

    const text =
      `📊 *إحصائيات القروب*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🏷 الاسم: *${grp?.title || 'غير معروف'}*\n` +
      `🎓 التخصص: *${specName}*\n\n` +
      `👥 أعضاء Telegram: *${tgCount}*\n` +
      `🗂 مسجلون في DB: *${dbCount}*\n\n` +
      `🔔 إشعارات الملفات: ${notifyOn}\n` +
      `🆔 معرف القروب: \`${chatId}\``;

    const sent = await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🗑 إغلاق', callback_data: 'close_stats_' + chatId },
        ]],
      },
    }).catch(() => null);

    if (sent) setTimeout(() => ctx.deleteMessage(sent.message_id).catch(err => { require('../utils/logger').debug("[silent]", err.message); }), 20000);
  } catch (e) {
    console.error('[GroupStats]', e.message);
  }
}

// ══════════════════════════════════════════════════════════
// 📌 قواعد القروب
// ══════════════════════════════════════════════════════════
async function showGroupRules(ctx, chatId) {
  try {
    const grp = await get('SELECT rules FROM group_chats WHERE chat_id=$1', [chatId]).catch(() => null);

    const defaultRules =
      `📜 *قواعد القروب*\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `1️⃣ الاحترام المتبادل بين جميع الأعضاء\n` +
      `2️⃣ ممنوع الإزعاج والفلود\n` +
      `3️⃣ ممنوع الإعلانات والسبام\n` +
      `4️⃣ الحفاظ على موضوع القروب (الدراسة)\n` +
      `5️⃣ المشرفون يملكون حق التحذير والطرد\n\n` +
      `⚠️ مخالفة القواعد = تحذير ثم حظر`;

    const text = grp?.rules || defaultRules;

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '✅ قرأت وفهمت', callback_data: 'rules_ok' }]],
      },
    }).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
  } catch (e) {
    console.error('[Rules]', e.message);
  }
}

async function setGroupRules(ctx, chatId, rules) {
  await run(
    `UPDATE group_chats SET rules=$1 WHERE chat_id=$2`,
    [rules, chatId]
  );
  return ctx.reply('✅ تم حفظ قواعد القروب').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
}

// ══════════════════════════════════════════════════════════
// 🛡 نظام التحذيرات (Warn System)
// ══════════════════════════════════════════════════════════
async function warnMember(ctx, chatId, targetUserId, reason) {
  try {
    // أضف تحذير
    await run(
      `INSERT INTO group_warns(chat_id, user_id, warned_by, reason, created_at)
       VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)`,
      [chatId, targetUserId, ctx.from.id, reason || 'مخالفة القواعد']
    ).catch(err => { require('../utils/logger').debug("[silent]", err.message); });

    // احسب مجموع التحذيرات
    const warnCount = await get(
      'SELECT COUNT(*) AS cnt FROM group_warns WHERE chat_id=$1 AND user_id=$2',
      [chatId, targetUserId]
    ).catch(() => ({ cnt: 0 }));

    const count = parseInt(warnCount?.cnt || 0);
    const MAX_WARNS = 3;

    let actionText = '';
    if (count >= MAX_WARNS) {
      // حظر تلقائي بعد 3 تحذيرات
      try {
        await ctx.telegram.banChatMember(chatId, targetUserId);
        actionText = `\n🚫 *تم الحظر تلقائياً* بعد ${MAX_WARNS} تحذيرات!`;
        // إعادة ضبط التحذيرات
        await run('DELETE FROM group_warns WHERE chat_id=$1 AND user_id=$2', [chatId, targetUserId]).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      } catch (_) {
        actionText = `\n⚠️ *تعذّر الحظر* — يرجى المراجعة يدوياً`;
      }
    } else if (count === MAX_WARNS - 1) {
      actionText = `\n⚠️ *تحذير أخير!* — تحذير آخر = حظر فوري`;
    }

    const _warnKb = count < MAX_WARNS ? [
      [{ text: 'انذارات', callback_data: 'grp_warnmenu_' + targetUserId + '_' + chatId },
       { text: 'كتم', callback_data: 'grp_mute_menu_' + targetUserId + '_' + chatId }],
      [{ text: '🚫 حظر 🏹',   callback_data: 'grp_ban_confirm_' + targetUserId + '_' + chatId },
       { text: 'اذونات', callback_data: 'grp_perms_' + targetUserId + '_' + chatId }],
    ] : [
      [{ text: '🔓 رفع الحظر', callback_data: 'grp_unban_' + targetUserId }],
    ];
    const msg = await ctx.reply(
      `⚠️ *تحذير رسمي*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `👤 المستخدم: [user](tg://user?id=${targetUserId})\n` +
      `📝 السبب: ${(reason || 'مخالفة القواعد')}\n` +
      `🔢 التحذير رقم: *${count}/${MAX_WARNS}*` +
      actionText,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: _warnKb } }
    ).catch(() => null);

    if (msg) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(err => { require('../utils/logger').debug("[silent]", err.message); }), 30000);
  } catch (e) {
    console.error('[Warn]', e.message);
  }
}

async function showWarns(ctx, chatId, targetUserId) {
  try {
    const warns = await all(
      'SELECT reason, created_at FROM group_warns WHERE chat_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 10',
      [chatId, targetUserId]
    ).catch(() => []);

    if (!warns.length) {
      return ctx.reply('✅ هذا العضو لا يملك أي تحذيرات').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
    }

    let text = `📋 *تحذيرات العضو*\n━━━━━━━━━━━━━━━━━━\n\n`;
    warns.forEach((w, i) => {
      const d = new Date(w.created_at).toLocaleDateString('ar-DZ');
      text += `${i + 1}. ${w.reason || 'لا سبب'} — _${d}_\n`;
    });

    return ctx.reply(text, { parse_mode: 'Markdown' }).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
  } catch (e) {
    console.error('[ShowWarns]', e.message);
  }
}

async function clearWarns(ctx, chatId, targetUserId) {
  await run('DELETE FROM group_warns WHERE chat_id=$1 AND user_id=$2', [chatId, targetUserId]).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
  return ctx.reply('✅ تم مسح تحذيرات العضو').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
}

// ══════════════════════════════════════════════════════════
// 🚫 حظر / رفع الحظر
// ══════════════════════════════════════════════════════════
async function banMember(ctx, chatId, targetUserId, reason, deleteMessages) {
  try {
    await ctx.telegram.banChatMember(chatId, targetUserId, {
      revoke_messages: deleteMessages || false,
    });

    // سجّل الحظر
    await run(
      `INSERT INTO group_bans(chat_id, user_id, banned_by, reason, created_at)
       VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)
       ON CONFLICT(chat_id, user_id) DO UPDATE SET reason=$4, updated_at=CURRENT_TIMESTAMP`,
      [chatId, targetUserId, ctx.from.id, reason || 'لا سبب']
    ).catch(err => { require('../utils/logger').debug("[silent]", err.message); });

    const msg = await ctx.reply(
      `🚫 *تم الحظر*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `👤 [العضو](tg://user?id=${targetUserId})\n` +
      `📝 السبب: ${reason || 'غير محدد'}`,
      {
        parse_mode: 'Markdown',
        reply_to_message_id: ctx.message?.reply_to_message?.message_id,
        reply_markup: { inline_keyboard: [
          [{ text: 'انذارات', callback_data: 'grp_warnmenu_' + targetUserId + '_' + chatId },
           { text: 'كتم', callback_data: 'grp_mute_menu_' + targetUserId + '_' + chatId }],
          [{ text: 'حظر',        callback_data: 'grp_ban_now_' + targetUserId },
           { text: 'اذونات',     callback_data: 'grp_perms_' + targetUserId + '_' + chatId }],
        ]}
      }
    ).catch(() => null);

    if (msg) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(err => { require('../utils/logger').debug("[silent]", err.message); }), 10000);
  } catch (e) {
    ctx.reply('❌ فشل الحظر: ' + e.message).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
  }
}

async function unbanMember(ctx, chatId, targetUserId) {
  try {
    await ctx.telegram.unbanChatMember(chatId, targetUserId);
    await run('DELETE FROM group_bans WHERE chat_id=$1 AND user_id=$2', [chatId, targetUserId]).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
    const msg = await ctx.reply(`✅ تم رفع الحظر عن [العضو](tg://user?id=${targetUserId})`, {
      parse_mode: 'Markdown',
    }).catch(() => null);
    if (msg) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(err => { require('../utils/logger').debug("[silent]", err.message); }), 8000);
  } catch (e) {
    ctx.reply('❌ فشل رفع الحظر: ' + e.message).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
  }
}

// ══════════════════════════════════════════════════════════
// 🔕 إسكات / تفعيل عضو واحد
// ══════════════════════════════════════════════════════════
async function muteMember(ctx, chatId, targetUserId, durationMinutes) {
  try {
    const until = durationMinutes
      ? Math.floor(Date.now() / 1000) + durationMinutes * 60
      : 0; // 0 = إلى الأبد

    await ctx.telegram.restrictChatMember(chatId, targetUserId, {
      permissions: {
        can_send_messages:       false,
        can_send_media_messages: false,
        can_send_polls:          false,
        can_send_other_messages: false,
      },
      until_date: until || undefined,
    });

    const durText = durationMinutes ? `${durationMinutes} دقيقة` : 'حتى يتم التفعيل يدوياً';
    const msg = await ctx.reply(
      `🔇 *تم إسكات العضو*\n` +
      `👤 [العضو](tg://user?id=${targetUserId})\n` +
      `⏱ المدة: ${durText}`,
      {
        parse_mode: 'Markdown',
        reply_to_message_id: ctx.message?.reply_to_message?.message_id,
        reply_markup: { inline_keyboard: [
          [{ text: 'انذارات', callback_data: 'grp_warnmenu_' + targetUserId + '_' + chatId },
           { text: 'كتم', callback_data: 'grp_mute_menu_' + targetUserId + '_' + chatId }],
          [{ text: 'حظر',        callback_data: 'grp_ban_now_' + targetUserId },
           { text: 'اذونات',     callback_data: 'grp_perms_' + targetUserId + '_' + chatId }],
        ]}
      }
    ).catch(() => null);
    if (msg) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(err => { require('../utils/logger').debug("[silent]", err.message); }), 8000);
  } catch (e) {
    ctx.reply('❌ فشل الإسكات: ' + e.message).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
  }
}

async function unmuteMember(ctx, chatId, targetUserId) {
  try {
    await ctx.telegram.restrictChatMember(chatId, targetUserId, {
      permissions: {
        can_send_messages:         true,
        can_send_media_messages:   true,
        can_send_polls:            true,
        can_add_web_page_previews: true,
        can_send_other_messages:   true,
        can_change_info:           false,
        can_invite_users:          true,
        can_pin_messages:          false,
      },
    });

    const msg = await ctx.reply(
      `🔊 *تم تفعيل العضو*\n👤 [العضو](tg://user?id=${targetUserId})`,
      {
        parse_mode: 'Markdown',
        reply_to_message_id: ctx.message?.reply_to_message?.message_id,
        reply_markup: { inline_keyboard: [
          [{ text: 'انذارات', callback_data: 'grp_warnmenu_' + targetUserId + '_' + chatId },
           { text: 'كتم', callback_data: 'grp_mute_menu_' + targetUserId + '_' + chatId }],
          [{ text: 'حظر',        callback_data: 'grp_ban_now_' + targetUserId },
           { text: 'اذونات',     callback_data: 'grp_perms_' + targetUserId + '_' + chatId }],
        ]}
      }
    ).catch(() => null);
    if (msg) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(err => { require('../utils/logger').debug("[silent]", err.message); }), 8000);
  } catch (e) {
    ctx.reply('❌ فشل التفعيل: ' + e.message).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
  }
}

// ══════════════════════════════════════════════════════════
// 🤖 مكافحة السبام (Anti-Spam)
// ══════════════════════════════════════════════════════════
const _spamMap = new Map(); // userId → { count, last }

function checkAntiSpam(userId, maxMsg = 5, windowMs = 5000) {
  const now  = Date.now();
  const data = _spamMap.get(userId) || { count: 0, last: now };

  if (now - data.last > windowMs) {
    _spamMap.set(userId, { count: 1, last: now });
    return false; // لا سبام
  }

  data.count++;
  data.last = now;
  _spamMap.set(userId, data);
  return data.count > maxMsg; // سبام!
}

// تنظيف خريطة السبام كل دقيقة
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [k, v] of _spamMap.entries()) {
    if (v.last < cutoff) _spamMap.delete(k);
  }
}, 60000).unref();

// ══════════════════════════════════════════════════════════
// 🔗 Helper
// ══════════════════════════════════════════════════════════
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════
// Exports
// ══════════════════════════════════════════════════════════
module.exports = {
  handleNewMember,
  handleMemberLeft,
  showAllMembers,
  registerMembers,
  tagAll,
  muteAll,
  unmuteAll,
  showGroupStats,
  showGroupRules,
  setGroupRules,
  warnMember,
  showWarns,
  clearWarns,
  banMember,
  unbanMember,
  muteMember,
  unmuteMember,
  setWelcomeImage,
  setWelcomeMessage,
  clearWelcome,
  checkAntiSpam,
};
