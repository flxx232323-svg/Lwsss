'use strict';
/**
 * 🛡️ handlers/group_protection.js — محرّك الحماية الذكي
 * ──────────────────────────────────────────────────────────────
 * يفحص كل رسالة في القروب (رسائل + تعديلات + أعضاء جدد) ويطبّق:
 *   anti_spam | anti_link | anti_flood | anti_forward | anti_mention
 *   anti_bot  | anti_edit | anti_words | anti_caps | anti_duplicate
 *   + أقفال الوسائط (group_locks)
 *
 * عند أي مخالفة: حذف الرسالة + تسجيلها + تطبيق سلّم العقوبات الذكي
 * (تحذير ← كتم ← طرد ← حظر) حسب إعدادات كل قروب.
 */

const db = require('../database/group_pro_db');
const { run } = require('../database/db');
const { cacheGet, cacheSet, cacheClear } = require('../utils/cache');
const logger = require('../utils/logger');

const SETTINGS_TTL = 60000;
const OWNER_ID = parseInt(process.env.OWNER_ID || '0');

// ══════════════════════════════════════════════════════════
// ⚙️ إعدادات (مع كاش)
// ══════════════════════════════════════════════════════════
async function getSettings(chatId) {
  const ck = 'gprot_' + chatId;
  let s = cacheGet(ck);
  if (s) return s;
  s = await db.getRawSettings(chatId);
  cacheSet(ck, s, SETTINGS_TTL);
  return s;
}

function clearSettingsCache(chatId) { cacheClear('gprot_' + chatId); }

async function updateSettings(chatId, patch) {
  const merged = await db.updateSettings(chatId, patch);
  cacheSet('gprot_' + chatId, merged, SETTINGS_TTL);
  return merged;
}

// ══════════════════════════════════════════════════════════
// 🔒 أقفال الوسائط (مع كاش)
// ══════════════════════════════════════════════════════════
async function getLocksCached(chatId) {
  const ck = 'glocks_' + chatId;
  let l = cacheGet(ck);
  if (l) return l;
  l = await db.getLocks(chatId);
  cacheSet(ck, l, 120000);
  return l;
}
function clearLocksCache(chatId) { cacheClear('glocks_' + chatId); }

// ══════════════════════════════════════════════════════════
// 🚷 كلمات محظورة (مع كاش)
// ══════════════════════════════════════════════════════════
async function getBannedWordsCached(chatId) {
  const ck = 'bwords_' + chatId;
  let w = cacheGet(ck);
  if (w) return w;
  w = (await db.listWords(chatId)).map(r => r.word);
  cacheSet(ck, w, 120000);
  return w;
}
function clearWordsCache(chatId) { cacheClear('bwords_' + chatId); }

// ══════════════════════════════════════════════════════════
// 👮 هل المستخدم مشرف تيليجرام في هذا القروب؟ (مع كاش)
// ══════════════════════════════════════════════════════════
async function isTelegramAdmin(ctx, chatId, uid) {
  if (parseInt(uid) === OWNER_ID) return true;
  const ck = 'tgadm_' + chatId + '_' + uid;
  let v = cacheGet(ck);
  if (v !== null) return v;
  let isAdm = false;
  try {
    const m = await ctx.telegram.getChatMember(chatId, uid);
    isAdm = ['administrator', 'creator'].includes(m?.status);
  } catch (_) {}
  cacheSet(ck, isAdm, 300000);
  return isAdm;
}
function clearAdminCache(chatId, uid) { cacheClear('tgadm_' + chatId + '_' + uid); }

// ══════════════════════════════════════════════════════════
// 🧠 حالة مؤقتة في الذاكرة (Flood / Duplicate / Cross-Spam)
// ══════════════════════════════════════════════════════════
const _floodMap   = new Map(); // chatId_uid -> {count,start}
const _dupMap     = new Map(); // chatId_uid -> {text,time}
const _crossSpam  = new Map(); // chatId -> Map(text -> {users:Set, time})

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _floodMap)  if (now - v.start > 60000)  _floodMap.delete(k);
  for (const [k, v] of _dupMap)    if (now - v.time  > 120000) _dupMap.delete(k);
  for (const [chatId, m] of _crossSpam) {
    for (const [text, v] of m) if (now - v.time > 300000) m.delete(text);
    if (!m.size) _crossSpam.delete(chatId);
  }
}, 60000).unref();

