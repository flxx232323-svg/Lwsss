'use strict';
/**
 * ════════════════════════════════════════════════════════════
 *  👮 utils/ingest_senders.js — من يُسمح بتتبع ملفاته في استيراد UserBot
 * ════════════════════════════════════════════════════════════
 *  القاعدة: المالك (OWNER_ID) دائماً. وإذا فُعِّل INGEST_TRACK_ADMINS=1 يُضاف مشرفو القروب نفسه.
 *
 *  - مصدر قائمة المشرفين: Bot API (getChatAdministrators) من البوت، لا من حساب UserBot.
 *    فلا استدعاءات إضافية على حسابك الشخصي، والخادم هو المرجع الوحيد (يفرضها في /config و/batch).
 *  - كاش 10 دقائق للنجاح، ودقيقة للفشل. فشل الجلب = المالك فقط (يُغلق على الأمان).
 *  - لا يُضاف من يرسل باسم القروب (مشرف مجهول): لا يمكن نسبته لشخص، ومعرّفه سالب أصلاً.
 *  - النطاق لا يتغيّر: يبقى مقيّداً بالمصادر والمواضيع المفعّلة في ingest_sources/ingest_rules.
 * ════════════════════════════════════════════════════════════
 */

const TTL_OK = 10 * 60 * 1000;
const TTL_FAIL = 60 * 1000;
const MAX_CACHE = 500;

function trackAdminsEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.INGEST_TRACK_ADMINS || '').trim());
}

/** @param getTelegram دالة تعيد كائن telegram الخاص بالبوت (أو null) */
function createAdminResolver(getTelegram, opts = {}) {
  const ttlOk = opts.ttlOk || TTL_OK;
  const ttlFail = opts.ttlFail || TTL_FAIL;
  const now = opts.now || Date.now;
  const cache = new Map();     // chatId -> { ids: Set|null, exp }
  const inflight = new Map();  // chatId -> Promise

  async function fetchAdmins(key) {
    try {
      const tg = getTelegram();
      if (!tg) return null;
      const list = await tg.getChatAdministrators(key);
      if (!Array.isArray(list)) return null;
      return new Set(list.filter((m) => m && m.user && !m.user.is_bot).map((m) => String(m.user.id)));
    } catch (_) {
      return null;
    }
  }

  return function getAdmins(chatId) {
    const key = String(chatId);
    const hit = cache.get(key);
    if (hit && hit.exp > now()) return Promise.resolve(hit.ids);
    if (inflight.has(key)) return inflight.get(key);
    const p = fetchAdmins(key)
      .then((ids) => {
        if (cache.size >= MAX_CACHE) cache.clear();
        cache.set(key, { ids, exp: now() + (ids ? ttlOk : ttlFail) });
        return ids;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}

/** المرسلون المسموحون كنصوص. admins: Set أو null (فشل/غير متاح). */
function allowedSenders({ owner, trackAdmins, admins }) {
  const out = new Set();
  if (owner !== undefined && owner !== null && String(owner) !== '') out.add(String(owner));
  if (trackAdmins && admins) for (const id of admins) out.add(String(id));
  return out;
}

let _tg = null;
function useTelegram(tg) { _tg = tg || null; }
const defaultResolver = createAdminResolver(() => _tg);

module.exports = { trackAdminsEnabled, createAdminResolver, allowedSenders, useTelegram, defaultResolver };
