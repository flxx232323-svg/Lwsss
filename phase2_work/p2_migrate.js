'use strict';
// ترحيل المرحلة 2: يستبدل دوال فحص المشرف بأغلفة فوق utils/group_auth.js
// أمان: لا يلمس دالة إلا إذا طابقت بصمة نصّها القديم المُختبَر، ويتراجع تلقائياً عند أي خطأ صياغة.
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const ROOT = process.argv[2] || process.cwd();
const S = 'groupAuth.BYPASS.STAFF', O = 'groupAuth.BYPASS.OWNER', N = 'groupAuth.BYPASS.NONE';
const NOTE = p => `// ✅ المرحلة 2: الفحص موحَّد في utils/group_auth.js — سياسة التجاوز هنا: ${p}`;
const STAFF = `  return groupAuth.isGroupAdmin(ctx, { bypass: ${S} });`;

// [ملف, دالة, توقيع, جسم الغلاف, السياسة, بصمة النص القديم]
const T = [
  ['handlers/group_commands.js', 'isTgAdmin', 'ctx', STAFF, 'مالك البوت + أدمن البوت', '1b0d3bbc87b6'],
  ['handlers/group_commands_pro.js', 'isTgAdmin', 'ctx', STAFF, 'مالك البوت + أدمن البوت', '950dc5d22678'],
  ['handlers/group_extras.js', 'isTgAdmin', 'ctx', STAFF, 'مالك البوت + أدمن البوت', 'a69b66fc4c5d'],
  ['handlers/group_schedule.js', 'isTgAdmin', 'ctx', STAFF, 'مالك البوت + أدمن البوت', 'a69b66fc4c5d'],
  ['handlers/fun_commands.js', 'isChatAdmin', 'ctx', STAFF, 'مالك البوت + أدمن البوت', 'e7e26fc900c7'],
  ['handlers/group_members_panel.js', 'isTgAdmin', 'ctx, chatId', `  return groupAuth.isGroupAdmin(ctx, { chatId, bypass: ${S} });`, 'مالك البوت + أدمن البوت', '68bf6b91ebe5'],
  ['handlers/group_topics.js', 'isTgAdminOrOwner', 'ctx', `  return groupAuth.isGroupAdmin(ctx, { bypass: ${O} });`, 'مالك البوت فقط', '588c5a7b7748'],
  ['handlers/group_topics.js', 'isTgAdminOrOwnerFor', 'ctx, chatId', `  return groupAuth.isGroupAdmin(ctx, { chatId, bypass: ${O} });`, 'مالك البوت فقط', 'd90b240e006c'],
  ['handlers/group_promote_panel.js', 'isTgAdminOrOwner', 'ctx', `  return groupAuth.isGroupAdmin(ctx, { bypass: ${O} });`, 'مالك البوت فقط', '588c5a7b7748'],
  ['handlers/nations.js', 'isAdmin', 'ctx', `  return groupAuth.isGroupAdmin(ctx, { bypass: ${N} });`, 'لا تجاوز (حتى المالك يمرّ على تيليجرام)', 'bd96266e564c'],
  ['handlers/group_panel.js', 'checkGroupAdmin', 'ctx, chatId',
`  const uid = Number(ctx.uid || ctx.from?.id);
  if (await groupAuth.isGroupAdmin(ctx, { chatId, userId: uid, bypass: ${O} })) return true;
  await ctx.answerCbQuery('🚫 ليس لديك صلاحية إدارة هذا القروب', { show_alert: true }).catch(() => {});
  return false;`, 'مالك البوت فقط', '6a26089a0252'],
  ['handlers/werewolf/engine.js', 'isGroupAdmin', 'chatId, uid', `  return groupAuth.isGroupAdminById(BOT && BOT.telegram, chatId, uid);`, 'لا تجاوز', '92a176d5115e'],
  ['handlers/group_pro_features.js', 'isTgAdmin', 'ctx, chatId, uid',
`  return groupAuth.isGroupAdmin(ctx, {
    chatId: chatId || (ctx.chat && ctx.chat.id),
    userId: uid || (ctx.from && ctx.from.id),
    bypass: ${S},
    ttl: 300000, // نفس مدة الكاش القديمة (5 دقائق)
  });`, 'مالك البوت + أدمن البوت', 'ebaa2d769228'],
  ['handlers/group_protection.js', 'isTelegramAdmin', 'ctx, chatId, uid',
`  return groupAuth.isGroupAdmin(ctx, { chatId, userId: uid, bypass: ${O}, ttl: 300000 }); // 5 دقائق كالقديم`, 'مالك البوت فقط', 'bee183ccb969'],
];