// ══════════════════════════════════════════════════════════
// 📛 أنماط سبام جاهزة (Heuristics)
// ══════════════════════════════════════════════════════════
const SPAM_PATTERNS = [
  /انضم(و[ا]?)?\s+الآن/i,
  /اربح(و[ا]?)?\s+(المال|فلوس|نقاط|آيفون)/i,
  /(فرصة|عرض)\s+(ذهبية|لا\s*يفوّت|محدود)/i,
  /ربح\s+مضمون/i,
  /استثمر\s+الآن/i,
  /free\s+(money|telegram\s*premium|robux|nitro)/i,
  /click\s+here\s+to/i,
  /earn\s+\$?\d+/i,
  /(t\.me|telegram\.me)\/joinchat/i,
  /crypto\s+(giveaway|airdrop)/i,
  /(واتساب|تليجرام)\s*(مجان[يا]|بريميوم\s*مجان)/i,
];

// ══════════════════════════════════════════════════════════
// 🏷️ تسميات المخالفات
// ══════════════════════════════════════════════════════════
const VIOLATION_LABELS = {
  flood:     'فلود (رسائل متكررة بسرعة)',
  duplicate: 'تكرار نفس الرسالة',
  spam:      'محتوى مشابه للسبام',
  link:      'رابط ممنوع',
  words:     'كلمة محظورة',
  mention:   'منشن جماعي مفرط',
  caps:      'إكثار في الحروف الكبيرة',
  length:    'رسالة طويلة جداً',
  forward:     'محتوى موجَّه (Forward)',
  short_link:  'رابط مختصر ممنوع',
  invite_link: 'رابط دعوة تيليجرام',
  media:       'صورة/فيديو ممنوع',
  file:        'ملف/مستند ممنوع',
  lock_sticker: 'ملصقات مقفولة',
  lock_gif:     'الصور المتحركة مقفولة',
  lock_photo:   'الصور مقفولة',
  lock_video:   'الفيديوهات مقفولة',
  lock_voice:   'الرسائل الصوتية مقفولة',
  lock_poll:    'الاستطلاعات مقفولة',
  lock_forward: 'إعادة التوجيه مقفولة',
  lock_link:    'الروابط مقفولة',
};

function violationLabel(type) { return VIOLATION_LABELS[type] || type; }

// ══════════════════════════════════════════════════════════
// 🔎 دوال الفحص الفردية — كل دالة ترجع null أو نوع المخالفة
// ══════════════════════════════════════════════════════════
function checkFlood(key, now, settings) {
  if (!settings.anti_flood) return null;
  const windowMs = (settings.flood_window || 5) * 1000;
  let f = _floodMap.get(key);
  if (!f || now - f.start > windowMs) {
    _floodMap.set(key, { count: 1, start: now });
    return null;
  }
  f.count++;
  return f.count > (settings.flood_limit || 5) ? 'flood' : null;
}

function checkDuplicate(key, txt, now, settings) {
  if (!settings.anti_duplicate || !txt) return null;
  const prev = _dupMap.get(key);
  _dupMap.set(key, { text: txt, time: now });
  if (prev && prev.text === txt && (now - prev.time) < (settings.dup_window_sec || 60) * 1000) return 'duplicate';
  return null;
}

function checkCrossSpam(chatId, uid, txt, now, settings) {
  if (!settings.anti_spam || !txt || txt.length < 10) return null;
  let m = _crossSpam.get(chatId);
  if (!m) { m = new Map(); _crossSpam.set(chatId, m); }
  let e = m.get(txt);
  if (!e) { e = { users: new Set(), time: now }; m.set(txt, e); }
  e.users.add(uid); e.time = now;
  return e.users.size >= 2 ? 'spam' : null;
}

function checkSpamPattern(txt, settings) {
  if (!settings.anti_spam || !txt) return null;
  return SPAM_PATTERNS.some(re => re.test(txt)) ? 'spam' : null;
}

