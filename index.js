'use strict';

require('dotenv').config();
require('./utils/validateEnv').validateEnv();

const { Telegraf }    = require('telegraf');
const express         = require('express');
const compression     = require('compression');
const helmet          = require('helmet');
const logger          = require('./utils/logger');
const { res: cbRes }  = require('./utils/cbRegistry');
const { initSchema, getSetting, run: dbRun, all: dbAll, get: dbGet, getPg } = require('./database/db');
const { authMiddleware, OWNER_ID } = require('./middlewares/auth');
const { loadAllStates }   = require('./utils/redis');
const { cacheWarmup, cacheClear, cacheClearPrefix } = require('./utils/cache');
const { startScheduler }  = require('./utils/scheduler');
const { initPersistentStates } = require('./utils/stateManager');
const { CBDedup, GrpBuf, GrpMsgs } = require('./bot/services');

// ── Handlers ──
const startHandler  = require('./handlers/start');
const manage        = require('./handlers/manage');
const browse        = require('./handlers/browse');
const userH         = require('./handlers/user');
const million       = require('./handlers/million');
const millionaire   = require('./handlers/millionaire');
const guessGame     = require('./handlers/guess_game');
const tools         = require('./handlers/owner_tools');
const bank          = require('./handlers/bank');
const bankPro       = require('./handlers/bank_pro');
const music         = require('./handlers/music');
const ownerH        = require('./handlers/owner');
const contentDb     = require('./database/content');
const usersDb       = require('./database/users');
const bundlesDb     = require('./database/bundles');
const commentsDb    = require('./database/comments');
const interactions  = require('./database/interactions');
const adminsDb      = require('./database/admins');
const filesDb       = require('./database/files');
const { handleAiChat, resetChat } = require('./handlers/ai_chat');
const { handleOwnerAI }           = require('./handlers/ai_owner');
const { smartSearch }             = require('./handlers/group');
const { handleNewMember, handleMemberLeft, showAllMembers, tagAll, muteAll, unmuteAll, showGroupStats, warnMember, banMember, unbanMember, muteMember, unmuteMember } = require('./handlers/group_admin');
const { setupGroupCommands, handleSettingsCallback } = require('./handlers/group_commands');
const { migrateGroupTables } = require('./database/group_db');
const groupBroadcast = require('./utils/groupBroadcast');
const { btn: kbBtn, build: kbBuild } = require('./utils/keyboard');
const { eos } = require('./utils/helpers');

// ── Config ──
const TOKEN          = process.env.BOT_TOKEN;
if (!TOKEN) { logger.error('FATAL: BOT_TOKEN missing'); process.exit(1); }
const WEBHOOK_URL    = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const PORT           = parseInt(process.env.PORT) || 3000;
const safeInt = v => { const n = parseInt(v); return isNaN(n) ? 0 : n; };

// ── maintenanceMode — module-level (لا global) ──
let maintenanceMode = false;
setInterval(async () => {
  try {
    const { cacheGet, cacheSet } = require('./utils/cache');
    let val = cacheGet('_maint_mode');
    if (val === null) {
      val = (await getSetting('maintenance')) === 'true';
      cacheSet('_maint_mode', val, 30000);
    }
    maintenanceMode = !!val;
  } catch(_) {}
}, 30000).unref();

// expose للـ middlewares التي تحتاجه
Object.defineProperty(global, 'maintenanceMode', {
  get: () => maintenanceMode,
  set: v => { maintenanceMode = !!v; },
  configurable: true,
});

// ── Express ──
const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"],
  scriptSrc:  ["'self'", "'unsafe-inline'", 'telegram.org', '*.telegram.org'],
  scriptSrcAttr: ["'unsafe-inline'"], // ✅ يسمح بأزرار onclick="..." (كانت محظورة بصمت بدون هذا السطر)
  styleSrc:   ["'self'", "'unsafe-inline'"],
  imgSrc:     ["'self'", 'data:', 'https:'],
  connectSrc: ["'self'", 'https://api.telegram.org'],
}}}));
app.use(compression({ level: 6, threshold: 512 }));
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') {
    res.set('Cache-Control', 'private, max-age=10');
    res.set('Vary', 'Accept-Encoding');
  }
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(require('path').join(__dirname, 'public'), {
  etag: false, maxAge: 0,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'),
}));
app.set('trust proxy', 1);
app.get('/', (_r, res) => res.send('OK'));

// ── Bot ──
const bot = new Telegraf(TOKEN, {
  handlerTimeout: 90000,
  telegram: { apiRoot: process.env.TELEGRAM_API_ROOT || undefined },
});
global.__bot = bot; // ✅ يُستخدم من routes/api.js وworkers وhandlers/xp.js للوصول للبوت خارج سياق ctx — كان غير معرَّف إطلاقاً

// ── Rate Limiter ──
const _floodMap = new Map();
setInterval(() => {
  const cut = Date.now() - 60000;
  for (const [k, v] of _floodMap) if (v.t < cut) _floodMap.delete(k);
}, 60000).unref();

const rateLimit = (ctx, next) => {
  const uid = ctx.from?.id;
  if (!uid) return next();
  if (ctx.isOwner || ctx.isAdmin) return next();
  const now = Date.now();
  let u = _floodMap.get(uid);
  if (!u || now - u.t > 2000) {
    _floodMap.set(uid, { c: 1, t: now });
    return next();
  }
  u.c++;
  if (u.c > 4) {
    if (u.c === 5 && ctx.callbackQuery)
      ctx.answerCbQuery('⚠️ إبطاء قليلاً...', { show_alert: false }).catch(() => {});
    return;
  }
  return next();
};

