'use strict';
const https = require('https');
const groupPanel = require('../handlers/group_panel');

module.exports.registerMessages = function(bot, deps) {
  // dedup للرسائل
  const _msgSeen = new Set();
  function isDupMsg(id) {
    if (_msgSeen.has(id)) return true;
    _msgSeen.add(id);
    setTimeout(() => _msgSeen.delete(id), 30000);
    return false;
  }
  const {
    ownerH, GrpBuf, GrpMsgs, handleAiChat, handleOwnerAI,
    manage, browse, userH, bundlesDb, filesDb, adminsDb,
    logger, OWNER_ID, safeInt,
  } = deps;

  const { run: dbRun, all: dbAll } = require('../database/db');
  const { cacheSet, cacheClear, cacheClearPrefix } = require('../utils/cache');
  const { btn: kbBtn, build: kbBuild } = require('../utils/keyboard');
  const { eos } = require('../utils/helpers');
  const commentsDb = require('../database/comments');
  const tools = require('../handlers/owner_tools');

  // ── Media Group Collector ──
  const MGColl = {
    _g: new Map(),
    add(id, msg) { if (!this._g.has(id)) this._g.set(id, []); this._g.get(id).push(msg); },
    drain(id)    { const m = this._g.get(id) || []; this._g.delete(id); return m; },
  };
  setInterval(() => { for (const k of MGColl._g.keys()) MGColl._g.delete(k); }, 30000).unref();

  // ── Message (group) ──
  bot.on('message', async (ctx, next) => {
    const _mid = ctx.message?.message_id + '_' + (ctx.from?.id || '');
    if (isDupMsg(_mid)) return;

    // 🔧 FIX: حالة "💬 تواصل مع المستخدم" (admin_contact) منطقها جاهز وكامل
    // بـ manage.handleText (نص/صورة/فيديو/ستيكر/مستند) — بس كانت تُستدعى بس من
    // داخل bot.on('text')، فأي رسالة مو نصية (صورة/فيديو/صوت/ستيكر) ما توصلها
    // إطلاقاً. هذا الفحص هنا (على مستوى bot.on('message') العام، يغطي كل الأنواع)
    // يسد الفجوة بدون ما يمس أي state تاني (كل الفحوصات التانية مقيّدة بنوعها).
    if (ctx.chat?.type === 'private') {
      const _acState = require('../utils/stateManager').getState(ctx.uid);
      if (_acState?.type === 'admin_contact') {
        await manage.handleText(ctx, _acState);
        return;
      }
      if (_acState?.type === 'mg_set_welcome' && (ctx.isAdmin || ctx.isOwner)) {
        await manage.handleText(ctx, _acState);
        return;
      }
    }

    if (ctx.chat?.type === 'private' && ctx.from?.id === OWNER_ID && ctx.message?.text?.startsWith('!'))
      return ownerH.handle(ctx, ctx.message.text);

    if (ctx.chat?.type !== 'private') {
      if (ctx.from && !ctx.from.is_bot)
        GrpBuf.add(ctx.chat.id, ctx.from.id, ctx.from.username, ctx.from.first_name);

      // ── Welcome message ──
      if (ctx.message?.new_chat_members?.length) {
        // 🤖 مكافحة البوتات غير المصرّحة (anti_bot)
        try { await require('../handlers/group_protection').checkNewChatMembers(ctx); } catch (_) {}
        // handled by chat_member event to avoid duplicates
        return;
      }

      // 🌍 لعبة الدول
      const _cg = require('../handlers/countries_game');
      if (ctx.message?.text) {
        const _cgTxt = ctx.message.text.trim();
        if (/^دول$/i.test(_cgTxt)) {
          await _cg.startGame(ctx).catch(() => {});
          return;
        }
        const _cgHandled = await _cg.handleAnswer(ctx).catch(() => false);
        if (_cgHandled) return;
      }

      // بطاقة المستخدم — قبل أي state
      if (['group','supergroup'].includes(ctx.chat?.type) && ctx.message?.text) {
        const _ctxt = ctx.message.text.trim().toLowerCase();
        if (_ctxt.length > 0 && _ctxt.length <= 40) {
          const { get: _gc } = require('../database/db');
          const card = await _gc(
            'SELECT mc.* FROM member_card_triggers mct JOIN member_cards mc ON mc.chat_id=mct.chat_id AND mc.user_id=mct.user_id WHERE mct.chat_id=$1 AND LOWER(mct.trigger_word)=$2 LIMIT 1',
            [ctx.chat.id, _ctxt]
          ).catch(() => null);
          if (card) {
            const name = card.first_name || '';
            const user = card.username ? ' @' + card.username : '';
            const bio = card.bio ? '\n\n' + card.bio : '';
            const caption = (name + user + bio).trim();
            const _tOpts = {
              reply_to_message_id: ctx.message?.message_id,
              ...(ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}),
            };
            if (card.photo_file_id) {
              await ctx.replyWithPhoto(card.photo_file_id, { ...(_tOpts), caption: caption || undefined }).catch(() => {});
            } else {
              await ctx.reply(caption || 'مستخدم', _tOpts).catch(() => {});
            }
            return;
          }
        }
      }

      const s = await (require('../utils/stateManager').getStateAsync || require('../utils/stateManager').getState)(ctx.uid).catch(()=>null);
      if (s?.type === 'mg_bundle_files' && ctx.message.media_group_id) {
        const mgId = ctx.message.media_group_id;
        MGColl.add(mgId, ctx.message);
        setTimeout(async () => {
          const msgs = MGColl.drain(mgId); if (!msgs.length) return;
          let c = 0;
          for (const m of msgs) {
            let fid, ft, tl = '';
            if (m.document)    { fid = m.document.file_id; ft = 'document'; tl = m.document.file_name || ''; }
            else if (m.photo)  { fid = m.photo[m.photo.length - 1].file_id; ft = 'photo'; }
            else if (m.video)  { fid = m.video.file_id; ft = 'video'; }
            else continue;
            await bundlesDb.addBundleFile(s.bundleId, fid, ft, tl).catch(err => { require('../utils/logger').debug("[silent]", err.message); }); c++;
          }
          s.fileCount = (s.fileCount || 0) + c;
          ctx.reply('📎 ' + c + ' ملف. المجموع: ' + s.fileCount + '\nأبعث المزيد أو /done').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
        }, 1500);
        return;
      }
      // game handler
      const _gtxt = ctx.message?.text?.trim();
      if (_gtxt) {
        const guessGame = require('../handlers/guess_game');
        if (/^مليون$/i.test(_gtxt)) {
          try {
            const millionaire = require('../handlers/millionaire');
            if (millionaire.startJoinPhase) await millionaire.startJoinPhase(ctx);
          } catch(e) { require('../utils/logger').error('[Million]', e.message); }
          return;
        }
        if (/^خمن$/i.test(_gtxt)) { guessGame.startInvite && guessGame.startInvite(ctx).catch(e=>console.error('[Guess]',e.message)); return; }
        if (/^قواعد$/.test(_gtxt)) {
          ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
          const { showGroupRules } = require('../handlers/group_admin');
          showGroupRules(ctx, ctx.chat.id).catch(() => {}); return;
        }
        if (/^تخمين[:\s]+/i.test(_gtxt)) { guessGame.handleGuessMsg && guessGame.handleGuessMsg(ctx).catch(()=>{}); return; }
      }
      // بطاقة المستخدم — قبل next()
      if (ctx.message?.text) {
        const txt = (ctx.message.text || '').trim().toLowerCase();
        if (txt.length > 0 && txt.length <= 40) {
          const { get: _gc } = require('../database/db');
          const card = await _gc(
            'SELECT mc.* FROM member_card_triggers mct JOIN member_cards mc ON mc.chat_id=mct.chat_id AND mc.user_id=mct.user_id WHERE mct.chat_id=$1 AND LOWER(mct.trigger_word)=$2 LIMIT 1',
            [ctx.chat.id, txt]
          ).catch(() => null);
          if (card) {
            const name = card.first_name || '';
            const user = card.username ? ' @' + card.username : '';
            const bio = card.bio ? '\n\n' + card.bio : '';
            const caption = name + user + bio;
            if (card.photo_file_id) {
              await ctx.replyWithPhoto(card.photo_file_id, { caption: caption || undefined }).catch(() => {});
            } else {
              await ctx.reply(caption || 'مستخدم').catch(() => {});
            }
            return;
          }
        }
      }
      // في القروب نمرر للـ command handlers
      return next();
    }
    // في الخاص — لا next() لأن text/document/photo handlers يشتغلون
    
  // بطاقة المستخدم — نسخة قديمة معطلة
  if (false && ctx.message?.text) {
    const txt = (ctx.message.text || '').trim().toLowerCase();
    if (txt.length > 0 && txt.length <= 40) {
      const { get: _gc } = require('../database/db');
      const card = await _gc(
        'SELECT mc.* FROM member_card_triggers mct JOIN member_cards mc ON mc.chat_id=mct.chat_id AND mc.user_id=mct.user_id WHERE mct.chat_id=$1 AND LOWER(mct.trigger_word)=$2 LIMIT 1',
        [ctx.chat.id, txt]
      ).catch(() => null);
      if (card) {
        const name = card.first_name || '';
        const user = card.username ? ' @' + card.username : '';
        const bio = card.bio ? '\n\n' + card.bio : '';
        const caption = name + user + bio;
        if (card.photo_file_id) {
          await ctx.replyWithPhoto(card.photo_file_id, { caption: caption || undefined, parse_mode: 'Markdown' }).catch(() => {});
        } else {
          await ctx.reply(caption || 'مستخدم', { parse_mode: 'Markdown' }).catch(() => {});
        }
        return;
      }
    }
  }
  return next();
  });

  // ── Documents ──
  bot.on('document', async ctx => {
    {
      const _gmS = require('../utils/stateManager').getState(ctx.uid);
      if (_gmS?.type === 'gm_dm') {
        require('../utils/stateManager').delState(ctx.uid);
        try {
          await ctx.telegram.copyMessage(_gmS.targetUserId, ctx.chat.id, ctx.message.message_id);
          await ctx.reply('✅ تم إرسال الرسالة.').catch(() => {});
        } catch (e) {
          await ctx.reply('❌ ما قدرتش نبعت الرسالة (يمكن العضو ما بداش محادثة مع البوت).').catch(() => {});
        }
        return;
      }
    }
    if (!ctx.isAdmin && !ctx.isOwner) {
      await require('../handlers/forward_organizer').handleForward(ctx).catch(() => {});
      return;
    }
    const s = require('../utils/stateManager').getState(ctx.uid);

    if (ctx.isOwner) {
      const isFwd = !!(ctx.message.forward_from || ctx.message.forward_from_chat || ctx.message.forward_sender_name || ctx.message.forward_date || ctx.message.forward_origin);
      const hasCap = !!(ctx.message.caption && /تخصص:|سنة:|spec:|year:|sem:|mat:|cat:/i.test(ctx.message.caption));
      if (isFwd && hasCap && !s) {
        // caption فيها تصنيف — استخدم المسار القديم مباشرة
      } else if (isFwd && !s) {
        // forward عادي بدون تصنيف — استخدم الميزة الجديدة حتى للـ owner
        const handled = await require('../handlers/forward_organizer').handleForward(ctx).catch(() => false);
        if (handled) return;
      }
      if (isFwd && !hasCap && !s) {
        await require('../utils/stateManager').setState(ctx.uid, { type: 'pending_forward', doc: ctx.message.document, photo: null });
        await ctx.reply('📎 ملف محفوظ! أرسل المسار:\n`تخصص: X | سنة: X | فصل: X | مادة: X | قسم: X`', { parse_mode: 'Markdown' }).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
        return;
      }
    }

    if (await tools.trySmartUpload(ctx)) return;
    if (s?.type === 'mg_bundle_files') return manage.handleBundleFileUpload(ctx);
    if (s?.type === 'mg_bulk_files')   return manage.handleBulkUpload(ctx);
    if (s?.type === 'mg_tpl_file') {
      await require('../utils/stateManager').setState(ctx.uid, { ...s, type: 'mg_tpl_content', fileId: ctx.message.document.file_id });
      return ctx.reply('✏️ اكتب نص الرسالة (أو skip):').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
    }

    // Restore backup
    if (s?.type === 'mg_awaiting_restore' && ctx.isOwner) {
      await require('../utils/stateManager').delState(ctx.uid);
      const msg = await ctx.reply('⏳ جاري الاستعادة...').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      try {
        const link = await ctx.telegram.getFileLink(ctx.message.document.file_id);
        const raw  = await new Promise((resolve, reject) => {
          let data = '';
          https.get(link.href, res => { res.on('data', c => data += c); res.on('end', () => resolve(data)); }).on('error', reject);
        });
        const backup = JSON.parse(raw);
        if (!backup.tables) throw new Error('ملف غير صالح');
        const { ALL_TABLES } = require('../utils/backup_full');
        const SAFE = new Set(ALL_TABLES);
        let restored = 0, errors = 0;
        const { getPg } = require('../database/db');
        const _pg = getPg();
        // ✅ استبدال كامل: امسح كل جدول مستهدف قبل إدراج بيانات النسخة القديمة
        // بدلاً من الدمج (INSERT فقط)، لضمان أن الاستعادة تُرجع الحالة القديمة
        // تماماً وتحذف أي بيانات أُضيفت بعد تاريخ النسخة الاحتياطية.
        for (const [table, rows] of Object.entries(backup.tables)) {
          if (!SAFE.has(table)) { errors++; continue; }
          if (_pg) {
            await _pg.query('TRUNCATE TABLE "' + table + '" CASCADE').catch(async () => {
              await _pg.query('DELETE FROM "' + table + '"').catch(() => {});
            });
          }
          if (!rows.length) { restored += 0; continue; } // جدول فُرِّغ بنجاح لكن لا بيانات لاستعادتها فيه
          const cols = Object.keys(rows[0]).filter(c => /^[a-zA-Z_][a-zA-Z0-9_]{0,59}$/.test(c));
          if (!cols.length) { errors++; continue; }
          const ph   = rows.map((_, ri) => '(' + cols.map((_, ci) => '$' + (ri * cols.length + ci + 1)).join(',') + ')').join(',');
          const vals = rows.flatMap(r => cols.map(c => r[c]));
          try { await dbRun('INSERT INTO ' + table + '(' + cols.join(',') + ') VALUES ' + ph + ' ON CONFLICT DO NOTHING', vals); restored += rows.length; }
          catch(e) { errors++; logger.error('[Restore]', table, e.message); }
        }
        require('../utils/cache').cacheClearAll();
        if (msg) ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
        const totalTables = Object.keys(backup.tables).length;
        ctx.reply(
          '✅ *تمت الاستعادة الشاملة!*\n\n' +
          '📊 الجداول: *' + totalTables + '*\n' +
          '📄 السجلات المستعادة: *' + restored + '*\n' +
          (errors ? '⚠️ أخطاء: *' + errors + '* (جداول فارغة أو غير موجودة)' : '✅ بدون أخطاء'),
          { parse_mode: 'Markdown' }
        ).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      } catch(e) {
        if (msg) ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
        ctx.reply('❌ فشلت الاستعادة: ' + e.message).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      }
      return;
    }

    if (s?.type === 'cg_q_content') return require('../handlers/game_builder_admin').handleText(ctx, ctx.message.caption || '', s);
    if (s?.type === 'mg_file') return manage.handleFileUpload(ctx);
  });

    // ── Photos / Videos / Audio / Voice ──
  bot.on(['photo', 'video', 'audio', 'voice'], async ctx => {
    {
      const _gmS = require('../utils/stateManager').getState(ctx.uid);
      if (_gmS?.type === 'gm_dm') {
        require('../utils/stateManager').delState(ctx.uid);
        try {
          await ctx.telegram.copyMessage(_gmS.targetUserId, ctx.chat.id, ctx.message.message_id);
          await ctx.reply('✅ تم إرسال الرسالة.').catch(() => {});
        } catch (e) {
          await ctx.reply('❌ ما قدرتش نبعت الرسالة (يمكن العضو ما بداش محادثة مع البوت).').catch(() => {});
        }
        return;
      }
    }
    // 💳 معالج صورة البطاقة الشخصية (في القروب أو الخاص)
    const _s = require('../utils/stateManager').getState(ctx.uid);
    if (_s?.type === 'member_card_photo') {
      const fileId = ctx.message.photo?.[ctx.message.photo.length - 1]?.file_id;
      if (fileId) {
        await require('../utils/stateManager').setState(ctx.uid, { type: 'member_card_bio', chatId: _s.chatId, photo: fileId });
        return ctx.reply('✏️ *الخطوة 2/2:* اكتب bio تعريفي عنك\n_(أو . للتخطي)_', { parse_mode: 'Markdown' }).catch(() => {});
      }
    }

    if (ctx.chat?.type !== 'private') return;
    // ✅ اسمح بالمرور لو عنده state معلّق من group_panel (gp_...) حتى لو مو أدمن عام على البوت
    // (التحقق الحقيقي إنه أدمن فذاك القروب بالذات صار مسبقاً فـ group_panel.js عند بداية الخطوة)
    const _pendingState = require('../utils/stateManager').getState(ctx.uid);
    const _hasGpState = _pendingState?.type?.startsWith('gp_');
    if (!ctx.isAdmin && !ctx.isOwner && !_hasGpState) {
      await require('../handlers/forward_organizer').handleForward(ctx).catch(() => {});
      return;
    }
    // owner/admin — لو forward عادي بدون state، جرّب الميزة الجديدة
    {
      const _sChk = require('../utils/stateManager').getState(ctx.uid);
      const _isFwdMedia = !!(ctx.message.forward_from || ctx.message.forward_from_chat || ctx.message.forward_sender_name || ctx.message.forward_date || ctx.message.forward_origin);
      if (_isFwdMedia && !_sChk) {
        const _h = await require('../handlers/forward_organizer').handleForward(ctx).catch(() => false);
        if (_h) return;
      }
    }
    const s = require('../utils/stateManager').getState(ctx.uid);
    if (s?.type === 'mg_bulk_files')   return manage.handleBulkUpload(ctx);
    if (s?.type === 'mg_bundle_files') return manage.handleBundleFileUpload(ctx);
    if (s?.type === 'mg_file')         return manage.handleFileUpload(ctx);
    if (s?.type === 'cg_q_content')     return require('../handlers/game_builder_admin').handleText(ctx, ctx.message.caption || '', s);

    // ── رد تلقائي بوسائط (صورة/فيديو/ستيكر/صوت) ──
    if (s?.type === 'mg_ar_response' && ctx.chat?.type === 'private') {
      const { setState } = require('../utils/stateManager');
      const { run: dbR } = require('../database/db');
      const { cacheDelete } = require('../utils/cache');
      const msg = ctx.message;
      let resp_type = 'text', file_id = null;
      if (msg.sticker)   { resp_type='sticker';  file_id=msg.sticker.file_id; }
      else if (msg.photo)     { resp_type='photo';    file_id=msg.photo[msg.photo.length-1].file_id; }
      else if (msg.video)     { resp_type='video';    file_id=msg.video.file_id; }
      else if (msg.voice)     { resp_type='voice';    file_id=msg.voice.file_id; }
      else if (msg.animation) { resp_type='animation';file_id=msg.animation.file_id; }
      else if (msg.document)  { resp_type='document'; file_id=msg.document.file_id; }
      if (file_id) {
        await dbR(
          'INSERT INTO auto_replies(trigger,response,match_type,resp_type,file_id,created_by) VALUES($1,$2,$3,$4,$5,$6)',
          [s.trigger, msg.caption||'', s.match_type||'contains', resp_type, file_id, ctx.uid]
        ).catch(()=>
          dbR('INSERT INTO auto_replies(trigger,response,match_type,created_by) VALUES($1,$2,$3,$4)',
            [s.trigger, file_id, s.match_type||'contains', ctx.uid])
        );
        try { require('../utils/cache').cacheClear('auto_replies_all'); } catch(_) {}
        setState(ctx.uid, null);
        return ctx.reply('✅ رد تلقائي بـ ' + resp_type + ' أضيف!', { ...require('../utils/keyboard').build([[require('../utils/keyboard').btn('◀️ رجوع','mg_auto_replies')]]) }).catch(()=>{});
      }
      return; // نص عادي — يكمل للمعالج الأصلي في manage.handleText
    }

        if (s?.type === 'mg_tpl_content')  return manage.handleText(ctx, s);
    if (s?.type === 'mg_notify_groups_msg') return manage.handleText(ctx, s);
    if (s?.type?.startsWith('gp_') || s?.type?.startsWith('mg_awaiting')) return groupPanel.handleMedia(ctx, s);
  });

  // ── Text ──
  bot.on('text', async ctx => {
    try {
      if (ctx.message.text.startsWith('/')) return;
      const _tid = 't_' + ctx.message?.message_id + '_' + (ctx.from?.id || '');
      if (isDupMsg(_tid)) return;
      const uid = ctx.uid;
      const _sm = require('../utils/stateManager');
      const s = await (_sm.getStateAsync || _sm.getState)(uid).catch(()=>null);
      if (!s) return;
      const txt = ctx.message.text.trim();

      // ── إضافة سؤال مليون — أولوية عالية ──
      if (s?.type?.startsWith('mq_step')) {
        const gp = require('../handlers/games_panel');
        const handled = await gp.handleText(ctx, s).catch(() => false);
        if (handled) return;
      }

      if (s.type === 'ai_mode' && ctx.chat?.type === 'private') {
        if (txt.length > 1000) return ctx.reply('⚠️ الحد 1000 حرف.').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
        if (ctx.isOwner && await handleOwnerAI(ctx, txt, null, null)) return;
        if (await handleAiChat(ctx, txt)) return;
      }
      if (s.type === 'mg_file')       return manage.handleFileUpload(ctx);
      if (s.type === 'mg_bulk_prefix') return manage.handleText(ctx, s);
      if (s.type === 'mg_bulk_files' && txt !== '/done') return manage.handleText(ctx, s);
      if (s.type === 'mg_tpl_link') {
        await require('../utils/stateManager').setState(ctx.uid, { ...s, type: 'mg_tpl_content', fileId: txt });
        return ctx.reply('✏️ اكتب نص الرسالة (أو skip):').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      }
      if (s.type === 'pending_forward' && ctx.isOwner) {
        const pTrig = /تخصص:|سنة:|فصل:|مادة:|قسم:|spec:|year:|sem:|mat:|cat:/i;
        if (pTrig.test(txt)) {
          const sv = s; await require('../utils/stateManager').delState(ctx.uid);
          const fCtx = Object.assign({}, ctx, { message: Object.assign({}, ctx.message, { document: sv.doc, photo: sv.photo, caption: txt }) });
          if (await tools.trySmartUpload(fCtx)) return;
        }
      }
      if (s.type === 'bundle_search') {
        const rows = await bundlesDb.searchBundles(txt).catch(() => []);
        await require('../utils/stateManager').delState(ctx.uid);
        if (!rows.length) return ctx.reply('❌ لا نتائج لـ "' + txt + '"').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
        const kb = rows.map(b => [kbBtn('📦 ' + b.name, 'bundle_view_' + b.id)]);
        return eos(ctx, '🔍 نتائج: ' + rows.length, { ...kbBuild(kb) });
      }
      if (s.type === 'mg_bundle_create') {
        if (!ctx.isAdmin) { await require('../utils/stateManager').delState(ctx.uid); return; }
        const name = txt.trim();
        if (!name) return ctx.reply('❌ الاسم فارغ').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
        const b = await bundlesDb.createBundle(name, null, null);
        await require('../utils/stateManager').setState(ctx.uid, { type: 'mg_bundle_files', bundleId: b.id, fileCount: 0 });
        return ctx.reply('✅ تم إنشاء الحزمة: *' + name + '*\n\nأرسل الملفات الآن.\n/done للإنهاء', { parse_mode: 'Markdown' }).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      }
      if (s.type === 'search')      return userH.handleSearch(ctx, txt);
      // 💳 البطاقة الشخصية
      if (s.type === 'member_card_word') {
        const chatId = s.chatId;
        const word = txt?.trim();
        if (!word || word.length < 1 || word.length > 25) {
          return ctx.reply('⚠️ الكلمة بين 1 و25 حرف').catch(() => {});
        }
        if (word.startsWith('/') || word.startsWith('@')) {
          return ctx.reply('⚠️ الكلمة لا تبدأ بـ / أو @').catch(() => {});
        }
        const uid = ctx.uid || ctx.from.id;
        const firstName = ctx.from.first_name || 'عضو';
        const username = ctx.from.username || null;

        // جيب صورة البروفايل
        let photoFileId = null;
        try {
          const photos = await ctx.telegram.getUserProfilePhotos(uid, { limit: 1 });
          if (photos && photos.total_count > 0 && photos.photos[0]) {
            const photoArr = photos.photos[0];
            photoFileId = photoArr[photoArr.length - 1].file_id;
          }
        } catch(_) {}
        // إذا ما أعطى صورة — جرب من avatar المستخدم
        if (!photoFileId) {
          try {
            const member = await ctx.telegram.getChatMember(chatId, uid);
            if (member?.user?.photo?.big_file_id) photoFileId = member.user.photo.big_file_id;
          } catch(_) {}
        }

        // جيب bio من تيليجرام
        let bio = null;
        try {
          const userChat = await ctx.telegram.getChat(uid);
          bio = userChat.bio || null;
        } catch(_) {}

        const { run: _run } = require('../database/db');

        // إنشاء الجداول
        await _run(`CREATE TABLE IF NOT EXISTS member_cards (
          chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL,
          trigger_word TEXT, photo_file_id TEXT, bio TEXT,
          username TEXT, first_name TEXT, updated_at TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY(chat_id, user_id))`).catch(() => {});
        await _run(`CREATE TABLE IF NOT EXISTS member_card_triggers (
          chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL, trigger_word TEXT NOT NULL,
          PRIMARY KEY(chat_id, trigger_word))`).catch(() => {});

        // احفظ البطاقة
        await _run(
          `INSERT INTO member_cards(chat_id,user_id,trigger_word,photo_file_id,bio,username,first_name)
           VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(chat_id,user_id) DO UPDATE SET
           trigger_word=$3,photo_file_id=$4,bio=$5,username=$6,first_name=$7,updated_at=NOW()`,
          [chatId, uid, word.toLowerCase(), photoFileId, bio, username, firstName]
        ).catch(() => {});

        // احفظ الـ trigger
        await _run(
          `INSERT INTO member_card_triggers(chat_id,user_id,trigger_word) VALUES($1,$2,$3)
           ON CONFLICT(chat_id,trigger_word) DO UPDATE SET user_id=$2`,
          [chatId, uid, word.toLowerCase()]
        ).catch(() => {});

        await require('../utils/stateManager').delState(uid);

        const confirmText =
          '✅ *تم حفظ بطاقتك!*\n\n' +
          '🔑 الكلمة: *' + word + '*\n' +
          (bio ? '📝 Bio: ' + bio + '\n' : '') +
          (photoFileId ? '📸 الصورة: محفوظة\n' : '') +
          '\nلما أحد يكتب *' + word + '* ستظهر بطاقتك!';

        if (photoFileId) {
          return ctx.replyWithPhoto(photoFileId, { caption: confirmText, parse_mode: 'Markdown' }).catch(() => {});
        }
        return ctx.reply(confirmText, { parse_mode: 'Markdown' }).catch(() => {});
      }

      if (s.type === 'member_card_photo') {
        const chatId = s.chatId;
        if (txt === '.') {
          await require('../utils/stateManager').setState(ctx.uid, { type: 'member_card_bio', chatId, photo: null });
          return ctx.reply('✏️ *الخطوة 2/2:* اكتب bio تعريفي عنك\n_(أو . للتخطي)_', { parse_mode: 'Markdown' }).catch(() => {});
        }
        return ctx.reply('📸 أرسل صورة أو اكتب . للتخطي').catch(() => {});
      }
      if (s.type === 'member_card_bio') {
        const chatId = s.chatId;
        const bio = txt === '.' ? null : txt.substring(0, 150);
        const { run: _run } = require('../database/db');
        await _run(
          `INSERT INTO member_cards(chat_id, user_id, photo_file_id, bio, username, first_name)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(chat_id, user_id) DO UPDATE SET bio=$4, username=$5, first_name=$6, updated_at=NOW()`,
          [chatId, ctx.uid, s.photo || null, bio, ctx.from.username || null, ctx.from.first_name || 'عضو']
        ).catch(() => {});
        await require('../utils/stateManager').delState(ctx.uid);
        return ctx.reply(
          '✅ *تم حفظ بطاقتك!*\n\nلما أحد يكتب اسمك في القروب سيظهر ردك تلقائياً.',
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }

      if (s.type === 'add_comment') {
        if (!txt || txt === '/cancel') { await require('../utils/stateManager').delState(ctx.uid); return ctx.reply('❌ تم الإلغاء.').catch(err => { require('../utils/logger').debug("[silent]", err.message); }); }
        if (txt.length > 500) return ctx.reply('⚠️ الحد 500 حرف.').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
        await commentsDb.addComment(s.fid, ctx.uid, txt);
        await require('../utils/stateManager').delState(ctx.uid);
        cacheClear('cmts_' + s.fid + '_0'); cacheClear('cmts_' + s.fid + '_1');
        await ctx.reply('✅ تم إضافة تعليقك!').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
        try {
          const _cf = await filesDb.getFile(s.fid);
          if (_cf) ctx.telegram.sendMessage(OWNER_ID, '💬 *تعليق جديد*\n📄 ' + _cf.title + '\n👤 ' + (ctx.from.first_name || '') + '\n\n' + txt.substring(0, 300), { parse_mode: 'Markdown' }).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
        } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
        return browse.showComments(ctx, s.fid, s.spId, s.yrId, s.smId, s.sbId, s.catId);
      }
      if (s?.type === 'admin_contact') return manage.handleText(ctx, s);
      if (s?.type && s.type.startsWith('mq_wizard')) {
        require('../utils/logger').info('[wizard] type=' + s.type + ' uid=' + (ctx.uid||ctx.from?.id));
        return manage.handleText(ctx, s);
      }
      if ((s?.type || '').startsWith('mg_') && (ctx.isAdmin || ctx.isOwner)) return manage.handleText(ctx, s);
      if ((s?.type || '').startsWith('gp_')) return groupPanel.handleText(ctx, txt, s);
      if ((s?.type || '').startsWith('gm_')) return require('../handlers/group_members_panel').handleText(ctx, txt, s);
      if ((s?.type || '').startsWith('cg_')) return require('../handlers/game_builder_admin').handleText(ctx, txt, s);
      if ((s?.type || '').startsWith('gpx_')) {
        const handled = await require('../handlers/group_pro_panel').handleText(ctx, txt, s).catch(() => false);
        if (handled !== false) return;
      }
      if (s?.type === 'million_add_q' || s?.type === 'million_del_q') {
        const gamesPanel = require('../handlers/games_panel');
        return gamesPanel.handleText(ctx, txt, s);
      }
      // ── ألعاب panel — mq_step_* و gp_million* و gp_guess* ──
      if (s?.type?.startsWith('mq_step') || s?.type?.startsWith('gp_million') || s?.type?.startsWith('gp_guess')) {
        const handled = await require('../handlers/games_panel').handleText(ctx).catch(() => false);
        if (handled) return;
      }
    } catch(e) { logger.error('[TextHandler]', e.message, { uid: ctx.from?.id }); }
  });

  // ── Chat member changes ──
  bot.on('my_chat_member', async ctx => {
    const chat = ctx.myChatMember?.chat, member = ctx.myChatMember?.new_chat_member, oldMember = ctx.myChatMember?.old_chat_member;
    if (!chat || chat.type === 'private') return;
    if (!global._cachedBotId) { try { global._cachedBotId = (await ctx.telegram.getMe()).id; } catch(_) { return; } }
    if (member?.user?.id !== global._cachedBotId) {
      if (oldMember?.status === 'left' && member?.status !== 'left') {
        // handleNewMember called via chat_member event below
      }
      return;
    }
    if (['member', 'administrator'].includes(member?.status)) {
      try {
        await dbRun('INSERT INTO group_chats(chat_id,title) VALUES($1,$2) ON CONFLICT(chat_id) DO UPDATE SET title=EXCLUDED.title', [chat.id, chat.title || '']);
        const sp = await dbAll('SELECT id,name FROM specialties WHERE is_deleted=0 ORDER BY id');
        // تم نقل رسالة الترحيب للخاص
        // رسالة الترحيب محذوفة
      } catch(e) { if (!e.message?.includes('TOPIC_CLOSED')) logger.error('[GrpJoin]', e.message); }
    } else if (['left', 'kicked'].includes(member?.status)) {
      await Promise.all([
        dbRun('DELETE FROM group_chats WHERE chat_id=$1',  [chat.id]).catch(err => { require('../utils/logger').debug("[silent]", err.message); }),
        dbRun('DELETE FROM group_members WHERE chat_id=$1', [chat.id]).catch(err => { require('../utils/logger').debug("[silent]", err.message); }),
      ]);
    }
  });

  // ── Inline Query ──
  // ── Stickers ──

  bot.on('chat_member', async ctx => {
    try {
      const chat   = ctx.chatMember?.chat;
      const member = ctx.chatMember?.new_chat_member;
      const old    = ctx.chatMember?.old_chat_member;
      if (!chat || chat.type === "private") return;
      if (member?.user?.is_bot) {
        // ✅ نسجّل البوتات فـ group_members (is_bot=1) باش تظهر لأوامر كشف/طرد البوتات
        // بلا ما نفعّل عليهم ترحيب/تحقق/anti-raid (هذا سلوك صحيح ويبقى كيفما هو)
        const u = member.user;
        const { run: _runBot } = require('../database/db');
        if (['member', 'restricted', 'administrator', 'creator'].includes(member.status)) {
          _runBot(
            `INSERT INTO group_members(chat_id,user_id,username,first_name,is_bot,updated_at)
             VALUES($1,$2,$3,$4,1,CURRENT_TIMESTAMP)
             ON CONFLICT(chat_id,user_id) DO UPDATE
               SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, is_bot=1, updated_at=CURRENT_TIMESTAMP`,
            [chat.id, u.id, u.username || '', u.first_name || 'بوت']
          ).catch(() => {});
        } else if (['left', 'kicked'].includes(member.status)) {
          _runBot('DELETE FROM group_members WHERE chat_id=$1 AND user_id=$2', [chat.id, u.id]).catch(() => {});
        }
        return;
      }
      const wasOut = ["left","kicked"].includes(old?.status);
      const isIn   = ["member","restricted","administrator","creator"].includes(member?.status);
      const isOut  = ["left","kicked"].includes(member?.status);
      if (wasOut && isIn) {
        // 🌊 Anti-Raid
        require('../handlers/group_extras').checkAntiRaid(bot, chat.id, member.user.id).catch(() => {});
        // 🛑 فحص الحظر العالمي
        const gbanned = await require('../handlers/group_pro_features').checkGban(bot, chat.id, member.user.id).catch(() => false);
        if (gbanned) return;
        const settings = await require('../handlers/group_protection').getSettings(chat.id).catch(() => null);
        if (settings?.verify_enabled) {
          require('../handlers/group_verify').startVerification(bot, chat.id, member.user).catch(() => {});
        } else {
          const { handleNewMember } = require('../handlers/group_admin');
          handleNewMember(bot, chat.id, member.user.id, member.user.first_name).catch(() => {});
        }
      }
      if (!wasOut && isOut) {
        const { handleMemberLeft } = require('../handlers/group_admin');
        handleMemberLeft(bot, chat.id, member.user.id, member.user.first_name).catch(() => {});
      }
    } catch(e) {}
  });
  bot.on('sticker', async ctx => {
    {
      const _gmS = require('../utils/stateManager').getState(ctx.uid);
      if (_gmS?.type === 'gm_dm') {
        require('../utils/stateManager').delState(ctx.uid);
        try {
          await ctx.telegram.copyMessage(_gmS.targetUserId, ctx.chat.id, ctx.message.message_id);
          await ctx.reply('✅ تم إرسال الرسالة.').catch(() => {});
        } catch (e) {
          await ctx.reply('❌ ما قدرتش نبعت الرسالة (يمكن العضو ما بداش محادثة مع البوت).').catch(() => {});
        }
        return;
      }
    }
    if (ctx.chat?.type !== 'private') return;
    const s = require('../utils/stateManager').getState(ctx.uid);
    if (s?.type === 'cg_q_content') return require('../handlers/game_builder_admin').handleText(ctx, '', s);
    // إذا كان في وضع إضافة رد تلقائي — احفظ الستيكر
    if (s?.type === 'mg_ar_response' && ctx.chat?.type === 'private') {
      const { setState } = require('../utils/stateManager');
      const { run: dbR } = require('../database/db');
      const file_id = ctx.message.sticker?.file_id;
      if (file_id) {
        let _arErr2 = null;
        await dbR(
          'INSERT INTO auto_replies(trigger,response,match_type,resp_type,file_id,created_by) VALUES($1,$2,$3,$4,$5,$6)',
          [s.trigger, '', s.match_type||'contains', 'sticker', file_id, ctx.uid]
        ).catch(async e1 => {
          try {
            await dbR('INSERT INTO auto_replies(trigger,response,match_type,created_by) VALUES($1,$2,$3,$4)',
              [s.trigger, file_id, s.match_type||'contains', ctx.uid]);
          } catch (e2) { _arErr2 = e2; }
        });
        require('../utils/cache').cacheClear('auto_replies_all');
        setState(ctx.uid, null);
        if (_arErr2) {
          return ctx.reply('❌ فشل حفظ رد الستيكر!\n\nالخطأ:\n' + _arErr2.message, {
            reply_markup: { inline_keyboard: [[{ text: '◀️ رجوع', callback_data: 'mg_auto_replies' }]] }
          }).catch(() => {});
        }
        return ctx.reply('✅ رد تلقائي بستيكر أضيف!', {
          reply_markup: { inline_keyboard: [[{ text: '◀️ رجوع', callback_data: 'mg_auto_replies' }]] }
        }).catch(() => {});
      }
    }
    if (s?.type?.startsWith('gp_') || s?.type?.startsWith('mg_awaiting')) return groupPanel.handleMedia(ctx, s);
  });

  bot.on('inline_query', async ctx => {
    const q = (ctx.inlineQuery?.query || '').trim();
    if (q.length < 2) { ctx.answerInlineQuery([], { cache_time: 5 }); return; }
    try {
      const { smartSearch } = require('../handlers/group');
      const res = await smartSearch(q, 10);
      if (!res?.length) { ctx.answerInlineQuery([], { cache_time: 5 }); return; }
      // جلب username البوت مرة واحدة + تخزينه
      if (!global._cachedBotUsername) {
        try { global._cachedBotUsername = (await ctx.telegram.getMe()).username; } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
      }
      const un = global._cachedBotUsername;
      const results = res.map(f => {
        const dlLink = un ? `https://t.me/${un}?start=file_${f.id}` : null;
        const txt = '📄 *' + f.title + '*' +
          (f.sub_name ? '\n📚 ' + f.sub_name : '') +
          (dlLink ? '\n\n🔽 [تحميل مباشر](' + dlLink + ')' : '');
        return {
          type: 'article', id: String(f.id),
          title: f.title,
          description: (f.sub_name || '') + (f.cat_name ? ' · ' + f.cat_name : ''),
          thumb_url: 'https://telegram.org/img/t_logo.png',
          input_message_content: {
            message_text: txt,
            parse_mode: 'Markdown'
          },
          reply_markup: dlLink ? {
            inline_keyboard: [[{ text: '📥 تحميل', url: dlLink }]]
          } : undefined
        };
      });
      ctx.answerInlineQuery(results, { cache_time: 30 });
    } catch(_) { ctx.answerInlineQuery([], { cache_time: 5 }); }
  });
};
// placeholder