function extractDomains(txt) {
  const out = [];
  const re = /(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=[\/\s,،]|$)/gi;
  let m;
  while ((m = re.exec(txt))) out.push(m[1].toLowerCase());
  return out;
}

function checkLink(txt, settings) {
  if (!settings.anti_link || !txt) return null;
  const hasLink = /https?:\/\/|t\.me\/|telegram\.me\/|www\.[a-z0-9-]+\.[a-z]{2,}/i.test(txt);
  if (!hasLink) return null;
  const wl = settings.link_whitelist || [];
  if (!wl.length) return 'link';
  const domains = extractDomains(txt);
  const allWhitelisted = domains.length > 0 && domains.every(d => wl.some(w => d === w.toLowerCase() || d.endsWith('.' + w.toLowerCase())));
  return allWhitelisted ? null : 'link';
}

async function checkWords(chatId, txt, settings) {
  if (!settings.anti_words || !txt) return null;
  const words = await getBannedWordsCached(chatId);
  if (!words.length) return null;
  const lower = txt.toLowerCase();
  return words.some(w => w && lower.includes(w)) ? 'words' : null;
}

function checkMention(ctx, settings) {
  if (!settings.anti_mention) return null;
  const entities = ctx.message?.entities || ctx.message?.caption_entities || [];
  const count = entities.filter(e => e.type === 'mention' || e.type === 'text_mention').length;
  return count > (settings.mention_limit || 4) ? 'mention' : null;
}

function checkCaps(txt, settings) {
  if (!settings.anti_caps || !txt) return null;
  if (txt.length < (settings.caps_min_len || 15)) return null;
  const letters = txt.replace(/[^a-zA-Z]/g, '');
  if (letters.length < (settings.caps_min_len || 15)) return null;
  const upper = letters.replace(/[^A-Z]/g, '');
  const pct = (upper.length / letters.length) * 100;
  return pct >= (settings.caps_percent || 70) ? 'caps' : null;
}

function checkLength(txt, settings) {
  if (!settings.max_msg_len || !txt) return null;
  return txt.length > settings.max_msg_len ? 'length' : null;
}

function checkForward(ctx, settings) {
  if (!settings.anti_forward) return null;
  const msg = ctx.message;
  return (msg.forward_date || msg.forward_from || msg.forward_from_chat || msg.forward_sender_name || msg.forward_origin) ? 'forward' : null;
}

// ── جديد: روابط مختصرة ──
const SHORT_LINK_DOMAINS = ['bit.ly','tinyurl.com','t.co','goo.gl','ow.ly','buff.ly','short.link','rb.gy','cutt.ly','is.gd','bl.ink','shorturl.at','tiny.cc','clck.ru','urlshortener.me'];
function checkShortLink(txt, settings) {
  if (!settings.anti_short_link || !txt) return null;
  const lower = txt.toLowerCase();
  return SHORT_LINK_DOMAINS.some(d => lower.includes(d)) ? 'short_link' : null;
}

// ── جديد: روابط دعوة تيليجرام ──
function checkInviteLink(txt, settings) {
  if (!settings.anti_invite || !txt) return null;
  return /t\.me\/\+[a-zA-Z0-9_-]{10,}|telegram\.me\/\+/i.test(txt) ? 'invite_link' : null;
}

// ── جديد: مكافحة الوسائط (صور/فيديو) ──
function checkMedia(ctx, settings) {
  if (!settings.anti_media) return null;
  const msg = ctx.message;
  return (msg.photo || msg.video || msg.video_note) ? 'media' : null;
}

// ── جديد: مكافحة الملفات ──
function checkFile(ctx, settings) {
  if (!settings.anti_file) return null;
  const msg = ctx.message;
  return (msg.document || msg.audio) ? 'file' : null;
}