// ══════════════════════════════════════════
// FIX 1: تحقق هل البوت أدمن — middleware مستقل على المستوى الأعلى
// (كان متداخل داخل bot.use آخر = memory leak + double processing)
// ══════════════════════════════════════════
// ⚡ PERF FIX: كاش 5 دقائق لحالة "البوت أدمن" — كان getChatMember يُستدعى (رحلة شبكة
// كاملة لتيليجرام) على *كل* أمر '/' بكل قروب بدون أي كاش. نفس مدة الكاش المستخدمة
// لفحوصات الأدمن الأخرى بالمشروع (utils/adminCache.js، group_protection.js).
// يتحدّث فوراً عند ترقية/إزالة البوت عبر my_chat_member (شوف launch() تحت).
const { cacheGet: _bacGet, cacheSet: _bacSet } = require('./utils/cache');
const botAdminCheck = async (ctx, next) => {
  if (!['group', 'supergroup'].includes(ctx.chat?.type)) return next();
  if (!ctx.message?.text?.startsWith('/')) return next();
  const _bacKey = 'botadm_' + ctx.chat.id;
  try {
    let isAdm = _bacGet(_bacKey);
    if (isAdm === null) {
      const me = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id);
      isAdm = (me.status === 'administrator' || me.status === 'creator');
      _bacSet(_bacKey, isAdm, 300000);
    }
    if (isAdm) return next();
    const botUn = ctx.botInfo?.username || '';
    await ctx.reply(
      '⚠️ أنا لست مشرفاً في هذا القروب!\n\nلكي تعمل الأوامر بشكل صحيح، يرجى إضافتي كمشرف 👇',
      {
        reply_to_message_id: ctx.message?.message_id,
        reply_markup: { inline_keyboard: [[
          { text: '➕ أضفني كمشرف', url: 'https://t.me/' + botUn + '?startgroup=admin' },
        ]]},
      }
    ).catch(() => {});
    return;
  } catch(_) { return next(); }
};

const { all: _dbAll } = require('./database/db');
const { cacheGet: _cGet, cacheSet: _cSet } = require('./utils/cache');

