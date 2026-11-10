'use strict';
// ══════════════════════════════════════════════════════════════════════
//  🛡 نواة صلاحيات المجموعات — المرحلة 2
//
//  مصدر واحد للسؤال: «هل هذا المستخدم مشرف تيليجرام في هذا القروب؟»
//  كان الجواب مكرَّراً في 14 دالة بأسماء مختلفة (isTgAdmin, isChatAdmin,
//  isTelegramAdmin, checkGroupAdmin, ...) بفروق غير موثّقة في الكاش
//  ومعالجة الخطأ وسياسة تجاوز المالك. هذه الوحدة تجمع الآلية، وتجعل
//  الفروق الشرعية منها «سياسة تُمرَّر صراحةً» بدل أن تكون صدفة في الكود.
//
//  ما لا تفعله (عمداً):
//   • لا تحلّ محل الرتب المخصّصة (handlers/group_roles.js) ولا RBAC البوت.
//   • لا تغيّر مَن يملك الصلاحية في أي ملف: كل موضع يمرّر سياسته القديمة.
// ══════════════════════════════════════════════════════════════════════

const ADMIN_STATUSES = Object.freeze(['administrator', 'creator']);

// سياسة التجاوز: من يُعدّ مشرفاً دون سؤال تيليجرام؟
//  NONE  : لا أحد — الافتراضي (أقل صلاحية). الفحص يمرّ دائماً على تيليجرام.
//  OWNER : مالك البوت فقط (OWNER_ID من البيئة).
//  STAFF : مالك البوت + أدمن البوت (ctx.isOwner || ctx.isAdmin من authMiddleware).
//          انتبه: «أدمن البوت» ≠ «مشرف المجموعة»، وهو يملك هذا التجاوز في كل مجموعة.
const BYPASS = Object.freeze({ NONE: 'none', OWNER: 'owner', STAFF: 'staff' });

// سبب القرار — يُستخدم للرسائل الموحّدة وللتشخيص
const REASON = Object.freeze({
  OWNER: 'owner',            // مالك البوت
  BOT_ADMIN: 'bot_admin',    // أدمن البوت (STAFF فقط)
  CREATOR: 'tg_creator',     // منشئ المجموعة
  ADMIN: 'tg_admin',         // مشرف تيليجرام
  NOT_ADMIN: 'not_admin',    // عضو عادي/مقيَّد/غادر/محظور
  API_ERROR: 'api_error',    // تعذّر التحقق (لا نعرف) — يُعامَل كرفض
  NO_CHAT: 'no_chat',        // لا معرّف مجموعة
  NO_USER: 'no_user',        // لا معرّف مستخدم (قناة/مشرف مجهول)
});

// نفس مفتاح الكاش الذي كان يتشاركه group_protection و group_pro_features،
// فيبقى clearAdminCache القديم وأي إبطال خارجي يعمل كما كان.
const KEY_PREFIX = 'tgadm_';
const ERR_PREFIX = 'tgadmerr_';   // حجب قصير بعد خطأ API (منفصل كي لا يلوّث نتيجة المشرف الحقيقية)

const DEFAULT_TTL = 60_000;       // مشرف: دقيقة. الإبطال الفوري يأتي من chat_member.
const DEFAULT_NEG_TTL = 15_000;   // غير مشرف: أقصر، كي لا ينتظر المرقّى حديثاً
const ERROR_BACKOFF_TTL = 5_000;  // بعد خطأ API: لا نُغرق تيليجرام لكن لا نحبس الخطأ طويلاً

const DENIAL_TEXT = Object.freeze({
  [REASON.NOT_ADMIN]: '🚫 للمشرفين فقط',
  [REASON.API_ERROR]: '⚠️ تعذّر التحقق من صلاحياتك الآن، حاول بعد قليل',
  [REASON.NO_USER]:   '🚫 تعذّر تحديد هويتك (رسالة مجهولة أو من قناة)',
  [REASON.NO_CHAT]:   '🚫 تعذّر تحديد القروب',
});

function _utilsCacheAdapter() {
  const c = require('./cache');
  return { get: c.cacheGet, set: c.cacheSet, clear: c.cacheClear, clearPrefix: c.cacheClearPrefix };
}

const _isEmptyId = v =>
  v === undefined || v === null || v === '' || (typeof v === 'number' && Number.isNaN(v));

/**
 * @param {object} [deps]
 * @param {{get,set,clear,clearPrefix}} [deps.cache]  يُحقَن في الاختبارات؛ الافتراضي utils/cache.js
 * @param {object} [deps.env]                         الافتراضي process.env
 */