function checkLocks(msg, locks) {
  if (locks.sticker && msg.sticker) return 'lock_sticker';
  if (locks.gif && msg.animation) return 'lock_gif';
  if (locks.photo && msg.photo) return 'lock_photo';
  if (locks.video && (msg.video || msg.video_note)) return 'lock_video';
  if (locks.voice && (msg.voice || msg.audio)) return 'lock_voice';
  if (locks.poll && msg.poll) return 'lock_poll';
  if (locks.forward && (msg.forward_date || msg.forward_from)) return 'lock_forward';
  if (locks.link && msg.text && /https?:\/\/|t\.me\/|@\w{4,}/i.test(msg.text)) return 'lock_link';
  return null;
}

// ══════════════════════════════════════════════════════════
// 🔐 ربط الأقفال بصلاحيات تيليجرام الفعلية (setChatPermissions)
// ──────────────────────────────────────────────────────────
// عند تفعيل قفل (مثل 🖼 الصور)، يُمنع الأعضاء من إرسالها على
// مستوى تيليجرام نفسه — وليس فقط حذفها بعد الإرسال.
// ⚠️ ملاحظة من تيليجرام: الملصقات والصور المتحركة يتشاركان
// نفس الصلاحية (can_send_other_messages)، والروابط/التوجيه
// ليس لهما صلاحية مباشرة في تيليجرام (يبقيان حذفاً فورياً من البوت).
// ══════════════════════════════════════════════════════════
const PERMISSION_LOCK_MAP = {
  photo:   ['can_send_photos'],
  video:   ['can_send_videos', 'can_send_video_notes'],
  voice:   ['can_send_voice_notes', 'can_send_audios'],
  poll:    ['can_send_polls'],
  sticker: ['can_send_other_messages'],
  gif:     ['can_send_other_messages'],
  file:    ['can_send_documents'],
  chat:    ['can_send_messages'],
  invite:  ['can_invite_users'],
  pin:     ['can_pin_messages'],
  info:    ['can_change_info'],
};

const PERMISSION_FIELDS = [
  'can_send_messages', 'can_send_audios', 'can_send_documents', 'can_send_photos',
  'can_send_videos', 'can_send_video_notes', 'can_send_voice_notes', 'can_send_polls',
  'can_send_other_messages', 'can_add_web_page_previews', 'can_change_info',
  'can_invite_users', 'can_pin_messages', 'can_manage_topics',
];

const MEDIA_FALLBACK_FIELDS = ['can_send_audios', 'can_send_documents', 'can_send_photos', 'can_send_videos', 'can_send_video_notes', 'can_send_voice_notes'];

// يحوّل permissions القادمة من getChat إلى مجموعة حقول حديثة موحّدة
function pickPermissions(perm) {
  const out = {};
  for (const f of PERMISSION_FIELDS) {
    if (perm && typeof perm[f] === 'boolean') { out[f] = perm[f]; continue; }
    if (perm && typeof perm.can_send_media_messages === 'boolean' && MEDIA_FALLBACK_FIELDS.includes(f)) { out[f] = perm.can_send_media_messages; continue; }
    out[f] = true; // افتراضي مسموح
  }
  return out;
}

