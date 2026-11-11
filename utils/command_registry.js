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
 *   - textAliases (المرحلة 3): عبارات عربية نصية تُسجَّل بـ bot.hears (ليست في مصفوفة
 *     bot.command). نص صريح، أو {say, sample}: say يُعرض للمستخدم، وsample عبارة فعلية
 *     يجب أن يطابقها تعبير hears حيّ. يفحص الاختبار ذلك آلياً.
 *   - examples (المرحلة 3): أمثلة استخدام حقيقية تبدأ باسم الأمر (تظهر في المساعدة).
 *   - menu:false (المرحلة 3): الأمر يظهر في مركز المساعدة فقط ولا يدخل قائمة "/" في تيليجرام.
 *     (القائمة الحالية من المرحلة 1 تبقى كما هي حرفياً؛ يحرسها اختبار.)
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
  // ── المرحلة 3: أقسام مركز المساعدة (تظهر في المساعدة؛ ترتيبها هنا = ترتيب العرض) ──
  content:    { label: 'المحتوى',            icon: '📝' },
  protection: { label: 'الحماية',            icon: '🔰' },
  stats:      { label: 'الإحصائيات والسجلات', icon: '📊' },
  tools:      { label: 'أدوات',              icon: '🔧' },
  topics:     { label: 'المواضيع',           icon: '🧵' },
  games:      { label: 'الألعاب',            icon: '🎮' },
  bank:       { label: 'البنك',              icon: '💰' },
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
    examples: ['/search ملخص الفيزياء'],
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
    textAliases: ['حظر'],
    desc: 'حظر عضو (بالرد على رسالته)',          usage: '/ban' },
  { name: 'unban',    category: 'mod', role: 'admin', scope: 'group',
    textAliases: ['فك حظر'],
    desc: 'رفع الحظر عن عضو',                    usage: '/unban' },
  { name: 'kick',     category: 'mod', role: 'admin', scope: 'group',
    textAliases: ['طرد'],
    desc: 'طرد عضو من القروب',                   usage: '/kick' },
  { name: 'mute',     category: 'mod', role: 'admin', scope: 'group',
    textAliases: ['كتم'],
    examples: ['/mute 1h'],
    desc: 'كتم عضو',                             usage: '/mute' },
  { name: 'unmute',   category: 'mod', role: 'admin', scope: 'group',
    textAliases: ['فك كتم'],
    desc: 'رفع الكتم عن عضو',                    usage: '/unmute' },
  { name: 'warn',     category: 'mod', role: 'admin', scope: 'group',
    textAliases: ['تحذير'],
    desc: 'تحذير عضو',                           usage: '/warn' },
  { name: 'unwarn',   category: 'mod', role: 'admin', scope: 'group',
    textAliases: ['فك تحذير'],
    desc: 'إزالة تحذيرات عضو',                   usage: '/unwarn' },
  { name: 'warns',    category: 'mod', role: 'admin', scope: 'group',
    textAliases: ['تحذيراته'],
    desc: 'عرض تحذيرات عضو',                     usage: '/warns' },
  { name: 'pin',      category: 'mod', role: 'admin', scope: 'group',
    textAliases: ['تثبيت'],
    desc: 'تثبيت رسالة (بالرد عليها)',           usage: '/pin' },
  { name: 'unpin',    category: 'mod', role: 'admin', scope: 'group',
    textAliases: ['فك تثبيت'],
    desc: 'إلغاء تثبيت رسالة',                   usage: '/unpin' },
  { name: 'del',      category: 'mod', role: 'admin', scope: 'group',
    textAliases: ['حذف'],
    desc: 'حذف رسالة (بالرد عليها)',             usage: '/del' },
  { name: 'promote',  category: 'mod', role: 'admin', scope: 'group',
    desc: 'ترقية عضو إلى مشرف (بالرد عليه)',     usage: '/promote' },
  { name: 'demote',   category: 'mod', role: 'admin', scope: 'group',
    desc: 'تنزيل مشرف إلى عضو',                  usage: '/demote' },
  { name: 'info',     category: 'mod', role: 'admin', scope: 'group',
    desc: 'معلومات عضو',                         usage: '/info' },
  { name: 'tag',      category: 'mod', role: 'admin', scope: 'group',
    examples: ['/tag اجتماع الليلة'],
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

  // ═══════════ المرحلة 3: أوامر موثَّقة في المساعدة وموجودة بالكود (صلاحيتها من قراءة معالجاتها) ═══════════
  // ── الإشراف ──
  { name: 'tempban',  category: 'mod', role: 'admin', scope: 'group', menu: false,
    aliases: ['حظر_مؤقت', 'حظرمؤقت'], desc: 'حظر عضو لمدة محددة', usage: '/tempban 1h [سبب]', examples: ['/tempban 1h إعلانات'] },
  { name: 'setwarnlimit', category: 'mod', role: 'admin', scope: 'group', menu: false,
    aliases: ['حد_التحذيرات'], desc: 'تحديد عدد التحذيرات قبل الحظر', usage: '/setwarnlimit [1-10]', examples: ['/setwarnlimit 3'] },
  // ── المحتوى ──
  { name: 'purge',    category: 'content', role: 'admin', scope: 'group', menu: false,
    aliases: ['مسح'], desc: 'حذف عدد من الرسائل الأخيرة', usage: '/purge [عدد]', examples: ['/purge 20'] },
  { name: 'purgeto',  category: 'content', role: 'admin', scope: 'group', menu: false,
    aliases: ['حذف_لحد'], desc: 'حذف الرسائل من رسالة محددة (بالرد عليها) حتى الأخيرة', usage: '/purgeto' },
  { name: 'save',     category: 'content', role: 'admin', scope: 'group', menu: false,
    aliases: ['note'], desc: 'حفظ ملاحظة باسم (بنص أو بالرد على رسالة)', usage: '/save اسم [نص]', examples: ['/save قواعد ممنوع الإعلانات'] },
  { name: 'notes',    category: 'content', role: 'user', scope: 'group', menu: false,
    desc: 'عرض الملاحظات المحفوظة (تُستدعى بكتابة #اسم)', usage: '/notes' },
  { name: 'delnote',  category: 'content', role: 'admin', scope: 'group', menu: false,
    desc: 'حذف ملاحظة', usage: '/delnote اسم' },
  { name: 'filter',   category: 'content', role: 'admin', scope: 'group', menu: false,
    aliases: ['فلتر', 'addfilter'], desc: 'إضافة رد تلقائي على كلمة', usage: '/filter كلمة الرد', examples: ['/filter مرحبا أهلاً بك'] },
  { name: 'filters',  category: 'content', role: 'user', scope: 'group', menu: false,
    aliases: ['الفلاتر', 'listfilters'], desc: 'عرض الردود التلقائية', usage: '/filters' },
  { name: 'delfilter', category: 'content', role: 'admin', scope: 'group', menu: false,
    aliases: ['rmfilter'], desc: 'حذف رد تلقائي', usage: '/delfilter كلمة' },
  // ── الحماية ──
  { name: 'protection', category: 'protection', role: 'admin', scope: 'group', menu: false,
    textAliases: ['الحماية'], aliases: ['proadmin'], desc: 'لوحة الحماية الكاملة', usage: '/protection' },
  { name: 'lock',     category: 'protection', role: 'admin', scope: 'group', menu: false,
    textAliases: [{ say: 'قفل [نوع]', sample: 'قفل شات' }], desc: 'قفل نوع من الوسائط أو الكتابة',
    usage: '/lock نوع', examples: ['/lock sticker'] },
  { name: 'unlock',   category: 'protection', role: 'admin', scope: 'group', menu: false,
    textAliases: [{ say: 'فتح [نوع]', sample: 'فتح شات' }], desc: 'فتح نوع مقفول',
    usage: '/unlock نوع', examples: ['/unlock sticker'] },
  { name: 'setword',  category: 'protection', role: 'admin', scope: 'group', menu: false,
    desc: 'إضافة كلمة محظورة', usage: '/setword كلمة' },
  { name: 'delword',  category: 'protection', role: 'admin', scope: 'group', menu: false,
    desc: 'حذف كلمة محظورة', usage: '/delword كلمة' },
  { name: 'approve',  category: 'protection', role: 'admin', scope: 'group', menu: false,
    aliases: ['استثناء'], desc: 'استثناء عضو من الحماية (بالرد عليه)', usage: '/approve' },
  { name: 'unapprove', category: 'protection', role: 'admin', scope: 'group', menu: false,
    aliases: ['الغاء_استثناء'], desc: 'إلغاء استثناء عضو من الحماية', usage: '/unapprove' },
  { name: 'approved', category: 'protection', role: 'user', scope: 'group', menu: false,
    aliases: ['المستثنون'], desc: 'قائمة المستثنين من الحماية', usage: '/approved' },
  { name: 'slowmode', category: 'protection', role: 'admin', scope: 'group', menu: false,
    aliases: ['slow', 'بطيء'], desc: 'تفعيل الوضع البطيء', usage: '/slowmode [ثواني]', examples: ['/slowmode 30'] },
  { name: 'verify',   category: 'protection', role: 'admin', scope: 'group', menu: false,
    textAliases: ['التحقق'], desc: 'التحقق من الأعضاء', usage: '/verify' },
  // ── الرتب ──
  { name: 'roles',    category: 'roles', role: 'user', scope: 'group', menu: false,
    textAliases: ['الرتب'], desc: 'عرض الرتب والصلاحيات', usage: '/roles' },
  // ── الإحصائيات والسجلات ──
  { name: 'stats',    category: 'stats', role: 'user', scope: 'both', menu: false,
    desc: 'إحصائياتك في الخاص، وإحصائيات القروب داخله', usage: '/stats' },
  { name: 'topactive', category: 'stats', role: 'user', scope: 'group', menu: false,
    aliases: ['الأنشط', 'نشاط', 'topusers'], desc: 'أنشط الأعضاء', usage: '/topactive' },
  { name: 'admins',   category: 'stats', role: 'user', scope: 'group', menu: false,
    aliases: ['admin', 'مشرفون', 'المشرفين', 'المشرفون'], desc: 'قائمة مشرفي القروب', usage: '/admins' },
  { name: 'whois',    category: 'stats', role: 'user', scope: 'group', menu: false,
    aliases: ['معلومات_مستخدم'], desc: 'معلومات عن مستخدم (بالرد أو @username)', usage: '/whois @username' },
  { name: 'logs',     category: 'stats', role: 'admin', scope: 'group', menu: false,
    textAliases: ['السجلات'], desc: 'سجلات القروب', usage: '/logs' },
  { name: 'violations', category: 'stats', role: 'admin', scope: 'group', menu: false,
    desc: 'مخالفات الحماية لعضو (بالرد عليه)', usage: '/violations' },
  { name: 'summary',  category: 'stats', role: 'admin', scope: 'group', menu: false,
    textAliases: ['تحليل'], desc: 'تحليل نشاط القروب بالذكاء الاصطناعي', usage: '/summary' },
  // ── الأدوات ──
  { name: 'schedule', category: 'tools', role: 'admin', scope: 'group', menu: false,
    aliases: ['جدول', 'جدولة'], desc: 'جدولة رسالة في وقت محدد', usage: '/schedule HH:MM رسالة', examples: ['/schedule 21:00 اجتماع الليلة'] },
  { name: 'watching', category: 'tools', role: 'admin', scope: 'group', menu: false,
    aliases: ['watch', 'مراقبة'], desc: 'مراقبة عضو', usage: '/watching @user' },
  { name: 'unwatch',  category: 'tools', role: 'admin', scope: 'group', menu: false,
    aliases: ['إلغاء_مراقبة'], desc: 'إيقاف مراقبة عضو', usage: '/unwatch @user' },
  { name: 'setjoin',  category: 'tools', role: 'admin', scope: 'group', menu: false,
    aliases: ['رسالة_ترحيب'], desc: 'تعيين رسالة الترحيب بالأعضاء الجدد', usage: '/setjoin [رسالة]' },
  // ── المواضيع ──
  { name: 'topic',    category: 'topics', role: 'user', scope: 'group', menu: false,
    desc: 'معلومات الموضوع (Topic) الحالي', usage: '/topic' },
  // ── الألعاب ──
  { name: 'truth',    category: 'games', role: 'user', scope: 'group', menu: false,
    aliases: ['صح', 'حقيقة'], desc: 'سؤال صراحة', usage: '/truth' },
  { name: 'dare',     category: 'games', role: 'user', scope: 'group', menu: false,
    aliases: ['جرأة'], desc: 'تحدي جرأة', usage: '/dare' },
  { name: 'couple',   category: 'games', role: 'user', scope: 'group', menu: false,
    aliases: ['زوج'], desc: 'زوج اليوم', usage: '/couple' },
  { name: 'slot',     category: 'games', role: 'user', scope: 'group', menu: false,
    aliases: ['سلوت', 'قمار'], desc: 'ماكينة الحظ', usage: '/slot' },
  { name: 'market',   category: 'games', role: 'user', scope: 'group', menu: false,
    aliases: ['متجر', 'shop'], desc: 'متجر البوت', usage: '/market' },
  { name: 'gamestatus', category: 'games', role: 'user', scope: 'private', menu: false,
    desc: 'حالة الألعاب الجارية', usage: '/gamestatus' },
  // ── البنك ──
  { name: 'daily',    category: 'bank', role: 'user', scope: 'both', menu: false,
    aliases: ['يومي'], desc: 'المكافأة اليومية', usage: '/daily' },
  { name: 'flip',     category: 'bank', role: 'user', scope: 'both', menu: false,
    aliases: ['عملة'], desc: 'قلب عملة بمبلغ', usage: '/flip [مبلغ]', examples: ['/flip 50'] },
  { name: 'rob',      category: 'bank', role: 'user', scope: 'both', menu: false,
    aliases: ['سرقة'], desc: 'محاولة سرقة عضو (بالرد على رسالته)', usage: '/rob' },
  { name: 'leaderboard', category: 'bank', role: 'user', scope: 'both', menu: false,
    aliases: ['متصدرين', 'lb'], desc: 'قائمة الأثرى', usage: '/leaderboard' },
  { name: 'bank',     category: 'bank', role: 'user', scope: 'both', menu: false,
    aliases: ['حسابي', 'بنكي'], desc: 'رصيدك البنكي', usage: '/bank' },
  // ── الدراسة ──
  { name: 'summarize', category: 'ai', role: 'user', scope: 'both', menu: false,
    aliases: ['لخص', 'sum'], desc: 'تلخيص ملف PDF (بالرد عليه)', usage: '/summarize' },
]);


