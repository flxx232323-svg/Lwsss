'use strict';
const escMd = t => (t || '').replace(/[*_`\[\]()~>#+=|{}.!\-]/g, '\\$&');
const { build, btn } = require('../utils/keyboard');
const { eos } = require('../utils/helpers');
const interactions = require('../database/interactions');
const usersDb = require('../database/users');
const content = require('../database/content');
const { cacheGet, cacheSet } = require('../utils/cache');
const filesDb = require('../database/files');
const { escMd: escMdCommon } = require('../utils/common');
const safeInt = v => { const n = parseInt(v); return isNaN(n) ? 0 : n; };

async function startHandler(ctx) {
  // ── FIRST: deep link shortcuts ──
  const _sp = ctx.startPayload || ((ctx.message?.text || '').split(' ')[1]) || '';
  if (_sp === 'mygroups') return require('./group_panel').showMyGroups(ctx);

  const uid  = ctx.uid;
  const name = ctx.from?.first_name || 'طالب';

  // ── تحقق من الاشتراك + رسالة الترحيب بالتوازي ──
  const { getSetting } = require('../database/db');
  const guard = require('../utils/channelGuard');
  const [_guardRes, welcomeText, welcomeMediaId, welcomeMediaType] = await Promise.all([
    (!ctx.isOwner && !ctx.isAdmin && ctx.chat?.type === 'private')
      ? guard.checkAllChannels({ telegram: ctx.telegram }, uid)
      : Promise.resolve({ ok: true }),
    getSetting('start_welcome_text').catch(() => null),
    getSetting('start_welcome_media_id').catch(() => null),
    getSetting('start_welcome_media_type').catch(() => null),
  ]);
  if (!_guardRes.ok) {
    const { text, buttons } = guard.buildSubscribeMessage(_guardRes.missing, name);
    return ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(() => {});
  }

  if ((welcomeText || welcomeMediaId) && !ctx.startPayload) {
    const _now = new Date(Date.now() + 3600000);
    const _date = _now.toLocaleDateString('ar-DZ', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const _time = _now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const _spec = await require('../database/db').get('SELECT s.name FROM users u LEFT JOIN specialties s ON u.specialty_id=s.id WHERE u.id=$1', [uid]).then(r => r?.name || '').catch(() => '');
    const _wt = (welcomeText || '')
      .replace(/\{name\}/g,    ctx.from?.first_name || 'صديق')
      .replace(/\{mention\}/g, '[' + (ctx.from?.first_name || 'صديق') + '](tg://user?id=' + uid + ')')
      .replace(/\{id\}/g,      String(uid))
      .replace(/\{username\}/g, ctx.from?.username ? '@' + ctx.from.username : ctx.from?.first_name || 'صديق')
      .replace(/\{spec\}/g,    _spec)
      .replace(/\{date\}/g,    _date)
      .replace(/\{time\}/g,    _time);
    const BOT_UN = process.env.BOT_USERNAME || '';
    const rows = [
      [btn('📚 تصفح المحتوى', 'browse')],
      [btn('👥 قروباتي', 'gp_mylist')],
      [{ text: '➕ أضف البوت لمجموعتك', url: 'https://t.me/' + BOT_UN + '?startgroup=true' }]
    ];
    const replyOpts = {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: rows }
    };
    if (welcomeMediaId && welcomeMediaType === 'photo') {
      await ctx.replyWithPhoto(welcomeMediaId, { caption: _wt, ...replyOpts }).catch(() => {
        ctx.reply(_wt, { ...replyOpts, disable_web_page_preview: false }).catch(() => {});
      });
    } else if (welcomeMediaId && welcomeMediaType === 'video') {
      await ctx.replyWithVideo(welcomeMediaId, { caption: _wt, ...replyOpts }).catch(() => {
        ctx.reply(_wt, { ...replyOpts, disable_web_page_preview: false }).catch(() => {});
      });
    } else {
      await ctx.reply(_wt, { ...replyOpts, disable_web_page_preview: false }).catch(() => {});
    }
    return;
  }
  const rawText = ctx.message?.text || '';
  const payload = rawText.includes(' ') ? rawText.split(' ')[1] : ctx.startPayload || null;

  // ── deep link: mygroups ──
  if (payload === 'mygroups') {
    return require('./group_panel').showMyGroups(ctx);
  }

  // ── deep link لملف مباشر ──
  if (payload?.startsWith('file_')) {
    const fid = safeInt(payload.replace('file_', ''));
    if (fid > 0) {
      const f = await filesDb.getFile(fid);
      if (f) {
        const isFav = await interactions.isFav(uid, fid).catch(() => false);
        const cap = '📄 *' + escMdCommon(f.title) + '*' +
          (f.description ? '\n📝 ' + escMdCommon(f.description) : '') +
          '\n📁 ' + escMdCommon(f.cat_name || '') + ' | 📖 ' + escMdCommon(f.sub_name || '');
        const kb = build([[
          btn(isFav ? '⭐ محفوظ' : '☆ حفظ', 'fav_' + fid),
          btn('🏠 الرئيسية', 'main_menu')
        ]]);
        try {
          if (f.file_type === 'photo')
            await ctx.replyWithPhoto(f.file_id, { caption: cap, parse_mode: 'Markdown', ...kb });
          else if (f.file_type === 'video')
            await ctx.replyWithVideo(f.file_id, { caption: cap, parse_mode: 'Markdown', ...kb });
          else if (f.file_type === 'link')
            await ctx.reply(cap + '\n\n🔗 ' + f.file_id, { parse_mode: 'Markdown', ...kb });
          else
            await ctx.replyWithDocument(f.file_id, { caption: cap, parse_mode: 'Markdown', ...kb });
          interactions.addHistory(uid, fid).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
          filesDb.incDownloads(fid).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
          // ملفات مشابهة
          require('./browse')._showSimilar(ctx, f, 0, 0, 0, 0, f.category_id).catch(() => {});
        } catch (e) { await ctx.reply('❌ تعذر إرسال الملف'); }
      }
      return; // لا تكمل للقائمة
    }
  }

  const hasSp = await usersDb.getSpecialty(uid);
  if (!hasSp) return askSpecialty(ctx, name);
  return showMainMenu(ctx, name);
}

async function askSpecialty(ctx, name) {
  const specs = await content.getSpecs();
  if (!specs.length) return showMainMenu(ctx, name);
  const rows = specs.map(s => [btn('🎓 ' + s.name, 'set_sp_' + s.id)]);
  rows.push([btn('⏭ تخطي لاحقاً', 'skip_sp')]);
  return eos(ctx,
    '👋 *أهلاً ' + name + '!*\n\n' +
    '📚 منصتك الأكاديمية على تيليغرام\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '🎓 *اختر تخصصك للبدء:*',
    { parse_mode: 'Markdown', ...build(rows) }
  );
}

async function showMainMenu(ctx, name) {
  const uid = ctx.uid;
  if (!name) name = ctx.from?.first_name || 'Student';

  // ── cache ──
  const menuKey = 'menu_data_' + uid;
  let menuData = cacheGet(menuKey);
  if (!menuData) {
    const spRow = await usersDb.getSpecialty(uid);
    const _spId = spRow?.specialty_id || null;
    const sp = _spId && _spId != 0
      ? (cacheGet('spec_' + _spId) || await content.getSpec(_spId))
      : null;
    menuData = { sp };
    cacheSet(menuKey, menuData, 60000);
  }

  const { sp } = menuData;
  const hour = new Date(Date.now() + 3600000).getHours(); // UTC+1 Algeria
  const timeGreet = hour < 5  ? '🌙 مساء النور'  :
                    hour < 12 ? '🌅 صباح النور'  :
                    hour < 18 ? '☀️ مساء الخير'  : '🌙 مساء النور';

  const specLine = sp ? '🎓 *' + escMd(sp.name) + '*' : '🎓 اختر تخصصك';

  // ── آخر ملف للمستخدم ──
  let lastFileBtn = null;
  try {
    const hist = await interactions.getHistory(uid, 1).catch(() => []);
    if (hist?.length) {
      const lf = hist[0];
      const shortTitle = (lf.title || '').substring(0, 20);
      lastFileBtn = btn('▶️ استكمال: ' + shortTitle, 'preview_' + lf.id + '_0_0_0_0_0');
    }
  } catch(err) { require('../utils/logger').debug('[catch]', err.message); }

  const welcome =
    timeGreet + ' *' + escMd(ctx.from?.first_name || 'Student') + '*\n' +
    '━━━━━━━━━━━━━━━━━━━━\n' +
    specLine + '\n\n' +
    '📚 *منصتك الأكاديمية* — اختر ما تريد:';

  const rows = [
    [btn('📚 تصفح المحتوى', 'browse')],
    [btn('🔍 بحث', 'search_prompt'), btn('⭐ مفضلاتي', 'favorites')],
    [btn('🗂 سجلي', 'history'),     btn('👤 ملفي', 'profile')],
  ];

  if (lastFileBtn) rows.push([lastFileBtn]);

  // ── لوحة الإدارة ──
  if (ctx.isOwner) rows.push([btn('🔧 لوحة الإدارة', 'mg_menu')]);
  else if (ctx.isAdmin) rows.push([btn('🛡️ لوحة الإدارة', 'mg_menu')]);

  return eos(ctx, welcome, { parse_mode: 'Markdown', ...build(rows) });
}

startHandler.clearAiMode = async function(uid) {
  const state = require('../utils/stateManager').getState(uid);
  if (state?.type === 'ai_mode') await require('../utils/stateManager').delState(uid);
};


async function showWelcome(telegram, chatId, from, name) {
  const uid = from?.id;
  if (!uid) return;
  try {
    const spRow = await usersDb.getSpecialty(uid);
    const _spId = spRow?.specialty_id || null;
    const sp = _spId && _spId != 0 ? await content.getSpec(_spId) : null;
    const hour = new Date(Date.now() + 3600000).getHours();
    const timeGreet = hour < 5 ? '🌙' : hour < 12 ? '🌅 صباح النور' : hour < 18 ? '☀️ مساء الخير' : '🌙 مساء النور';
    const specLine = sp ? '🎓 *' + escMd(sp.name) + '*' : '';
    const welcome = timeGreet + ' *' + escMd(name) + '*\n━━━━━━━━━━━━━━━━━━━━\n' + (specLine ? specLine + '\n\n' : '\n') + '📚 *منصتك الأكاديمية* — اختر ما تريد:';
    const rows = [
      [{ text: '📚 تصفح المحتوى', callback_data: 'browse' }],
      [{ text: '🔍 بحث سريع', callback_data: 'search_prompt' }, { text: '🆕 أحدث الملفات', callback_data: 'latest' }],
      [{ text: '⭐ مفضلاتي', callback_data: 'favorites' }, { text: '🗂 آخر ما شاهدت', callback_data: 'history' }],
      [{ text: '👤 ملفي', callback_data: 'profile' }, { text: '📊 إحصائياتي', callback_data: 'stats' }],
      [{ text: sp ? '🎓 تغيير تخصصي' : '🎓 اختر تخصصي', callback_data: 'change_sp' }],
    ];
    await telegram.sendMessage(chatId, welcome, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
  } catch(e) {}
}

module.exports = startHandler;
module.exports.showMainMenu = showMainMenu;
module.exports.showWelcome = showWelcome;
module.exports.askSpecialty = askSpecialty;