// ══════════════════════════════════════════
// FIX 2: Auto-Reply + حماية القروب — middleware مستقل (لا nested bot.use)
// ══════════════════════════════════════════
const groupProtectionMiddleware = async (ctx, next) => {
  if (ctx.chat?.type === 'private' || !ctx.message || !ctx.from) return next();

  const uid = ctx.from.id;
  const cid = ctx.chat.id;
  const txt = ctx.message?.text || ctx.message?.caption || '';
  const now = Date.now();

  // 🎮 Game Builder System
  if (ctx.message?.text) {
    const gb = require('./handlers/game_builder');
    gb.checkAnswerReveal(ctx).catch(() => {});
    gb.checkGameSkip(ctx).catch(() => {});
    gb.checkGameAnswer(ctx).catch(() => {});
    gb.checkGameTrigger(ctx).catch(() => {});
  }

  // 🤖 Auto-Reply
  const _isGameMsg = /^(تخمين[:\s]|خمن$|خمن |انا$|مليون$)/i.test(txt.trim())
    || txt.trim() === 'خمن' || txt.trim() === 'مليون';
  const _uid4ar  = ctx.from?.id;
  const _state4ar = _uid4ar ? require('./utils/stateManager').getState(_uid4ar) : null;
  const _inArMode = _state4ar?.type?.startsWith('mg_ar') || _state4ar?.type?.startsWith('mg_awaiting');

  if (txt && txt.length > 0 && !_isGameMsg && !_inArMode) {
      // فحص إذا الردود موقوفة في هذا القروب
      const _arDisKey = 'auto_reply_disabled_' + cid;
      let _arDis = _cGet(_arDisKey);
      if (_arDis === null) {
        const { get: _dbGet } = require('./database/db');
        const _row = await _dbGet('SELECT value FROM settings WHERE key=$1', [_arDisKey]).catch(() => null);
        _arDis = _row?.value === '1' ? 1 : 0;
        _cSet(_arDisKey, _arDis, 86400000);
      }
      if (_arDis === 1) return next();

    // تجاهل الردود التلقائية لكلمات الألعاب
    const _gameWords = ['دول','xo','مليون','خمن','لوب غارو','werewolf','Xo','XO'];
    if (_gameWords.some(w => txt.toLowerCase() === w.toLowerCase())) return next();

    const arKey = 'auto_replies_all';
    let arList = _cGet(arKey);
    if (!arList) {
      arList = await _dbAll('SELECT * FROM auto_replies WHERE is_active=1').catch(() => []);
      _cSet(arKey, arList, 120000);
    }
    const matched = [];
    for (const ar of arList) {
      try {
        let isMatch = false;
        if (ar.match_type === 'regex') {
          isMatch = new RegExp(ar.trigger, 'i').test(txt);
        } else if (ar.match_type === 'exact') {
          isMatch = txt.toLowerCase() === ar.trigger.toLowerCase();
        } else {
          // مطابقة كلمة كاملة (word boundary) بدل substring — يمنع "لا" من مطابقة "بوسسيلا"
          const escaped = ar.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          isMatch = new RegExp('(^|\\s)' + escaped + '($|\\s|[.,!?؟،])', 'i').test(txt);
        }
        if (isMatch) matched.push(ar);
      } catch(_) {
        if (txt.toLowerCase() === ar.trigger.toLowerCase()) matched.push(ar);
      }
    }
    if (matched.length > 0) {
      const pick   = matched[Math.floor(Math.random() * matched.length)];
      const _rtype = pick.resp_type || 'text';
      const _fid   = pick.file_id;
      const _opts  = { reply_to_message_id: ctx.message.message_id };
      if      (_rtype === 'sticker'   && _fid) ctx.telegram.sendSticker(ctx.chat.id, _fid, _opts).catch(() => {});
      else if (_rtype === 'photo'     && _fid) ctx.telegram.sendPhoto(ctx.chat.id, _fid, { ..._opts, caption: pick.response || undefined, parse_mode: 'Markdown' }).catch(() => {});
      else if (_rtype === 'video'     && _fid) ctx.telegram.sendVideo(ctx.chat.id, _fid, { ..._opts, caption: pick.response || undefined, parse_mode: 'Markdown' }).catch(() => {});
      else if (_rtype === 'voice'     && _fid) ctx.telegram.sendVoice(ctx.chat.id, _fid, { ..._opts, caption: pick.response || undefined }).catch(() => {});
      else if (_rtype === 'animation' && _fid) ctx.telegram.sendAnimation(ctx.chat.id, _fid, { ..._opts, caption: pick.response || undefined, parse_mode: 'Markdown' }).catch(() => {});
      else if (_rtype === 'document'  && _fid) ctx.telegram.sendDocument(ctx.chat.id, _fid, { ..._opts, caption: pick.response || undefined, parse_mode: 'Markdown' }).catch(() => {});
      else ctx.reply(pick.response, { reply_to_message_id: ctx.message.message_id, parse_mode: 'Markdown' }).catch(() => {});
    }
  }

  // 😀 Auto React
  if (txt && ['group','supergroup'].includes(ctx.chat?.type)) {
    try {
      let _reactList = _cGet('auto_reactions_all');
      if (!_reactList) {
        _reactList = await _dbAll('SELECT trigger, emoji FROM auto_reactions WHERE is_active=1').catch(()=>[]);
        _cSet('auto_reactions_all', _reactList, 60000);
      }
      for (const r of _reactList) {
        if (txt.toLowerCase().includes(r.trigger.toLowerCase())) {
          ctx.telegram.setMessageReaction(
            ctx.chat.id, ctx.message.message_id,
            [{ type: 'emoji', emoji: r.emoji }]
          ).catch(()=>{});
          break;
        }
      }
    } catch(_) {}
  }

  // 🌙 فحص AFK (لا يحظر التدفّق — fire & forget، يشمل الأدمنز أيضاً)
  try { require('./handlers/fun_commands').checkAfkOnMessage(ctx).catch(() => {}); } catch (_) {}

  // 📊 تسجيل نشاط الرسائل (للإحصائيات)
  if (ctx.from?.id && ctx.chat?.id) {
    // 👁 مراقبة الأعضاء (fire & forget)
    require('./handlers/group_schedule').runWatchMiddleware(
      bot, cid, uid, ctx.from.first_name,
      ctx.message?.text || ctx.message?.caption || '',
      ctx.message?.message_id
    ).catch(() => {});
    // 📊 تتبع عدد الرسائل (+ username صار يُحفظ هنا، شوف ملاحظة PERF FIX بـ trackMsg)
    require('./handlers/group_pro_features').trackMsg(cid, uid, ctx.from.first_name, ctx.from.username).catch(() => {});
  }

  // حماية الأدمنز من فلاتر الحماية
  if (ctx.isAdmin || ctx.isOwner) return next();

  // 🛡️ نظام الحماية الاحترافي
  try {
    const approved = await require('./handlers/group_pro_features').isApproved(cid, uid).catch(() => false);
    if (!approved) {
      const handled = await require('./handlers/group_protection').runProtection(ctx);
      if (handled) return;
    }
  } catch (e) { logger.error('[Protection] ' + e.message); }

  // 🎯 فلاتر ذكية (يعمل بعد الحماية فقط)
  try {
    const filtered = await require('./handlers/group_filters').checkFilters(ctx);
    if (filtered) return;
  } catch (e) { logger.error('[Filters] ' + e.message); }

  return next();
};

