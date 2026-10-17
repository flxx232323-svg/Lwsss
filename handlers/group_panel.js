'use strict';
const { all, run, get } = require('../database/db');
const { build: kbBuild, btn: kbBtn } = require('../utils/keyboard');
const { eos } = require('../utils/helpers');
const { cacheGet, cacheSet } = require('../utils/cache');

// ══════════════════════════════════════════════════════════
// 🏆 ترتيب القروبات (Leaderboard) — أدوات مساعدة
// ══════════════════════════════════════════════════════════
const RANK_EMOJI = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const MEMBER_COUNT_TTL = 10 * 60 * 1000; // 10 دقائق

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

// عدد أعضاء القروب الحقيقي من تيليجرام (مع كاش لتجنّب تجاوز حدود الـ API)
async function getMemberCount(ctx, chatId, force) {
  const ck = 'grpmc_' + chatId;
  if (!force) {
    const cached = cacheGet(ck);
    if (cached !== null) return cached;
  }
  try {
    const cnt = await ctx.telegram.getChatMembersCount(chatId);
    cacheSet(ck, cnt, MEMBER_COUNT_TTL);
    return cnt;
  } catch (_) {
    return null;
  }
}

async function migrateGroupPanel() {
  const cols = [
    'ALTER TABLE group_chats ADD COLUMN IF NOT EXISTS welcome_enabled INTEGER DEFAULT 1',
    'ALTER TABLE group_chats ADD COLUMN IF NOT EXISTS welcome_msg     TEXT',
    'ALTER TABLE group_chats ADD COLUMN IF NOT EXISTS welcome_photo   TEXT',
    'ALTER TABLE group_chats ADD COLUMN IF NOT EXISTS goodbye_enabled INTEGER DEFAULT 0',
  ];
  for (const q of cols) await run(q, []).catch(() => {});
  console.log('[GroupPanel] Migration done');
}

// تنظيف الأسماء من الزخرفات والرموز الخاصة التي تكسر عرض القائمة
function cleanTitle(title, fallback) {
  if (!title) return fallback;
  // احتفظ بالحروف العربية/اللاتينية/الأرقام/المسافات فقط + إيموجي بسيطة
  let clean = title.replace(/[\u0300-\u036f\u0653-\u065f\u0670\u06d6-\u06ed]/g, ''); // إزالة التشكيل/الزخرفة
  clean = clean.replace(/[^\u0621-\u064A\u0660-\u0669a-zA-Z0-9\s\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
  return clean || fallback;
}

async function showGroupPanel(ctx) {
  // تنظيف سريع — نتحقق من أول 20 قروب فقط لتجنب البطء
  const allG = await all('SELECT chat_id, title FROM group_chats WHERE is_active!=0 ORDER BY title').catch(() => []);
  const botId = ctx.botInfo?.id || (await ctx.telegram.getMe().catch(() => ({}))).id;
  const { run: dbRun2 } = require('../database/db');
  // parallel بدل sequential — أسرع بـ 10x
  await Promise.allSettled(allG.slice(0, 20).map(async g => {
    try {
      const bm = await ctx.telegram.getChatMember(g.chat_id, botId).catch(() => null);
      if (!bm || ['left','kicked'].includes(bm.status)) {
        await dbRun2('UPDATE group_chats SET is_active=0 WHERE chat_id=$1', [g.chat_id]).catch(() => {});
        g._remove = true;
      }
    } catch(_) {
      await dbRun2('UPDATE group_chats SET is_active=0 WHERE chat_id=$1', [g.chat_id]).catch(() => {});
      g._remove = true;
    }
  }));
  const groups = allG.filter(g => !g._remove);
  const total = groups.length;

  let text = '📋 *لوحة إدارة القروبات*\n';
  text += '━━━━━━━━━━━━━━━━━━\n\n';
  text += '👥 *القروبات المسجلة:* ' + total + '\n';

  const rows = [];

  if (!groups.length) {
    text += '\n_لا توجد قروبات بعد_\n';
    text += '_أضف البوت لقروب وسيظهر هنا_';
  } else {
    const _gbtns = groups.map(g => {
      const sp = g.specialty_id ? '🎓' : '📚';
      const w  = g.welcome_enabled ? '✅' : '❌';
      return kbBtn(sp + ' ' + Array.from(cleanTitle(g.title, 'قروب ' + g.chat_id)).slice(0, 14).join('') + ' ' + w, 'gp_view_' + g.chat_id);
    });
    for (let i = 0; i < _gbtns.length; i += 2) rows.push(_gbtns.slice(i, i + 2)); // 2×2
  }

  rows.push([kbBtn('📢 رسالة للكل', 'gp_broadcast_0')]);
  rows.push([kbBtn('⚙️ الإعدادات الافتراضية للقروبات الجديدة', 'gp_defaults')]);
  rows.push([kbBtn('◀️ رجوع', 'grp_main')]);

  return eos(ctx, text, { parse_mode: 'Markdown', ...kbBuild(rows) });
}

// ══════════════════════════════════════════════════════════
// ⚙️ الإعدادات الافتراضية العامة — تُطبَّق على أي قروب جديد
// ══════════════════════════════════════════════════════════
async function showDefaultSettings(ctx) {
  const uid = ctx.uid || ctx.from?.id;
  if (uid !== parseInt(process.env.OWNER_ID)) return ctx.answerCbQuery('🚫').catch(() => {});

  await run(`CREATE TABLE IF NOT EXISTS bot_defaults (
    key TEXT PRIMARY KEY, value TEXT
  )`).catch(() => {});

  const rows = await all('SELECT key, value FROM bot_defaults').catch(() => []);
  const defs = {};
  rows.forEach(r => defs[r.key] = r.value);

  const hasMsg = !!defs.default_welcome_msg;
  const hasPhoto = !!defs.default_welcome_photo;

  const text =
    '⚙️ *الإعدادات الافتراضية للقروبات الجديدة*\n━━━━━━━━━━━━━━━\n\n' +
    'هذه الإعدادات تُطبَّق تلقائياً على أي قروب جديد لا يملك رسالة ترحيب مخصصة.\n\n' +
    '📝 رسالة افتراضية: ' + (hasMsg ? '✅ مضبوطة' : '❌ (يُستخدم النص الأساسي)') + '\n' +
    '🖼 صورة افتراضية: ' + (hasPhoto ? '✅ مضبوطة' : '❌ بدون صورة') + '\n\n' +
    '_المتغيرات المتاحة: {name} {mention} {id} {spec} {date} {time} {count} {group}_';

  const kb = [
    [kbBtn('✏️ تعديل الرسالة الافتراضية', 'gp_def_setmsg')],
    [kbBtn('🖼 تعديل الصورة الافتراضية', 'gp_def_setphoto')],
    hasMsg || hasPhoto ? [kbBtn('🗑 إعادة الضبط للنص الأساسي', 'gp_def_reset')] : null,
    [kbBtn('◀️ رجوع', 'gp_panel')],
  ].filter(Boolean);

  return ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } })
    .catch(() => ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(() => {}));
}