function createGroupAuth(deps = {}) {
  const env = deps.env || process.env;
  let _cache = deps.cache || null;
  const cache = () => _cache || (_cache = _utilsCacheAdapter());
  const inflight = new Map();

  // الكاش لا يجوز أن يكسر فحص الصلاحية أبداً
  const safe = fn => { try { return fn(); } catch (_) { return null; } };

  // GROUP_AUTH_CACHE_TTL_MS=0 → إيقاف الكاش تماماً (يعيد السلوك الحيّ القديم). رقم موجب → مدة المشرف.
  function _cfg() {
    const raw = env.GROUP_AUTH_CACHE_TTL_MS;
    if (raw === undefined || raw === '') return { off: false, ttl: DEFAULT_TTL };
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return { off: false, ttl: DEFAULT_TTL };
    if (n === 0) return { off: true, ttl: 0 };
    return { off: false, ttl: n };
  }

  function _ownerId() {
    const n = Number(env.OWNER_ID);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  }
  const _isOwnerId = uid => { const o = _ownerId(); return o > 0 && !_isEmptyId(uid) && Number(uid) === o; };

  const _key = (chatId, userId) => KEY_PREFIX + chatId + '_' + userId;
  const _errKey = (chatId, userId) => ERR_PREFIX + chatId + '_' + userId;

  async function _fetch(telegram, chatId, userId, opts, cfg) {
    let member;
    try {
      if (!telegram || typeof telegram.getChatMember !== 'function') throw new Error('telegram غير متاح');
      member = await telegram.getChatMember(chatId, userId);
    } catch (e) {
      if (!cfg.off) safe(() => cache().set(_errKey(chatId, userId), 1, ERROR_BACKOFF_TTL));
      return { ok: false, reason: REASON.API_ERROR, error: e && e.message };
    }
    const status = member && member.status;
    const ok = ADMIN_STATUSES.includes(status);
    if (!cfg.off) {
      const custom = Number(opts.ttl) > 0 ? Number(opts.ttl) : 0;
      const ttl = custom || (ok ? cfg.ttl : Math.min(DEFAULT_NEG_TTL, cfg.ttl));
      safe(() => cache().set(_key(chatId, userId), ok, ttl));
    }
    return { ok, reason: ok ? (status === 'creator' ? REASON.CREATOR : REASON.ADMIN) : REASON.NOT_ADMIN, status };
  }

  async function _lookup(telegram, chatId, userId, opts) {
    const cfg = _cfg();
    const key = _key(chatId, userId);
    if (!cfg.off && !opts.fresh) {
      const hit = safe(() => cache().get(key));
      if (hit !== null && hit !== undefined) {
        return { ok: !!hit, reason: hit ? REASON.ADMIN : REASON.NOT_ADMIN, cached: true };
      }
      if (safe(() => cache().get(_errKey(chatId, userId)))) {
        return { ok: false, reason: REASON.API_ERROR, cached: true };
      }
    }
    if (!cfg.off) {
      const pending = inflight.get(key);
      if (pending) return pending;           // دمج الطلبات المتزامنة لنفس (قروب، مستخدم)
    }
    const p = _fetch(telegram, chatId, userId, opts, cfg);
    if (!cfg.off) {
      inflight.set(key, p);
      p.then(() => inflight.delete(key), () => inflight.delete(key));
    }
    return p;
  }

  /**
   * القرار الكامل مع السبب.
   * @param {object} ctx  سياق Telegraf (أو {telegram} فقط)
   * @param {object} [opts]
   * @param {string|number} [opts.chatId]  الافتراضي ctx.chat.id
   * @param {string|number} [opts.userId]  الافتراضي ctx.from.id
   * @param {'none'|'owner'|'staff'} [opts.bypass='none']
   * @param {number}  [opts.ttl]    مدة كاش مخصّصة (مللي ثانية) لهذا الاستدعاء
   * @param {boolean} [opts.fresh]  تجاوز قراءة الكاش (للإجراءات الحسّاسة)
   * @param {object}  [opts.telegram]
   * @returns {Promise<{ok:boolean, reason:string, cached?:boolean}>}
   */
  async function resolveGroupAdmin(ctx, opts = {}) {
    const bypass = opts.bypass === undefined ? BYPASS.NONE : opts.bypass;
    if (!Object.values(BYPASS).includes(bypass)) throw new TypeError('group_auth: سياسة bypass غير معروفة: ' + bypass);

    const callerId = ctx && ctx.from ? ctx.from.id : undefined;
    // مفتاح صريح في opts يُحترم حتى لو كانت قيمته undefined (لا رجوع صامت إلى ctx):
    // الدوال القديمة ذات الوسيط الصريح كانت تفشل عند غيابه، والتكافؤ يقتضي ذلك.
    const has = k => Object.prototype.hasOwnProperty.call(opts, k);
    const userId = has('userId') ? opts.userId : callerId;
    // أعلام ctx تخص «المستدعي»؛ لا تمنح تجاوزاً لمستخدم آخر يُفحَص بمعرّفه.
    const subjectIsCaller = opts.userId === undefined ||
      (callerId !== undefined && String(opts.userId) === String(callerId));

    if (bypass === BYPASS.STAFF && subjectIsCaller && ctx) {
      if (ctx.isOwner) return { ok: true, reason: REASON.OWNER };
      if (ctx.isAdmin) return { ok: true, reason: REASON.BOT_ADMIN };
    }
    if (bypass === BYPASS.OWNER && _isOwnerId(userId)) return { ok: true, reason: REASON.OWNER };

    const chatId = has('chatId') ? opts.chatId : (ctx && ctx.chat ? ctx.chat.id : undefined);
    if (_isEmptyId(chatId)) return { ok: false, reason: REASON.NO_CHAT };
    if (_isEmptyId(userId)) return { ok: false, reason: REASON.NO_USER };

    return _lookup(opts.telegram || (ctx && ctx.telegram), chatId, userId, opts);
  }

  async function isGroupAdmin(ctx, opts = {}) {
    return (await resolveGroupAdmin(ctx, opts)).ok;
  }

  /** نسخة بلا ctx (مثل محرك لعبة يملك كائن البوت فقط). بلا أي تجاوز. */
  async function isGroupAdminById(telegram, chatId, userId, opts = {}) {
    const r = await resolveGroupAdmin({ telegram }, { ...opts, chatId, userId, bypass: BYPASS.NONE });
    return r.ok;
  }

  function invalidateGroupAdmin(chatId, userId) {
    safe(() => { cache().clear(_key(chatId, userId)); cache().clear(_errKey(chatId, userId)); });
  }

  /** يمسح كل مشرفي قروب (عند تغيّر جماعي أو بعد جلب قائمة المشرفين). */
  function invalidateChat(chatId) {
    safe(() => { cache().clearPrefix(KEY_PREFIX + chatId + '_'); cache().clearPrefix(ERR_PREFIX + chatId + '_'); });
  }

  /**
   * يُستدعى من معالج chat_member: أي تغيّر في عضوية مستخدم يُبطل كاشه فوراً،
   * فلا ينتظر المرقّى انتهاء المدة، ولا يحتفظ المعزول بصلاحيته.
   * @param {object} cm  كائن ChatMemberUpdated (ctx.chatMember)
   * @returns {boolean}  هل أُبطل شيء؟
   */
  function handleChatMemberUpdate(cm) {
    const chatId = cm && cm.chat && cm.chat.id;
    const m = cm && cm.new_chat_member;
    const userId = m && m.user && m.user.id;
    if (_isEmptyId(chatId) || _isEmptyId(userId)) return false;
    invalidateGroupAdmin(chatId, userId);
    return true;
  }

  function denialMessage(reason) {
    return DENIAL_TEXT[reason] || DENIAL_TEXT[REASON.NOT_ADMIN];
  }

  /**
   * رفض موحّد: يفحص، وإن رُفض يرسل رسالة واضحة السبب (تنبيه للأزرار، رد للأوامر).
   * جاهزة للمراحل التالية؛ أغلفة المرحلة 2 تحتفظ برسائلها القديمة للحفاظ على التكافؤ.
   */
  async function requireGroupAdmin(ctx, opts = {}) {
    const r = await resolveGroupAdmin(ctx, opts);
    if (r.ok) return true;
    const text = opts.denyText || denialMessage(r.reason);
    try {
      if (ctx && ctx.callbackQuery && typeof ctx.answerCbQuery === 'function') {
        await ctx.answerCbQuery(text, { show_alert: true });
      } else if (ctx && typeof ctx.reply === 'function') {
        await ctx.reply(text);
      }
    } catch (_) { /* الرفض لا يجوز أن يرمي */ }
    return false;
  }

  return {
    resolveGroupAdmin, isGroupAdmin, isGroupAdminById, requireGroupAdmin,
    invalidateGroupAdmin, invalidateChat, handleChatMemberUpdate, denialMessage,
    // الثوابت على كل نسخة: النسخة المحقونة (اختبارات) تتصرف كتصدير الوحدة تماماً
    BYPASS, REASON, ADMIN_STATUSES, KEY_PREFIX,
  };
}

module.exports = {
  createGroupAuth,
  ...createGroupAuth(),
};