// ══════════════════════════════════════════
// FIX 3: Middleware الألعاب والبنك — trigger واحد فقط لكل أمر
// (حذف النسخ المكررة من bot.on('message') لاحقاً)
// ══════════════════════════════════════════
const gameAndBankMiddleware = async (ctx, next) => {
  const isGroup = ['group', 'supergroup'].includes(ctx.chat?.type);
  const txt     = (ctx.message?.text || '').trim();

  if (isGroup && ctx.message) {
    if (/^خمن$/i.test(txt))           return guessGame.startInvite(ctx).catch(() => next());
    if (/^(العاب|الالعاب)$/i.test(txt)) {
      try { await require('./handlers/group_commands').showGamesMenu(ctx); return; } catch(_) {}
    }
    if (/^تخمين[:\s:]+/i.test(txt)) {
      const handled = await guessGame.handleGuessMsg(ctx).catch(() => false);
      if (handled) return;
    }
    if (/^[أاآ]نا$/i.test(txt))       return guessGame.handleJoin(ctx).catch(() => next());

    // FIX: مليون — trigger واحد فقط هنا، محذوف من bot.on('message')
    if (/^مليون$/i.test(txt)) {
      try { await millionaire.startJoinPhase(ctx); return; }
      catch(e) { logger.error('[Million]', e.message); }
    }

    // البنك
    // bank.js القديم محذوف — استخدم bank_pro.js

    // 🌍 لعبة الدول
    if (/^دول$/i.test(txt)) {
      return require('./handlers/countries_game').startGame(ctx).catch(() => next());
    }

    // 🎮 لعبة XO
    if (/^xo$/i.test(txt) || /^XO$/i.test(txt)) {
      return require('./handlers/xo').startGame(ctx).catch(() => next());
    }

    // 🎵 البحث عن الأغاني
    if (/^🎵\s+.+/i.test(txt) || /^موسيقى\s+.+/i.test(txt) || /^اغنية\s+.+/i.test(txt) || /^أغنية\s+.+/i.test(txt)) {
      return music.handleSearch(ctx).catch(e => { console.error('[Music trigger]', e.message, e.stack); return ctx.reply('❌ خطأ: ' + e.message).catch(()=>{}); });
    }

        // 🏦 Taline Bank
    if (/^حسابي$/i.test(txt))                     return bankPro.showWalletNoButtons(ctx).catch(() => next());
    if (/^فلوسي$/i.test(txt))                     return bankPro.showBalance(ctx).catch(() => next());
    if (/^بنك$/i.test(txt))                       return bankPro.openAccount(ctx).catch(() => next());
    if (/^محفظتي$/i.test(txt))                    return bankPro.showWallet(ctx).catch(() => next());
    if (/^بطاقتي$/i.test(txt))                    return bankPro.showCard(ctx).catch(() => next());
    if (/^كشف$/i.test(txt))                       return bankPro.showStatement(ctx).catch(() => next());
    if (/^تحويل\s+\d/i.test(txt))                return bankPro.transfer(ctx).catch(() => next());
    if (/^قرض(\s+\d.*)?$/i.test(txt))            return bankPro.requestLoan(ctx).catch(() => next());
    if (/^ديوني$/i.test(txt))                     return bankPro.showLoans(ctx).catch(() => next());
    if (/^سداد$/i.test(txt))                      return bankPro.repayLoan(ctx).catch(() => next());
    if (/^استثمار(\s+\d.*)?$/i.test(txt))        return bankPro.invest(ctx).catch(() => next());
    if (/^سحب استثمار$/i.test(txt))               return bankPro.withdrawInvest(ctx).catch(() => next());
    if (/^(الاثرياء|أثرياء|اثرياء)$/i.test(txt)) return bankPro.richList(ctx).catch(() => next());
  }

  // 📊 تصويت — في الخاص فقط
  if (!isGroup && ctx.chat?.type === 'private') {
    const _pollHandled = await require('./handlers/poll_system').handleDraft(ctx).catch(() => false);
    if (_pollHandled) return;
  }

  // 📥 تنظيم النصوص المُعاد توجيهها — في الخاص فقط، وليس لصاحب البوت أو الأدمن
  if (!isGroup && ctx.chat?.type === 'private' && !ctx.isAdmin && !ctx.isOwner) {
    const _fwdTxtHandled = await require('./handlers/forward_organizer').handleForward(ctx).catch(() => false);
    if (_fwdTxtHandled) return next();
  }

  // PV لعبة خمن
  if (!isGroup && ctx.chat?.type === 'private') {
    const uid = String(ctx.from?.id || '');
    if (guessGame.hasPvState(uid)) {
      return guessGame.handlePvDirect(ctx).catch(e => {
        logger.error('[GuessGame PV]', e.message);
        return next();
      });
    }
  }

  return next();
};

// ── تسجيل middleware بالترتيب الصحيح ──
// TIMING: measures callback_query round-trip time, logs to console.
bot.use(async (ctx, next) => {
  if (ctx.callbackQuery) {
    const _t0 = Date.now();
    await next();
    const _ms = Date.now() - _t0;
    console.log('[TIMING] callback "' + ctx.callbackQuery.data + '" -> ' + _ms + 'ms');
  } else {
    await next();
  }
});
bot.use(rateLimit);

// 🏗 إنشاء جداول member cards عند البدء
setTimeout(async () => {
  try {
    await dbRun(`CREATE TABLE IF NOT EXISTS member_cards (
      chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL,
      trigger_word TEXT, photo_file_id TEXT, bio TEXT,
      username TEXT, first_name TEXT, updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY(chat_id, user_id))`);
    await dbRun(`CREATE TABLE IF NOT EXISTS member_card_triggers (
      chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL, trigger_word TEXT NOT NULL,
      PRIMARY KEY(chat_id, trigger_word))`);
    logger.info('[MemberCards] ✅ Tables ready');
    // جداول gpq_approve
    await dbRun(`CREATE TABLE IF NOT EXISTS group_approved (
      chat_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      approved_by BIGINT,
      approved_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY(chat_id, user_id)
    )`).catch(() => {});
    await dbRun(`CREATE TABLE IF NOT EXISTS group_protection_stats (
      chat_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      violations INT DEFAULT 0,
      last_violation TIMESTAMP,
      PRIMARY KEY(chat_id, user_id)
    )`).catch(() => {});
  } catch(e) { logger.error('[MemberCards]', e.message); }
}, 3000);

// 🧹 مسح كل الردود مؤقت
bot.command('clear_cards', async ctx => {
  if (String(ctx.from?.id) !== String(process.env.OWNER_ID)) return ctx.reply('🚫').catch(() => {});
  await dbRun('DELETE FROM member_cards').catch(() => {});
  await dbRun('DELETE FROM member_card_triggers').catch(() => {});
  ctx.reply('✅ تم مسح كل الردود').catch(() => {});
});

// 🤖 حالة UserBot — Owner فقط
bot.command('userbot_status', async ctx => {
  if (String(ctx.from?.id) !== String(process.env.OWNER_ID)) return ctx.reply('🚫').catch(() => {});
  const { getUserbotStatus } = require('./routes/internal');
  const s = getUserbotStatus();
  if (!s.online) {
    const ago = s.secondsAgo === null ? 'لا يوجد اتصال بعد' : `منذ ${s.secondsAgo} ثانية`;
    return ctx.reply(`🔴 UserBot Offline\nLast heartbeat: ${ago}`).catch(() => {});
  }
  ctx.reply(
    `🤖 UserBot\n\n` +
    `Status: 🟢 Online\n` +
    `Telegram: 🟢 Connected${s.username ? ' (@' + s.username + ')' : ''}\n` +
    `Last heartbeat: ${s.secondsAgo} seconds ago`
  ).catch(() => {});
});