/**
 * عبارات نصية عربية تُسجَّل بغير bot.command (bot.hears أو موجّه نصوص عام).
 * لا تدخل قائمة "/" أبداً؛ تظهر في مركز المساعدة فقط.
 *   verify: 'hears'  → يجب أن يطابق sample تعبير bot.hears حيّ محدَّد (غير شامل).
 *           'source' → العبارة (token) ظاهرة في الملف الحيّ evidence كنص مقتبس أو داخل تعبير نمطي.
 *                      (تحقق أضعف: يكشف حذف الميزة لا تعطّلها)
 *           'none'   → لا دليل آلي؛ يحصرها اختبار بقائمة ثابتة (فارغة حالياً) لا يجوز أن تكبر.
 *   kind: 'button' → زر في قائمة وليس نصاً يُكتب (يُوثَّق في المساعدة كزر).
 */
const TRIGGERS = Object.freeze([
  // ── المجموعة: bot.hears ──
  { say: 'ادارة',  category: 'tools', role: 'admin', scope: 'group', desc: 'لوحة الإدارة السريعة', verify: 'hears', sample: 'ادارة' },
  { say: '#اسم',   category: 'content', role: 'user', scope: 'group', desc: 'استدعاء ملاحظة محفوظة', verify: 'hears', sample: '#اسم' },
  { say: 'رتبة +', category: 'roles', role: 'admin', scope: 'group', desc: 'رفع رتبة عضو (بالرد عليه)', verify: 'hears', sample: 'رتبة +' },
  { say: 'رتبة -', category: 'roles', role: 'admin', scope: 'group', desc: 'خفض رتبة عضو (بالرد عليه)', verify: 'hears', sample: 'رتبة -' },
  { say: 'موضوع',  category: 'topics', role: 'user', scope: 'group', desc: 'معلومات الموضوع (Topic) الحالي', verify: 'hears', sample: 'موضوع' },
  { say: 'موضوع انشاء [اسم]', category: 'topics', role: 'admin', scope: 'group', desc: 'إنشاء موضوع جديد', verify: 'hears', sample: 'موضوع انشاء مثال' },
  { say: 'موضوع تسمية [اسم]', category: 'topics', role: 'admin', scope: 'group', desc: 'تعديل اسم الموضوع الحالي', verify: 'hears', sample: 'موضوع تسمية مثال' },
  { say: 'موضوع اغلاق', category: 'topics', role: 'admin', scope: 'group', desc: 'إغلاق الموضوع الحالي', verify: 'hears', sample: 'موضوع اغلاق' },
  { say: 'موضوع فتح',   category: 'topics', role: 'admin', scope: 'group', desc: 'إعادة فتح الموضوع الحالي', verify: 'hears', sample: 'موضوع فتح' },
  // ── الألعاب: موجّه النصوص في index.js (داخل كتلة القروب فقط) ──
  { say: 'مليون', category: 'games', role: 'user', scope: 'group', desc: 'من سيربح المليون', verify: 'source', evidence: 'handlers/million_battle.js', token: 'مليون' },
  { say: 'خمن',   category: 'games', role: 'user', scope: 'group', desc: 'لعبة التخمين', verify: 'source', evidence: 'index.js', token: 'خمن' },
  { say: 'انا',   category: 'games', role: 'user', scope: 'group', desc: 'الانضمام للعبة جارية', verify: 'hears', sample: 'انا' },
  // ── البنك (Taline Bank): موجّه النصوص في index.js (داخل كتلة القروب فقط) ──
  { say: 'بنك',          category: 'bank', role: 'user', scope: 'group', desc: 'فتح حساب بنكي', verify: 'source', evidence: 'index.js', token: 'بنك' },
  { say: 'فلوسي',        category: 'bank', role: 'user', scope: 'group', desc: 'رصيدك الحالي', verify: 'source', evidence: 'index.js', token: 'فلوسي' },
  { say: 'محفظتي',       category: 'bank', role: 'user', scope: 'group', desc: 'محفظتك', verify: 'source', evidence: 'index.js', token: 'محفظتي' },
  { say: 'بطاقتي',       category: 'bank', role: 'user', scope: 'group', desc: 'بطاقتك البنكية', verify: 'source', evidence: 'index.js', token: 'بطاقتي' },
  { say: 'كشف',          category: 'bank', role: 'user', scope: 'group', desc: 'كشف الحساب', verify: 'source', evidence: 'index.js', token: 'كشف' },
  { say: 'تحويل [مبلغ]', category: 'bank', role: 'user', scope: 'group', desc: 'تحويل مبلغ', verify: 'source', evidence: 'index.js', token: 'تحويل' },
  { say: 'قرض [مبلغ]',   category: 'bank', role: 'user', scope: 'group', desc: 'طلب قرض', verify: 'source', evidence: 'index.js', token: 'قرض' },
  { say: 'ديوني',        category: 'bank', role: 'user', scope: 'group', desc: 'قروضك الحالية', verify: 'source', evidence: 'index.js', token: 'ديوني' },
  { say: 'سداد',         category: 'bank', role: 'user', scope: 'group', desc: 'سداد القرض', verify: 'source', evidence: 'index.js', token: 'سداد' },
  { say: 'استثمار [مبلغ]', category: 'bank', role: 'user', scope: 'group', desc: 'استثمار مبلغ', verify: 'source', evidence: 'index.js', token: 'استثمار' },
  { say: 'سحب استثمار',  category: 'bank', role: 'user', scope: 'group', desc: 'سحب الاستثمار', verify: 'source', evidence: 'index.js', token: 'سحب استثمار' },
  { say: 'الاثرياء',     category: 'bank', role: 'user', scope: 'group', desc: 'قائمة الأثرياء', verify: 'source', evidence: 'index.js', token: 'الاثرياء' },
  // ── أزرار قائمة /start في الخاص (أزرار لا كلمات تُكتب؛ تُوثَّق كأزرار) ──
  { say: '🔍 بحث',    kind: 'button', category: 'study', role: 'user', scope: 'private', desc: 'زر في /start: بحث سريع في الملفات', verify: 'source', evidence: 'handlers/start.js', token: '🔍 بحث' },
  { say: '🆕 جديد',   kind: 'button', category: 'study', role: 'user', scope: 'private', desc: 'زر في /start: آخر الملفات المضافة', verify: 'source', evidence: 'handlers/start.js', token: '🆕 جديد' },
  { say: '⭐ مفضلاتي', kind: 'button', category: 'study', role: 'user', scope: 'private', desc: 'زر في /start: ملفاتك المحفوظة', verify: 'source', evidence: 'handlers/start.js', token: '⭐ مفضلاتي' },
  { say: '🗂 سجلي',   kind: 'button', category: 'study', role: 'user', scope: 'private', desc: 'زر في /start: سجل ما شاهدته من ملفات', verify: 'source', evidence: 'handlers/start.js', token: '🗂 سجلي' },
  { say: '👤 ملفي',   kind: 'button', category: 'study', role: 'user', scope: 'private', desc: 'زر في /start: ملفك الشخصي', verify: 'source', evidence: 'handlers/start.js', token: '👤 ملفي' },
]);

/** بحث بالاسم الأساسي أو أي اسم بديل (غير حساس لحالة الأحرف). */
function findCommand(nameOrAlias) {
  const n = String(nameOrAlias || '').replace(/^\//, '').toLowerCase();
  return COMMANDS.find(c => c.name === n || (c.aliases || []).some(a => a.toLowerCase() === n)) || null;
}

module.exports = { CATEGORIES, ROLES, SCOPES, COMMANDS, TRIGGERS, findCommand };