async function handleDefaultCallback(ctx, data) {
  const uid = ctx.uid || ctx.from?.id;
  if (uid !== parseInt(process.env.OWNER_ID)) return ctx.answerCbQuery('🚫').catch(() => {});

  if (data === 'gp_def_setmsg') {
    await require('../utils/stateManager').setState(uid, { type: 'gp_def_msg' });
    return ctx.reply(
      '✏️ *أرسل نص الرسالة الافتراضية الجديدة:*\n\n' +
      '_المتغيرات: {name} {mention} {id} {spec} {date} {time} {count} {group}_\n\n' +
      '💡 نصيحة: استخدم {mention} بدل {id} داخل رابط — يعطي اسم واضح بدل رقم مغبش.\n\n' +
      '(أو /cancel للإلغاء)',
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }

  if (data === 'gp_def_setphoto') {
    await require('../utils/stateManager').setState(uid, { type: 'gp_def_photo' });
    return ctx.reply('🖼 أرسل الصورة الافتراضية الجديدة:\n\n(أو /cancel للإلغاء)').catch(() => {});
  }

  if (data === 'gp_def_reset') {
    await run('DELETE FROM bot_defaults WHERE key IN ($1,$2)', ['default_welcome_msg', 'default_welcome_photo']).catch(() => {});
    ctx.answerCbQuery('✅ تمت إعادة الضبط').catch(() => {});
    return showDefaultSettings(ctx);
  }

  return false;
}

// ══════════════════════════════════════════════════════════
// 🏆 ترتيب القروبات — الأكثر أعضاءً
// ══════════════════════════════════════════════════════════
async function showGroupsLeaderboard(ctx, opts = {}) {
  const force = !!opts.refresh;

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(force ? '🔄 جاري التحديث...' : '⏳ جاري التحميل...').catch(() => {});
  }

  const groups = await all('SELECT chat_id, title FROM group_chats WHERE is_active!=0').catch(() => []);

  if (!groups.length) {
    return eos(ctx, '📭 لا توجد قروبات نشطة بعد.', {
      parse_mode: 'Markdown',
      ...kbBuild([[kbBtn('◀️ رجوع', 'grp_main')]]),
    });
  }

  const results = await Promise.allSettled(groups.map(g => getMemberCount(ctx, g.chat_id, force)));

  const ranked = groups
    .map((g, i) => ({ ...g, count: results[i].status === 'fulfilled' ? results[i].value : null }))
    .filter(g => g.count !== null)
    .sort((a, b) => b.count - a.count);

  if (!ranked.length) {
    return eos(ctx, '⚠️ تعذّر جلب بيانات الأعضاء حالياً، حاول لاحقاً.', {
      parse_mode: 'Markdown',
      ...kbBuild([[kbBtn('🔄 إعادة المحاولة', 'gp_leaderboard_refresh')], [kbBtn('◀️ رجوع', 'grp_main')]]),
    });
  }

  const totalMembers = ranked.reduce((s, g) => s + g.count, 0);

  let text = '🏆 *ترتيب القروبات*\n━━━━━━━━━━━━━━━━━━\n\n';
  ranked.forEach((g, i) => {
    const rank = RANK_EMOJI[i] || (i + 1) + '.';
    const title = cleanTitle(g.title, 'قروب ' + g.chat_id).substring(0, 30);
    text += rank + ' ' + title + '\n';
    text += '👥 ' + fmtNum(g.count) + ' عضو\n\n';
  });
  text += '━━━━━━━━━━━━━━━━━━\n';
  text += '📊 إجمالي الأعضاء عبر *' + ranked.length + '* قروب: *' + fmtNum(totalMembers) + '*';
  if (ranked.length < groups.length) {
    text += '\n⚠️ تعذّر جلب ' + (groups.length - ranked.length) + ' قروب (قد يكون البوت أُزيل منها)';
  }

  const rows = [
    [kbBtn('🔄 تحديث', 'gp_leaderboard_refresh')],
    [kbBtn('◀️ رجوع', 'grp_main')],
  ];
  return eos(ctx, text, { parse_mode: 'Markdown', ...kbBuild(rows) });
}

// ✅ تحقق موحّد من صلاحية إدارة قروب مُعيّن (Owner أو أدمن حقيقي في *هذا* القروب بالذات)
async function checkGroupAdmin(ctx, chatId) {
  const uid = Number(ctx.uid || ctx.from?.id);
  const ownerId = Number(process.env.OWNER_ID);
  if (uid === ownerId) return true;
  try {
    const member = await ctx.telegram.getChatMember(chatId, uid);
    if (['administrator','creator'].includes(member?.status)) return true;
  } catch (e) { /* fallthrough */ }
  await ctx.answerCbQuery('🚫 ليس لديك صلاحية إدارة هذا القروب', { show_alert: true }).catch(() => {});
  return false;
}

