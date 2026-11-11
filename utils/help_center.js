'use strict';
// ══════════════════════════════════════════════════════════════════════
//  🤖 مركز المساعدة الموحّد — المرحلة 3
//
//  يُبنى بالكامل من السجل المركزي (utils/command_registry.js):
//   • لا نصوص مساعدة ثابتة تنحرف عن الكود (كانت تذكر /words و/settings ولا وجود لهما).
//   • يتكيّف مع الجمهور: خاص/قروب × عادي/مشرف. المستخدم العادي لا يرى أوامر الإشراف.
//   • أمثلة الاستخدام من حقل examples في السجل.
//   • HTML مُهرَّب بدل Markdown (الشرطة السفلية في أسماء الأوامر تكسر Markdown).
//   • وحدة نقية: لا تعتمد على تيليجراف ولا قاعدة البيانات، فتُختبر كاملة بلا شبكة.
//
//  مفاتيح الأزرار: help_<قسم> في القروب، phelp_<قسم> في الخاص (توافق كامل مع القديم).
// ══════════════════════════════════════════════════════════════════════

const registry = require('./command_registry');

const MAX_MESSAGE = 4096;
const DIVIDER = '━━━━━━━━━━━━━━━━';
const PREFIX = Object.freeze({ group: 'help_', private: 'phelp_' });

// مفاتيح أزرار قديمة تغيّر معناها: في الخاص كان content = تصفح الملفات، وصار القسم study
const LEGACY_KEYS = Object.freeze({ private: { content: 'study' }, group: {} });

const esc = v => String(v)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/**
 * @param {{chatType?:string, isAdmin?:boolean}} p
 * @returns {{chat:'private'|'group', admin:boolean}}
 */
function audience(p = {}) {
  return { chat: p.chatType === 'private' ? 'private' : 'group', admin: !!p.isAdmin };
}

function _data(data) {
  return {
    commands: (data && data.commands) || registry.COMMANDS,
    triggers: (data && data.triggers) || registry.TRIGGERS,
    categories: (data && data.categories) || registry.CATEGORIES,
  };
}

const _scopeOk = (item, aud) => item.scope === 'both' || item.scope === aud.chat;
const _roleOk = (item, aud) => item.role === 'user' || (item.role === 'admin' && aud.admin);

/** كل ما يراه هذا الجمهور، مجمَّعاً بالأقسام وبترتيب السجل. */
function visibleByCategory(aud, data) {
  const d = _data(data);
  const out = new Map();
  for (const key of Object.keys(d.categories)) out.set(key, { commands: [], triggers: [] });
  for (const c of d.commands) if (out.has(c.category) && _scopeOk(c, aud) && _roleOk(c, aud)) out.get(c.category).commands.push(c);
  for (const t of d.triggers) if (out.has(t.category) && _scopeOk(t, aud) && _roleOk(t, aud)) out.get(t.category).triggers.push(t);
  for (const [k, v] of [...out]) if (!v.commands.length && !v.triggers.length) out.delete(k);
  return out;
}

function categoriesFor(aud, data) {
  return [...visibleByCategory(aud, data).keys()];
}

const _slash = a => (/^[a-z0-9_]+$/i.test(a) ? '/' + a : a);

function _aliasLine(c) {
  const parts = [];
  for (const a of c.aliases || []) parts.push(_slash(a));
  for (const t of c.textAliases || []) parts.push(typeof t === 'string' ? t : t.say);
  return parts.length ? '   ↳ أو: ' + parts.map(esc).join('، ') : '';
}

function _renderCommand(c, aud) {
  const lock = aud.admin && c.role === 'admin' ? ' 🔒' : '';
  const lines = ['<code>' + esc(c.usage) + '</code> — ' + esc(c.desc) + lock];
  const al = _aliasLine(c);
  if (al) lines.push(al);
  if (c.examples && c.examples.length) lines.push('   مثال: ' + c.examples.map(e => '<code>' + esc(e) + '</code>').join('  '));
  return lines.join('\n');
}

function _renderTrigger(t, aud) {
  const lock = aud.admin && t.role === 'admin' ? ' 🔒' : '';
  return '<code>' + esc(t.say) + '</code> — ' + esc(t.desc) + lock;
}

function _fit(text) {
  if (text.length <= MAX_MESSAGE) return text;
  const cut = text.slice(0, MAX_MESSAGE - 2);
  return cut.slice(0, cut.lastIndexOf('\n')) + '\n…';
}

function _btn(label, prefix, key) { return { text: label, callback_data: prefix + key }; }

function _homeKeyboard(keys, aud, d) {
  const prefix = PREFIX[aud.chat];
  const rows = [];
  for (let i = 0; i < keys.length; i += 2) {
    rows.push(keys.slice(i, i + 2).map(k => _btn(d.categories[k].icon + ' ' + d.categories[k].label, prefix, k)));
  }
  return { inline_keyboard: rows };
}

/** الصفحة الرئيسية: أقسام مرئية لهذا الجمهور فقط. */
function buildHome(aud, data) {
  const d = _data(data);
  const keys = categoriesFor(aud, data);
  let text = '🤖 <b>مركز المساعدة</b>\n' + DIVIDER + '\nاختر القسم:';
  if (aud.admin) text += '\n\n🔒 = أوامر للمشرفين فقط';
  if (aud.chat === 'private') text += '\n\n💡 <i>إذا رغبت بأوامر إدارة قروب معين، اكتب اوامر داخل ذاك القروب مباشرة.</i>';
  return { text: _fit(text), parse_mode: 'HTML', reply_markup: _homeKeyboard(keys, aud, d) };
}

/** صفحة قسم. تعيد null إن لم يكن القسم موجوداً أو لا يراه هذا الجمهور. */
function buildCategory(key, aud, data) {
  const d = _data(data);
  const real = (LEGACY_KEYS[aud.chat] || {})[key] || key;
  const vis = visibleByCategory(aud, data).get(real);
  if (!vis) return null;
  const cat = d.categories[real];
  const blocks = [
    ...vis.commands.map(c => _renderCommand(c, aud)),
    ...vis.triggers.map(t => _renderTrigger(t, aud)),
  ];
  const text = cat.icon + ' <b>' + esc(cat.label) + '</b>\n' + DIVIDER + '\n' + blocks.join('\n');
  return {
    text: _fit(text),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[_btn('◀️ رجوع', PREFIX[aud.chat], 'home')]] },
  };
}

/**
 * يحلّل callback_data إلى إجراء. يعيد null إن لم تكن بيانات مساعدة.
 * @returns {{aud:'private'|'group', action:'home'|'category', key?:string}|null}
 */
function parseCallback(data) {
  const s = String(data || '');
  for (const [chat, prefix] of Object.entries(PREFIX)) {
    if (s.startsWith(prefix)) {
      const key = s.slice(prefix.length);
      return key === 'home' ? { chat, action: 'home' } : { chat, action: 'category', key };
    }
  }
  return null;
}

/** هل المفتاح قسم معروف (أو مفتاح قديم محوَّل)؟ يحمي مسار الأزرار القديمة من مفاتيح عشوائية. */
function isCategory(key, data) {
  const d = _data(data);
  const k = String(key);
  return Object.prototype.hasOwnProperty.call(d.categories, k) ||
    Object.values(LEGACY_KEYS).some(m => Object.prototype.hasOwnProperty.call(m, k));
}

module.exports = {
  audience, categoriesFor, visibleByCategory,
  buildHome, buildCategory, parseCallback, isCategory,
  esc, PREFIX, LEGACY_KEYS, MAX_MESSAGE,
};
