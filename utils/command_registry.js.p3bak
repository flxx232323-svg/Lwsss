'use strict';
/**
 * utils/command_registry.js — السجل المركزي للأوامر الموثّقة.
 *
 * مصدر واحد للحقيقة لثلاثة استخدامات (المرحلة 1 تستخدم الأول فقط):
 *   1) قائمة الأوامر داخل تيليجرام عند كتابة "/"   (utils/command_menu.js)
 *   2) مركز المساعدة الموحّد                        (مرحلة لاحقة)
 *   3) تخصيص صلاحية كل أمر لكل مجموعة               (مرحلة لاحقة)
 *
 * ⚠️ قواعد صارمة لإضافة أي أمر هنا:
 *   - لا يُضاف أمر إلا بعد قراءة معالجه والتأكد من وصفه ومن يحق له تنفيذه.
 *   - الاسم الأساسي (name) لاتيني فقط (شرط تيليجرام للقائمة: a-z 0-9 _ حتى 32).
 *   - aliases: أسماء بديلة (عربية أو لاتينية) موجودة فعلاً في نفس مصفوفة
 *     bot.command([...]) بالكود. الاختبار يفحص ذلك آلياً ويفشل عند أي خطأ.
 *   - role: 'user' = أي عضو | 'admin' = مشرف القروب (أو أدمن/مالك البوت).
 *   - scope: 'private' | 'group' | 'both' = أين يعمل الأمر فعلياً.
 *
 * هذا الملف بيانات فقط: لا يغيّر سلوك أي معالج موجود.
 */

const CATEGORIES = Object.freeze({
  general: { label: 'عام',               icon: '🤖' },
  study:   { label: 'الدراسة',           icon: '📚' },
  ai:      { label: 'الذكاء الاصطناعي',  icon: '🧠' },
  members: { label: 'أعضاء القروب',      icon: '👥' },
  mod:     { label: 'الإشراف',           icon: '🛡️' },
  roles:   { label: 'الرتب',             icon: '🎭' },
});

const ROLES  = Object.freeze(['user', 'admin']);
const SCOPES = Object.freeze(['private', 'group', 'both']);