async function showGroupDetail(ctx, chatId) {
  const uid = ctx.uid || ctx.from?.id;
  const isOwner = uid === parseInt(process.env.OWNER_ID);

  // تحقق من صلاحيات المستخدم
  if (!isOwner) {
    try {
      const member = await ctx.telegram.getChatMember(chatId, uid);
      if (!['administrator','creator'].includes(member?.status)) {
        return ctx.answerCbQuery('🚫 ليس لديك صلاحية إدارة هذا القروب', { show_alert: true }).catch(() => {});
      }
    } catch(e) {
      return ctx.answerCbQuery('🚫 تعذر التحقق من صلاحياتك', { show_alert: true }).catch(() => {});
    }
  }

  const [g, spec, mc, warns, bans, protSettings, tgCount] = await Promise.all([
    get('SELECT * FROM group_chats WHERE chat_id=$1', [chatId]),
    get('SELECT s.name FROM specialties s JOIN group_chats g ON g.specialty_id=s.id WHERE g.chat_id=$1', [chatId]).catch(() => null),
    get('SELECT COUNT(*) AS cnt FROM group_members WHERE chat_id=$1', [chatId]).catch(() => ({ cnt: 0 })),
    get('SELECT COUNT(*) AS cnt FROM group_warns WHERE chat_id=$1', [chatId]).catch(() => ({ cnt: 0 })),
    get('SELECT COUNT(*) AS cnt FROM group_bans WHERE chat_id=$1', [chatId]).catch(() => ({ cnt: 0 })),
    require('./group_protection').getSettings(chatId).catch(() => null),
    getMemberCount(ctx, chatId),
  ]);
  if (!g) return ctx.answerCbQuery('غير موجود', { show_alert: true }).catch(() => {});

  const on  = '🟢';
  const off = '🔴';

  let text = '👥 *' + cleanTitle(g.title, 'قروب').substring(0,30) + '*\n';
  text += '━━━━━━━━━━━━━━━━━━\n\n';
  text += '🆔 `' + chatId + '`\n';
  text += '🎓 التخصص: *' + (spec?.name || 'غير محدد') + '*\n';
  if (tgCount !== null) text += '👥 إجمالي الأعضاء: *' + fmtNum(tgCount) + '*\n';
  text += '👤 الأعضاء المسجلون: *' + mc.cnt + '*\n';
  text += '⚠️ التحذيرات: *' + warns.cnt + '* | 🚫 المحظورون: *' + bans.cnt + '*\n\n';
  text += '━━━━━━━━━━━━━━━━━━\n';
  text += '⚙️ *الإعدادات:*\n';
  text += (g.welcome_enabled  ? on : off) + ' رسالة الترحيب\n';
  text += (g.goodbye_enabled  ? on : off) + ' رسالة الوداع\n';
  text += (g.notify_new_files ? on : off) + ' إشعار الملفات الجديدة\n';
  if (protSettings) {
    const antiKeys = Object.keys(protSettings).filter(k => k.startsWith('anti_'));
    const protCount = antiKeys.filter(k => protSettings[k]).length;
    text += '🛡 الحماية الاحترافية: *' + protCount + '/' + antiKeys.length + '* مفعّلة\n';
  }

  const rows = [
    [kbBtn('👥 الأعضاء',        'grp_main_' + chatId),
     kbBtn('👮 الإدارة',        'gp_roles_' + chatId)],
    [kbBtn('📋 السجل',          'gp_logs_' + chatId),
     kbBtn('📊 الإحصائيات',     'grp_stats_' + chatId)],
    [kbBtn('💬 الرسائل',        'gp_msgone_' + chatId),
     kbBtn('🛡 الحماية',        'gpx_home_' + chatId)],
    [kbBtn('⚙️ إعدادات القروب', 'gp_settings_' + chatId)],
  ];
  rows.push([kbBtn('◀️ رجوع', 'gp_panel'), kbBtn('🗑 إغلاق', 'gp_close')]);
  rows.push([kbBtn('🚪 خروج من القروب', 'gp_leave_' + chatId)]);
  return eos(ctx, text, { parse_mode: 'Markdown', ...kbBuild(rows) });
}

// ── ⚙️ إعدادات القروب — صفحة تجميعية تربط الأقسام الموجودة دون تكرارها ──
async function showGroupSettingsSection(ctx, chatId) {
  const rows = [
    [kbBtn('👋 الترحيب والوداع', 'gp_sec_welcome_' + chatId),
     kbBtn('📢 الإشعارات',      'gp_sec_notify_' + chatId)],
    [kbBtn('📜 تعديل القواعد',  'gp_setrules_' + chatId),
     kbBtn('🎓 معلومات القروب', 'gp_sec_info_' + chatId)],
  ];
  if (ctx.isOwner) {
    rows.push([kbBtn('🗳 التصويت', 'gp_sec_poll_' + chatId)]);
  }
  rows.push([kbBtn('◀️ رجوع', 'gp_view_' + chatId)]);
  return eos(ctx, '⚙️ *إعدادات القروب*\n━━━━━━━━━━━━━━━━━━', { parse_mode: 'Markdown', ...kbBuild(rows) });
}

// ── قوائم فرعية جديدة ──
async function showGroupWelcomeSection(ctx, chatId) {
  const rows = [
    [kbBtn('📜 تعديل القواعد', 'gp_setrules_' + chatId),
     kbBtn('✏️ رسالة الترحيب', 'gp_setwelcome_' + chatId)],
    [kbBtn('🖼 صورة الترحيب', 'gp_setwphoto_' + chatId)],
    [kbBtn('◀️ رجوع', 'gp_settings_' + chatId)],
  ];
  return eos(ctx, '👋 *الترحيب والوداع*\n━━━━━━━━━━━━━━━━━━', { parse_mode: 'Markdown', ...kbBuild(rows) });
}

async function showGroupNotifySection(ctx, chatId, g) {
  const rows = [
    [kbBtn(g.welcome_enabled  ? '🔴 إيقاف الترحيب'  : '🟢 تفعيل الترحيب',  'gp_togglew_'      + chatId)],
    [kbBtn(g.goodbye_enabled  ? '🔴 إيقاف الوداع'   : '🟢 تفعيل الوداع',   'gp_togglebye_'    + chatId)],
    [kbBtn(g.notify_new_files ? '🔕 إيقاف الإشعار'  : '🔔 تفعيل الإشعار',  'gp_togglenotify_' + chatId)],
    [kbBtn('◀️ رجوع', 'gp_settings_' + chatId)],
  ];
  return eos(ctx, '📢 *الإشعارات*\n━━━━━━━━━━━━━━━━━━', { parse_mode: 'Markdown', ...kbBuild(rows) });
}

async function showGroupInfoSection(ctx, chatId) {
  const rows = [
    [kbBtn('🎓 تغيير التخصص', 'gp_setspec_' + chatId)],
    [kbBtn('◀️ رجوع', 'gp_settings_' + chatId)],
  ];
  return eos(ctx, '🎓 *معلومات القروب*\n━━━━━━━━━━━━━━━━━━', { parse_mode: 'Markdown', ...kbBuild(rows) });
}

async function showGroupPollSection(ctx, chatId) {
  if (!ctx.isOwner) return ctx.answerCbQuery('🚫 هذا القسم للمالك فقط').catch(() => {});
  const rows = [
    [kbBtn('📋 إنشاء تصويت', 'gp_poll_' + chatId)],
    [kbBtn('⏹ إيقاف التصويت', 'gp_pollstop_' + chatId), kbBtn('👁 عرض النتائج', 'gp_pollresults_' + chatId)],
    [kbBtn('◀️ رجوع', 'gp_settings_' + chatId)],
  ];
  return eos(ctx, '🗳 *التصويت*\n━━━━━━━━━━━━━━━━━━', { parse_mode: 'Markdown', ...kbBuild(rows) });
}