function close(src, i, o, c) {
  let d = 0;
  for (; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1];
    if (ch === '/' && nx === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && nx === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { const q = ch; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } continue; }
    if (ch === o) d++; else if (ch === c) { d--; if (d === 0) return i; }
  }
  return -1;
}
function findFn(src, name) {
  const hits = [...src.matchAll(new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'g'))];
  if (hits.length !== 1) return { err: hits.length ? 'معرَّفة ' + hits.length + ' مرات' : 'غير موجودة' };
  const s = hits[0].index, pc = close(src, src.indexOf('(', s), '(', ')'), bo = src.indexOf('{', pc), bc = close(src, bo, '{', '}');
  if (pc < 0 || bc < 0) return { err: 'تعذّر تحديد حدود الدالة' };
  return { s, e: bc + 1, text: src.slice(s, bc + 1) };
}
const sha = t => crypto.createHash('sha1').update(t.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
const P = f => path.join(ROOT, f);
const rel = f => (f.startsWith('handlers/werewolf/') ? '../../utils/group_auth' : '../utils/group_auth');

const touched = new Set(), report = [];
function backup(f) { if (!fs.existsSync(P(f) + '.p2bak')) fs.copyFileSync(P(f), P(f) + '.p2bak'); touched.add(f); }

for (const [f, fn, params, body, pol, fp] of T) {
  const tag = f + ' :: ' + fn;
  if (!fs.existsSync(P(f))) { report.push(['SKIP', tag, 'الملف غير موجود']); continue; }
  let src = fs.readFileSync(P(f), 'utf8');
  const r = findFn(src, fn);
  if (r.err) { report.push(['SKIP', tag, r.err]); continue; }
  if (/\bgroupAuth\./.test(r.text)) { report.push(['SKIP', tag, 'مُرحَّلة سابقاً']); continue; }
  if (sha(r.text) !== fp) { report.push(['SKIP', tag, 'نصّها يختلف عن المُختبَر (لم أغيّرها حفاظاً على السلوك)']); continue; }
  const hasReq = /const\s+groupAuth\s*=\s*require\(/.test(src);
  const head = NOTE(pol) + '\n' + (hasReq ? '' : `const groupAuth = require('${rel(f)}');\n`);
  const neu = head + (/^async\s/.test(r.text) ? 'async ' : '') + `function ${fn}(${params}) {\n${body}\n}`;
  backup(f);
  fs.writeFileSync(P(f), src.slice(0, r.s) + neu + src.slice(r.e));
  report.push(['DONE', tag, '']);
}

function edit(f, tag, fn) {
  if (!fs.existsSync(P(f))) { report.push(['SKIP', tag, 'الملف غير موجود']); return; }
  const src = fs.readFileSync(P(f), 'utf8'); const out = fn(src);
  if (out === null) { report.push(['SKIP', tag, 'الموضع غير موجود/مكرَّر/مُنفَّذ سابقاً']); return; }
  backup(f); fs.writeFileSync(P(f), out); report.push(['DONE', tag, '']);
}
const hasGA = s => /const\s+groupAuth\s*=\s*require\(/.test(s);
const once = (s, a) => s.split(a).length === 2;

edit('handlers/group_protection.js', 'group_protection :: clearAdminCache', s => {
  const a = "function clearAdminCache(chatId, uid) { cacheClear('tgadm_' + chatId + '_' + uid); }";
  return hasGA(s) && once(s, a) ? s.replace(a, () => 'function clearAdminCache(chatId, uid) { groupAuth.invalidateGroupAdmin(chatId, uid); }') : null;
});
edit('handlers/group_pro_features.js', 'group_pro_features :: /admins (مسح الكاش)', s => {
  const a = "    cacheClear('tgadm_' + chatId + '_');\n";
  return hasGA(s) && once(s, a) ? s.replace(a, () => "    groupAuth.invalidateChat(chatId); // كان cacheClear('tgadm_<chat>_') بمفتاح حرفي فلا يمسح شيئاً\n") : null;
});
edit('bot/messages.js', 'bot/messages :: إبطال الكاش عند chat_member', s => {
  if (s.includes('handleChatMemberUpdate')) return null;
  const st = s.indexOf("bot.on('chat_member'"); if (st < 0) return null;
  const a = 'if (!chat || chat.type === "private") return;';
  const i = s.indexOf(a, st); if (i < 0) return null;
  const hook = "// ✅ المرحلة 2: إبطال كاش «مشرف تيليجرام» فور أي تغيّر عضوية (قبل أي return تحت)\n      try { require('../utils/group_auth').handleChatMemberUpdate(ctx.chatMember); } catch (_) {}\n      ";
  return s.slice(0, i) + hook + s.slice(i);
});

// فحص صياغة كل ملف عُدِّل، وتراجع تلقائي عند الفشل
for (const f of touched) {
  try { cp.execFileSync(process.execPath, ['--check', P(f)], { stdio: 'pipe' }); }
  catch (e) { fs.copyFileSync(P(f) + '.p2bak', P(f)); report.push(['ROLLBACK', f, 'فشل فحص الصياغة فأُعيد الملف']); }
}

const icon = { DONE: '✅', SKIP: '⏭ ', ROLLBACK: '↩️ ' };
for (const [k, t, m] of report) console.log(icon[k], t, m ? '— ' + m : '');
const n = c => report.filter(r => r[0] === c).length;
console.log(`\nالملخص: مُرحَّل ${n('DONE')} | متخطّى ${n('SKIP')} | تراجع ${n('ROLLBACK')}`);

// اختبار ذاتي سريع للنواة (بلا شبكة)
(async () => {
  let ga;
  try { ga = require(P('utils/group_auth')); } catch (e) { console.log('❌ تعذّر تحميل النواة:', e.message); process.exit(1); }
  const mk = st => ({ async getChatMember() { if (st === 'throws') throw new Error('x'); return { status: st }; } });
  let uid = 900000000;
  const ctx = (st, o = {}) => ({ telegram: mk(st), chat: { id: -100999 }, from: { id: ++uid }, isOwner: false, isAdmin: false, ...o });
  const rows = [
    ['مشرف تيليجرام → true', await ga.isGroupAdmin(ctx('administrator')), true],
    ['منشئ القروب → true', await ga.isGroupAdmin(ctx('creator')), true],
    ['عضو عادي → false', await ga.isGroupAdmin(ctx('member')), false],
    ['خطأ API → false', await ga.isGroupAdmin(ctx('throws')), false],
    ['أدمن البوت + STAFF → true', await ga.isGroupAdmin(ctx('member', { isAdmin: true }), { bypass: ga.BYPASS.STAFF }), true],
    ['أدمن البوت بلا تجاوز → false', await ga.isGroupAdmin(ctx('member', { isAdmin: true })), false],
  ];
  let bad = 0;
  for (const [t, got, want] of rows) { const ok = got === want; if (!ok) bad++; console.log(ok ? '✅' : '❌', 'اختبار ذاتي:', t); }
  console.log(bad ? '\n❌ فشل الاختبار الذاتي — استعد النسخة الاحتياطية' : '\n🟢 النواة تعمل. النسخ الاحتياطية: *.p2bak بجانب كل ملف معدَّل');
  process.exit(bad ? 1 : 0);
})();