// يطبّق الأقفال الحالية للقروب كصلاحيات فعلية على تيليجرام
async function applyLockPermissions(ctx, chatId) {
  const locks = await db.getLocks(chatId);
  let chat;
  try { chat = await ctx.telegram.getChat(chatId); }
  catch (e) { return { ok: false, error: e.message }; }

  const merged = pickPermissions(chat.permissions);

  // 1) أي قفل مفعّل → أقفل صلاحياته
  for (const [lockType, permKeys] of Object.entries(PERMISSION_LOCK_MAP)) {
    if (!locks[lockType]) continue;
    for (const pk of permKeys) merged[pk] = false;
  }
  // 2) أي قفل معطّل → أعد فتح صلاحياته فقط إن لم يشاركه قفل آخر مفعّل
  for (const [lockType, permKeys] of Object.entries(PERMISSION_LOCK_MAP)) {
    if (locks[lockType]) continue;
    for (const pk of permKeys) {
      const sharers = Object.entries(PERMISSION_LOCK_MAP).filter(([, pks]) => pks.includes(pk)).map(([lt]) => lt);
      if (!sharers.some(lt => locks[lt])) merged[pk] = true;
    }
  }

  try {
    await ctx.telegram.setChatPermissions(chatId, merged, { use_independent_chat_permissions: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function anyProtectionEnabled(s) {
  return !!(s.anti_spam || s.anti_link || s.anti_flood || s.anti_forward ||
            s.anti_mention || s.anti_words || s.anti_caps || s.anti_duplicate ||
            s.anti_short_link || s.anti_invite || s.anti_media || s.anti_file ||
            (s.max_msg_len > 0));
}

// ══════════════════════════════════════════════════════════
// ⚖️ سلّم العقوبات الذكي
// ══════════════════════════════════════════════════════════
function resolveAction(ladder, count) {
  ladder = ladder && Object.keys(ladder).length ? ladder : db.DEFAULT_SETTINGS.punish_ladder;
  if (ladder[String(count)]) return ladder[String(count)];
  const keys = Object.keys(ladder).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
  if (!keys.length) return 'warn';
  const maxKey = keys[keys.length - 1];
  if (count > maxKey) return ladder[String(maxKey)] || 'ban';
  for (const k of keys) if (count <= k) return ladder[String(k)];
  return 'warn';
}

function actionLabel(action) {
  if (!action || action === 'none') return '';
  if (action === 'warn') return 'تحذير';
  if (action === 'kick') return 'طرد';
  if (action === 'ban')  return 'حظر';
  if (action.startsWith('mute_')) {
    const mins = parseInt(action.split('_')[1]) || 0;
    if (mins <= 0) return 'كتم دائم';
    if (mins < 60) return 'كتم ' + mins + ' دقيقة';
    if (mins < 1440) return 'كتم ' + Math.round(mins / 60) + ' ساعة';
    return 'كتم ' + Math.round(mins / 1440) + ' يوم';
  }
  return action;
}

async function executeAction(ctx, chatId, uid, action, botUserId) {
  if (!action || action === 'none') return '';

  if (action === 'warn') {
    await run(
      `INSERT INTO group_warns(chat_id,user_id,warned_by,reason,created_at) VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)`,
      [chatId, uid, botUserId || 0, '🛡 مخالفة حماية تلقائية']
    ).catch(() => {});
    return actionLabel(action);
  }

  if (action.startsWith('mute_')) {
    const mins = parseInt(action.split('_')[1]) || 60;
    await ctx.telegram.restrictChatMember(chatId, uid, {
      permissions: { can_send_messages: false, can_send_media_messages: false, can_send_polls: false, can_send_other_messages: false },
      until_date: mins > 0 ? Math.floor(Date.now() / 1000) + mins * 60 : undefined,
    }).catch(() => {});
    return actionLabel(action);
  }

  if (action === 'kick') {
    await ctx.telegram.banChatMember(chatId, uid).catch(() => {});
    await ctx.telegram.unbanChatMember(chatId, uid).catch(() => {});
    return actionLabel(action);
  }

  if (action === 'ban') {
    await ctx.telegram.banChatMember(chatId, uid).catch(() => {});
    await run(
      `INSERT INTO group_bans(chat_id,user_id,banned_by,reason,created_at) VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)
       ON CONFLICT(chat_id,user_id) DO UPDATE SET reason=$4`,
      [chatId, uid, botUserId || 0, '🛡 مخالفات متكررة (نظام الحماية)']
    ).catch(() => {});
    await db.resetViolations(chatId, uid);
    return actionLabel(action);
  }

  return '';
}

// ══════════════════════════════════════════════════════════
// 🚨 معالجة المخالفة (حذف + تسجيل + عقوبة)
// ══════════════════════════════════════════════════════════
async function handleViolation(ctx, chatId, uid, type, settings) {
  await ctx.deleteMessage().catch(() => {});

  const label = violationLabel(type);
  await db.addViolation(chatId, uid, type, '', label);
  const count = await db.getViolationCount(chatId, uid, settings.violation_window_hours || 24);
  const action = resolveAction(settings.punish_ladder, count);

  let actionText = '';
  try { actionText = await executeAction(ctx, chatId, uid, action, ctx.botInfo?.id); }
  catch (_) { actionText = ''; }

  const name = ctx.from.first_name || 'عضو';
  const msg = await ctx.reply(
    '🛡 *' + label + '*\n' +
    '👤 [' + name + '](tg://user?id=' + uid + ')\n' +
    '🔢 المخالفات (' + (settings.violation_window_hours || 24) + 'س): *' + count + '*' +
    (actionText ? '\n⚡ الإجراء: *' + actionText + '*' : ''),
    { parse_mode: 'Markdown' }
  ).catch(() => null);
  if (msg) setTimeout(() => ctx.telegram.deleteMessage(chatId, msg.message_id).catch(() => {}), 8000);

  try {
    await require('./group_logs').logAction({ telegram: ctx.telegram }, chatId, 'violation', {
      targetId: uid, targetName: name,
      details: label + (actionText ? ' • الإجراء: ' + actionText : '') + ' • العدد: ' + count,
    });
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════
// 🔒 محتوى مقفول — حذف فوري وصامت (بدون إنذار أو سلّم عقوبات)
// ══════════════════════════════════════════════════════════
async function handleLockDelete(ctx, chatId, uid, type) {
  await ctx.deleteMessage().catch(() => {});
  try {
    await require('./group_logs').logAction({ telegram: ctx.telegram }, chatId, 'lock_delete', {
      targetId: uid, targetName: ctx.from?.first_name || '',
      details: '🔒 ' + violationLabel(type) + ' — حذف تلقائي',
    });
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════
// 🚀 الفحص الرئيسي — رسائل عادية
// ══════════════════════════════════════════════════════════
async function runProtection(ctx) {
  if (ctx.chat?.type === 'private' || !ctx.message || !ctx.from || ctx.from.is_bot) return false;
  const chatId = ctx.chat.id;
  const uid     = ctx.from.id;

  if (ctx.isOwner || ctx.isAdmin) return false;

  const [settings, locks] = await Promise.all([getSettings(chatId), getLocksCached(chatId)]);
  const anyLock = Object.values(locks).some(Boolean);
  if (!anyLock && !anyProtectionEnabled(settings)) return false;

  if (await isTelegramAdmin(ctx, chatId, uid)) return false;

  const txt = ctx.message.text || ctx.message.caption || '';
  const now = Date.now();
  const key = chatId + '_' + uid;

  // 🔒 الأقفال أولاً — حذف فوري وصامت، لا تُحسب كمخالفة ولا تدخل سلّم العقوبات
  if (anyLock) {
    const lockHit = checkLocks(ctx.message, locks);
    if (lockHit) {
      await handleLockDelete(ctx, chatId, uid, lockHit);
      return true;
    }
  }

  let violation = checkFlood(key, now, settings);
  if (!violation) violation = checkDuplicate(key, txt, now, settings);
  if (!violation) violation = checkCrossSpam(chatId, uid, txt, now, settings);
  if (!violation) violation = checkSpamPattern(txt, settings);
  if (!violation) violation = checkLink(txt, settings);
  if (!violation) violation = await checkWords(chatId, txt, settings);
  if (!violation) violation = checkMention(ctx, settings);
  if (!violation) violation = checkCaps(txt, settings);
  if (!violation) violation = checkLength(txt, settings);
  if (!violation) violation = checkForward(ctx, settings);
  if (!violation) violation = checkShortLink(txt, settings);
  if (!violation) violation = checkInviteLink(txt, settings);
  if (!violation) violation = checkMedia(ctx, settings);
  if (!violation) violation = checkFile(ctx, settings);

  if (!violation) return false;

  await handleViolation(ctx, chatId, uid, violation, settings);
  return true;
}

// ══════════════════════════════════════════════════════════
// ✏️ فحص الرسائل المعدَّلة (anti_edit)
// ══════════════════════════════════════════════════════════
async function checkEdited(ctx, msg) {
  try {
    const chat = msg?.chat;
    const from = msg?.from;
    if (!chat || !from || from.is_bot) return false;
    if (chat.type === 'private') return false;
    const chatId = chat.id;
    const uid     = from.id;

    if (parseInt(uid) === OWNER_ID) return false;

    const settings = await getSettings(chatId);
    if (!settings.anti_edit) return false;
    if (await isTelegramAdmin(ctx, chatId, uid)) return false;

    const txt = msg.text || msg.caption || '';
    let violation = checkLink(txt, settings)
      || await checkWords(chatId, txt, settings)
      || checkSpamPattern(txt, settings)
      || checkCaps(txt, settings)
      || checkLength(txt, settings);

    if (!violation) return false;

    await ctx.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
    await db.addViolation(chatId, uid, 'edit_' + violation, '', 'تعديل رسالة → ' + violationLabel(violation));
    const count  = await db.getViolationCount(chatId, uid, settings.violation_window_hours || 24);
    const action = resolveAction(settings.punish_ladder, count);
    let actionText = '';
    try { actionText = await executeAction(ctx, chatId, uid, action, ctx.botInfo?.id); } catch (_) {}

    const m = await ctx.telegram.sendMessage(chatId,
      '✏️🛡 *تعديل رسالة لتصبح مخالفة*\n' +
      '👤 [' + (from.first_name || 'عضو') + '](tg://user?id=' + uid + ')\n' +
      '📝 السبب: ' + violationLabel(violation) +
      (actionText ? '\n⚡ الإجراء: *' + actionText + '*' : ''),
      { parse_mode: 'Markdown' }
    ).catch(() => null);
    if (m) setTimeout(() => ctx.telegram.deleteMessage(chatId, m.message_id).catch(() => {}), 8000);

    await require('./group_logs').logAction({ telegram: ctx.telegram }, chatId, 'violation', {
      targetId: uid, targetName: from.first_name || '',
      details: 'تعديل رسالة → ' + violationLabel(violation) + (actionText ? ' • الإجراء: ' + actionText : ''),
    }).catch(() => {});

    return true;
  } catch (e) {
    logger.error('[Protection.checkEdited] ' + e.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════
// 🤖 مكافحة البوتات غير المصرّح بها (anti_bot)
// ══════════════════════════════════════════════════════════
async function checkNewChatMembers(ctx) {
  try {
    const members = ctx.message?.new_chat_members;
    if (!members?.length) return false;
    const chatId = ctx.chat.id;
    const settings = await getSettings(chatId);
    if (!settings.anti_bot) return false;

    const adder = ctx.message.from;
    const adderOk = adder && (parseInt(adder.id) === OWNER_ID || await isTelegramAdmin(ctx, chatId, adder.id));

    let removed = 0;
    for (const m of members) {
      if (!m.is_bot) continue;
      if (m.id === ctx.botInfo?.id) continue;
      if (adderOk) continue;

      try {
        await ctx.telegram.banChatMember(chatId, m.id);
        await ctx.telegram.unbanChatMember(chatId, m.id);
        removed++;
        await require('./group_logs').logAction({ telegram: ctx.telegram }, chatId, 'violation', {
          actorId: adder?.id, actorName: adder?.first_name || '',
          targetId: m.id, targetName: m.first_name || m.username || 'بوت',
          details: '🤖 إزالة بوت غير مصرّح به (anti_bot)',
        }).catch(() => {});
      } catch (_) {}
    }

    if (removed) {
      const m = await ctx.reply('🤖 *تمت إزالة ' + removed + ' بوت غير مصرّح به!*\n_فقط المشرفون يمكنهم إضافة بوتات._', { parse_mode: 'Markdown' }).catch(() => null);
      if (m) setTimeout(() => ctx.telegram.deleteMessage(chatId, m.message_id).catch(() => {}), 10000);
      return true;
    }
    return false;
  } catch (e) {
    logger.error('[Protection.checkNewChatMembers] ' + e.message);
    return false;
  }
}

module.exports = {
  DEFAULT_SETTINGS: db.DEFAULT_SETTINGS,
  getSettings, clearSettingsCache, updateSettings,
  getLocksCached, clearLocksCache,
  getBannedWordsCached, clearWordsCache,
  isTelegramAdmin, clearAdminCache,
  runProtection, checkEdited, checkNewChatMembers,
  resolveAction, actionLabel, violationLabel,
  VIOLATION_LABELS, SPAM_PATTERNS,
  PERMISSION_LOCK_MAP, applyLockPermissions, handleLockDelete,
};