async function showBroadcastSpecPicker(ctx) {
  const specs = await all('SELECT * FROM specialties ORDER BY name').catch(() => []);
  const rows = specs.map(s => [kbBtn('🎓 ' + s.name, 'gp_broadcast_' + s.id)]);
  rows.push([kbBtn('📣 كل القروبات', 'gp_broadcast_0')]);
  rows.push([kbBtn('◀️ رجوع', 'grp_main')]);
  return eos(ctx, '📢 *ارسال رسالة للقروبات*\n━━━━━━━━━━━━━━━━━━\n\nاختر التخصص:', { parse_mode: 'Markdown', ...kbBuild(rows) });
}

async function handleCallback(ctx, data) {
  const uid = ctx.uid;
  if (data === 'gp_panel') { const uid = ctx.uid || ctx.from?.id; const isOwner = uid === parseInt(process.env.OWNER_ID); return isOwner ? showGroupPanel(ctx) : showMyGroups(ctx); }
  if (data === 'gp_defaults') return showDefaultSettings(ctx);
  if (data === 'gp_botuser') return showBotUserPanel(ctx);
  if (data === 'gp_def_setmsg' || data === 'gp_def_setphoto' || data === 'gp_def_reset') return handleDefaultCallback(ctx, data);

  if (data === 'gp_broadcast_sp') return showBroadcastSpecPicker(ctx);

  if (data === 'gp_leaderboard')         return showGroupsLeaderboard(ctx);
  if (data === 'gp_leaderboard_refresh') return showGroupsLeaderboard(ctx, { refresh: true });

  // ── أقسام لوحة القروب المُنظَّمة ──
  if (data.startsWith('gp_sec_welcome_')) return showGroupWelcomeSection(ctx, data.replace('gp_sec_welcome_', ''));
  if (data.startsWith('gp_sec_notify_')) {
    const chatId = data.replace('gp_sec_notify_', '');
    const g = await get('SELECT * FROM group_chats WHERE chat_id=$1', [chatId]).catch(() => ({}));
    return showGroupNotifySection(ctx, chatId, g || {});
  }
  if (data.startsWith('gp_sec_info_')) return showGroupInfoSection(ctx, data.replace('gp_sec_info_', ''));
  if (data.startsWith('gp_sec_poll_')) return showGroupPollSection(ctx, data.replace('gp_sec_poll_', ''));

  // ── تعديل قواعد القروب ──
  if (data.startsWith('gp_setrules_')) {
    const chatId = data.replace('gp_setrules_', '');
    // ✅ لازم يكون OWNER أو أدمن حقيقي في هذا القروب بالذات
    const isOwnerR = uid === parseInt(process.env.OWNER_ID);
    if (!isOwnerR) {
      try {
        const member = await ctx.telegram.getChatMember(chatId, uid);
        if (!['administrator','creator'].includes(member?.status)) {
          return ctx.answerCbQuery('🚫 ليس لديك صلاحية إدارة هذا القروب', { show_alert: true }).catch(() => {});
        }
      } catch(e) {
        return ctx.answerCbQuery('🚫 تعذر التحقق من صلاحياتك', { show_alert: true }).catch(() => {});
      }
    }
    await require('../utils/stateManager').setState(ctx.from.id, { type: 'gp_set_rules', chatId });
    return ctx.reply(
      '📜 *تعديل قواعد القروب*\n\nأرسل القواعد الجديدة:\n_(أو /cancel للإلغاء)_\n\n' +
      '💡 يمكنك استخدام الأرقام والإيموجي:\n' +
      '1️⃣ الاحترام المتبادل\n' +
      '2️⃣ ممنوع الفلود...',
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }

  if (data.startsWith('gp_broadcast_')) {
    const spId = data.replace('gp_broadcast_', '');
    await require('../utils/stateManager').setState(uid, { type: 'gp_broadcast_msg', spId });
    return ctx.reply('📢 *ارسال رسالة للقروبات*\n\nارسل الرسالة:\n نص فقط\n صورة مع caption\n فيديو مع caption\n\n_(او /cancel)_', { parse_mode: 'Markdown' }).catch(() => {});
  }

  if (data === 'gp_mylist') {
    return showMyGroups(ctx);
  }

  if (data.startsWith('gp_poll_')) {
    const chatId = data.replace('gp_poll_', '');
    await require('../handlers/poll_system').startCreate(ctx, chatId);
    return true;
  }

  if (data.startsWith('gp_pollstop_')) {
    const chatId = data.replace('gp_pollstop_', '');
    const poll = await require('../database/db').get('SELECT * FROM polls WHERE chat_id=$1 ORDER BY created_at DESC LIMIT 1', [chatId]).catch(() => null);
    if (!poll) return ctx.answerCbQuery('❌ ما فيه تصويت بهذا القروب', { show_alert: true }).catch(() => {});
    if (!poll.is_active) return ctx.answerCbQuery('⚠️ التصويت متوقف مسبقاً', { show_alert: true }).catch(() => {});
    await require('../handlers/poll_system').endPoll(ctx.telegram, poll.id);
    return ctx.answerCbQuery('✅ تم إيقاف التصويت').catch(() => {});
  }

  if (data.startsWith('gp_pollresults_')) {
    const chatId = data.replace('gp_pollresults_', '');
    const poll = await require('../database/db').get('SELECT * FROM polls WHERE chat_id=$1 ORDER BY created_at DESC LIMIT 1', [chatId]).catch(() => null);
    if (!poll) return ctx.answerCbQuery('❌ ما فيه تصويت بهذا القروب', { show_alert: true }).catch(() => {});
    return require('../handlers/poll_system').showResults(ctx, poll.id);
  }

  if (data.startsWith('gp_msgone_')) {
    const chatId = data.replace('gp_msgone_', '');
    await require('../utils/stateManager').setState(uid, { type: 'gp_msgone', chatId });
    return ctx.reply('📢 ارسل الرسالة لهذا القروب:\n_(او /cancel)_', { parse_mode: 'Markdown' }).catch(() => {});
  }

  if (data === 'gp_invite_me_list') return handleInviteMeList(ctx);
  if (data.startsWith('gp_gen_invite_')) return handleGenInvite(ctx, data.replace('gp_gen_invite_', ''));

  if (data.startsWith('gp_settings_')) {
    const chatId = data.replace('gp_settings_', '');
    if (!(await checkGroupAdmin(ctx, chatId))) return;
    return showGroupSettingsSection(ctx, chatId);
  }

  if (data.startsWith('gp_roles_')) {
    const chatId = data.replace('gp_roles_', '');
    if (!(await checkGroupAdmin(ctx, chatId))) return;
    return require('./group_roles').showRolesMenu(ctx, chatId);
  }

  if (data.startsWith('gp_logs_')) {
    const chatId = data.replace('gp_logs_', '');
    if (!(await checkGroupAdmin(ctx, chatId))) return;
    return require('./group_logs').showLogsMenu(ctx, chatId);
  }

  if (data.startsWith('gp_view_')) return showGroupDetail(ctx, data.replace('gp_view_', ''));

  if (data.startsWith('gp_togglew_')) {
    const chatId = data.replace('gp_togglew_', '');
    const g = await get('SELECT welcome_enabled, goodbye_enabled, notify_new_files FROM group_chats WHERE chat_id=$1', [chatId]);
    await run('UPDATE group_chats SET welcome_enabled=$1 WHERE chat_id=$2', [g?.welcome_enabled ? 0 : 1, chatId]);
    const g2 = await get('SELECT welcome_enabled, goodbye_enabled, notify_new_files FROM group_chats WHERE chat_id=$1', [chatId]);
    return showGroupNotifySection(ctx, chatId, g2 || {});
  }

  if (data.startsWith('gp_togglebye_')) {
    const chatId = data.replace('gp_togglebye_', '');
    const g = await get('SELECT welcome_enabled, goodbye_enabled, notify_new_files FROM group_chats WHERE chat_id=$1', [chatId]);
    await run('UPDATE group_chats SET goodbye_enabled=$1 WHERE chat_id=$2', [g?.goodbye_enabled ? 0 : 1, chatId]);
    const g2 = await get('SELECT welcome_enabled, goodbye_enabled, notify_new_files FROM group_chats WHERE chat_id=$1', [chatId]);
    return showGroupNotifySection(ctx, chatId, g2 || {});
  }

  if (data.startsWith('gp_togglenotify_')) {
    const chatId = data.replace('gp_togglenotify_', '');
    const g = await get('SELECT welcome_enabled, goodbye_enabled, notify_new_files FROM group_chats WHERE chat_id=$1', [chatId]);
    await run('UPDATE group_chats SET notify_new_files=$1 WHERE chat_id=$2', [g?.notify_new_files ? 0 : 1, chatId]);
    const g2 = await get('SELECT welcome_enabled, goodbye_enabled, notify_new_files FROM group_chats WHERE chat_id=$1', [chatId]);
    return showGroupNotifySection(ctx, chatId, g2 || {});
  }

  if (data.startsWith('gp_setwelcome_')) {
    const chatId = data.replace('gp_setwelcome_', '');
    // ✅ OWNER أو أدمن حقيقي في هذا القروب بالذات
    const isOwnerW = uid === parseInt(process.env.OWNER_ID);
    if (!isOwnerW) {
      try {
        const member = await ctx.telegram.getChatMember(chatId, uid);
        if (!['administrator','creator'].includes(member?.status)) {
          return ctx.answerCbQuery('🚫 ليس لديك صلاحية إدارة هذا القروب', { show_alert: true }).catch(() => {});
        }
      } catch(e) {
        return ctx.answerCbQuery('🚫 تعذر التحقق من صلاحياتك', { show_alert: true }).catch(() => {});
      }
    }
    await require('../utils/stateManager').setState(uid, { type: 'gp_set_welcome', chatId });
    return ctx.reply('✏️ ارسل نص رسالة الترحيب:\n\nالمتغيرات: {name} اسم العضو | {id} معرفه | {date} التاريخ\n\n_(او /cancel)_', { parse_mode: 'Markdown' }).catch(() => {});
  }

  if (data.startsWith('gp_setwphoto_')) {
    const chatId = data.replace('gp_setwphoto_', '');
    // ✅ OWNER أو أدمن حقيقي في هذا القروب بالذات
    const isOwnerP = uid === parseInt(process.env.OWNER_ID);
    if (!isOwnerP) {
      try {
        const member = await ctx.telegram.getChatMember(chatId, uid);
        if (!['administrator','creator'].includes(member?.status)) {
          return ctx.answerCbQuery('🚫 ليس لديك صلاحية إدارة هذا القروب', { show_alert: true }).catch(() => {});
        }
      } catch(e) {
        return ctx.answerCbQuery('🚫 تعذر التحقق من صلاحياتك', { show_alert: true }).catch(() => {});
      }
    }
    await require('../utils/stateManager').setState(uid, { type: 'gp_set_wphoto', chatId });
    return ctx.reply('🖼 ارسل صورة الترحيب:\n_(او /cancel)_', { parse_mode: 'Markdown' }).catch(() => {});
  }

  if (data.startsWith('gp_setspec_')) {
    const chatId = data.replace('gp_setspec_', '');
    const specs = await all('SELECT * FROM specialties ORDER BY name').catch(() => []);
    const rows = specs.map(s => [kbBtn('🎓 ' + s.name, 'gp_dospec_' + chatId + '_' + s.id)]);
    rows.push([kbBtn('◀️ رجوع', 'gp_view_' + chatId)]);
    return eos(ctx, 'اختر التخصص:', { ...kbBuild(rows) });
  }

  if (data.startsWith('gp_dospec_')) {
    const parts = data.replace('gp_dospec_', '').split('_');
    const chatId = parts[0];
    const spId = parts[1];
    await run('UPDATE group_chats SET specialty_id=$1 WHERE chat_id=$2', [spId, chatId]);
    ctx.answerCbQuery('تم تحديث التخصص').catch(() => {});
    return showGroupDetail(ctx, chatId);
  }
}

async function handleText(ctx, text, state) {
  if (state.type === 'gp_set_rules') {
    if (text === '/cancel') {
      await require('../utils/stateManager').delState(ctx.uid);
      return ctx.reply('❌ تم الإلغاء').catch(() => {});
    }
    await run('UPDATE group_chats SET rules=$1 WHERE chat_id=$2', [text, state.chatId]).catch(() => {});
    await require('../utils/stateManager').delState(ctx.uid);
    await ctx.reply('✅ *تم حفظ القواعد بنجاح!*\n\nسيظهر للأعضاء عند كتابة /rules في القروب.', { parse_mode: 'Markdown' }).catch(() => {});
    return showGroupDetail(ctx, state.chatId);
  }
  if (state.type === 'gp_set_welcome') {
    // حفظ في الجدولين
    await run('UPDATE group_chats SET welcome_msg=$1 WHERE chat_id=$2', [text, state.chatId]).catch(() => {});
    await run(
      `INSERT INTO group_welcome(chat_id, message, updated_at) VALUES($1,$2,NOW())
       ON CONFLICT(chat_id) DO UPDATE SET message=$2, updated_at=NOW()`,
      [state.chatId, text]
    ).catch(() => {});
    await require('../utils/stateManager').delState(ctx.uid);
    await ctx.reply('✅ تم حفظ رسالة الترحيب!\n\n📝 المتغيرات:\n`{name}` الاسم | `{id}` المعرف\n`{spec}` التخصص | `{date}` التاريخ\n`{count}` عدد الأعضاء | `{group}` اسم القروب', { parse_mode: 'Markdown' }).catch(() => {});
    return showGroupDetail(ctx, state.chatId);
  }
  if (state.type === 'gp_broadcast_msg') {
    await require('../utils/stateManager').delState(ctx.uid);
    return _doBroadcast(ctx, state.spId, text, null, null);
  }
  if (state.type === 'gp_msgone') {
    await require('../utils/stateManager').delState(ctx.uid);
    try {
      console.log('[gp_msgone] sending to:', state.chatId);
      await ctx.telegram.sendMessage(state.chatId, text, { parse_mode: 'Markdown' });
      return ctx.reply('تم الارسال!', kbBuild([[kbBtn('◀️ رجوع', 'gp_view_' + state.chatId)]])).catch(() => {});
    } catch (e) { return ctx.reply('فشل: ' + e.message).catch(() => {}); }
  }
  if (state.type === 'gp_def_msg') {
    if (text === '/cancel') {
      await require('../utils/stateManager').delState(ctx.uid);
      return ctx.reply('❌ تم الإلغاء').catch(() => {});
    }
    await run(`CREATE TABLE IF NOT EXISTS bot_defaults (key TEXT PRIMARY KEY, value TEXT)`).catch(() => {});
    await run(
      `INSERT INTO bot_defaults(key, value) VALUES('default_welcome_msg', $1)
       ON CONFLICT(key) DO UPDATE SET value=$1`,
      [text]
    ).catch(() => {});
    await require('../utils/stateManager').delState(ctx.uid);
    await ctx.reply('✅ *تم حفظ الرسالة الافتراضية!*\n\nستُطبَّق على أي قروب جديد بدون رسالة مخصصة.', { parse_mode: 'Markdown' }).catch(() => {});
    return showDefaultSettings(ctx);
  }
}

async function handleMedia(ctx, state) {
  // صورة الترحيب
  if (state.type === 'gp_set_wphoto') {
    const photo = ctx.message?.photo;
    const fileId = photo ? photo[photo.length - 1].file_id : null;
    if (!fileId) return ctx.reply('⚠️ أرسل صورة صحيحة').catch(() => {});
    await run(
      `INSERT INTO group_welcome(chat_id, image_file_id, updated_at) VALUES($1,$2,NOW())
       ON CONFLICT(chat_id) DO UPDATE SET image_file_id=$2, updated_at=NOW()`,
      [state.chatId, fileId]
    ).catch(() => {});
    await run('UPDATE group_chats SET welcome_photo=$1 WHERE chat_id=$2', [fileId, state.chatId]).catch(() => {});
    await require('../utils/stateManager').delState(ctx.uid);
    await ctx.reply('✅ تم حفظ صورة الترحيب!').catch(() => {});
    return showGroupDetail(ctx, state.chatId);
  }
  if (state.type === 'gp_def_photo') {
    const photo = ctx.message?.photo;
    const fileId = photo ? photo[photo.length - 1].file_id : null;
    if (!fileId) return ctx.reply('⚠️ أرسل صورة صحيحة').catch(() => {});
    await run(`CREATE TABLE IF NOT EXISTS bot_defaults (key TEXT PRIMARY KEY, value TEXT)`).catch(() => {});
    await run(
      `INSERT INTO bot_defaults(key, value) VALUES('default_welcome_photo', $1)
       ON CONFLICT(key) DO UPDATE SET value=$1`,
      [fileId]
    ).catch(() => {});
    await require('../utils/stateManager').delState(ctx.uid);
    await ctx.reply('✅ *تم حفظ الصورة الافتراضية!*', { parse_mode: 'Markdown' }).catch(() => {});
    return showDefaultSettings(ctx);
  }

  const msg = ctx.message;
  const caption = msg.caption || '';

  if (state.type === 'gp_set_wphoto') {
    const photo = msg.photo;
    if (!photo?.length) return ctx.reply('ارسل صورة صحيحة').catch(() => {});
    const fileId = photo[photo.length - 1].file_id;
    await run('UPDATE group_chats SET welcome_photo=$1 WHERE chat_id=$2', [fileId, state.chatId]);
    await require('../utils/stateManager').delState(ctx.uid);
    await ctx.reply('تم تحديث صورة الترحيب!').catch(() => {});
    return showGroupDetail(ctx, state.chatId);
  }

  if (state.type === 'gp_set_wphoto') {
    // صورة ترحيب — يجب أن تكون صورة
    await require('../utils/stateManager').delState(ctx.uid);
    await ctx.reply('⚠️ أرسل صورة وليس نصاً').catch(() => {});
    return;
  }
  if (state.type === 'gp_broadcast_msg') {
    await require('../utils/stateManager').delState(ctx.uid);
    let fileId, mediaType;
    if (msg.photo)         { fileId = msg.photo[msg.photo.length-1].file_id; mediaType = 'photo'; }
    else if (msg.video)    { fileId = msg.video.file_id;    mediaType = 'video'; }
    else if (msg.document) { fileId = msg.document.file_id; mediaType = 'document'; }
    else if (msg.sticker)  { fileId = msg.sticker.file_id;  mediaType = 'sticker'; }
    else if (msg.voice)    { fileId = msg.voice.file_id;    mediaType = 'voice'; }
    return _doBroadcast(ctx, state.spId, caption || '', fileId, mediaType);
  }

  if (state.type === 'gp_msgone') {
    await require('../utils/stateManager').delState(ctx.uid);
    try {
      if (msg.photo)
        await ctx.telegram.sendPhoto(state.chatId, msg.photo[msg.photo.length-1].file_id, { caption: caption || '', parse_mode: 'Markdown' });
      else if (msg.video)
        await ctx.telegram.sendVideo(state.chatId, msg.video.file_id, { caption: caption || '', parse_mode: 'Markdown' });
      else if (msg.voice)
        await ctx.telegram.sendVoice(state.chatId, msg.voice.file_id);
      else if (msg.sticker)
        await ctx.telegram.sendSticker(state.chatId, msg.sticker.file_id);
      else if (msg.audio)
        await ctx.telegram.sendAudio(state.chatId, msg.audio.file_id);
      return ctx.reply('تم الارسال!').catch(() => {});
    } catch (e) {
      if (e.message?.includes('TOPIC_CLOSED') || e.message?.includes('CHAT_WRITE_FORBIDDEN')) {
        return ctx.reply('تم الارسال (topic مغلق - تجاهل)').catch(() => {});
      }
      return ctx.reply('فشل: ' + e.message).catch(() => {});
    }
  }
}

async function _doBroadcast(ctx, spId, text, fileId, mediaType) {
  const groups = spId === '0'
    ? await all('SELECT chat_id FROM group_chats')
    : await all('SELECT chat_id FROM group_chats WHERE specialty_id=$1', [spId]);

  if (!groups.length)
    return ctx.reply('لا يوجد قروبات', kbBuild([[kbBtn('◀️ رجوع', 'gp_panel')]])).catch(() => {});

  const prog = await ctx.reply('جاري الارسال... ' + groups.length + ' قروب', { parse_mode: 'Markdown' }).catch(() => null);
  let sent = 0, fail = 0;
  const msgText = text;
  const CHUNK = 5;

  for (let i = 0; i < groups.length; i += CHUNK) {
    const chunk = groups.slice(i, i + CHUNK);
    const results = await Promise.allSettled(chunk.map(async g => {
      if (mediaType === 'photo' && fileId)
        return ctx.telegram.sendPhoto(g.chat_id, fileId, { caption: msgText, parse_mode: 'Markdown' });
      else if (mediaType === 'video' && fileId)
        return ctx.telegram.sendVideo(g.chat_id, fileId, { caption: msgText, parse_mode: 'Markdown' });
      else if (mediaType === 'sticker' && fileId)
        return ctx.telegram.sendSticker(g.chat_id, fileId);
      else if (mediaType === 'voice' && fileId)
        return ctx.telegram.sendVoice(g.chat_id, fileId);
      else if (mediaType === 'document' && fileId)
        return ctx.telegram.sendDocument(g.chat_id, fileId, { caption: msgText, parse_mode: 'Markdown' });
      else
        return ctx.telegram.sendMessage(g.chat_id, msgText, { parse_mode: 'Markdown' });
    }));
    results.forEach(r => r.status === 'fulfilled' ? sent++ : fail++);
    if (i + CHUNK < groups.length) await new Promise(r => setTimeout(r, 1000));
  }

  if (prog) ctx.telegram.deleteMessage(ctx.chat.id, prog.message_id).catch(() => {});

  return ctx.reply(
    'اكتمل الارسال!\nاجمالي: *' + groups.length + '*\nنجح: *' + sent + '*\nفشل: *' + fail + '*',
    { parse_mode: 'Markdown', ...kbBuild([[kbBtn('◀️ رجوع', 'gp_panel')]]) }
  ).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// القائمة الرئيسية للقروبات
// ══════════════════════════════════════════════════════════
async function showMainMenu(ctx) {
  const groups  = await all('SELECT COUNT(*) AS cnt FROM group_chats WHERE is_active!=0').then(r => r[0]?.cnt || 0).catch(() => 0);
  const channels = await all('SELECT COUNT(*) AS cnt FROM group_chats WHERE specialty_id IS NOT NULL').then(r => r[0]?.cnt || 0).catch(() => 0);

  const _isOwner = String(ctx.uid || ctx.from?.id) === String(process.env.OWNER_ID);
  const rows = [
    [kbBtn('👥 إدارة القروبات',         'gp_panel')],
    [kbBtn('🏆 ترتيب القروبات', 'gp_leaderboard'), kbBtn('🎓 رسالة لتخصص', 'gp_broadcast_sp')],
    [kbBtn('📨 أضفني لقروب (رابط دعوة)', 'gp_invite_me_list')],
  ];
  if (_isOwner) rows.push([kbBtn('🤖 Bot User', 'gp_botuser')]);
  rows.push([kbBtn('◀️ رجوع',                   'mg_menu')]);

  return eos(ctx,
    '👥 *القروبات والقنوات*\n' +
    '━━━━━━━━━━━━━━━━━━\n\n' +
    '👥 القروبات: *' + groups + '*\n',
    { parse_mode: 'Markdown', ...kbBuild(rows) }
  );
}


async function showMyGroups(ctx) {
  const uid = ctx.uid || ctx.from?.id;
  const isOwner = uid === parseInt(process.env.OWNER_ID);

  const allGroups = await all('SELECT chat_id, title FROM group_chats WHERE is_active!=0 ORDER BY title').catch(() => []);

  const BOT_UN = process.env.BOT_USERNAME || '';

  const myGroups = [];
  if (isOwner) {
    allGroups.forEach(g => myGroups.push(g));
  } else {
    // parallel — كل القروبات دفعة واحدة
    const checks = await Promise.allSettled(
      allGroups.map(g => ctx.telegram.getChatMember(g.chat_id, uid).catch(() => null))
    );
    const staleIds = [];
    checks.forEach((res, i) => {
      const g = allGroups[i];
      const member = res.status === 'fulfilled' ? res.value : null;
      const status = member?.status;
      if (['administrator','creator'].includes(status) || String(g.added_by) === String(uid)) {
        myGroups.push(g);
      }
    });

  }

  if (!myGroups.length) {
    return ctx.reply(
      '📭 أنت لست ادمين في أي قروب يحتوي البوت.\n\nأضف البوت لقروبك:',
      { reply_markup: { inline_keyboard: [[
        { text: '➕ أضف البوت لقروب', url: 'https://t.me/' + BOT_UN + '?startgroup=owner&admin=change_info+delete_messages+restrict_members+invite_users+pin_messages+manage_video_chats+manage_chat+manage_topics' }
      ]]}}
    ).catch(() => {});
    return;
  }

  const { build: kb, btn: b } = require('../utils/keyboard');
  const text = '👥 *قروباتك (' + myGroups.length + ')*\n━━━━━━━━━━━━\n\nاختر قروب لإدارته:';
  const rows = myGroups.map(g => [b('⚙️ ' + String(g.title || g.chat_id).substring(0,25), 'gp_view_' + g.chat_id)]);
  if (isOwner) {
    rows.push([b('📨 أضفني لقروب (رابط دعوة)', 'gp_invite_me_list')]);
  }
  rows.push([{ text: '➕ أضف البوت لقروب جديد', url: 'https://t.me/' + BOT_UN + '?startgroup=owner&admin=change_info+delete_messages+restrict_members+invite_users+pin_messages+manage_video_chats+manage_chat+manage_topics' }]);
  return eos(ctx, text, { parse_mode: 'Markdown', ...kbBuild(rows) });
}

// ── Owner: أضفني لقروب ──────────────────────────────────
async function handleInviteMeList(ctx) {
  const uid = ctx.uid || ctx.from?.id;
  if (uid !== parseInt(process.env.OWNER_ID)) return ctx.answerCbQuery('🚫').catch(() => {});
  ctx.answerCbQuery('').catch(() => {});

  const groups = await all('SELECT chat_id, title FROM group_chats WHERE is_active!=0 ORDER BY title').catch(() => []);
  if (!groups.length) return ctx.reply('لا توجد قروبات مسجلة.').catch(() => {});

  let text = '📨 *اختر قروب لتوليد رابط دعوة لك:*\n\n';
  const rows = [];

  for (const g of groups.slice(0, 20)) {
    rows.push([{ text: '🔗 ' + cleanTitle(g.title, String(g.chat_id)).substring(0, 30), callback_data: 'gp_gen_invite_' + g.chat_id }]);
  }
  rows.push([{ text: '◀️ رجوع', callback_data: 'grp_main' }]);

  return ctx.editMessageText(text + '_اضغط على القروب لتوليد رابط دعوة_', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows }
  }).catch(() => ctx.reply(text, { reply_markup: { inline_keyboard: rows } }).catch(() => {}));
}

