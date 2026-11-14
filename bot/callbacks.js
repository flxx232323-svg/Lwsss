'use strict';
const { handleBankGamesCallback } = require('../handlers/bank_games');
const { handleSettingsCallback } = require('../handlers/group_commands');
const browse      = require('../handlers/browse');
const groupPanel  = require('../handlers/group_panel');
const groupSetup  = require('../handlers/group_setup');
const gamesPanel  = require('../handlers/games_panel');
const millionGame = require('../handlers/millionaire');

module.exports.registerCallbacks = function(bot, deps) {
  const { handleCallback: infoCb } = require('../handlers/group_info_panel');
  const pollSystem = require('../handlers/poll_system');
  // استخراج uid و chatId من callback_data بشكل آمن مع chatId السالب
  function extractUidChat(str) {
    // format: uid_chatId حيث chatId قد يكون سالب مثل -1001234567
    const match = str.match(/^(-?\d+)_(-?\d+)$/);
    if (match) return { uid: parseInt(match[1]), chatId: parseInt(match[2]) };
    // fallback: uid فقط
    return { uid: parseInt(str), chatId: null };
  }
  const {
    CBDedup, cbRes, startHandler, manage, browse, userH,
    bundlesDb, contentDb, usersDb, interactions, commentsDb,
    cacheClear, cacheClearPrefix, kbBtn, kbBuild, eos,
    logger, safeInt, tagAll, muteAll, unmuteAll,
  } = deps;

  const { run: dbRun, all: dbAll } = require('../database/db');
  const filesDb  = require('../database/files');
  const million  = require('../handlers/million');
  const { botRequirePerm } = require('../middlewares/rbac'); // ✅ RBAC مركزي

  // ── Helpers ──
  async function hGrpSp(ctx, d) {
    // ✅ RBAC: كانت owner-only بدون سبب رغم وجود صلاحية 'manage_groups' مخصصة لإدارة القروبات.
    if (!(await botRequirePerm(ctx, 'manage_groups'))) return;
    const r = d.substring(7), i = r.lastIndexOf('_');
    const cid = parseInt(r.substring(0, i)), sid = parseInt(r.substring(i + 1));
    try {
      await dbRun('INSERT INTO group_chats(chat_id,specialty_id) VALUES($1,$2) ON CONFLICT(chat_id) DO UPDATE SET specialty_id=$2', [cid, sid]);
      const sp = await dbAll('SELECT name FROM specialties WHERE id=$1', [sid]);
      const nm = sp[0]?.name || sid;
      await ctx.answerCbQuery('✅ ' + nm).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      await ctx.telegram.editMessageText(cid, ctx.callbackQuery.message.message_id, null, '✅ تخصص القروب: 🎓 ' + nm).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
    } catch(e) { ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(err => { require('../utils/logger').debug("[silent]", err.message); }); }
  }

  async function hGrpDl(ctx, d) {
    // ✅ RBAC: كانت owner-only بدون سبب — نفس فئة إجراءات إدارة القروبات.
    if (!(await botRequirePerm(ctx, 'manage_groups'))) return;
    // ✅ رد فوري على الزر
    ctx.answerCbQuery('📤 جاري الإرسال...').catch(() => {});
    try {
      const f = await filesDb.getFile(d.substring(7));
      if (!f) return;
      const cap = '📄 ' + f.title + (f.sub_name ? '\n📚 ' + f.sub_name : '');
      let sm;
      if (f.file_type === 'photo')     sm = await ctx.telegram.sendPhoto(ctx.chat.id, f.file_id, { caption: cap });
      else if (f.file_type === 'link') sm = await ctx.telegram.sendMessage(ctx.chat.id, cap + '\n🔗 ' + f.file_id);
      else                              sm = await ctx.telegram.sendDocument(ctx.chat.id, f.file_id, { caption: cap });
      if (sm?.message_id) dbRun('INSERT INTO group_bot_msgs(chat_id,message_id) VALUES($1,$2)', [ctx.chat.id, sm.message_id]).catch(() => {});
    } catch(e) { logger.error('[hGrpDl]', e.message); }
  }

  async function hSearchDel(ctx, d) {
    // ✅ RBAC: كان يكفي isAdmin ثنائي — الآن يتطلب صلاحية 'delete' تحديداً.
    if (!(await botRequirePerm(ctx, 'delete'))) return;
    const p = d.substring(11).split('|'), fid = p[0], q = decodeURIComponent(p[1] || '');
    await filesDb.softDelete(fid);
    cacheClearPrefix('search_');
    if (global._clearSearchCache) global._clearSearchCache();
    await ctx.answerCbQuery('✅ تم الحذف').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
    return userH.handleSearch(ctx, q);
  }

  async function hMgTtype(ctx, d) {
    if (!ctx.reply) return;
    const i = d.indexOf('_', 9), tt = d.substring(9, i), nm = decodeURIComponent(d.substring(i + 1));
    if (tt === 'text' || tt === 'link') {
      await require('../utils/stateManager').setState(ctx.from?.id, { type: 'mg_tpl_content', name: nm, tplType: tt, fileId: '' });
      return ctx.reply(tt === 'link' ? '🔗 اكتب الرابط:' : '✏️ اكتب المحتوى:').catch(() => {});
    }
    await require('../utils/stateManager').setState(ctx.from?.id, { type: 'mg_tpl_file', name: nm, tplType: tt, fileId: '' });
    return ctx.reply('📎 أبعث الملف أو الصورة:').catch(() => {});
  }

  // ── Exact matches ──
  const exactR = new Map([
    ['bundle_search_prompt', async ctx => {
      await require('../utils/stateManager').setState(ctx.uid, { type: 'bundle_search' });
      return ctx.reply('🔍 اكتب اسم الحزمة للبحث:').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
    }],
    ['bundle_list', async ctx => {
      try {
        const rows = await bundlesDb.getAllBundles().catch(() => []);
        if (!rows.length) return ctx.reply('📦 لا توجد حزم.').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
        const kb = rows.map(b => [kbBtn('📦 ' + b.title + (b.specialty_name ? ' · ' + b.specialty_name : ''), 'bundle_view_' + b.id)]);
        kb.push([kbBtn('➕ حزمة جديدة', 'bundle_new')]);
        return eos(ctx, '📦 *الحزم الدراسية* (' + rows.length + ')', { parse_mode: 'Markdown', ...kbBuild(kb) });
      } catch(e) { return ctx.reply('❌ ' + e.message).catch(err => { require('../utils/logger').debug("[silent]", err.message); }); }
    }],
    ['bundle_new', async ctx => {
      await require('../utils/stateManager').setState(ctx.uid, { type: 'mg_bundle_create' });
      return ctx.reply('📦 اكتب اسم الحزمة الجديدة:').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
    }],
    ['noop',       () => {}],
    ['main_menu',  ctx => startHandler.showMainMenu(ctx)],
    ['mygroups_refresh', ctx => tools.listGroups(ctx)],
    
    ['mg_open_app', async ctx => {
      const url = process.env.WEBHOOK_URL + '/app/app_index.html?v=' + Date.now();
      return ctx.reply('📱 افتح الـ Mini App:', {
        reply_markup: { inline_keyboard: [[{ text: '📱 فتح EduMaster App', web_app: { url } }]] }
      }).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
    }],
    ['mg_toggle_app', async ctx => {
      global._appPublic = !global._appPublic;
      await ctx.answerCbQuery(global._appPublic ? '✅ App ظاهر للكل' : '🔒 App مخفي', { show_alert: true }).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      return manage.mainMenu(ctx);
    }],
    ['mg_menu',    ctx => { if (!ctx.isAdmin) return ctx.answerCbQuery('🚫', { show_alert: true }).catch(err => { require('../utils/logger').debug("[silent]", err.message); }); return manage.mainMenu(ctx); }],
    ['mg_cat_stats',  ctx => { if (!ctx.isAdmin) return ctx.answerCbQuery('🚫',{show_alert:true}).catch(()=>{}); return manage.catStats(ctx); }],
    ['mg_cat_content', ctx => { if (!ctx.isAdmin) return ctx.answerCbQuery('🚫',{show_alert:true}).catch(()=>{}); return manage.catContent(ctx); }],
    ['mg_cat_notify',  ctx => { if (!ctx.isAdmin) return ctx.answerCbQuery('🚫',{show_alert:true}).catch(()=>{}); return manage.catNotify(ctx); }],
    ['mg_cat_tools',   ctx => { if (!ctx.isAdmin) return ctx.answerCbQuery('🚫',{show_alert:true}).catch(()=>{}); return manage.catTools(ctx); }],
    ['mg_cat_admin',  ctx => { if (!ctx.isAdmin) return ctx.answerCbQuery('🚫',{show_alert:true}).catch(()=>{}); return manage.catAdmin(ctx); }],
    ['mg_cat_system', ctx => { if (!ctx.isAdmin) return ctx.answerCbQuery('🚫',{show_alert:true}).catch(()=>{}); return manage.catSystem(ctx); }],
    ['mg_content', ctx => { if (!ctx.isAdmin) return ctx.answerCbQuery('🚫', { show_alert: true }).catch(err => { require('../utils/logger').debug("[silent]", err.message); }); return manage.handleCallback(ctx, 'mg_content'); }],
    ['browse',          ctx => browse.showSpecs(ctx)],
    ['latest',          ctx => userH.showLatest(ctx)],
    ['new_in_sp',       ctx => userH.showNewInSpecialty(ctx)],
    ['recommended',     ctx => userH.showRecommended(ctx)],
    ['favorites',       ctx => userH.showFavorites(ctx)],
    ['history',         ctx => userH.showHistory(ctx)],
    ['profile',         ctx => userH.showProfile(ctx)],
    ['stats',           ctx => userH.showStats(ctx)],
    ['progress',        ctx => userH.showProgress(ctx)],
    ['search_prompt',   ctx => { require('../utils/stateManager').setState(ctx.uid, { type: 'search' }); return ctx.reply('🔍 اكتب كلمة البحث:').catch(err => { require('../utils/logger').debug("[silent]", err.message); }); }],
    ['ai_prompt',       ctx => { require('../utils/stateManager').setState(ctx.uid, { type: 'ai_mode' }); return ctx.reply('🤖 المساعد الذكي مفعل!\n\nاكتب سؤالك:').catch(err => { require('../utils/logger').debug("[silent]", err.message); }); }],
    ['ai_reset',        ctx => { const { resetChat } = require('../handlers/ai_chat'); resetChat(ctx.uid); return ctx.reply('🔄 تم مسح سياق المحادثة.').catch(err => { require('../utils/logger').debug("[silent]", err.message); }); }],
    ['clear_my_history', async ctx => {
      await dbRun('DELETE FROM history WHERE user_id=$1', [ctx.uid]).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      cacheClear('lastfile_' + ctx.uid); cacheClear('rec_' + ctx.uid);
      return ctx.answerCbQuery('✅ تم مسح سجلك', { show_alert: true }).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
    }],
    ['skip_sp',   async ctx => { await usersDb.setSpecialty(ctx.uid, 0); return startHandler.showMainMenu(ctx); }],
    ['change_sp', async ctx => {
      const sp = await contentDb.getSpecs();
      // 2×2 grid
      const rows = [];
      for (let i = 0; i < sp.length; i += 2) {
        const row = [require('../utils/keyboard').btnSpec(sp[i].name, 'set_sp_' + sp[i].id)];
        if (sp[i+1]) row.push(require('../utils/keyboard').btnSpec(sp[i+1].name, 'set_sp_' + sp[i+1].id));
        rows.push(row);
      }
      return eos(ctx, '🎓 *اختر تخصصك:*', { parse_mode: 'Markdown', ...kbBuild(rows) });
    }],
  ]);

  // ── Prefix matches — مرتبة من الأطول للأقصر ──
  const prefR = [
    // Bundle
    { p: 'bundle_del_file_',  fn: async (ctx, d) => {
      // ✅ RBAC: صلاحية 'delete' تحديداً بدل isAdmin الثنائي.
      if (!(await botRequirePerm(ctx, 'delete'))) return;
      const p = d.substring(16).split('_'), bid = parseInt(p[0]), fid = parseInt(p[1]);
      try {
        await bundlesDb.removeBundleFile(bid, fid);
        await ctx.answerCbQuery('✅ تم حذف الملف').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
        const [files, b] = await Promise.all([bundlesDb.getBundleFiles(bid), bundlesDb.getBundle(bid)]);
        const kb = files.map(f => [kbBtn('🗑️ ' + f.title.substring(0,35), 'bundle_del_file_' + bid + '_' + f.id)]);
        kb.push([kbBtn('➕ إضافة ملفات', 'bundle_add_files_' + bid), kbBtn('🗑️ حذف الحزمة', 'bundle_delete_' + bid)]);
        kb.push([kbBtn('◀️ رجوع', 'mg_content')]);
        return eos(ctx, '📦 *' + (b.title || (b.title || b.name || 'حزمة') || "حزمة") + '*\n\n' + files.length + ' ملف', { parse_mode: 'Markdown', ...kbBuild(kb) });
      } catch(e) { ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(err => { require('../utils/logger').debug("[silent]", err.message); }); }
    }},
    { p: 'bundle_add_files_', fn: async (ctx, d) => {
      // ✅ RBAC: صلاحية 'upload' تحديداً بدل isAdmin الثنائي.
      if (!(await botRequirePerm(ctx, 'upload'))) return;
      const bid = parseInt(d.substring(17));
      await require('../utils/stateManager').setState(ctx.uid, { type: 'mg_bundle_files', bundleId: bid, fileCount: 0 });
      return ctx.reply('📦 أرسل الملفات الآن.\n/done للإنهاء').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
    }},
    { p: 'reply_user_', fn: async (ctx, d) => {
      // 💬 رد سريع على مستخدم أرسل رسالة/ملف — يفعّل نفس آلية المراسلة الموجودة بـmanage.js (mg_msg_user_content) مباشرة، بدون إدخال ID يدوياً.
      if (!ctx.isOwner) return ctx.answerCbQuery('🚫 للمالك فقط', { show_alert: true }).catch(() => {});
      const targetId = d.substring(11);
      await require('../utils/stateManager').setState(ctx.uid, { type: 'mg_msg_user_content', targetId });
      await ctx.answerCbQuery().catch(() => {});
      return ctx.reply('📝 اكتب ردّك الآن (نص، صورة، فيديو، sticker، voice):\n_(أو /cancel للإلغاء)_', { parse_mode: 'Markdown' }).catch(() => {});
    }},
    { p: 'bundle_delete_',    fn: async (ctx, d) => {
      // ✅ RBAC: كانت owner-only — أصبحت مربوطة بصلاحية 'delete' (نفس فئة حذف الملفات، Owner مسموح دائماً).
      if (!(await botRequirePerm(ctx, 'delete'))) return;
      const bid = parseInt(d.substring(14));
      try { await bundlesDb.deleteBundle(bid); await ctx.answerCbQuery('✅ تم حذف الحزمة').catch(err => { require('../utils/logger').debug("[silent]", err.message); }); return ctx.reply('✅ تم حذف الحزمة.').catch(err => { require('../utils/logger').debug("[silent]", err.message); }); }
      catch(e) { ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(err => { require('../utils/logger').debug("[silent]", err.message); }); }
    }},
    { p: 'bundle_view_',      fn: async (ctx, d) => {
      const bid = parseInt(d.substring(12));
      try {
        const [b, files] = await Promise.all([bundlesDb.getBundle(bid), bundlesDb.getBundleFiles(bid)]);
        if (!b) return ctx.answerCbQuery('❌ غير موجود').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
        const kb = files.map(f => [kbBtn('🗑️ ' + f.title.substring(0,35), 'bundle_del_file_' + bid + '_' + f.id)]);
        kb.push([kbBtn('➕ إضافة ملفات', 'bundle_add_files_' + bid), kbBtn('🗑️ حذف الحزمة', 'bundle_delete_' + bid)]);
        kb.push([kbBtn('◀️ رجوع', 'mg_content')]);
        return eos(ctx, '📦 *' + (b.title || (b.title || b.name || 'حزمة') || "حزمة") + '*\n\n' + files.length + ' ملف\n\n_اضغط على ملف لحذفه_', { parse_mode: 'Markdown', ...kbBuild(kb) });
      } catch(e) { ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(err => { require('../utils/logger').debug("[silent]", err.message); }); }
    }},

    // Search & Manage
    { p: 'search_del_', fn: hSearchDel },
    { p: 'mg_ttype_',   fn: hMgTtype  },

    // Group Admin
    { p: 'unmute_all_', fn: (ctx, d) => unmuteAll(ctx, parseInt(d.substring(11))) },
    { p: 'mute_all_',   fn: (ctx, d) => muteAll(ctx, parseInt(d.substring(9))) },
    { p: 'tag_all_',    fn: (ctx, d) => tagAll(ctx, parseInt(d.substring(8))) },

    // Report & Comments
    { p: 'do_report_',  fn: (ctx, d) => { const p = d.substring(10).split('_'); return browse.doReport(ctx, p[0], p[1], p[2], p[3], p[4], p[5], p[6]); }},
    { p: 'add_cmt_',    fn: async (ctx, d) => {
      const p = d.substring(8).split('_');
      await require('../utils/stateManager').setState(ctx.uid, { type: 'add_comment', fid: p[0], spId: p[1], yrId: p[2], smId: p[3], sbId: p[4], catId: p[5] });
      return ctx.reply('✍️ اكتب تعليقك:\n_(أو /cancel)_', { parse_mode: 'Markdown' }).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
    }},
    { p: 'cmt_pg_',     fn: (ctx, d) => { const p = d.substring(7).split('_'); return browse.showComments(ctx, p[0], p[1], p[2], p[3], p[4], p[5], p[6], parseInt(p[7])); }},
    { p: 'dcmt_',       fn: async (ctx, d) => {
      const p = d.substring(5).split('_');
      await commentsDb.deleteCommentAdmin(p[0]);
      await ctx.answerCbQuery('✅ تم الحذف').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      return browse.showComments(ctx, p[1], p[2], p[3], p[4], p[5], p[6], p[7]);
    }},
    { p: 'report_',     fn: (ctx, d) => { const p = d.substring(7).split('_'); return browse.showReportMenu(ctx, p[0], p[1], p[2], p[3], p[4], p[5]); }},
    { p: 'cmt_',        fn: (ctx, d) => { const p = d.substring(4).split('_'); return browse.showComments(ctx, p[0], p[1], p[2], p[3], p[4], p[5], p[6]); }},

    // Navigation pages
    { p: 'yr_page_',    fn: (ctx, d) => { const p = d.substring(8).split('_'); return browse.showYears(ctx, p[0], parseInt(p[1])); }},
    { p: 'sb_page_',    fn: (ctx, d) => { const p = d.substring(8).split('_'); return browse.showSubjects(ctx, p[0], p[1], p[2], parseInt(p[3])); }},
    { p: 'ct_page_',    fn: (ctx, d) => { const p = d.substring(8).split('_'); return browse.showFiles(ctx, p[0], p[1], p[2], p[3], p[4], parseInt(p[5])); }},
    { p: 'preview_',    fn: (ctx, d) => { const p = d.split('_'); return browse.showPreview(ctx, p[1], p[2], p[3], p[4], p[5], p[6]); }},

    // Specialty, Favorites, Rating
    { p: 'set_sp_',     fn: async (ctx, d) => { await usersDb.setSpecialty(ctx.uid, safeInt(d.substring(7))); await ctx.answerCbQuery('✅ تم حفظ تخصصك').catch(err => { require('../utils/logger').debug("[silent]", err.message); }); return startHandler.showMainMenu(ctx); }},
    { p: 'unfav_',      fn: (ctx, d) => userH.toggleFav(ctx, safeInt(d.substring(6)), true)  },
    { p: 'rate_',       fn: async (ctx, d) => {
      const p = d.substring(5).split('_');
      await interactions.addRating(ctx.uid, p[0], parseInt(p[1]));
      await ctx.answerCbQuery('⭐ تم التقييم!').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      cacheClear('personal_' + ctx.uid + '_' + p[0]);
      return browse.showPreview(ctx, p[0], p[2], p[3], p[4], p[5], p[6]);
    }},

    // Group
    { p: 'grp_main_',   fn: (ctx, d) => { const chatId = d.replace('grp_main_',''); return require('../handlers/group_members_panel').showMembersHub(ctx, chatId); } },
    { p: 'gm_',         fn: (ctx, d) => require('../handlers/group_members_panel').handleCallback(ctx, d) },
    { p: 'cg_',         fn: (ctx, d) => require('../handlers/game_builder_admin').handleCallback(ctx, d) },
    { p: 'grp_main',    fn: (ctx, d) => { const uid = ctx.uid || ctx.from?.id; const isOwner = uid === parseInt(process.env.OWNER_ID); return isOwner ? groupPanel.showMainMenu(ctx) : groupPanel.showMyGroups(ctx); } },
    { p: 'gp_jreq_',    fn: (ctx, d) => require('../handlers/group_join_requests').handleCallback(ctx, d) },
    { p: 'grp_customgame_', fn: (ctx, d) => require('../handlers/game_builder').startGameById(ctx, d.replace('grp_customgame_', '')) },
    { p: 'gp_topicdel_', fn: (ctx, d) => require('../handlers/group_topics').handleCallback(ctx, d) },
    { p: 'gp_promo_',   fn: (ctx, d) => require('../handlers/group_promote_panel').handleCallback(ctx, d) },
    { p: 'gp_',         fn: (ctx, d) => groupPanel.handleCallback(ctx, d) },
    { p: 'help_',       fn: (ctx, d) => require('../handlers/group_pro_features').handleHelpCallback(ctx, d) },
    { p: 'phelp_',      fn: (ctx, d) => require('../handlers/group_pro_features').handleHelpCallback(ctx, d) },
    { p: 'gpq_',        fn: async (ctx, d) => {
      const parts = d.replace('gpq_', '').split('_');
      const action = parts[0];
      // الصيغة: gpq_action_userId_chatId
      const userId  = parseInt(parts[1]);
      const chatId  = parseInt(parts[2]);
      const { run: _r, all: _a, get: _g } = require('../database/db');
      const { muteMember, unmuteMember } = require('../handlers/group_admin');

      ctx.answerCbQuery('').catch(() => {});

      if (action === 'ban') {
        try {
          await ctx.telegram.banChatMember(chatId, userId);
          return ctx.editMessageText('🚫 *تم الحظر*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔓 رفع الحظر', callback_data: 'gpq_unban_' + chatId + '_' + userId }]] } }).catch(() => {});
        } catch(e) { return ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
      }

      if (action === 'unban') {
        try {
          await ctx.telegram.unbanChatMember(chatId, userId);
          return ctx.editMessageText('✅ *رُفع الحظر*', { parse_mode: 'Markdown' }).catch(() => {});
        } catch(e) { return ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
      }

      if (action === 'kick') {
        try {
          await ctx.telegram.banChatMember(chatId, userId);
          await ctx.telegram.unbanChatMember(chatId, userId);
          return ctx.editMessageText('🦵 *تم الطرد*', { parse_mode: 'Markdown' }).catch(() => {});
        } catch(e) { return ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
      }

      if (action === 'mute') {
        // عرض خيارات المدة
        const muteKb = [
          [{ text: '5د', callback_data: 'gpq_muted_5_' + chatId + '_' + userId }, { text: '15د', callback_data: 'gpq_muted_15_' + chatId + '_' + userId }, { text: '30د', callback_data: 'gpq_muted_30_' + chatId + '_' + userId }],
          [{ text: '1س', callback_data: 'gpq_muted_60_' + chatId + '_' + userId }, { text: '6س', callback_data: 'gpq_muted_360_' + chatId + '_' + userId }, { text: '24س', callback_data: 'gpq_muted_1440_' + chatId + '_' + userId }],
          [{ text: '◀️ رجوع', callback_data: 'gpq_back_' + chatId + '_' + userId }],
        ];
        return ctx.editMessageReplyMarkup({ inline_keyboard: muteKb }).catch(() => {});
      }

      if (action === 'muted') {
        const mins = parseInt(parts[1]);
        const cid2 = parseInt(parts[2]);
        const uid2 = parseInt(parts[3]);
        try {
          await muteMember(ctx, cid2, uid2, mins);
          const label = mins < 60 ? mins + 'د' : (mins/60) + 'س';
          return ctx.editMessageText('🔇 *تم الكتم ' + label + '*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔊 رفع الكتم', callback_data: 'gpq_unmute_' + cid2 + '_' + uid2 }]] } }).catch(() => {});
        } catch(e) { return ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
      }

      if (action === 'unmute') {
        try {
          await unmuteMember(ctx, chatId, userId);
          return ctx.editMessageText('🔊 *رُفع الكتم*', { parse_mode: 'Markdown' }).catch(() => {});
        } catch(e) { return ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
      }

      if (action === 'warn') {
        await _r('INSERT INTO group_warns(chat_id,user_id,reason,warned_by) VALUES($1,$2,$3,$4)', [chatId, userId, 'إنذار يدوي', ctx.from.id]).catch(() => {});
        const cnt = await _g('SELECT COUNT(*) as c FROM group_warns WHERE chat_id=$1 AND user_id=$2', [chatId, userId]).then(r => r?.c || 0).catch(() => 0);
        if (parseInt(cnt) >= 3) {
          await ctx.telegram.banChatMember(chatId, userId).catch(() => {});
          await _r('DELETE FROM group_warns WHERE chat_id=$1 AND user_id=$2', [chatId, userId]).catch(() => {});
          return ctx.editMessageText('🚫 *تم الحظر تلقائياً بعد 3 إنذارات!*', { parse_mode: 'Markdown' }).catch(() => {});
        }
        const warnKb = [
          [{ text: '➕ إنذار', callback_data: 'gpq_warn_' + chatId + '_' + userId }, { text: '➖ إنذار', callback_data: 'gpq_unwarn_' + chatId + '_' + userId }],
          [{ text: '◀️ رجوع', callback_data: 'gpq_back_' + chatId + '_' + userId }],
        ];
        return ctx.editMessageText('⚠️ *الإنذارات: ' + cnt + '/3*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: warnKb } }).catch(() => {});
      }

      if (action === 'unwarn') {
        const last = await _g('SELECT id FROM group_warns WHERE chat_id=$1 AND user_id=$2 ORDER BY id DESC LIMIT 1', [chatId, userId]).catch(() => null);
        if (last) await _r('DELETE FROM group_warns WHERE id=$1', [last.id]).catch(() => {});
        const cnt = await _g('SELECT COUNT(*) as c FROM group_warns WHERE chat_id=$1 AND user_id=$2', [chatId, userId]).then(r => r?.c || 0).catch(() => 0);
        return ctx.answerCbQuery('✅ الإنذارات: ' + cnt + '/3').catch(() => {});
      }

      if (action === 'reset') {
        await _r('DELETE FROM group_warns WHERE chat_id=$1 AND user_id=$2', [chatId, userId]).catch(() => {});
        await _r('UPDATE grp_member_stats SET violations=0 WHERE chat_id=$1 AND user_id=$2', [chatId, userId]).catch(() => {});
        return ctx.editMessageText('♻️ *تم تصفير المخالفات والإنذارات*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '◀️ رجوع', callback_data: 'gpq_back_' + chatId + '_' + userId }]] } }).catch(() => {});
      }

      if (action === 'approve') {
        await _r('INSERT INTO group_approved(chat_id,user_id,approved_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [chatId, userId, ctx.from.id]).catch(() => {});
        return ctx.answerCbQuery('✅ تم الاستثناء من الحماية').catch(() => {});
      }

      if (action === 'unapprove') {
        await _r('DELETE FROM group_approved WHERE chat_id=$1 AND user_id=$2', [chatId, userId]).catch(() => {});
        return ctx.answerCbQuery('✅ تم إلغاء الاستثناء').catch(() => {});
      }

      if (action === 'watch') {
        await _r('INSERT INTO group_watching(chat_id,user_id,admin_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [chatId, userId, ctx.from.id]).catch(() => {});
        return ctx.answerCbQuery('👁 تم تفعيل المراقبة').catch(() => {});
      }

      if (action === 'perms') {
        try {
          const member = await ctx.telegram.getChatMember(chatId, userId);
          const p = member;
          const can = key => p[key] !== false;
          const permsKb = [
            [{ text: (can('can_send_messages') ? '✅' : '❌') + ' الرسائل', callback_data: 'gpq_ptog_can_send_messages_' + chatId + '_' + userId }],
            [{ text: (can('can_send_media_messages') ? '✅' : '❌') + ' الوسائط', callback_data: 'gpq_ptog_can_send_media_messages_' + chatId + '_' + userId }],
            [{ text: (can('can_send_polls') ? '✅' : '❌') + ' الاستطلاعات', callback_data: 'gpq_ptog_can_send_polls_' + chatId + '_' + userId }],
            [{ text: (can('can_add_web_page_previews') ? '✅' : '❌') + ' معاينة الروابط', callback_data: 'gpq_ptog_can_add_web_page_previews_' + chatId + '_' + userId }],
            [{ text: (can('can_invite_users') ? '✅' : '❌') + ' دعوة أعضاء', callback_data: 'gpq_ptog_can_invite_users_' + chatId + '_' + userId }],
            [{ text: (can('can_pin_messages') ? '✅' : '❌') + ' تثبيت رسائل', callback_data: 'gpq_ptog_can_pin_messages_' + chatId + '_' + userId }],
            [
              { text: '💾 حفظ', callback_data: 'gpq_psave_' + chatId + '_' + userId },
              { text: '◀️ رجوع', callback_data: 'gpq_back_' + chatId + '_' + userId },
            ],
          ];
          return ctx.editMessageReplyMarkup({ inline_keyboard: permsKb }).catch(() => {});
        } catch(e) { return ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
      }

      if (action === 'ptog') {
        const permKey = parts[1];
        const cid2 = parseInt(parts[2]);
        const uid2 = parseInt(parts[3]);
        const curKb = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard || [];
        const newKb = curKb.map(row => row.map(btn => {
          if (btn.callback_data === d) {
            const isOn = btn.text.startsWith('✅');
            return { ...btn, text: (isOn ? '❌' : '✅') + btn.text.slice(1) };
          }
          return btn;
        }));
        return ctx.editMessageReplyMarkup({ inline_keyboard: newKb }).catch(() => {});
      }

      if (action === 'psave') {
        const curKb = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard || [];
        const perms = {};
        for (const row of curKb) {
          for (const btn of row) {
            if (btn.callback_data?.startsWith('gpq_ptog_')) {
              const key = btn.callback_data.split('_').slice(2, -2).join('_');
              perms[key] = btn.text.startsWith('✅');
            }
          }
        }
        try {
          await ctx.telegram.restrictChatMember(chatId, userId, { permissions: { ...perms, can_send_other_messages: perms.can_send_messages } });
          return ctx.editMessageText('✅ *تم حفظ الأذونات*', { parse_mode: 'Markdown' }).catch(() => {});
        } catch(e) { return ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
      }

      if (action === 'back') {
        // رجوع للوحة الرئيسية
        const { buildQuickPanel } = require('../handlers/group_pro');
        try {
          const panel = await buildQuickPanel(chatId, userId, ctx);
          return ctx.editMessageText(panel.txt, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: panel.kb } }).catch(() => {});
        } catch(_) {}
      }

      if (action === 'violations') {
        const vio = await _g('SELECT violations FROM grp_member_stats WHERE chat_id=$1 AND user_id=$2', [chatId, userId]).catch(() => null);
        const cnt = vio?.violations || 0;
        return ctx.editMessageText('🛡 *مخالفات الحماية: ' + cnt + '*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '♻️ تصفير', callback_data: 'gpq_reset_' + chatId + '_' + userId }, { text: '◀️ رجوع', callback_data: 'gpq_back_' + chatId + '_' + userId }]] } }).catch(() => {});
      }

      if (action === 'cancel') {
        return ctx.deleteMessage().catch(() => {});
      }
    }},
    { p: 'poll_',       fn: (ctx, d) => require('../handlers/poll_system').handleCallback(ctx, d) },
    { p: 'inf_',        fn: (ctx, d) => require('../handlers/group_info_panel').handleCallback(ctx, d) },
    { p: 'nat_',        fn: (ctx, d) => require('../handlers/nations').handleCallback(ctx, d) },
    { p: 'nation_',     fn: (ctx, d) => require('../handlers/nations').handleCallback(ctx, d) },
    { p: 'gpx_',        fn: (ctx, d) => require('../handlers/group_pro_panel').handleCallback(ctx, d) },
    { p: 'grp_sp_',     fn: hGrpSp },
    { p: 'grp_dl_',     fn: hGrpDl },

    // Back navigation shortcuts
    { p: 'sbs_',        fn: (ctx, d) => { const p = d.substring(4).split('_'); return browse.showSubjects(ctx, p[0], p[1], p[2]); }},
    { p: 'sms_',        fn: (ctx, d) => { const p = d.substring(4).split('_'); return browse.showSemesters(ctx, p[0], p[1]); }},
    { p: 'yrs_',        fn: (ctx, d) => { const p = d.substring(4).split('_'); return browse.showYears(ctx, p[0]); }},
    { p: 'fav_',        fn: (ctx, d) => userH.toggleFav(ctx, safeInt(d.substring(4)), false) },

    // Browse navigation — الترتيب مهم (الأطول أولاً)
    { p: 'bundle_',     fn: (ctx, d) => { const p = d.split('_'); return browse.showBundle(ctx, p[1], p[2], p[3], p[4], p[5], p[6]); }},
    { p: 'bdl_',        fn: (ctx, d) => { const p = d.split('_'); return browse.sendBundle(ctx, p[1], p[2], p[3], p[4], p[5], p[6]); }},
    { p: 'fl_',         fn: (ctx, d) => { const p = d.split('_'); return browse.sendFile(ctx, p[1], p[2], p[3], p[4], p[5], p[6]); }},
    { p: 'ml_',         fn: (ctx)    => million.handleCallback(bot, ctx) },
    { p: 'mlr_',        fn: (ctx, d) => millionGame.handleCallback(ctx, d) },
    { p: 'mar_',        fn: (ctx, d) => millionGame.handleCallback(ctx, d) },
    { p: 'share_',      fn: (ctx)    => { const { handleShare } = require('../handlers/share_summary'); return handleShare(ctx); } },
    { p: 'ct_',         fn: (ctx, d) => { const p = d.split('_'); return browse.showFiles(ctx, p[1], p[2], p[3], p[4], p[5]); }},
    { p: 'sb_',         fn: (ctx, d) => { const p = d.split('_'); return browse.showCategories(ctx, p[1], p[2], p[3], p[4]); }},
    { p: 'sm_',         fn: (ctx, d) => { const p = d.split('_'); return browse.showSubjects(ctx, p[1], p[2], p[3]); }},   // ✅ semester → subjects
    { p: 'yr_',         fn: (ctx, d) => { const p = d.split('_'); return browse.showSemesters(ctx, p[1], p[2]); }},          // ✅ year → semesters
    { p: 'sp_',         fn: (ctx, d) => browse.showYears(ctx, safeInt(d.substring(3))) },                                    // ✅ specialty → years

    // Admin (آخر شيء — prefix قصير)

    // del_channel
    { p: 'del_channel_', fn: async (ctx, d) => {
      if (!ctx.isOwner) return ctx.answerCbQuery("للمالك فقط", { show_alert: true }).catch(() => {});
      const channelId = d.replace('del_channel_', '');
      const { removeChannel } = require('../utils/channelGuard');
      const { cacheClear } = require('../utils/cache');
      await removeChannel(channelId).catch(() => {});
      cacheClear('required_channels');
      ctx.answerCbQuery('تم الحذف').catch(() => {});
      const { getChannels } = require("../utils/channelGuard");
      const list = await getChannels().catch(() => []);
      if (!list.length) return ctx.editMessageText("لا توجد قنوات").catch(() => ctx.reply("لا توجد قنوات").catch(() => {}));
      const rows = list.map(ch => [{
        text: "🗑 " + (ch.channel_name || ch.channel_id),
        callback_data: "del_channel_" + ch.channel_id
      }]);
      return ctx.editMessageReplyMarkup({ inline_keyboard: rows }).catch(() => {});
    }},
    { p: 'grp_stats_', fn: async (ctx, d) => {
      const chatId = d.replace('grp_stats_', '');
      try {
        const { all: dbAll2 } = require('../database/db');
        const [msgs, members, warns] = await Promise.all([
          dbAll2('SELECT COUNT(*) AS cnt FROM group_messages WHERE chat_id=$1', [chatId]).catch(() => [{ cnt: 0 }]),
          dbAll2('SELECT COUNT(*) AS cnt FROM group_members WHERE chat_id=$1', [chatId]).catch(() => [{ cnt: 0 }]),
          dbAll2('SELECT COUNT(*) AS cnt FROM group_warns WHERE chat_id=$1', [chatId]).catch(() => [{ cnt: 0 }]),
        ]);
        const text = '📊 *إحصائيات القروب*\n━━━━━━━━━━━━\n\n' +
          '👤 الأعضاء المسجلون: *' + (members[0]?.cnt || 0) + '*\n' +
          '⚠️ التحذيرات: *' + (warns[0]?.cnt || 0) + '*\n' +
          '💬 الرسائل المحفوظة: *' + (msgs[0]?.cnt || 0) + '*';
        return ctx.answerCbQuery().catch(()=>{}).then(() =>
          ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '◀️ رجوع', callback_data: 'gp_view_' + chatId }]] } })
          .catch(() => ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => {}))
        );
      } catch(e) { ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
    }},
    { p: 'gp_close', fn: async (ctx, d) => {
      await ctx.answerCbQuery().catch(() => {});
      await ctx.deleteMessage().catch(async () => {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
      });
      return;
    }},
    { p: 'leave_grp_', fn: async (ctx, d) => {
      // ✅ RBAC: كانت owner-only — أصبحت مربوطة بصلاحية 'manage_groups' (Owner مسموح دائماً).
      if (!(await botRequirePerm(ctx, 'manage_groups'))) return;
      const chatId = parseInt(d.substring(10));
      try {
        await ctx.telegram.leaveChat(chatId);
        await dbRun('DELETE FROM group_chats WHERE chat_id=$1', [chatId]);
        await ctx.answerCbQuery('✅ تم الخروج').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
        return ctx.editMessageText('✅ خرجت من القروب ' + chatId).catch(() => ctx.reply('✅ تم الخروج.').catch(err => { require('../utils/logger').debug("[silent]", err.message); }));
      } catch(e) { ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(err => { require('../utils/logger').debug("[silent]", err.message); }); }
    }},
    { p: 'mg_',         fn: async (ctx, d) => { if (!ctx.isAdmin && !ctx.isOwner) return ctx.answerCbQuery('🚫', { show_alert: true }).catch(err => { require('../utils/logger').debug("[silent]", err.message); }); return manage.handleCallback(ctx, d); }},
  ];

  function _getPrefixHandler(data) {
    for (const r of prefR) if (data.startsWith(r.p)) return r.fn;
    return null;
  }

  // ── Main callback handler ──
  bot.on('callback_query', async ctx => {
    if (!ctx.from) return;
    const _raw = ctx.callbackQuery?.data, cbId = ctx.callbackQuery?.id;
    if (!_raw || CBDedup.isDupe(cbId)) return;

    // 🛡️ شبكة أمان: امسح أي state عالقة عند أي ضغطة زر (تنقل/رجوع/إلغاء)،
    // إلا الأزرار اللي هي خطوة داخل ويزارد وتحتاج تقرا الحالة القديمة باش تكمل
    const _wizardStepPrefixes = ['cg_hasans_', 'cg_showans_', 'mq_correct_', 'mq_diff_', 'mg_pick_emoji_'];
    if (!_wizardStepPrefixes.some(p => _raw.startsWith(p))) {
      require('../utils/stateManager').delState(ctx.from.id).catch(() => {});
    }

    // 🐺 لوب غارو — معالجة مباشرة داخل نفس الـ handler (لأن handler بدون next)
    if (_raw.startsWith('ww:') || _raw.startsWith('wwx:')) {
      try {
        const { parseCb, parseCbx } = require('../handlers/werewolf/codec');
        const wwState = require('../handlers/werewolf/state');

        if (_raw.startsWith('ww:')) {
          const parsed = parseCb(_raw);
          if (!parsed) return ctx.answerCbQuery('❌ بيانات غير صالحة.').catch(() => {});
          const game = wwState.getGameById(parsed.gameId);
          if (!game) return ctx.answerCbQuery('⌛ انتهت اللعبة أو تم إلغاؤها.', { show_alert: true }).catch(() => {});
          if (parsed.epoch !== game.epoch) {
            return ctx.answerCbQuery('🚫 هذا الزر لم يعد صالحاً.', { show_alert: true }).catch(() => {});
          }
          const engine  = require('../handlers/werewolf/engine');
          const actions = require('../handlers/werewolf/actions');
          if (['j','lv','st','cn'].includes(parsed.verb)) {
            return engine.handleLobbyAction(ctx, game, parsed);
          }
          return actions.handle(ctx, game, parsed);
        }

        if (_raw.startsWith('wwx:')) {
          const parsed = parseCbx(_raw);
          if (!parsed) return ctx.answerCbQuery().catch(() => {});
          return require('../handlers/werewolf/engine').handleMenuAction(ctx, parsed);
        }
      } catch(e) {
        require('../utils/logger').error('[WW CB] ' + e.message);
        return ctx.answerCbQuery('⚠️ خطأ مؤقت.').catch(() => {});
      }
      return;
    }

    // 🎮 أكسيو أو فيريتي — معالجة مباشرة (نفس سبب عدم استخدام next)
    if (_raw.startsWith('tod:') || _raw.startsWith('todadm:')) {
      try {
        if (_raw === 'noop') return ctx.answerCbQuery().catch(() => {});

        if (_raw.startsWith('tod:')) {
          const { parseCb } = require('../handlers/tod/codec');
          const todState = require('../handlers/tod/state');
          const parsed = parseCb(_raw);
          if (!parsed) return ctx.answerCbQuery('❌ بيانات غير صالحة.').catch(() => {});
          const session = todState.getSession(parsed.chatId);
          if (!session) return ctx.answerCbQuery('⌛ انتهت اللعبة.', { show_alert: true }).catch(() => {});
          if (parsed.epoch !== session.epoch) {
            return ctx.answerCbQuery('🚫 هذا الزر لم يعد صالحاً.', { show_alert: true }).catch(() => {});
          }
          const engine = require('../handlers/tod/engine');
          if (parsed.verb === 'ch')  return engine.handleChoiceCallback(ctx, session, parsed);
          if (parsed.verb === 'end') return engine.handleEndCallback(ctx, session);
          return ctx.answerCbQuery().catch(() => {});
        }

        if (_raw.startsWith('todadm:')) {
          return require('../handlers/tod/admin_panel').handleAdminCallback(ctx, _raw);
        }
      } catch (e) {
        require('../utils/logger').error('[ToD CB] ' + e.message);
        return ctx.answerCbQuery('⚠️ خطأ مؤقت.').catch(() => {});
      }
      return;
    }

    // 🤫 نظام الهمسة — نفس نمط todadm: (تفويض مباشر، لا حاجة لـcodec/epoch معقّد)
    if (_raw.startsWith('whisper:')) {
      try {
        return await require('../handlers/whisper').handleOpenCallback(ctx, _raw);
      } catch (e) {
        require('../utils/logger').error('[Whisper CB] ' + e.message);
        return ctx.answerCbQuery('⚠️ خطأ مؤقت.').catch(() => {});
      }
    }

    const data = cbRes(_raw);

    try {
      // ── ألعاب ──
      if (data === 'mb_panel' || data.startsWith('gp_million') || data.startsWith('gp_guess') || data.startsWith('gp_slot') || data.startsWith('gp_tod')) {
        return gamesPanel.handleCallback(ctx, data);
      }
      if (data.startsWith('mq_correct_') || data.startsWith('mq_add') || data.startsWith('mq_del')) {
        return manage.handleCallback(ctx, data);
      }
      if (data.startsWith('mq_')) {
        return gamesPanel.handleCallback(ctx, data);
      }

      if (data === 'rules_ok') {
        ctx.answerCbQuery('✅ شكراً! التزم بالقواعد 🙏').catch(() => {});
        ctx.deleteMessage().catch(() => {});
        return;
      }
      if (data.startsWith('gs_')) {
        ctx.answerCbQuery('').catch(() => {});
        await handleSettingsCallback(ctx, data);
        return;
      }

      // أجب فوراً مرة وحدة فقط
      ctx.answerCbQuery('').catch(() => {});


      // ── toggle أذونات (يشتغل من الخاص) ──
      if (data.startsWith('grp_ptog_')) {
        const raw2    = data.replace('grp_ptog_', '').split('_');
        const cid3    = parseInt(raw2[raw2.length - 1]);
        const uid3    = parseInt(raw2[raw2.length - 2]);
        const permKey = raw2.slice(0, -2).join('_');
        const curKb   = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard || [];
        const labels  = {
          can_send_messages:'الرسائل النصية',
          can_send_media_messages:'الوسائط (صور/فيديو)',
          can_send_polls:'الاستطلاعات',
          can_add_web_page_previews:'معاينة الروابط',
          can_invite_users:'دعوة أعضاء',
          can_pin_messages:'تثبيت الرسائل',
        };
        // نقلب حالة الزر في الـ keyboard
        const newKb = curKb.map(row => row.map(btn => {
          if (btn.callback_data === data) {
            const isOn = btn.text.startsWith('✅');
            return { ...btn, text: (isOn ? '❌ ' : '✅ ') + (labels[permKey] || permKey) };
          }
          return btn;
        }));
        await ctx.editMessageReplyMarkup({ inline_keyboard: newKb }).catch(() => {});
        return ctx.answerCbQuery('').catch(() => {});
      }

      if (data.startsWith('grp_psave_')) {
        const parts3  = data.replace('grp_psave_', '').split('_');
        const uid3    = parseInt(parts3[0]);
        const cid3    = parseInt(parts3[1]);
        const curKb2  = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard || [];
        // نستخرج الإذونات من الأزرار — كل key يبدأ بـ grp_ptog_
        const permsToSave = {};
        for (const row of curKb2) {
          for (const btn of row) {
            if (btn.callback_data?.startsWith('grp_ptog_')) {
              const key = btn.callback_data.replace('grp_ptog_', '').split('_').slice(0, -2).join('_');
              permsToSave[key] = btn.text.startsWith('✅');
            }
          }
        }
        try {
          // لو can_send_messages=true لازم يكون أول شيء يُرسل
          // نرسل الإذونات كاملة دفعة واحدة
          const fullPerms = {
            can_send_messages:       permsToSave.can_send_messages       ?? true,
            can_send_photos:         permsToSave.can_send_photos         ?? true,
            can_send_videos:         permsToSave.can_send_videos         ?? true,
            can_send_audios:         permsToSave.can_send_audios         ?? true,
            can_send_documents:      permsToSave.can_send_documents      ?? true,
            can_send_voice_notes:    permsToSave.can_send_voice_notes    ?? true,
            can_send_video_notes:    permsToSave.can_send_video_notes    ?? true,
            can_send_polls:          permsToSave.can_send_polls          ?? true,
            can_send_other_messages: permsToSave.can_send_other_messages ?? true,
            can_add_web_page_previews: permsToSave.can_add_web_page_previews ?? true,
            can_change_info:         permsToSave.can_change_info         ?? false,
            can_invite_users:        permsToSave.can_invite_users        ?? true,
            can_pin_messages:        permsToSave.can_pin_messages        ?? false,
          };
          await ctx.telegram.restrictChatMember(cid3, uid3, { permissions: fullPerms });
          await ctx.editMessageText('✅ *تم حفظ الأذونات!*', { parse_mode: 'Markdown' }).catch(() => {});
          return ctx.answerCbQuery('✅ تم الحفظ').catch(() => {});
        } catch(e) {
          return ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {});
        }
      }

        if (data.startsWith('gp_leave_')) {
          const leaveChatId = parseInt(data.replace('gp_leave_', ''));
          const { run: dbRun2 } = require('../database/db');
          try {
            await ctx.telegram.leaveChat(leaveChatId);
            await dbRun2('UPDATE group_chats SET is_active=0 WHERE chat_id=$1', [leaveChatId]).catch(() => {});
            await ctx.editMessageText(
              '✅ *تم الخروج من القروب بنجاح*',
              { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '◀️ رجوع', callback_data: 'gp_mygroups' }]] }}
            ).catch(() => ctx.reply('✅ تم الخروج').catch(() => {}));
          } catch(e) {
            ctx.answerCbQuery('❌ فشل الخروج: ' + e.message, { show_alert: true }).catch(() => {});
          }
          return;
        }


      // ── صح أو جرأة ──
      if (data.startsWith('tnd_truth_') || data.startsWith('tnd_dare_')) {
        const isT = data.startsWith('tnd_truth_');
        const uid2 = parseInt(data.replace(isT ? 'tnd_truth_' : 'tnd_dare_', ''));
        const truths = [
          "ما هو أكبر كذبة قلتها في حياتك؟",
          "من هو الشخص الذي تحبه سراً في هذا القروب؟",
          "ما هو أحرج موقف مررت به؟",
          "ما هو الشيء الذي تخجل من الاعتراف به؟",
          "هل سبق أن تجسست على شخص ما؟",
          "ما هو أغبى شيء فعلته في حياتك؟",
          "ما هو سرك الذي لم تخبر به أحداً؟",
          "ما هو الشيء الذي تفعله سراً ولا تريد أحداً أن يعرف؟",
          "ما هو أسوأ قرار اتخذته في حياتك؟",
          "من هو الشخص الذي تعتذر منه لو قدرت؟",
        ];
        const dares = [
          "أرسل آخر صورة في هاتفك! 📸",
          "اكتب رسالة محرجة لآخر شخص تحدثت معه!",
          "غير اسمك في القروب لشيء مضحك لمدة ساعة!",
          "أرسل صوت تقلد فيه شخصاً مشهوراً! 🎤",
          "اكتب 10 أشياء تحبها في نفسك!",
          "قلد أسلوب كتابة شخص في القروب لرسالة كاملة!",
          "اعترف بشيء محرج حدث معك هذا الأسبوع!",
          "اكتب رأيك الحقيقي في آخر شخص تكلم في القروب!",
          "تحدى شخصاً آخر في القروب على شيء!",
          "أرسل ميم يعبر عن مزاجك الآن!",
        ];
        const list = isT ? truths : dares;
        const q = list[Math.floor(Math.random() * list.length)];
        const emoji = isT ? "🤔" : "😈";
        const label = isT ? "سؤال صح" : "تحدي جرأة";
        const kb = [[
          { text: isT ? "🎭 جرأة بدل" : "🤔 صح بدل", callback_data: (isT ? "tnd_dare_" : "tnd_truth_") + uid2 },
          { text: "🔄 " + (isT ? "سؤال آخر" : "تحدي آخر"), callback_data: data },
        ]];
        await ctx.editMessageText(
          emoji + " *" + label + ":*\n\n" + q,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: kb } }
        ).catch(() => {});
        return ctx.answerCbQuery("").catch(() => {});
      }

      // ── slot callbacks ──
      if (data.startsWith('slot_play_')) {
        const uid2 = parseInt(data.replace('slot_play_', ''));
        if (ctx.from.id !== uid2) return ctx.answerCbQuery('🚫 هذه ليست لعبتك!', { show_alert: true }).catch(() => {});
        const { get: dbGet, run: dbRun } = require('../database/db');
        const BET = 50;
        const acc = await dbGet('SELECT balance FROM pro_bank_accounts WHERE user_id=$1', [uid2]).catch(() => null);
        if (!acc || parseFloat(acc.balance) < BET) return ctx.answerCbQuery('❌ رصيدك غير كافٍ! (' + BET + ' DA)', { show_alert: true }).catch(() => {});
        await dbRun('UPDATE pro_bank_accounts SET balance=balance-$1 WHERE user_id=$2', [BET, uid2]).catch(() => {});
        await dbRun("INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES($1,0,$2,0,'slot_bet','رهان سلوت')", [uid2, BET]).catch(() => {});
        const symbols = ['🍎','🍊','🍋','🍒','🍇','⭐','💎','7️⃣'];
        const r1 = symbols[Math.floor(Math.random()*symbols.length)];
        const r2 = symbols[Math.floor(Math.random()*symbols.length)];
        const r3 = symbols[Math.floor(Math.random()*symbols.length)];
        let win = 0, resultTxt = '';
        if (r1===r2&&r2===r3) {
          if (r1==='💎'){win=BET*10;resultTxt='💎 *جاكبوت!! ×10*';}
          else if (r1==='7️⃣'){win=BET*7;resultTxt='7️⃣ *سبعة ×7*';}
          else if (r1==='⭐'){win=BET*5;resultTxt='⭐ *نجوم ×5*';}
          else {win=BET*3;resultTxt='🎉 *ثلاثة متشابهة ×3*';}
        } else if (r1===r2||r2===r3||r1===r3) { win=Math.floor(BET*1.5); resultTxt='✅ *اثنان متشابهان ×1.5*'; }
        else { resultTxt='❌ *خسرت!*'; }
        if (win>0) { await dbRun('UPDATE pro_bank_accounts SET balance=balance+$1 WHERE user_id=$2',[win,uid2]).catch(()=>{}); await dbRun("INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES(0,$1,$2,0,'slot_win','ربح سلوت')", [uid2, win]).catch(() => {}); }
        const newBal = await dbGet('SELECT balance FROM pro_bank_accounts WHERE user_id=$1',[uid2]).then(r=>r?.balance||0).catch(()=>0);
        await ctx.editMessageText(
          '🎰 *ماكينة القمار*\n\n[ '+r1+' | '+r2+' | '+r3+' ]\n\n'+resultTxt+'\n'+(win>0?'💰 ربحت: *'+win+' DA*':'💸 خسرت: *'+BET+' DA*')+'\n👛 رصيدك: *'+parseFloat(newBal).toFixed(0)+' DA*',
          { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[[
            {text:'🎰 العب مجدداً', callback_data:'slot_play_'+uid2},
            {text:'💰 رصيدي', callback_data:'slot_bal_'+uid2},
          ]]}}
        ).catch(()=>{});
        return ctx.answerCbQuery('').catch(()=>{});
      }

      if (data.startsWith('slot_bal_')) {
        const uid2 = parseInt(data.replace('slot_bal_', ''));
        const { get: dbGet } = require('../database/db');
        const acc = await dbGet('SELECT balance FROM pro_bank_accounts WHERE user_id=$1',[uid2]).catch(()=>null);
        return ctx.answerCbQuery('💰 رصيدك: '+(acc?parseFloat(acc.balance).toFixed(0):0)+' DA', { show_alert:true }).catch(()=>{});
      }

      // ── shop callbacks ──
      if (data.startsWith('shop_buy_')) {
        const parts = data.replace('shop_buy_','').split('_');
        const itemId = parseInt(parts[0]);
        const uid2   = parseInt(parts[1]);
        if (ctx.from.id !== uid2) return ctx.answerCbQuery('🚫 هذه ليست قائمتك!', { show_alert:true }).catch(()=>{});
        const { get: dbGet, run: dbRun } = require('../database/db');
        const items = [
          { id:1, name:'🛡️ درع الحماية',  price:500  },
          { id:2, name:'⭐ نجمة VIP',      price:1000 },
          { id:3, name:'🎯 تذكرة مليون',   price:300  },
          { id:4, name:'🎰 رمز سلوت ×2',   price:200  },
          { id:5, name:'📦 صندوق مفاجأة',  price:150  },
        ];
        const item = items.find(i=>i.id===itemId);
        if (!item) return ctx.answerCbQuery('❌ منتج غير موجود', {show_alert:true}).catch(()=>{});
        const acc = await dbGet('SELECT balance FROM pro_bank_accounts WHERE user_id=$1',[uid2]).catch(()=>null);
        if (!acc || parseFloat(acc.balance) < item.price)
          return ctx.answerCbQuery('❌ رصيدك غير كافٍ! تحتاج '+item.price+' DA', {show_alert:true}).catch(()=>{});
        await dbRun('UPDATE pro_bank_accounts SET balance=balance-$1 WHERE user_id=$2',[item.price, uid2]).catch(()=>{});
        await dbRun("INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES($1,0,$2,0,'shop_purchase',$3)", [uid2, item.price, item.name]).catch(()=>{});
        // تنفيذ المنتج
        if (itemId === 5) {
          const bonus = Math.floor(Math.random()*1900)+100;
          await dbRun('UPDATE pro_bank_accounts SET balance=balance+$1 WHERE user_id=$2',[bonus,uid2]).catch(()=>{});
          await dbRun("INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES(0,$1,$2,0,'shop_box','صندوق مفاجأة')", [uid2, bonus]).catch(()=>{});
          return ctx.answerCbQuery('📦 فتحت الصندوق وربحت '+bonus+' DA! 🎉', {show_alert:true}).catch(()=>{});
        }
        await ctx.answerCbQuery('✅ اشتريت '+item.name+'!', {show_alert:true}).catch(()=>{});
        const newBal = await dbGet('SELECT balance FROM pro_bank_accounts WHERE user_id=$1',[uid2]).then(r=>r?.balance||0).catch(()=>0);
        await ctx.editMessageText(
          '✅ *تمت عملية الشراء!*\n\n'+item.name+'\n💰 المبلغ: '+item.price+' DA\n👛 رصيدك الآن: '+parseFloat(newBal).toFixed(0)+' DA',
          { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[[{text:'🏪 العودة للمتجر', callback_data:'shop_back_'+uid2}]]}}
        ).catch(()=>{});
        return;
      }

      if (data === 'shop_close') {
        await ctx.deleteMessage().catch(()=>{});
        return ctx.answerCbQuery('').catch(()=>{});
      }

      if (data.startsWith('shop_back_')) {
        return ctx.answerCbQuery('🏪 اكتب /متجر لفتح المتجر مجدداً').catch(()=>{});
      }

      // ── bank callbacks ──
      if (data === 'bank_transfer_help') {
        return ctx.answerCbQuery('💸 رد على رسالة شخص واكتب: فارسي 500', { show_alert: true }).catch(() => {});
      }
      if (data.startsWith('bank_stats_')) {
        const uid2 = parseInt(data.replace('bank_stats_', ''));
        const { all: dbAll } = require('../database/db');
        const stats = await dbAll(
          'SELECT type, SUM(amount) as total, COUNT(*) as cnt FROM pro_bank_transactions WHERE to_id=$1 OR from_id=$1 GROUP BY type',
          [uid2]
        ).catch(() => []);
        let txt = '📊 *إحصائياتك البنكية*\n━━━━━━━━━━━━━━━━━━\n\n';
        for (const s of stats) {
          txt += '• ' + (s.type||'معاملة') + ': ' + s.cnt + ' مرة (' + s.total + ' DA)\n';
        }
        if (!stats.length) txt += '_لا توجد معاملات بعد_';
        await ctx.reply(txt, { parse_mode: 'Markdown' }).catch(() => {});
        return ctx.answerCbQuery('').catch(() => {});
      }
      if (data === 'bank_top') {
        const { all: dbAll } = require('../database/db');
        const top = await dbAll(
          'SELECT user_id, first_name, balance FROM pro_bank_accounts ORDER BY balance DESC LIMIT 10'
        ).catch(() => []);
        let txt = '🏆 *أثرى المستخدمين*\n━━━━━━━━━━━━━━━━━━\n\n';
        const medals = ['🥇','🥈','🥉'];
        top.forEach((u,i) => {
          txt += (medals[i]||i+1+'.') + ' ' + (u.first_name||'مجهول') + ' — *' + parseFloat(u.balance).toLocaleString() + ' DA*\n';
        });
        await ctx.reply(txt, { parse_mode: 'Markdown' }).catch(() => {});
        return ctx.answerCbQuery('').catch(() => {});
      }
      if (data === 'grp_search_close') {
        await ctx.deleteMessage().catch(() => {});
        return ctx.answerCbQuery('').catch(() => {});
      }

      // inf_ تشتغل في الخاص والقروب
      if (data.startsWith('inf_')) {
        const _infFn = _getPrefixHandler(data);
        if (_infFn) return _infFn(ctx, data);
        return;
      }

      // grp_kick_ handler
      if (data.startsWith('grp_kick_')) {
        const parts = data.replace('grp_kick_', '').split('_');
        const uid2 = parseInt(parts[0]);
        const cid2 = parseInt(parts[1]) || ctx.chat?.id;
        try {
          await ctx.telegram.banChatMember(cid2, uid2);
          await ctx.telegram.unbanChatMember(cid2, uid2);
          return ctx.editMessageText('🦵 *تم الطرد*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🚫 حظر', callback_data: 'grp_ban_now_' + uid2 }]] } }).catch(() => {});
        } catch(e) { return ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
      }

      // grp_violations_ handler
      if (data.startsWith('grp_violations_')) {
        const parts = data.replace('grp_violations_', '').split('_');
        const uid2 = parseInt(parts[0]);
        const cid2 = parseInt(parts[1]);
        const { get: _g2, run: _r2 } = require('../database/db');
        const vio = await _g2('SELECT violations FROM grp_member_stats WHERE chat_id=$1 AND user_id=$2', [cid2, uid2]).catch(() => null);
        const cnt = vio?.violations || 0;
        const warns = await _g2('SELECT COUNT(*) as c FROM group_warns WHERE chat_id=$1 AND user_id=$2', [cid2, uid2]).then(r => r?.c || 0).catch(() => 0);
        const txt = '🛡 *مخالفات الحماية*\n━━━━━━━━━━━━\n\n' +
          '🔴 مخالفات الفلاتر: *' + cnt + '*\n' +
          '⚠️ الإنذارات: *' + warns + '/3*';
        const kb = [[
          { text: '♻️ تصفير المخالفات', callback_data: 'gpq_reset_' + uid2 + '_' + cid2 },
        ]];
        return ctx.editMessageText(txt, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(() => {});
      }

      // gpq_ تشتغل في الخاص والقروب
      if (data.startsWith('gpq_')) {
        const _gpqFn = _getPrefixHandler(data);
        if (_gpqFn) return _gpqFn(ctx, data);
        return;
      }



      if (ctx.chat?.type !== 'private') {
        if (data.startsWith('grp_main_')) {
          const chatId = data.replace('grp_main_', '');
          const { showAllMembers } = require('../handlers/group_admin');
          return showAllMembers(ctx, chatId);
        }

        if (data.startsWith('grp_reg_btn_')) {
          const regChatId = data.replace('grp_reg_btn_', '');
          const { registerMembers } = require('../handlers/group_admin');
          ctx.answerCbQuery('').catch(() => {});
          return registerMembers(ctx, regChatId);
        }

        if (data.startsWith('grp_register_')) {
          const regChatId = data.replace('grp_register_', '');
          const u = ctx.from;
          require('../database/db').run(
            `INSERT INTO group_members(chat_id,user_id,username,first_name,updated_at)
             VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)
             ON CONFLICT(chat_id,user_id) DO UPDATE SET first_name=EXCLUDED.first_name, updated_at=CURRENT_TIMESTAMP`,
            [regChatId, u.id, u.username||'', u.first_name||'']
          ).catch(() => {});
          require('../utils/cache').cacheClear('grp_members_' + regChatId);
          ctx.answerCbQuery('✅ تم تسجيلك!').catch(() => {});
          return;
        }

        // ── التصويت (في القروبات) ──
        if (data.startsWith('poll_')) {
          return require('../handlers/poll_system').handleCallback(ctx, data);
        }

        // ── ألعاب المليون (في القروبات والخاص) ──────────────────
        if (data.startsWith('ml_') || data.startsWith('ma_') ||
            data.startsWith('mlr_') || data.startsWith('mar_')) {
          if (millionGame.handleCallback) {
            return millionGame.handleCallback(ctx, data).catch(e => ctx.answerCbQuery('❌ ' + e.message).catch(() => {}));
          }
          return;
        }

        
        // ── فحص admin لكل أزرار grp_ ──
        if (data.startsWith('grp_mute_') || data.startsWith('grp_ban_') ||
            data.startsWith('grp_warns_') || data.startsWith('grp_perms_') ||
            data.startsWith('grp_ptog_') || data.startsWith('grp_psave_') ||
            data.startsWith('grp_wadd_') || data.startsWith('grp_wdel_') ||
            data.startsWith('grp_warn1_') || data.startsWith('grp_unwarn1_') ||
            data.startsWith('grp_warnmenu_') || data.startsWith('grp_warnback_') ||
            data.startsWith('grp_clearwarn_') || data.startsWith('grp_pall_') ||
            data.startsWith('grp_pnone_') || data.startsWith('grp_aptog_') ||
            data.startsWith('grp_apsave_') || data.startsWith('grp_demote_') ||
            data.startsWith('grp_restrict_') || data.startsWith('grp_unrestrict_') ||
            data.startsWith('grp_ban_confirm_') || data.startsWith('grp_ban_now_') ||
            data.startsWith('grp_promote_') || data.startsWith('grp_mute_menu_') ||
            data.startsWith('grp_unban_') || data.startsWith('grp_unmute_')) {
          // استخرج chatId من آخر جزء في الـ data
          const _dataParts = data.split('_');
          const _extractedChatId = parseInt(_dataParts[_dataParts.length - 1]) || ctx.chat?.id;
          const chatIdCheck = _extractedChatId;
          let isCallerAdm = ctx.isAdmin || ctx.isOwner;
          if (!isCallerAdm && chatIdCheck && chatIdCheck < 0) {
            const callerMember = await ctx.telegram.getChatMember(chatIdCheck, ctx.from.id).catch(() => null);
            isCallerAdm = ['administrator','creator'].includes(callerMember?.status);
          } else if (!isCallerAdm) {
            // من الخاص — نتحقق من جدول admins
            const { get: _ag } = require('../database/db');
            const _arow = await _ag('SELECT user_id FROM admins WHERE user_id=$1', [ctx.from.id]).catch(() => null);
            isCallerAdm = !!_arow || String(ctx.from.id) === String(process.env.OWNER_ID);
          }
          if (!isCallerAdm) return ctx.answerCbQuery('🚫 للمشرفين فقط', { show_alert: true }).catch(() => {});
        }

        // ── قائمة الإنذارات (تفتح من زر /info) ──
        if (data.startsWith('grp_warnmenu_')) {
          const parts2  = data.replace('grp_warnmenu_', '').split('_');
          const uid2    = parseInt(parts2[0]);
          const chatId2 = parseInt(parts2[1]);
          const { all: dbA } = require('../database/db');
          const warns = await dbA('SELECT id FROM group_warns WHERE chat_id=$1 AND user_id=$2', [chatId2, uid2]).catch(() => []);
          const cnt = warns.length;
          return ctx.editMessageReplyMarkup({ inline_keyboard: [
            [
              { text: '＋ تحذير',    callback_data: 'grp_warn1_'     + uid2 },
              { text: '－ تحذير',    callback_data: 'grp_unwarn1_'   + uid2 },
              { text: '🗑 مسح الكل', callback_data: 'grp_clearwarn_' + uid2 },
            ],
            [
              { text: '↩️ رجوع (' + cnt + '/3)', callback_data: 'grp_warnback_' + uid2 + '_' + chatId2 },
            ],
          ]}).catch(() => ctx.answerCbQuery('').catch(() => {}));
        }

        // ── رجوع لقائمة /info ──
        if (data.startsWith('grp_warnback_')) {
          const parts2  = data.replace('grp_warnback_', '').split('_');
          const uid2    = parseInt(parts2[0]);
          const chatId2 = parseInt(parts2[1]);
          const { all: dbA } = require('../database/db');
          const warns = await dbA('SELECT id FROM group_warns WHERE chat_id=$1 AND user_id=$2', [chatId2, uid2]).catch(() => []);
          const cnt = warns.length;
          return ctx.editMessageReplyMarkup({ inline_keyboard: [
            [
              { text: 'كتم',      callback_data: 'grp_mute_menu_'   + uid2 },
              { text: 'حظر',      callback_data: 'grp_ban_confirm_' + uid2 },
            ],
            [
              { text: 'الغاء الكتم', callback_data: 'grp_unrestrict_' + uid2 + '_' + chatId2 },
              { text: 'انذارات ' + cnt + '/3', callback_data: 'grp_warnmenu_' + uid2 + '_' + chatId2 },
            ],
            [
              { text: 'اذونات', callback_data: 'grp_perms_' + uid2 + '_' + chatId2 },
            ],
          ]}).catch(() => ctx.answerCbQuery('').catch(() => {}));
        }

        // ── +1 تحذير ──
        if (data.startsWith('grp_warn1_')) {
          const { uid: uid2, chatId: chatId2 } = extractUidChat(data.replace('grp_warn1_', ''));
          const { run: dbR, all: dbA } = require('../database/db');
          await dbR(
            'INSERT INTO group_warns(chat_id,user_id,reason,warned_by) VALUES($1,$2,$3,$4)',
            [chatId2, uid2, 'مخالفة القواعد', ctx.from.id]
          ).catch(() => {});
          const warns = await dbA('SELECT id FROM group_warns WHERE chat_id=$1 AND user_id=$2', [chatId2, uid2]).catch(() => []);
          const count = warns.length;
          if (count >= 3) {
            await ctx.telegram.banChatMember(chatId2, uid2).catch(() => {});
            await dbR('DELETE FROM group_warns WHERE chat_id=$1 AND user_id=$2', [chatId2, uid2]).catch(() => {});
            return ctx.answerCbQuery('🚫 وصل 3 تحذيرات — تم الحظر!', { show_alert: true }).catch(() => {});
          }
          return ctx.answerCbQuery('⚠️ تحذير ' + count + '/3', { show_alert: false }).catch(() => {});
        }

        // ── -1 تحذير ──
        if (data.startsWith('grp_unwarn1_')) {
          const uid2    = parseInt(data.replace('grp_unwarn1_', ''));
          const chatId2 = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
          const { run: dbR, get: dbG } = require('../database/db');
          // احذف آخر تحذير فقط
          const last = await dbG(
            'SELECT id FROM group_warns WHERE chat_id=$1 AND user_id=$2 ORDER BY id DESC LIMIT 1',
            [chatId2, uid2]
          ).catch(() => null);
          if (last) await dbR('DELETE FROM group_warns WHERE id=$1', [last.id]).catch(() => {});
          const remaining = await dbG(
            'SELECT COUNT(*) AS c FROM group_warns WHERE chat_id=$1 AND user_id=$2',
            [chatId2, uid2]
          ).catch(() => ({ c: 0 }));
          return ctx.answerCbQuery('✅ تحذير ' + remaining.c + '/3', { show_alert: false }).catch(() => {});
        }

        // ── قائمة خيارات الكتم ──
        if (data.startsWith('grp_mute_menu_')) {
          const { uid: uid2, chatId: cid2 } = extractUidChat(data.replace('grp_mute_menu_', ''));
          const kb = [[
            { text: '5 دقائق',  callback_data: 'grp_mute_5_'    + uid2 + '_' + cid2 },
            { text: '30 دقيقة', callback_data: 'grp_mute_30_'   + uid2 + '_' + cid2 },
          ],[
            { text: 'ساعة',     callback_data: 'grp_mute_60_'   + uid2 + '_' + cid2 },
            { text: '6 ساعات',  callback_data: 'grp_mute_360_'  + uid2 + '_' + cid2 },
          ],[
            { text: 'يوم كامل', callback_data: 'grp_mute_1440_' + uid2 + '_' + cid2 },
            { text: 'الغاء',    callback_data: 'grp_cancel' },
          ]];
          return ctx.editMessageReplyMarkup({ inline_keyboard: kb }).catch(() => ctx.answerCbQuery('').catch(() => {}));
        }

        // ── تنفيذ الكتم بالوقت ──
        if (/^grp_mute_\d+_/.test(data)) {
          const parts = data.replace('grp_mute_', '').split('_');
          const mins  = parseInt(parts[0]);
          const uid2  = parseInt(parts[1]);
          const cid2  = parseInt(parts[2]) || ctx.chat?.id;
          const { muteMember } = require('../handlers/group_admin');
          await muteMember(ctx, cid2, uid2, mins).catch(() => {});
          const label = mins < 60 ? mins + ' دقيقة' : (mins/60) + ' ساعة';
          await ctx.editMessageReplyMarkup({ inline_keyboard: [[
            { text: 'رفع الكتم', callback_data: 'grp_unmute_' + uid2 + '_' + cid2 }
          ]]}).catch(() => {});
          return ctx.answerCbQuery('تم الكتم ' + label).catch(() => {});
        }

        // ── تأكيد الحظر ──
        if (data.startsWith('grp_ban_confirm_')) {
          const { uid: uid2, chatId: _bchatId } = extractUidChat(data.replace('grp_ban_confirm_', ''));
          const kb = [[
            { text: 'تأكيد الحظر', callback_data: 'grp_ban_now_' + uid2 + '_' + _bchatId },
            { text: 'الغاء',        callback_data: 'grp_cancel' },
          ]];
          return ctx.editMessageReplyMarkup({ inline_keyboard: kb }).catch(() => ctx.answerCbQuery('').catch(() => {}));
        }

        // ── إلغاء ──
        if (data === 'grp_cancel') {
          return ctx.deleteMessage().catch(() => ctx.answerCbQuery('').catch(() => {}));
        }
        if (data.startsWith('grp_perms_')) {
          const parts   = data.replace('grp_perms_', '').split('_');
          const uid2    = parseInt(parts[0]);
          const chatId2 = parts[1] ? parseInt(parts[1]) : ctx.chat.id;
          const adminId = ctx.from.id;
          const member  = await ctx.telegram.getChatMember(chatId2, uid2).catch(() => null);
          const isAdminMember = ['administrator','creator'].includes(member?.status);
          const p = member?.can_send_messages !== undefined ? member : null;
          const can = (key) => p ? (p[key] !== false) : true;
          const acan = (key) => member ? (member[key] === true) : false;
          const tog  = (label, key) => [{ text: (can(key)  ? '✅ ' : '❌ ') + label, callback_data: 'grp_ptog_'  + key + '_' + uid2 + '_' + chatId2 }];
          const atog = (label, key) => [{ text: (acan(key) ? '✅ ' : '❌ ') + label, callback_data: 'grp_aptog_' + key + '_' + uid2 + '_' + chatId2 }];

          const name2 = member?.user?.first_name || 'عضو';
          const txt2 = (isAdminMember ? '👮' : '👤') + ' *' + name2 + '*\n' +
            '🆔 ' + uid2 + ' • ' + (isAdminMember ? 'مشرف' : 'عضو') + '\n\n' +
            '_اختر الإجراء:_';
          const kb2 = [
            [
              { text: 'كتم',        callback_data: 'grp_mute_menu_'   + uid2 + '_' + chatId2 },
              { text: 'حظر',        callback_data: 'grp_ban_confirm_' + uid2 + '_' + chatId2 },
            ],
            [
              { text: 'الغاء الكتم', callback_data: 'grp_unrestrict_' + uid2 + '_' + chatId2 },
              { text: 'انذار',       callback_data: 'grp_warn1_'      + uid2 + '_' + chatId2 },
            ],
            [
              { text: 'الاذونات', callback_data: 'grp_perms_' + uid2 + '_' + chatId2 },
            ],
          ];
          if (isAdminMember) {
            kb2.push([{ text: '🗑 إزالة من المشرفين', callback_data: 'grp_demote_' + uid2 + '_' + chatId2 }]);
          }
          try {
            await ctx.telegram.sendMessage(adminId, txt2, {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: kb2 }
            });
            return ctx.answerCbQuery('📨 تم').catch(() => {});
          } catch(_) {
            return ctx.answerCbQuery('⚠️ افتح الخاص مع البوت أولاً', { show_alert: true }).catch(() => {});
          }
        }

        // ── إعطاء كل الإذونات دفعة ──
        if (data.startsWith('grp_pall_')) {
          const [uid2, cid2] = data.replace('grp_pall_', '').split('_').map(Number);
          await ctx.telegram.restrictChatMember(cid2, uid2, { permissions: {
            can_send_messages: true, can_send_photos: true, can_send_videos: true,
            can_send_audios: true, can_send_documents: true, can_send_voice_notes: true,
            can_send_video_notes: true, can_send_polls: true, can_send_other_messages: true,
            can_add_web_page_previews: true, can_change_info: true,
            can_invite_users: true, can_pin_messages: true,
          }}).catch(() => {});
          return ctx.answerCbQuery('✅ كل الإذونات مُعطاة').catch(() => {});
        }

        // ── سحب كل الإذونات دفعة ──
        if (data.startsWith('grp_pnone_')) {
          const [uid2, cid2] = data.replace('grp_pnone_', '').split('_').map(Number);
          await ctx.telegram.restrictChatMember(cid2, uid2, { permissions: {
            can_send_messages: false, can_send_photos: false, can_send_videos: false,
            can_send_audios: false, can_send_documents: false, can_send_voice_notes: false,
            can_send_video_notes: false, can_send_polls: false, can_send_other_messages: false,
            can_add_web_page_previews: false, can_change_info: false,
            can_invite_users: false, can_pin_messages: false,
          }}).catch(() => {});
          return ctx.answerCbQuery('❌ كل الإذونات مسحوبة').catch(() => {});
        }

        // ── toggle إذونات Admin ──
        if (data.startsWith('grp_aptog_')) {
          const curKb = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard || [];
          const newKb = curKb.map(row => row.map(btn => {
            if (btn.callback_data === data) {
              const isOn = btn.text.startsWith('✅');
              return { ...btn, text: (isOn ? '❌ ' : '✅ ') + btn.text.slice(2) };
            }
            return btn;
          }));
          await ctx.editMessageReplyMarkup({ inline_keyboard: newKb }).catch(() => {});
          return ctx.answerCbQuery('').catch(() => {});
        }

        // ── حفظ إذونات Admin ──
        if (data.startsWith('grp_apsave_')) {
          const parts3 = data.replace('grp_apsave_', '').split('_');
          const uid3   = parseInt(parts3[0]);
          const cid3   = parseInt(parts3[1]);
          const curKb  = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard || [];
          const adminPerms = {};
          const keyMap = {
            'حذف الرسائل':'can_delete_messages', 'حظر الأعضاء':'can_restrict_members',
            'تثبيت الرسائل':'can_pin_messages', 'دعوة عبر رابط':'can_invite_users',
            'تغيير معلومات':'can_change_info', 'إدارة البث المباشر':'can_manage_video_chats',
            'إدارة القروب':'can_manage_chat', 'إضافة مشرفين':'can_promote_members',
          };
          for (const row of curKb) {
            for (const btn of row) {
              const isOn = btn.text.startsWith('✅');
              for (const [label, key] of Object.entries(keyMap)) {
                if (btn.text.includes(label)) adminPerms[key] = isOn;
              }
            }
          }
          try {
            await ctx.telegram.promoteChatMember(cid3, uid3, adminPerms);
            await ctx.editMessageText('✅ *تم حفظ إذونات المشرف!*', { parse_mode: 'Markdown' }).catch(() => {});
            return ctx.answerCbQuery('✅ تم الحفظ').catch(() => {});
          } catch(e) {
            return ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {});
          }
        }

        // ── إزالة من المشرفين ──
        if (data.startsWith('grp_demote_')) {
          const parts3 = data.replace('grp_demote_', '').split('_');
          const uid3   = parseInt(parts3[0]);
          const cid3   = parseInt(parts3[1]);
          try {
            await ctx.telegram.promoteChatMember(cid3, uid3, {
              can_delete_messages: false, can_restrict_members: false,
              can_pin_messages: false, can_manage_chat: false,
              can_invite_users: false, can_change_info: false,
              can_promote_members: false, can_manage_video_chats: false,
            });
            await ctx.editMessageText('✅ *تمت إزالة المشرف*', { parse_mode: 'Markdown' }).catch(() => {});
            return ctx.answerCbQuery('✅ تمت الإزالة').catch(() => {});
          } catch(e) {
            return ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {});
          }
        }

        // ── ترقية لمشرف ──
        if (data.startsWith('grp_promote_')) {
          const parts3 = data.replace('grp_promote_', '').split('_');
          const uid3   = parseInt(parts3[0]);
          const cid3   = parseInt(parts3[1]);
          // عرض لوحة اختيار صلاحيات الترقية
          const promoteKb = [
            [{ text: '✅ حذف الرسائل',      callback_data: 'grp_aptog_can_delete_messages_' + uid3 + '_' + cid3 }],
            [{ text: '✅ حظر الأعضاء',       callback_data: 'grp_aptog_can_restrict_members_' + uid3 + '_' + cid3 }],
            [{ text: '✅ تثبيت الرسائل',     callback_data: 'grp_aptog_can_pin_messages_' + uid3 + '_' + cid3 }],
            [{ text: '✅ دعوة عبر رابط',     callback_data: 'grp_aptog_can_invite_users_' + uid3 + '_' + cid3 }],
            [{ text: '✅ تغيير معلومات',     callback_data: 'grp_aptog_can_change_info_' + uid3 + '_' + cid3 }],
            [{ text: '✅ إدارة البث',         callback_data: 'grp_aptog_can_manage_video_chats_' + uid3 + '_' + cid3 }],
            [{ text: '✅ إدارة القروب',       callback_data: 'grp_aptog_can_manage_chat_' + uid3 + '_' + cid3 }],
            [
              { text: '💾 حفظ الصلاحيات', callback_data: 'grp_apsave_' + uid3 + '_' + cid3 },
              { text: '❌ إلغاء',           callback_data: 'grp_cancel' },
            ],
          ];
          await ctx.editMessageText(
            '👑 *اختر صلاحيات المشرف الجديد:*\n\n_اضغط على صلاحية لتفعيلها/إلغائها_',
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: promoteKb } }
          ).catch(() => ctx.reply('👑 اختر صلاحيات المشرف:', { reply_markup: { inline_keyboard: promoteKb } }).catch(() => {}));
          return ctx.answerCbQuery('').catch(() => {});
        }
        if (data.startsWith('grp_restrict_')) {
          const uid2 = parseInt(data.replace('grp_restrict_', ''));
          await ctx.telegram.restrictChatMember(ctx.chat.id, uid2, {
            permissions: { can_send_messages: false, can_send_media_messages: false, can_send_polls: false }
          }).catch(() => {});
          await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '🔊 إعطاء الكلام', callback_data: 'grp_unrestrict_' + uid2 }]] }).catch(() => {});
          return ctx.answerCbQuery('🔇 تم سحب الكلام').catch(() => {});
        }
        if (data.startsWith('grp_unrestrict_')) {
          const uid2 = parseInt(data.replace('grp_unrestrict_', ''));
          await ctx.telegram.restrictChatMember(ctx.chat.id, uid2, {
            permissions: { can_send_messages: true, can_send_media_messages: true, can_send_polls: true, can_add_web_page_previews: true }
          }).catch(() => {});
          await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '🔇 سحب الكلام', callback_data: 'grp_restrict_' + uid2 }]] }).catch(() => {});
          return ctx.answerCbQuery('🔊 تم إعطاء الكلام').catch(() => {});
        }

        // ── أزرار warn/info — للأدمن فقط ──
        if (data.startsWith('grp_warns_show_') || data.startsWith('grp_mute_60_') ||
            data.startsWith('grp_ban_now_') || data.startsWith('grp_perms_') ||
            data.startsWith('grp_restrict_') || data.startsWith('grp_unrestrict_') ||
            data.startsWith('grp_ptog_') || data.startsWith('grp_psave_')) {
          const isAdmOrOwner = ctx.isAdmin || ctx.isOwner ||
            ['administrator','creator'].includes(
              (await ctx.telegram.getChatMember(ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id, ctx.from.id).catch(() => null))?.status
            );
          if (!isAdmOrOwner) return ctx.answerCbQuery('🚫 للمشرفين فقط', { show_alert: true }).catch(() => {});
        }
        if (data.startsWith('grp_warns_show_')) {
          const parts_w = data.replace('grp_warns_show_', '').split('_');
          const uid2  = parseInt(parts_w[0]);
          const cid_w = parts_w[1] ? parseInt(parts_w[1]) : ctx.chat?.id;
          const { all: dbAll, run: dbRun } = require('../database/db');
          const rows = await dbAll('SELECT id, reason, created_at FROM group_warns WHERE chat_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 5', [cid_w, uid2]).catch(() => []);
          const cnt = rows.length;
          let txt = '❗ *إنذارات العضو: ' + cnt + '/3*\n\n';
          for (const r of rows) {
            const d = new Date(r.created_at).toLocaleDateString('ar');
            txt += '• ' + r.reason + ' — ' + d + '\n';
          }
          if (!cnt) txt = '✅ لا توجد إنذارات بعد';
          const wKb = [[
            { text: '➕ إنذار', callback_data: 'grp_wadd_' + uid2 + '_' + cid_w },
            { text: '➖ حذف إنذار', callback_data: 'grp_wdel_' + uid2 + '_' + cid_w },
          ]];
          await ctx.answerCbQuery('').catch(() => {});
          return ctx.reply(txt, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: wKb } }).catch(() => {});
        }

        if (data.startsWith('grp_wadd_')) {
          const parts_wa = data.replace('grp_wadd_', '').split('_');
          const uid2 = parseInt(parts_wa[0]);
          const cid_w = parseInt(parts_wa[1]);
          const { run: dbRun, get: dbGet } = require('../database/db');
          await dbRun(
            'INSERT INTO group_warns(chat_id,user_id,warned_by,reason,created_at) VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)',
            [cid_w, uid2, ctx.from.id, 'إنذار يدوي']
          ).catch(() => {});
          const cnt = await dbGet('SELECT COUNT(*) as c FROM group_warns WHERE chat_id=$1 AND user_id=$2', [cid_w, uid2]).then(r=>r?.c||0).catch(()=>0);
          // تحقق إذا وصل 3
          if (parseInt(cnt) >= 3) {
            await ctx.telegram.banChatMember(cid_w, uid2).catch(() => {});
            await dbRun('DELETE FROM group_warns WHERE chat_id=$1 AND user_id=$2', [cid_w, uid2]).catch(() => {});
            return ctx.editMessageText('🚫 *تم الحظر تلقائياً بعد 3 إنذارات!*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'رفع الحظر', callback_data: 'grp_unban_' + uid2 + '_' + _bncid }]] }}).catch(() => {});
          }
          await ctx.editMessageText(
            '❗ *إنذارات العضو: ' + cnt + '/3*\n\n✅ تم إضافة إنذار',
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
              { text: '➕ إنذار', callback_data: 'grp_wadd_' + uid2 + '_' + cid_w },
              { text: '➖ حذف إنذار', callback_data: 'grp_wdel_' + uid2 + '_' + cid_w },
            ]]}}
          ).catch(() => {});
          return ctx.answerCbQuery('✅ تم إضافة إنذار — ' + cnt + '/3').catch(() => {});
        }

        if (data.startsWith('grp_wdel_')) {
          const parts_wd = data.replace('grp_wdel_', '').split('_');
          const uid2 = parseInt(parts_wd[0]);
          const cid_w = parseInt(parts_wd[1]);
          const { run: dbRun, get: dbGet, all: dbAll2 } = require('../database/db');
          // نحذف آخر إنذار
          const last = await dbAll2('SELECT id FROM group_warns WHERE chat_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1', [cid_w, uid2]).then(r=>r[0]).catch(()=>null);
          if (last) await dbRun('DELETE FROM group_warns WHERE id=$1', [last.id]).catch(() => {});
          const cnt = await dbGet('SELECT COUNT(*) as c FROM group_warns WHERE chat_id=$1 AND user_id=$2', [cid_w, uid2]).then(r=>r?.c||0).catch(()=>0);
          await ctx.editMessageText(
            '❗ *إنذارات العضو: ' + cnt + '/3*\n\n✅ تم حذف إنذار',
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
              { text: '➕ إنذار', callback_data: 'grp_wadd_' + uid2 + '_' + cid_w },
              { text: '➖ حذف إنذار', callback_data: 'grp_wdel_' + uid2 + '_' + cid_w },
            ]]}}
          ).catch(() => {});
          return ctx.answerCbQuery('✅ تم حذف إنذار — ' + cnt + '/3').catch(() => {});
        }
        if (data.startsWith('grp_mute_60_')) {
          const uid2 = parseInt(data.replace('grp_mute_60_', ''));
          const { muteMember } = require('../handlers/group_admin');
          await muteMember(ctx, ctx.chat.id, uid2, 60).catch(() => {});
          await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '🔊 رفع الكتم', callback_data: 'grp_unmute_' + uid2 }]] }).catch(() => {});
          return ctx.answerCbQuery('🔇 تم الكتم ساعة').catch(() => {});
        }
        if (data.startsWith('grp_ban_now_')) {
          const { uid: uid2, chatId: _bncid } = extractUidChat(data.replace('grp_ban_now_', ''));
          await ctx.telegram.banChatMember(_bncid, uid2).catch(() => {});
          await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '🔓 رفع الحظر', callback_data: 'grp_unban_' + uid2 }]] }).catch(() => {});
          return ctx.answerCbQuery('🚫 تم الحظر').catch(() => {});
        }
        if (data.startsWith('grp_restrict_')) {
          const uid2 = parseInt(data.replace('grp_restrict_', ''));
          await ctx.telegram.restrictChatMember(ctx.chat.id, uid2, {
            permissions: { can_send_messages: false, can_send_media_messages: false, can_send_polls: false }
          }).catch(() => {});
          await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '🔊 إعطاء الكلام', callback_data: 'grp_unrestrict_' + uid2 }]] }).catch(() => {});
          return ctx.answerCbQuery('🔇 تم سحب الكلام').catch(() => {});
        }
        if (data.startsWith('grp_unrestrict_')) {
          const uid2 = parseInt(data.replace('grp_unrestrict_', ''));
          await ctx.telegram.restrictChatMember(ctx.chat.id, uid2, {
            permissions: { can_send_messages: true, can_send_media_messages: true, can_send_polls: true, can_add_web_page_previews: true, can_invite_users: true }
          }).catch(() => {});
          await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '🔇 سحب الكلام', callback_data: 'grp_restrict_' + uid2 }]] }).catch(() => {});
          return ctx.answerCbQuery('🔊 تم إعطاء الكلام').catch(() => {});
        }



      // ── إرسال ملف للقروب من نتائج البحث ──
      if (data.startsWith('gsf-')) {
        const parts  = data.replace('gsf-', '').split('-');
        const fileId = parts[0];
        const reqUid = parseInt(parts[1]);
        if (ctx.from.id !== reqUid) return ctx.answerCbQuery('🚫 هذا البحث مو لك!', { show_alert: true }).catch(() => {});
        const { get: dbGet } = require('../database/db');
        const file = await dbGet('SELECT * FROM files WHERE id=$1 AND is_deleted=0', [fileId]).catch(() => null);
        if (!file) return ctx.answerCbQuery('❌ الملف غير موجود', { show_alert: true }).catch(() => {});
        try {
          const caption = '📁 *' + (file.title || file.name || 'ملف') + '*';
          if (file.file_type === 'photo') {
            await ctx.telegram.sendPhoto(ctx.chat.id, file.file_id, { caption, parse_mode: 'Markdown' });
          } else if (file.file_type === 'link') {
            await ctx.reply(caption + '\n🔗 ' + file.file_id, { parse_mode: 'Markdown' });
          } else {
            await ctx.telegram.sendDocument(ctx.chat.id, file.file_id, { caption, parse_mode: 'Markdown' });
          }
          await ctx.deleteMessage().catch(() => {});
          return ctx.answerCbQuery('✅ تم إرسال الملف').catch(() => {});
        } catch(e) {
          return ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {});
        }
      }
        const _grpOk = data.startsWith('grp_') || data.startsWith('del_channel_')
          || data.startsWith('poll_') // [تعديل] تفعيل أزرار التصويت (poll_system.js) داخل القروب
          || data.startsWith('gs_') || data.startsWith('grp_unban_')
          || data.startsWith('grp_unmute_') || data === 'check_subscription'
          || data === 'refresh_channels' || data.startsWith('mute_all_')
          || data.startsWith('unmute_all_') || data.startsWith('tag_all_')
          || data.startsWith('close_list_') || data.startsWith('close_stats_')
          || data.startsWith('grp_stats_') || data === 'rules_ok'
          || data.startsWith('ml_') || data.startsWith('gp_') || data.startsWith('gpx_')
          || data.startsWith('grp_register_') || data.startsWith('grp_reg_btn_')
          || data === 'mb_panel' || data.startsWith('gp_million') || data.startsWith('gp_guess')
          || data.startsWith('mlr_') || data.startsWith('mar_')
          || data.startsWith('grp_mute_1h_') || data.startsWith('grp_ban_')
          || data.startsWith('grp_warns_') || data.startsWith('grp_perms_')
          || data.startsWith('grp_restrict_') || data.startsWith('grp_unrestrict_')
          || data.startsWith('games_')
          || data.startsWith('music_')
          || data.startsWith('xo_')
          || data.startsWith('tnd_')
          || data.startsWith('slot_')
          || data.startsWith('shop_')
          || data.startsWith('inf_')
          || data.startsWith('gpq_')
          || data.startsWith('ml_') || data.startsWith('ma_')
          || data.startsWith('mlr_') || data.startsWith('mar_')
          || data.startsWith('mq_')
          || data.startsWith('gsf-')
          || data === 'rules_ok'
          || data === 'shop_close'
          || data === 'bank_transfer_help'
          || data === 'bank_top'
          || data.startsWith('bank_') || data.startsWith('bnk_')
          || data.startsWith('bankpro:')
          || data === 'bank_menu' || data === 'bank_wallet'
          || data.startsWith('inv_') || data.startsWith('loan_')
          || data.startsWith('transfer_') || data.startsWith('card_')
          || data.startsWith('tnd_') || data.startsWith('slot_')
          || data.startsWith('shop_') || data === 'shop_close'
          || data.startsWith('gsf-') || data.startsWith('games_how_')
          || data.startsWith('adv_') || data.startsWith('nat_') || data.startsWith('nation_')
          || data.startsWith('ww:') || data.startsWith('wwx:')
          || data.startsWith('tod:') || data.startsWith('todadm:')
          || data.startsWith('grp_promote_') || data.startsWith('grp_aptog_')
          || data.startsWith('grp_apsave_') || data.startsWith('grp_demote_')
          || data.startsWith('grp_mute_menu_') || data.startsWith('grp_ban_confirm_')
          || data.startsWith('grp_warn1_') || data.startsWith('grp_unwarn1_')
          || data.startsWith('grp_clearwarn_') || data === 'grp_cancel'
          || data.startsWith('grp_warnmenu_') || data.startsWith('grp_warnback_')
          || data.startsWith('grp_wadd_') || data.startsWith('grp_wdel_')
          || data.startsWith('grp_pall_') || data.startsWith('grp_pnone_')
          || data.startsWith('grp_unban_') || data.startsWith('grp_unmute_')
          || data.startsWith('gpq_') || data.startsWith('inf_') || data.startsWith('help_')
          || data.startsWith('grp_perms_') || data.startsWith('grp_mute_')
          || data.startsWith('grp_ban_') || data.startsWith('grp_kick_')
          || data.startsWith('grp_warns_') || data.startsWith('grp_restrict_')
          || data.startsWith('grp_unrestrict_') || data.startsWith('grp_ptog_')
          || data.startsWith('grp_psave_');
        if (!_grpOk)
          return ctx.answerCbQuery('👉 استخدم البوت في الخاص', { show_alert: true }).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      }

      // Pre-warm بالتوازي
      // Pre-warm aggressive
      if (data === 'browse' || data === 'main_menu') {
        contentDb.getSpecs().catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      } else if (data.startsWith('sp_')) {
        const sid = parseInt(data.split('_').pop());
        contentDb.getYears(sid).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      } else if (data.startsWith('yr_') && !data.startsWith('yr_page_')) {
        const yid = parseInt(data.split('_').pop());
        contentDb.getSemesters(yid).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      } else if (data.startsWith('sm_')) {
        const smid = parseInt(data.split('_').pop());
        Promise.all([
          contentDb.getSubjects(smid),
        ]).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      } else if (data.startsWith('sb_')) {
        const parts = data.split('_');
        const sbid = parseInt(parts.pop());
        contentDb.getCategories(sbid).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      } else if (data.startsWith('ct_') && !data.startsWith('ct_page_')) {
        const parts = data.split('_');
        // pre-warm files for this category
        const filesDb = require('../database/files');
        filesDb.getFiles(parseInt(parts[parts.length-1])).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      }

      // ── ألعاب القروب ──
      if (data.startsWith('games_')) {
        try { await handleBankGamesCallback(ctx, data); }
        catch(e) { ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {}); }
        return;
      }

            if (exactR.has(data)) return exactR.get(data)(ctx, data);
      const _h = _getPrefixHandler(data);
      if (_h) return _h(ctx, data);

    } catch(e) { logger.error('[CB]', e.message, { data, uid: ctx.from?.id }); }
  

  // تحقق من الاشتراك
  if (data === 'check_subscription') {
    const uid = ctx.from.id;
    const name = ctx.from.first_name || 'صديقي';
    const guard = require('../utils/channelGuard');
    const bot = global.__bot || { telegram: ctx.telegram };
    const res = await guard.checkAllChannels(bot, uid);
    if (!res.ok) {
      const { text, buttons } = guard.buildSubscribeMessage(res.missing, name);
      await ctx.answerCbQuery('❌ لم تشترك بعد!', { show_alert: true }).catch(()=>{});
      return ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(() => ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(()=>{}));
    }
    await ctx.answerCbQuery('✅ تم التحقق!').catch(()=>{});
    await ctx.deleteMessage().catch(()=>{});
    return startHandler(ctx);
  }
  // ── ألعاب القروب — شرح كل لعبة ──
  if (data.startsWith('grp_game_info_')) {
    const game = data.replace('grp_game_info_', '');
    const info = {
      million: {
        text:
          '🏆 *من سيربح المليون*\n' +
          '━━━━━━━━━━━━━━━━━━━━\n\n' +
          '📌 *طريقة اللعب:*\n' +
          'اكتب *مليون* في القروب لبدء جلسة\n' +
          'سيظهر زر انضمام للأعضاء\n' +
          'تبدأ الأسئلة بعد 60 ثانية\n\n' +
          '🃏 *المساعدات:*\n' +
          '50/50 — استطلاع الجمهور — اتصال صديق — تخطي\n\n' +
          '💰 *الجوائز:* تصاعدية من 1,000 → 1,000,000\n\n' +
          '⚡ كل إجابة خاطئة = خروج من اللعبة',
        btn: '▶️ ابدأ المليون الآن'
      },
      guess: {
        text:
          '📸 *خمّن الصورة*\n' +
          '━━━━━━━━━━━━━━━━━━━━\n\n' +
          '📌 *طريقة اللعب:*\n' +
          'اكتب *خمن* لبدء التحدي\n' +
          'يظهر جزء من صورة مخفية\n' +
          'اكتب إجابتك في القروب\n\n' +
          '⏱ وقت الإجابة: 30 ثانية\n' +
          '🏅 الفائز يحصل على XP ونقاط\n\n' +
          '💡 يمكن للمشرف إضافة صور جديدة',
        btn: '▶️ ابدأ خمن الصورة'
      },
      flip: {
        text:
          '🎲 *قلب العملة*\n' +
          '━━━━━━━━━━━━━━━━━━━━\n\n' +
          '📌 *طريقة اللعب:*\n' +
          '/flip [مبلغ] [صورة/كتابة]\n\n' +
          '🔹 مثال: /flip 500 صورة\n' +
          '🔹 الحد الأدنى: 10 دج\n' +
          '🔹 الحد الأقصى: رصيدك كاملاً\n\n' +
          '✅ ربح = ضعف المبلغ\n' +
          '❌ خسارة = تخسر المبلغ',
        btn: '🎲 العب الآن'
      },
      rob: {
        text:
          '🦹 *السرقة*\n' +
          '━━━━━━━━━━━━━━━━━━━━\n\n' +
          '📌 *طريقة اللعب:*\n' +
          'رد على رسالة شخص + اكتب /rob\n\n' +
          '⚠️ *شروط:*\n' +
          '🔹 الضحية يملك أكثر من 100 دج\n' +
          '🔹 انتظر ساعة بين كل سرقة\n\n' +
          '✅ نجاح = تسرق 10-30% من رصيده\n' +
          '❌ فشل = تخسر 50 دج غرامة',
        btn: '🦹 سرق الآن'
      },
      bank: {
        text:
          '🏦 *البنك والمكافآت*\n' +
          '━━━━━━━━━━━━━━━━━━━━\n\n' +
          '📌 *الأوامر:*\n' +
          '/daily — مكافأة يومية مجانية\n' +
          '/leaderboard — أغنى الأعضاء\n' +
          '/flip — قلب العملة\n' +
          '/rob — سرق عضو\n\n' +
          '💰 *طرق الكسب:*\n' +
          '🔹 المكافأة اليومية\n' +
          '🔹 الفوز في الألعاب\n' +
          '🔹 تصدر القوائم',
        btn: '💰 رصيدي'
      },
      werewolf: {
        text:
          '🐺 *لوب غارو*\n' +
          '━━━━━━━━━━━━━━━━━━━━\n\n' +
          '📌 *طريقة اللعب:*\n' +
          'اكتب *لوب غارو* لبدء جلسة تجميع لاعبين\n' +
          'كل لاعب ياخذ دور سري (قروي/مستذئب/إلخ)\n' +
          'النهار للنقاش والتصويت، الليل لأفعال الأدوار السرية\n\n' +
          '🏆 الفوز: القرويين يقصون كل المستذئبين، أو العكس',
        btn: '▶️ ابدأ لوب غارو'
      },
      tod: {
        text:
          '🎲 *صحصح (اكسيو فيريتي)*\n' +
          '━━━━━━━━━━━━━━━━━━━━\n\n' +
          '📌 *طريقة اللعب:*\n' +
          'اكتب *صحصح* لبدء جولة جماعية\n' +
          'كل عضو ياخذ دورو يختار صراحة أو جرأة\n\n' +
          '🎯 لعبة تفاعلية جماعية بلا فايز محدد',
        btn: '▶️ ابدأ صحصح'
      },
    };

    const g = info[game];
    if (!g) return ctx.answerCbQuery('').catch(() => {});

    const backKb = [[
      { text: g.btn, callback_data: 'grp_game_start_' + game },
      { text: '◀️ رجوع', callback_data: 'grp_game_back' },
    ]];

    await ctx.answerCbQuery('').catch(() => {});
    return ctx.editMessageText(g.text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: backKb }
    }).catch(() => {});
  }

  // ── رجوع للقائمة الرئيسية للألعاب — نفس الدالة المشتركة تماماً، بلا تكرار ──
  if (data === 'grp_game_back') {
    const { text: mainText, keyboard: mainKb, parseMode } = await require('../handlers/group_commands').buildGamesMenuContent();
    await ctx.answerCbQuery('').catch(() => {});
    return ctx.editMessageText(mainText, {
      parse_mode: parseMode || 'Markdown',
      reply_markup: mainKb
    }).catch(() => {});
  }

  // ── بدء لعبة من الزر ──
  if (data.startsWith('grp_game_start_')) {
    const game = data.replace('grp_game_start_', '');
    await ctx.answerCbQuery('').catch(() => {});
    if (game === 'million') return ctx.reply('🏆 اكتب *مليون* لبدء اللعبة!', { parse_mode: 'Markdown' }).catch(() => {});
    if (game === 'guess')   return ctx.reply('📸 اكتب *خمن* لبدء التحدي!',   { parse_mode: 'Markdown' }).catch(() => {});
    if (game === 'flip')    return ctx.reply('🎲 استخدم /flip [مبلغ]',        { parse_mode: 'Markdown' }).catch(() => {});
    if (game === 'rob')     return ctx.reply('🦹 رد على رسالة شخص + /rob',    { parse_mode: 'Markdown' }).catch(() => {});
    if (game === 'bank')    return ctx.reply('💰 استخدم /daily للمكافأة اليومية', { parse_mode: 'Markdown' }).catch(() => {});
  }


  // ══ 🎵 Music Search Callbacks ══
  // ══ 🎮 XO Game ══
  if (data.startsWith('xo_')) {
    return require('../handlers/xo').handleCallback(ctx).catch(() => {});
  }

  if (data === 'music_close' || data.startsWith('music_dl_') || data.startsWith('music_track_')) {
    return require('../handlers/music').handleCallback(ctx)
      .catch(e => require('../utils/logger').error('[Music callback] unexpected error:', e.message));
  }

  });
};