// 📥 حالة استيراد الملفات — Owner فقط (قراءة فقط)
require('./handlers/ingest_status').register(bot);
require('./handlers/ingest_panel').register(bot); // 📥 أزرار اختيار القروبات — Owner فقط
require('./handlers/ingest_review').register(bot); // 📋 مركز مراجعة الملفات — Owner فقط

// 🐺 لوب غارو trigger
bot.hears(/^(لوب غارو|لوب_غارو|ذئب|werewolf)$/i, async (ctx) => {
  if (!['group','supergroup'].includes(ctx.chat?.type)) return;
  try { return require('./handlers/werewolf/engine').createLobby(ctx); } catch(e) {}
});
// 💳 عرض بطاقة عضو تلقائياً
bot.hears(/^.{2,25}$/, async (ctx, next) => {
  if (!["group","supergroup"].includes(ctx.chat?.type)) return next();
  const txt = ctx.message?.text?.trim();
  if (!txt || txt.startsWith("/") || txt.startsWith("@")) return next();
  if (ctx.message?.reply_to_message) return next();
  // تجاهل الكلمات المحجوزة
  const _blocked = ["ضف رد","امحي ردي","اعمل","بنك","مواطن","دولتي","لوب غارو","werewolf","خمن","مليون","بطاقتي","فلوسي","حسابي"];
  if (_blocked.some(b => txt.toLowerCase() === b.toLowerCase())) return next();
  // تجاهل إذا المستخدم في state نشط
  try {
    const _st = require('./utils/stateManager').getState(ctx.from?.id);
    if (_st?.type?.startsWith('member_card') || _st?.type?.startsWith('tod') || _st?.type?.startsWith('mg_') || _st?.type?.startsWith('gp_')) return next();
  } catch(_) {}
  try {
    const { get: _get } = require("./database/db");
    const trigger = await _get("SELECT user_id FROM member_card_triggers WHERE chat_id=$1 AND trigger_word=$2", [ctx.chat.id, txt.toLowerCase()]).catch(() => null);
    if (!trigger) return next();
    const card = await _get("SELECT * FROM member_cards WHERE chat_id=$1 AND user_id=$2", [ctx.chat.id, trigger.user_id]).catch(() => null);
    if (!card) return next();
    // جيب صورة البروفايل الحالية من تيليجرام مباشرة
    let livePhoto = card.photo_file_id;
    try {
      const photos = await ctx.telegram.getUserProfilePhotos(card.user_id, { limit: 1 });
      if (photos && photos.total_count > 0 && photos.photos[0]) {
        const arr = photos.photos[0];
        livePhoto = arr[arr.length - 1].file_id;
      }
    } catch(_) {}

    // جيب bio الحالي
    let liveBio = card.bio;
    try {
      const userChat = await ctx.telegram.getChat(card.user_id);
      if (userChat.bio) liveBio = userChat.bio;
    } catch(_) {}

    const name = card.first_name || "عضو";
    const uname = card.username ? "@" + card.username : "";
    const text = "• Use ↤ [" + name + "](tg://user?id=" + card.user_id + ")" +
      (liveBio ? "\n\n• Bio ↤ " + liveBio : "") +
      (uname ? "\n• " + uname : "");
    const kb = { inline_keyboard: [[{ text: name, url: "tg://user?id=" + card.user_id }]] };
    if (livePhoto) {
      await ctx.replyWithPhoto(livePhoto, { caption: text, parse_mode: "Markdown", reply_markup: kb, reply_to_message_id: ctx.message.message_id }).catch(() => {});
    } else {
      await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb, reply_to_message_id: ctx.message.message_id }).catch(() => {});
    }
  } catch(_) { return next(); }
});

// 🎮 أكسيو أو فيريتي — تسجيل مبكر (قبل أي middleware قد يبتلع الرسائل)
require('./handlers/tod').register(bot);
require('./handlers/whisper').register(bot); // 🤫 نظام الهمسة — نفس سبب التسجيل المبكر
bot.use(gameAndBankMiddleware);   // الألعاب والبنك قبل auth
bot.use(authMiddleware);
bot.use(botAdminCheck);           // FIX: مستوى أعلى — لا nested
bot.use(groupProtectionMiddleware); // auto-reply + flood/spam/link

bot.catch((err, ctx) => {
  if (!err.message.includes('is not modified'))
    logger.error('[BotErr] ' + err.message, { uid: ctx.from?.id, type: ctx.updateType });
  if (!ctx.callbackQuery && ctx.chat?.type === 'private')
    ctx.reply('⚠️ حدث خطأ. حاول مجدداً.').catch(() => {});
});

// ── تسجيل الأوامر ──
require('./bot/commands')(bot, {
  startHandler, manage, userH, million, tools, browse, bank,
  contentDb, usersDb, bundlesDb, dbAll, cacheClear,
  logger, OWNER_ID, kbBtn, kbBuild, eos, resetChat,
  millionaire, tagAll, muteAll, unmuteAll, showAllMembers,
});

// ── Callbacks ──
const { registerCallbacks } = require('./bot/callbacks');
registerCallbacks(bot, {
  CBDedup, cbRes, startHandler, manage, browse, userH,
  bundlesDb, contentDb, usersDb, interactions, commentsDb,
  cacheClear, cacheClearPrefix, kbBtn, kbBuild, eos, logger,
  safeInt, tagAll, muteAll, unmuteAll,
});

