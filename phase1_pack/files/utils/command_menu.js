'use strict';
/**
 * utils/command_menu.js — يبني قوائم الأوامر من السجل المركزي ويرسلها لتيليجرام
 * (setMyCommands)، فيظهر للمستخدم زر "القائمة" عند كتابة "/" دون حفظ الأسماء.
 *
 * ثلاث قوائم حسب النطاق (scope) — كل مستخدم يرى ما يخصّه فقط:
 *   - الخاص (والافتراضي): أوامر المستخدم العادي في الخاص.
 *   - القروبات (لكل الأعضاء): أوامر الأعضاء فقط.
 *   - مشرفو القروبات: أوامر الأعضاء + أوامر الإشراف
 *     (تيليجرام يعرض للمشرف قائمة مشرفي القروب فقط، فلازم تحوي أوامر الأعضاء أيضاً).
 *
 * سلوك آمن:
 *   - يتحقق من كل القوائم أولاً؛ لو فيها أي خطأ لا يُرسل شيء إطلاقاً.
 *   - فشل نطاق واحد لا يوقف باقي النطاقات ولا يوقف البوت.
 *   - COMMAND_MENU_SYNC=off يعطّل المزامنة كلياً (مثلاً لو تفضّل ضبط القائمة يدوياً من BotFather).
 */
const { COMMANDS } = require('./command_registry');

const NAME_RE = /^[a-z0-9_]{1,32}$/;      // شرط تيليجرام لاسم الأمر
const MAX_DESC = 256;                      // شرط تيليجرام لوصف الأمر
const MAX_PER_SCOPE = 100;                 // أقصى عدد أوامر لكل نطاق

// تيليجرام: scope غير مرسَل = النطاق الافتراضي
const TARGETS = Object.freeze([
  { key: 'default', scope: null },
  { key: 'private', scope: { type: 'all_private_chats' } },
  { key: 'group',   scope: { type: 'all_group_chats' } },
  { key: 'admins',  scope: { type: 'all_chat_administrators' } },
]);

const toBotCommand = (c) => ({ command: c.name, description: c.desc });

function buildMenus(commands = COMMANDS) {
  const pick = (scopes, roles) =>
    commands.filter(c => scopes.includes(c.scope) && roles.includes(c.role)).map(toBotCommand);
  const priv = pick(['private', 'both'], ['user']);
  return {
    default: priv,
    private: priv,
    group:   pick(['group', 'both'], ['user']),
    admins:  pick(['group', 'both'], ['user', 'admin']),
  };
}

/** يرجع مصفوفة مشاكل (فارغة = سليم). */
function validateMenus(menus) {
  const problems = [];
  for (const [key, list] of Object.entries(menus)) {
    if (list.length > MAX_PER_SCOPE) problems.push(`${key}: ${list.length} أمر (الحد ${MAX_PER_SCOPE})`);
    const seen = new Set();
    for (const bc of list) {
      if (!NAME_RE.test(bc.command)) problems.push(`${key}: اسم غير صالح "${bc.command}"`);
      if (!bc.description || bc.description.length > MAX_DESC) problems.push(`${key}: وصف غير صالح لـ /${bc.command}`);
      if (seen.has(bc.command)) problems.push(`${key}: اسم مكرر /${bc.command}`);
      seen.add(bc.command);
    }
  }
  return problems;
}

async function applyCommandMenus(telegram, opts = {}) {
  const env = opts.env || process.env;
  const log = opts.logger || require('./logger');

  if (String(env.COMMAND_MENU_SYNC || 'on').toLowerCase() === 'off') {
    log.info('[CommandMenu] المزامنة معطّلة (COMMAND_MENU_SYNC=off)');
    return { skipped: true, reason: 'disabled', ok: 0, failed: 0 };
  }

  const menus = buildMenus(opts.commands);
  const problems = validateMenus(menus);
  if (problems.length) {
    log.error('[CommandMenu] قوائم غير صالحة — لم يُرسل شيء: ' + problems.join(' | '));
    return { skipped: true, reason: 'invalid', problems, ok: 0, failed: 0 };
  }

  let ok = 0, failed = 0;
  for (const t of TARGETS) {
    try {
      await telegram.setMyCommands(menus[t.key], t.scope ? { scope: t.scope } : {});
      ok++;
    } catch (e) {
      failed++;
      log.error('[CommandMenu] فشل ضبط قائمة "' + t.key + '": ' + (e && e.message));
    }
  }
  log.info('[CommandMenu] تمت المزامنة: ' + ok + '/' + TARGETS.length + ' نطاقات');
  return { skipped: false, ok, failed };
}

module.exports = { buildMenus, validateMenus, applyCommandMenus, TARGETS, NAME_RE, MAX_DESC, MAX_PER_SCOPE };