const COMMANDS = Object.freeze([
  // ── عام (الخاص) ────────────────────────────────────────────
  { name: 'start',    category: 'general', role: 'user', scope: 'private',
    desc: 'ابدأ استخدام البوت', usage: '/start' },
  { name: 'help',     category: 'general', role: 'user', scope: 'both',
    aliases: ['مساعدة', 'cmds', 'commands', 'اوامر', 'أوامر'],
    desc: 'مركز المساعدة: الأقسام والأوامر', usage: '/help' },
  { name: 'cancel',   category: 'general', role: 'user', scope: 'private',
    desc: 'إلغاء العملية الحالية', usage: '/cancel' },
  { name: 'mygroups', category: 'general', role: 'user', scope: 'private',
    desc: 'قروباتي وإضافة البوت لقروب', usage: '/mygroups' },

  // ── الدراسة ───────────────────────────────────────────────
  { name: 'search',   category: 'study',   role: 'user', scope: 'private',
    desc: 'البحث في ملفات المنصة', usage: '/search كلمة البحث' },

  // ── الذكاء الاصطناعي ──────────────────────────────────────
  { name: 'ai',       category: 'ai',      role: 'user', scope: 'private',
    desc: 'الدردشة مع الذكاء الاصطناعي', usage: '/ai' },
  { name: 'reset',    category: 'ai',      role: 'user', scope: 'private',
    desc: 'مسح سياق محادثة الذكاء الاصطناعي', usage: '/reset' },

  // ── أعضاء القروب ──────────────────────────────────────────
  { name: 'rules',    category: 'members', role: 'user', scope: 'group',
    aliases: ['قواعد'],
    desc: 'عرض قواعد القروب', usage: '/rules' },
  { name: 'report',   category: 'members', role: 'user', scope: 'group',
    aliases: ['بلاغ'],
    desc: 'إبلاغ المشرفين عن رسالة (بالرد عليها)', usage: '/report' },

  // ── الإشراف (مشرفو القروب) ────────────────────────────────
  { name: 'ban',      category: 'mod', role: 'admin', scope: 'group',
    desc: 'حظر عضو (بالرد على رسالته)',          usage: '/ban' },
  { name: 'unban',    category: 'mod', role: 'admin', scope: 'group',
    desc: 'رفع الحظر عن عضو',                    usage: '/unban' },
  { name: 'kick',     category: 'mod', role: 'admin', scope: 'group',
    desc: 'طرد عضو من القروب',                   usage: '/kick' },
  { name: 'mute',     category: 'mod', role: 'admin', scope: 'group',
    desc: 'كتم عضو',                             usage: '/mute' },
  { name: 'unmute',   category: 'mod', role: 'admin', scope: 'group',
    desc: 'رفع الكتم عن عضو',                    usage: '/unmute' },
  { name: 'warn',     category: 'mod', role: 'admin', scope: 'group',
    desc: 'تحذير عضو',                           usage: '/warn' },
  { name: 'unwarn',   category: 'mod', role: 'admin', scope: 'group',
    desc: 'إزالة تحذيرات عضو',                   usage: '/unwarn' },
  { name: 'warns',    category: 'mod', role: 'admin', scope: 'group',
    desc: 'عرض تحذيرات عضو',                     usage: '/warns' },
  { name: 'pin',      category: 'mod', role: 'admin', scope: 'group',
    desc: 'تثبيت رسالة (بالرد عليها)',           usage: '/pin' },
  { name: 'unpin',    category: 'mod', role: 'admin', scope: 'group',
    desc: 'إلغاء تثبيت رسالة',                   usage: '/unpin' },
  { name: 'del',      category: 'mod', role: 'admin', scope: 'group',
    desc: 'حذف رسالة (بالرد عليها)',             usage: '/del' },
  { name: 'promote',  category: 'mod', role: 'admin', scope: 'group',
    desc: 'ترقية عضو إلى مشرف (بالرد عليه)',     usage: '/promote' },
  { name: 'demote',   category: 'mod', role: 'admin', scope: 'group',
    desc: 'تنزيل مشرف إلى عضو',                  usage: '/demote' },
  { name: 'info',     category: 'mod', role: 'admin', scope: 'group',
    desc: 'معلومات عضو',                         usage: '/info' },
  { name: 'tag',      category: 'mod', role: 'admin', scope: 'group',
    desc: 'منشن جميع الأعضاء (مع نص اختياري)',   usage: '/tag نص اختياري' },
  { name: 'all',      category: 'mod', role: 'admin', scope: 'group',
    desc: 'منشن الكل',                           usage: '/all' },
  { name: 'setlog',   category: 'mod', role: 'admin', scope: 'group',
    desc: 'تعيين قناة سجل الإجراءات',            usage: '/setlog' },

  // ── الرتب ─────────────────────────────────────────────────
  { name: 'setrole',    category: 'roles', role: 'admin', scope: 'group',
    desc: 'تعيين رتبة لعضو',  usage: '/setrole' },
  { name: 'removerole', category: 'roles', role: 'admin', scope: 'group',
    desc: 'إزالة رتبة من عضو', usage: '/removerole' },
]);

/** بحث بالاسم الأساسي أو أي اسم بديل (غير حساس لحالة الأحرف). */
function findCommand(nameOrAlias) {
  const n = String(nameOrAlias || '').replace(/^\//, '').toLowerCase();
  return COMMANDS.find(c => c.name === n || (c.aliases || []).some(a => a.toLowerCase() === n)) || null;
}

module.exports = { CATEGORIES, ROLES, SCOPES, COMMANDS, findCommand };