async function handleGenInvite(ctx, chatId) {
  const uid = ctx.uid || ctx.from?.id;
  if (uid !== parseInt(process.env.OWNER_ID)) return ctx.answerCbQuery('🚫').catch(() => {});

  try {
    // ✅ getChat يُرجع الرابط الحالي الفعلي للقروب (invite_link) دون
    // إنشاء رابط جديد أو إبطال القديم — يبقى صالحاً ودائماً ويتحدّث
    // تلقائياً في كل استعلام حتى لو غيّره المشرفون يدوياً من تيليجرام.
    const chat = await ctx.telegram.getChat(chatId);
    let link = chat.invite_link;

    // إذا لم يوجد رابط دائم بعد (نادر)، أنشئ واحداً كـ fallback فقط أول مرة
    if (!link) {
      link = await ctx.telegram.exportChatInviteLink(chatId);
    }

    const g = await all('SELECT title FROM group_chats WHERE chat_id=$1', [chatId]).catch(() => []);
    const title = cleanTitle(g[0]?.title || chat.title, String(chatId));

    // إذا Owner محظور في هذا القروب — فك حظره تلقائياً قبل إرسال الرابط
    let wasUnbanned = false;
    try {
      const meInGroup = await ctx.telegram.getChatMember(chatId, uid).catch(() => null);
      if (meInGroup?.status === 'kicked') {
        await ctx.telegram.unbanChatMember(chatId, uid, { only_if_banned: true });
        wasUnbanned = true;
      }
    } catch(_) {}

    ctx.answerCbQuery('✅ تم جلب الرابط الحالي').catch(() => {});
    return ctx.reply(
      '🔗 *رابط دعوة لـ: ' + title + '*\n\n' + link +
      (wasUnbanned ? '\n\n✅ _تم رفع حظرك تلقائياً من هذا القروب_' : '') +
      '\n\n_هذا هو رابط القروب الحالي — يعمل مهما تغيّرت الظروف طالما لم يُبطَل يدوياً_',
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  } catch(e) {
    ctx.answerCbQuery('❌ فشل: ' + e.message.slice(0,30), { show_alert: true }).catch(() => {});
  }
}

async function cleanDeadGroups(ctx) {
  const groups = await all('SELECT chat_id, title FROM group_chats WHERE is_active!=0').catch(() => []);
  let cleaned = 0;
  for (const g of groups) {
    try {
      const me = await ctx.telegram.getChatMember(g.chat_id, ctx.botInfo.id);
      if (['left', 'kicked'].includes(me.status)) {
        await require('../database/db').run('UPDATE group_chats SET is_active=0 WHERE chat_id=$1', [g.chat_id]);
        cleaned++;
      }
    } catch (e) {
      // البوت مش موجود أصلاً بالقروب (خطأ 403 مثلاً) = ميت
      await require('../database/db').run('UPDATE group_chats SET is_active=0 WHERE chat_id=$1', [g.chat_id]).catch(() => {});
      cleaned++;
    }
  }
  return ctx.reply(`✅ تم تنظيف *${cleaned}* قروب ميت من أصل *${groups.length}*`, { parse_mode: 'Markdown' }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 🤖 Bot User — يجمع مراقبة الملفات ومراجعة الملفات (Owner فقط)
// ══════════════════════════════════════════════════════════
async function showBotUserPanel(ctx) {
  const uid = ctx.uid || ctx.from?.id;
  if (String(uid) !== String(process.env.OWNER_ID)) return ctx.answerCbQuery('🚫').catch(() => {});
  const rows = [
    [kbBtn('📥 مراقبة الملفات', 'ing_list'), kbBtn('📋 مراجعة الملفات', 'inr_q')],
    [kbBtn('◀️ رجوع', 'grp_main')],
  ];
  return eos(ctx, '🤖 *Bot User*\n━━━━━━━━━━━━━━━━━━\n\nاختر:', { parse_mode: 'Markdown', ...kbBuild(rows) });
}

module.exports = {
  showMyGroups, showMainMenu, showGroupPanel, showGroupsLeaderboard, cleanDeadGroups,
  handleCallback, handleText, handleMedia, migrateGroupPanel,
  handleInviteMeList, handleGenInvite,
  showDefaultSettings, handleDefaultCallback,
  showGroupWelcomeSection, showGroupNotifySection, showGroupInfoSection, showGroupPollSection };