// ── Messages ──
setupGroupCommands(bot);

// ✅ Topics لازم تتسجل قبل أوامر القفل العامة (قفل/فتح <نوع>) وإلا "قفل التوبيكات" تتفسر كنوع مجهول
const { setupTopicCommands, trackTopicMiddleware, ensureTopicsTable } = require('./handlers/group_topics');
ensureTopicsTable().catch(() => {});
trackTopicMiddleware(bot);
const { setupHelpPdfCommands } = require('./handlers/group_help_pdf');
setupHelpPdfCommands(bot);
setupTopicCommands(bot);

require('./handlers/group_commands_pro').setupProCommands(bot);
require('./handlers/group_commands_ar').setupArabicModCommands(bot);
const { setupPromoteCommands } = require('./handlers/group_promote_panel');
setupPromoteCommands(bot);
require('./handlers/group_pro_features').setupProFeatures(bot);
require('./handlers/game_builder_admin').setup(bot);
require('./handlers/group_schedule').setupSchedule(bot);
require('./handlers/nations').setup(bot);
require('./handlers/group_filters').setupFilters(bot);
require('./handlers/group_extras').setupExtras(bot);

const { registerMessages } = require('./bot/messages');
const { registerJoinRequests } = require('./handlers/group_join_requests');
registerMessages(bot, {
  ownerH, GrpBuf, GrpMsgs, handleAiChat, handleOwnerAI,
  manage, browse, userH, bundlesDb, filesDb, adminsDb,
  logger, OWNER_ID, safeInt,
});
registerJoinRequests(bot);

// ✏️ مكافحة تعديل الرسائل لتصبح مخالفة (anti_edit)
bot.on('edited_message', async ctx => {
  try {
    const msg = ctx.update?.edited_message;
    if (msg) await require('./handlers/group_protection').checkEdited(ctx, msg);
  } catch (e) { logger.error('[EditedMsg] ' + e.message); }
});

// ── deep link: /start file_{fileId} ──
const { handleSummarize } = require('./handlers/share_summary');
bot.command(['لخص', 'summarize', 'sum'], handleSummarize);

bot.start(async (ctx, next) => {
  const payload = ctx.startPayload;
  if (payload?.startsWith('file_')) {
    const fid = parseInt(payload.replace('file_', ''));
    if (fid) {
      try {
        const file = await dbGet('SELECT * FROM files WHERE id=$1 AND is_deleted=0', [fid]);
        if (file) {
          const type = file.file_type === 'photo' ? 'sendPhoto' : 'sendDocument';
          await ctx.telegram[type](ctx.chat.id, file.file_id, {
            caption: '📄 *' + file.title + '*\n\n🔽 اضغط للتحميل المباشر',
            parse_mode: 'Markdown',
          });
          return;
        }
      } catch(_) {}
    }
  }
  return next();
});

// ── Launch ──
async function loadMaintenance() {
  try { maintenanceMode = (await getSetting('maintenance')) === 'true'; } catch(_) {}
}

// FIX: _launched guard — يمنع تسجيل handlers مرتين عند retry
let _launched = false;

async function launch() {
  logger.info('🚀 Study Bot — Starting...');
  try {
    await initSchema();
    await migrateGroupTables().catch(() => {});
    await require('./database/group_pro_db').migrate().catch(() => {});
    await require('./database/ingest_db').migrate().catch((e) => logger.error('[IngestDB] migration failed — feature stays inactive:', e.message));
    require('./utils/cache').clearAllSubCache();
    await require('./handlers/group_panel').migrateGroupPanel().catch(() => {});
    await require('./database/db').initBankTables().catch(() => {});
    await require('./handlers/millionaire').initMillionaireSchema().catch(() => {}); // ✅ كانت معرَّفة وغير مستدعاة أبداً — سبب فشل حفظ نتائج "من سيربح المليون"
    await initPersistentStates();
    logger.info('✅ DB ready');

    await Promise.all([loadMaintenance(), loadAllStates().catch(() => {})]);
    await cacheWarmup();
    logger.info('✅ Cache warm');

    // Preload ban status
    try {
      const { cacheSet: _cs } = require('./utils/cache');
      const [banned, active] = await Promise.all([
        dbAll("SELECT id FROM users WHERE is_banned=1 LIMIT 5000"),
        dbAll("SELECT id FROM users WHERE is_banned=0 AND last_active > NOW() - INTERVAL '3 days' LIMIT 10000"),
      ]);
      banned.forEach(u => _cs('ban_' + u.id, 1, 86400000));
      active.forEach(u => _cs('ban_' + u.id, 0, 3600000));
      logger.info('⚡ Preloaded ban status: ' + (banned.length + active.length) + ' users');
    } catch(_) {}

    music.checkDependencies().catch(() => {}); // فحص yt-dlp/ffmpeg مبكراً — يظهر في اللوغز فوراً إن كانا مفقودين

    startScheduler(bot, [OWNER_ID]);
    GrpBuf.start();
    require('./handlers/group_verify').startVerifyWatcher(bot);
    require('./handlers/group_schedule').startScheduleWatcher(bot);
    const _me = await bot.telegram.getMe().catch(() => ({}));
    const BOT_USERNAME = _me.username || process.env.BOT_USERNAME || '';
    logger.info('✅ Services started — @' + BOT_USERNAME);
    // تنظيف القروبات المطرود منها عند البدء
    setTimeout(async () => {
      try {
        const groups = await dbAll('SELECT chat_id FROM group_chats WHERE is_active != 0').catch(() => []);
        for (const g of groups) {
          try {
            await bot.telegram.getChat(g.chat_id);
          } catch(e) {
            if (e.message?.includes('kicked') || e.message?.includes('Forbidden') || e.message?.includes('not found')) {
              await dbRun('UPDATE group_chats SET is_active=0, notify_new_files=0 WHERE chat_id=$1', [g.chat_id]).catch(()=>{});
              logger.info('[Cleanup] مطرود من: ' + g.chat_id);
            }
          }
        }
        logger.info('[Cleanup] ✅ تم تنظيف القروبات');
      } catch(e) { logger.error('[Cleanup]', e.message); }
    }, 10000);

    app.use(bot.webhookCallback('/webhook/' + TOKEN, { secretToken: WEBHOOK_SECRET || undefined }));

    app.get('/health', async (_r, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const mu    = process.memoryUsage();
      const heapMB = Math.round(mu.heapUsed / 1048576);
      let dbOk = false;
      try { await dbAll('SELECT 1'); dbOk = true; } catch(_) {}
      res.json({
        status: dbOk && heapMB < 450 ? 'ok' : 'degraded',
        uptime: Math.floor(process.uptime()),
        heap:   heapMB + 'MB',
        rss:    Math.round(mu.rss / 1048576) + 'MB',
        db:     dbOk ? 'ok' : 'error',
        region: process.env.RAILWAY_REGION || 'local',
        ts:     Date.now(),
      });
    });

    // ── API Routes ──
    const apiRoutes = require('./routes/api');
    app.use('/api', apiRoutes);

    // ── Internal service-to-service routes (UserBot heartbeat, etc.) ──
    const internalRoutes = require('./routes/internal');
    app.use('/internal', internalRoutes.router);
    app.use('/internal/ingest', internalRoutes.requireInternalSecret, require('./routes/ingest_internal').router);

    // ── Global Express Error Handler ──
    app.use((err, req, res, _next) => {
      logger.error('[API Error] ' + err.message, { path: req.path, uid: req.tgUser?.id });
      res.status(err.status || 500).json({ error: 'حدث خطأ، حاول مجددًا.' });
    });

    app.listen(PORT, () => {
  logger.info('✅ Express :' + PORT);
  // 🔌 يكتب البورت الحقيقي بملف مشترك عشان UserBot (Python) يقرأه مباشرة
  // بدل الاعتماد على تخمين localhost:3000 (Railway قد يحقن PORT ديناميكياً).
  try { require('fs').writeFileSync(require('path').join(__dirname, '.internal_port'), String(PORT)); } catch (_) {}
});

    // FIX: _launched guard — تسجيل handlers مرة واحدة فقط
    if (!_launched) {
      _launched = true;

      // ══════════════════════════════════════════
      // FIX: bot.on handlers خارج launch — لا يتراكموا عند retry
      // ══════════════════════════════════════════

      // تسجيل القروب تلقائياً
      bot.on('my_chat_member', async ctx => {
        try {
          const upd     = ctx.update?.my_chat_member;
          const newM    = upd?.new_chat_member;
          const addedBy = upd?.from;
          const chat    = upd?.chat;
          if (newM?.user?.is_bot &&
              (newM?.status === 'member' || newM?.status === 'administrator') &&
              addedBy?.id && chat?.type !== 'private') {
            const me    = ctx.botInfo || await ctx.telegram.getMe().catch(() => ({}));
            const un    = me.username || '';
            const chatId = chat.id;
            const title  = chat.title || 'القروب';
            setTimeout(async () => {
              try {
                const botMember = await ctx.telegram.getChatMember(chatId, ctx.botInfo?.id || me.id).catch(() => null);
                const isAdmin   = botMember?.status === 'administrator';
                if (isAdmin) {
                  await ctx.telegram.sendMessage(addedBy.id,
                    '✅ تم إضافتي في *' + title + '* كـ ادمين!\n\nيمكنك إعداد القروب والتحكم فيه من هنا:',
                    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
                      { text: '⚙️ إعداد القروب', url: 'https://t.me/' + un + '?start=setup_' + chatId },
                    ]]}},
                  );
                } else {
                  const _kb = { inline_keyboard: [[
                    { text: '👑 أضفني كـ مشرف 🛡️', url: 'https://t.me/' + un + '?startgroup=true&admin=delete_messages+restrict_members+pin_messages+invite_users+manage_chat' },
                  ]]};
                  await ctx.telegram.sendMessage(addedBy.id,
                    '⚠️ أضفتني في *' + title + '* بدون صلاحيات ادمين!\n\n👇 اضغط لإعادة إضافتي كمشرف:',
                    { parse_mode: 'Markdown', reply_markup: _kb }
                  ).catch(() => {});
                }
              } catch(_) {}
            }, 2000);
          }
        } catch(_) {}

        try {
          const update = ctx.myChatMember;
          const chat   = update?.chat;
          const member = update?.new_chat_member;
          if (!chat || !['group', 'supergroup'].includes(chat.type)) return;
          if (['member', 'administrator'].includes(member?.status)) {
            // لو مش ادمين — اخرج فوراً
            if (member?.status === 'member') {
              _bacSet('botadm_' + chat.id, false, 300000); // ⚡ حدّث كاش فوراً (مو ضروري لأن البوت هيخرج، بس للسلامة)
              logger.warn('[GroupReg] مش ادمين — خروج من: ' + (chat.title || chat.id));
              bot.telegram.leaveChat(chat.id).catch(() => {});
              return;
            }
            _bacSet('botadm_' + chat.id, true, 300000); // ⚡ ترقية لأدمن — حدّث الكاش فوراً بدل انتظار انتهاء TTL
            await dbRun(
              `INSERT INTO group_chats(chat_id, title, specialty_id, welcome_enabled, goodbye_enabled, notify_new_files, added_by)
               VALUES($1,$2,0,1,0,1,$3)
               ON CONFLICT(chat_id) DO UPDATE SET title=$2, added_by=COALESCE(group_chats.added_by,$3)`,
              [chat.id, chat.title || '', update?.from?.id || null]
            ).catch(() => {});
            logger.info('[GroupReg] ✅ أُضيف البوت لـ: ' + (chat.title || chat.id));
          } else if (['left', 'kicked'].includes(member?.status)) {
            cacheClear('botadm_' + chat.id); // ⚡ نظافة كاش — البوت مو موجود بالقروب أصلاً
            await dbRun('UPDATE group_chats SET is_active=0 WHERE chat_id=$1', [chat.id]).catch(() => {});
            logger.info('[GroupReg] 🚪 خرج البوت من: ' + (chat.title || chat.id));
          }
        } catch(e) { logger.error('[my_chat_member]', e.message); }
      });

      // ── Inline Query — @bot كلمة بحث ──────────────────────
      bot.on('inline_query', async ctx => {
        const query = ctx.inlineQuery?.query?.trim() || '';
        if (query.length < 2) {
          return ctx.answerInlineQuery([], {
            switch_pm_text: '🔍 اكتب اسم الملف للبحث...',
            switch_pm_parameter: 'search',
            cache_time: 0,
          }).catch(() => {});
        }
        try {
          const results = await smartSearch(query, 15);
          if (!results || !results.length) {
            return ctx.answerInlineQuery([], {
              switch_pm_text: '❌ لا نتائج لـ: ' + query,
              switch_pm_parameter: 'search',
              cache_time: 10,
            }).catch(() => {});
          }
          const items = results.map(f => ({
            type: 'article',
            id: String(f.id),
            title: '📄 ' + (f.title || 'ملف'),
            description: (f.sub_name || '') + (f.cat_name ? ' · ' + f.cat_name : ''),
            input_message_content: {
              message_text: '📄 *' + (f.title || 'ملف') + '*\n\n' +
                (f.sub_name ? '📚 ' + f.sub_name + '\n' : '') +
                (f.cat_name ? '📁 ' + f.cat_name + '\n' : '') +
                '\n_استخدم البوت للتحميل_',
              parse_mode: 'Markdown',
            },
            reply_markup: {
              inline_keyboard: [[
                { text: '📥 فتح في البوت', url: 'https://t.me/' + (ctx.botInfo?.username || BOT_USERNAME) + '?start=file_' + f.id }
              ]]
            },
            thumb_url: 'https://cdn-icons-png.flaticon.com/512/337/337946.png',
          }));
          return ctx.answerInlineQuery(items, { cache_time: 30 }).catch(() => {});
        } catch(e) {
          logger.error('[InlineQuery]', e.message);
          return ctx.answerInlineQuery([], { cache_time: 5 }).catch(() => {});
        }
      });

      // تسجيل رسائل القروب + تسجيل الأعضاء
      // FIX: لا يوجد trigger مليون/بنك هنا — موجود في gameAndBankMiddleware فقط
      bot.on('message', async (ctx, next) => {
        try {
          const chat = ctx.chat;
          if (!['group', 'supergroup'].includes(chat?.type)) return next();

          dbRun(
            `INSERT INTO group_chats(chat_id, title) VALUES($1,$2)
             ON CONFLICT(chat_id) DO UPDATE SET title=$2`,
            [chat.id, chat.title || '']
          ).catch(() => {});

          // ⚡ PERF FIX: شيلنا هنا كتابة group_members المباشرة — كانت مكررة مع
          // trackMsg() (بـ groupProtectionMiddleware، تشتغل قبل هذا الهاندلر بالسلسلة
          // لكل رسالة) اللي صارت تحفظ username كمان الحين. كان الجدول يتكتب مرتين
          // منفصلتين على كل رسالة قروب بلا داعي.
        } catch(_) {}
        return next();
      });

      // Games — register مرة واحدة
      guessGame.register(bot);
      require('./handlers/werewolf').register(bot).catch(e => console.error('[WW]',e.message));
      millionaire.register(bot);
      logger.info('[Launch] ✅ Games registered');

      // BullMQ Workers
      setImmediate(() => {
        try { require('./workers/broadcast.worker'); } catch(e) { logger.warn('[Worker] broadcast:', e.message); }
        try { require('./workers/notify.worker');    } catch(e) { logger.warn('[Worker] notify:', e.message); }
      });
    }

    if (WEBHOOK_URL) {
      await bot.telegram.setWebhook(WEBHOOK_URL + '/webhook/' + TOKEN, {
        allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member', 'chat_member', 'inline_query', 'chat_join_request'],
        drop_pending_updates: true,
        max_connections: 40,
        ...(WEBHOOK_SECRET && { secret_token: WEBHOOK_SECRET }),
      });
      logger.info('✅ Webhook: ' + WEBHOOK_URL);
    } else {
      logger.warn('⚠️ No WEBHOOK_URL — polling mode');
      bot.launch({ drop_pending_updates: true });
    }

    logger.info('🚀 Ready!');
  } catch(e) {
    logger.error('[Launch]', e.message);
    setTimeout(launch, 10000);
  }
}

async function shutdown(sig) {
  logger.info('[Shutdown] ' + sig);
  try {
    bot.stop(sig);
    await GrpBuf.stop();
    const pg = getPg();
    if (pg) await pg.end();
    process.exit(0);
  } catch(_) { process.exit(1); }
}

process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

launch();
