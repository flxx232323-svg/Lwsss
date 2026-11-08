'use strict';
/**
 * 🧪 test/command_registry.test.js — المرحلة 1: السجل المركزي + قائمة الأوامر + المحلل.
 *
 * بلا شبكة ولا قاعدة بيانات ولا تيليجرام (telegram وهمي يسجّل الاستدعاءات).
 * يحرس:
 *  - سلامة السجل (أسماء تيليجرام الصالحة، عدم التكرار، رتب/نطاقات معروفة).
 *  - القوائم: المستخدم العادي لا يرى أوامر الإشراف، والمشرف يرى الأعضاء + الإشراف.
 *  - المزامنة: فشل نطاق لا يوقف الباقي، والتعطيل بمتغير بيئة، وعدم إرسال شيء عند قائمة غير صالحة.
 *  - المحلل: يتجاهل التعليقات، يقرأ المصفوفات والـregex، ويكشف الميت/المفقود/البديل الخاطئ.
 *  - انحراف التوثيق: كل أمر في السجل موجود فعلاً ومحمّل في الكود الحقيقي للمشروع.
 *
 * التشغيل: node --test test/command_registry.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const registry = require('../utils/command_registry');
const menu = require('../utils/command_menu');
const S = require('../scripts/lib/command_scanner');

const ROOT = path.join(__dirname, '..');
const silent = { info() {}, error() {}, warn() {}, debug() {} };

// ── السجل ────────────────────────────────────────────────────
test('registry: كل أمر له الحقول الإلزامية وقيم معروفة', () => {
  for (const c of registry.COMMANDS) {
    assert.match(c.name, /^[a-z0-9_]{1,32}$/, 'اسم غير صالح لتيليجرام: ' + c.name);
    assert.ok(registry.CATEGORIES[c.category], 'تصنيف غير معروف: ' + c.name);
    assert.ok(registry.ROLES.includes(c.role), 'رتبة غير معروفة: ' + c.name);
    assert.ok(registry.SCOPES.includes(c.scope), 'نطاق غير معروف: ' + c.name);
    assert.ok(c.desc && c.desc.length <= menu.MAX_DESC, 'وصف فارغ/طويل: ' + c.name);
    assert.ok(c.usage && c.usage.startsWith('/' + c.name), 'usage لا يبدأ باسم الأمر: ' + c.name);
  }
});

test('registry: لا أسماء مكررة ولا تعارض بين اسم أمر واسم بديل لأمر آخر', () => {
  const seen = new Map();
  for (const c of registry.COMMANDS) {
    for (const n of [c.name, ...(c.aliases || [])].map(x => x.toLowerCase())) {
      assert.ok(!seen.has(n), `"${n}" مستخدم في /${seen.get(n)} و /${c.name}`);
      seen.set(n, c.name);
    }
  }
});

test('registry: findCommand يعمل بالاسم والبديل العربي ومع "/"', () => {
  assert.equal(registry.findCommand('/help').name, 'help');
  assert.equal(registry.findCommand('مساعدة').name, 'help');
  assert.equal(registry.findCommand('BAN').name, 'ban');
  assert.equal(registry.findCommand('nope'), null);
});

// ── القوائم ──────────────────────────────────────────────────
test('menus: المستخدم العادي في القروب لا يرى أي أمر إشراف', () => {
  const m = menu.buildMenus();
  const adminOnly = registry.COMMANDS.filter(c => c.role === 'admin').map(c => c.name);
  const groupNames = m.group.map(x => x.command);
  for (const n of adminOnly) assert.ok(!groupNames.includes(n), '/' + n + ' ظهر لعضو عادي');
  for (const n of adminOnly) assert.ok(!m.private.map(x => x.command).includes(n));
});

// ⚠️ قائمة مكتوبة يدوياً عمداً (وليست مشتقة من السجل) حتى لا يكون الاختبار دائرياً:
// أي تغيير خاطئ لرتبة أمر إشراف يجب أن يُكسر هنا.
const MUST_BE_ADMIN = ['ban', 'unban', 'kick', 'mute', 'unmute', 'warn', 'unwarn', 'warns', 'pin', 'unpin',
  'del', 'promote', 'demote', 'info', 'tag', 'all', 'setlog', 'setrole', 'removerole'];
const MUST_BE_USER = ['start', 'help', 'cancel', 'mygroups', 'search', 'ai', 'reset', 'rules', 'report'];

test('menus: أوامر الإشراف الحساسة مثبّتة صراحةً كـ admin ولا تظهر في أي قائمة لغير المشرفين', () => {
  const m = menu.buildMenus();
  for (const n of MUST_BE_ADMIN) {
    const c = registry.findCommand(n);
    assert.ok(c, '/' + n + ' غير موجود في السجل');
    assert.equal(c.role, 'admin', '/' + n + ' يجب أن يبقى للمشرفين فقط');
    for (const key of ['default', 'private', 'group']) {
      assert.ok(!m[key].some(x => x.command === n), '/' + n + ' ظهر في قائمة "' + key + '" لغير المشرفين');
    }
    assert.ok(m.admins.some(x => x.command === n), '/' + n + ' مفقود من قائمة المشرفين');
  }
});

test('menus: أوامر الأعضاء الأساسية مثبّتة كـ user ومتاحة بالقوائم الصحيحة', () => {
  const m = menu.buildMenus();
  for (const n of MUST_BE_USER) assert.equal(registry.findCommand(n).role, 'user', '/' + n);
  for (const n of ['rules', 'report']) assert.ok(m.group.some(x => x.command === n), '/' + n + ' غير متاح لأعضاء القروب');
  for (const n of ['start', 'search', 'ai']) assert.ok(m.private.some(x => x.command === n), '/' + n + ' غير متاح في الخاص');
});

test('menus: المشرف يرى كل أوامر الأعضاء + أوامر الإشراف', () => {
  const m = menu.buildMenus();
  const adm = new Set(m.admins.map(x => x.command));
  for (const x of m.group) assert.ok(adm.has(x.command), 'أمر عضو مفقود من قائمة المشرف: ' + x.command);
  for (const n of ['ban', 'mute', 'warn', 'pin', 'del']) assert.ok(adm.has(n), 'مفقود: ' + n);
});

test('menus: الخاص يحوي start/help ولا يزيد أي نطاق عن 100 والقوائم الحقيقية صالحة', () => {
  const m = menu.buildMenus();
  assert.ok(m.private.some(x => x.command === 'start') && m.private.some(x => x.command === 'help'));
  assert.deepEqual(m.default, m.private);
  for (const list of Object.values(m)) assert.ok(list.length <= menu.MAX_PER_SCOPE);
  assert.deepEqual(menu.validateMenus(m), []);
});

test('menus: validateMenus يلتقط الاسم غير الصالح والوصف الفارغ والمكرر والحد الأقصى', () => {
  const bad = {
    a: [{ command: 'Ban', description: 'x' }, { command: 'حظر', description: 'x' },
        { command: 'ok', description: '' }, { command: 'dup', description: 'x' }, { command: 'dup', description: 'x' },
        { command: 'long', description: 'ط'.repeat(300) }],
    b: Array.from({ length: 101 }, (_, i) => ({ command: 'c' + i, description: 'x' })),
  };
  const p = menu.validateMenus(bad).join('\n');
  assert.match(p, /اسم غير صالح "Ban"/);
  assert.match(p, /اسم غير صالح "حظر"/);
  assert.match(p, /وصف غير صالح لـ \/ok/);
  assert.match(p, /اسم مكرر \/dup/);
  assert.match(p, /وصف غير صالح لـ \/long/);
  assert.match(p, /b: 101 أمر/);
});

// ── المزامنة مع تيليجرام ─────────────────────────────────────
function fakeTelegram(failScopeType) {
  const calls = [];
  return {
    calls,
    async setMyCommands(commands, extra) {
      calls.push({ commands, extra });
      if (failScopeType && extra && extra.scope && extra.scope.type === failScopeType) throw new Error('boom');
      return true;
    },
  };
}

test('sync: يرسل 4 نطاقات بالترتيب الصحيح والنطاق الافتراضي بلا scope', async () => {
  const tg = fakeTelegram();
  const r = await menu.applyCommandMenus(tg, { logger: silent, env: {} });
  assert.deepEqual([r.ok, r.failed, r.skipped], [4, 0, false]);
  assert.deepEqual(tg.calls.map(c => (c.extra.scope ? c.extra.scope.type : 'default')),
    ['default', 'all_private_chats', 'all_group_chats', 'all_chat_administrators']);
  assert.deepEqual(tg.calls[0].extra, {});
  assert.ok(tg.calls.every(c => c.commands.every(x => typeof x.command === 'string' && typeof x.description === 'string')));
});

test('sync: فشل نطاق واحد لا يوقف الباقي ولا يرمي استثناء', async () => {
  const tg = fakeTelegram('all_group_chats');
  const r = await menu.applyCommandMenus(tg, { logger: silent, env: {} });
  assert.deepEqual([r.ok, r.failed], [3, 1]);
  assert.equal(tg.calls.length, 4);
});

test('sync: COMMAND_MENU_SYNC=off لا يرسل شيئاً', async () => {
  for (const v of ['off', 'OFF']) {
    const tg = fakeTelegram();
    const r = await menu.applyCommandMenus(tg, { logger: silent, env: { COMMAND_MENU_SYNC: v } });
    assert.equal(tg.calls.length, 0);
    assert.deepEqual([r.skipped, r.reason], [true, 'disabled']);
  }
});

test('sync: قائمة غير صالحة => لا يُرسل أي نطاق إطلاقاً (fail-closed)', async () => {
  const tg = fakeTelegram();
  const bad = [{ name: 'Ban', category: 'mod', role: 'admin', scope: 'group', desc: 'x', usage: '/Ban' },
               { name: 'ok', category: 'general', role: 'user', scope: 'both', desc: 'x', usage: '/ok' }];
  const r = await menu.applyCommandMenus(tg, { logger: silent, env: {}, commands: bad });
  assert.equal(tg.calls.length, 0);
  assert.deepEqual([r.skipped, r.reason], [true, 'invalid']);
});

// ── المحلل الثابت ────────────────────────────────────────────
test('scanner: يقرأ النص والمصفوفة والـregex ويتجاهل التعليقات ويحسب السطر', () => {
  const src = [
    "bot.command(['ban', 'حظر'], h);",                 // 1
    "bot.hears(/^(مرحبا|اهلا)\\s*(.+)?$/i, h);",       // 2
    "// bot.command('commented', h);",                  // 3
    "  /* bot.command('block', h) */",                  // 4
    "bot.action('x_', h); // bot.command('trail', h)", // 5
    "const s = 'bot.command(\"in_string\")';",          // 6 (داخل نص: يبقى — حدّ معروف بسيط)
  ].join('\n');
  const regs = S.scanSource(src, 'f.js');
  const byKind = regs.map(r => r.kind + '@' + r.line);
  assert.deepEqual(byKind.slice(0, 3), ['command@1', 'hears@2', 'action@5']);
  assert.ok(!regs.some(r => /commented|block|trail/.test(r.arg || '')), 'سُجّل تعليق كأنه كود');
  assert.deepEqual(S.namesOf(regs[0].arg), ['ban', 'حظر']);
  assert.equal(regs[1].arg, '/^(مرحبا|اهلا)\\s*(.+)?$/i');
});

test('scanner: findUnloadedModules يكشف الملف الذي لا يحمّله أحد', () => {
  const scan = {
    registrations: [{ file: 'handlers/a.js', kind: 'command' }, { file: 'handlers/b.js', kind: 'command' },
                    { file: 'handlers/tod/index.js', kind: 'command' }, { file: 'index.js', kind: 'command' }],
    sources: {
      'index.js': "require('./handlers/a'); require('./handlers/tod');",
      'handlers/a.js': '', 'handlers/b.js': '', 'handlers/tod/index.js': '',
    },
  };
  assert.deepEqual(S.findUnloadedModules(scan), ['handlers/b.js']);
});

test('scanner: auditRegistry يميّز المفقود والميت والبديل الخاطئ وغير الموثّق', () => {
  const scan = { registrations: [
    { file: 'live.js', kind: 'command', arg: "['ban', 'حظر']" },
    { file: 'live.js', kind: 'command', arg: "'extra'" },
    { file: 'dead.js', kind: 'command', arg: "'ghost'" },
  ] };
  const reg = { COMMANDS: [
    { name: 'ban', aliases: ['حظر', 'bogus'] }, { name: 'gone' }, { name: 'ghost' },
  ] };
  const r = S.auditRegistry(reg, scan, ['dead.js']);
  assert.deepEqual(r.missing, ['gone']);
  assert.deepEqual(r.onlyInUnloaded, ['ghost']);
  assert.deepEqual(r.aliasMismatch, ['ban ↔ bogus']);
  assert.deepEqual(r.undocumentedLatin, ['extra']);
});

// ── انحراف التوثيق عن الكود الحقيقي ─────────────────────────
test('drift: كل أمر وبديل في السجل موجود فعلاً ومحمّل في كود المشروع', () => {
  const scan = S.scanProject(ROOT);
  const r = S.auditRegistry(registry, scan, S.findUnloadedModules(scan));
  assert.deepEqual(r.missing, [], 'أوامر في السجل غير موجودة بالكود');
  assert.deepEqual(r.onlyInUnloaded, [], 'أوامر في السجل موجودة بملف غير محمّل');
  assert.deepEqual(r.aliasMismatch, [], 'أسماء بديلة في السجل غير موجودة بنفس التسجيل');
});

test('drift: index.js يستدعي المزامنة مرة واحدة، دون await، وبمعالجة خطأ، قبل startScheduler', () => {
  const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const call = "require('./utils/command_menu').applyCommandMenus(bot.telegram)";
  assert.equal(src.split(call).length - 1, 1, 'يجب أن يوجد استدعاء واحد');
  const i = src.indexOf(call), j = src.indexOf('startScheduler(bot, [OWNER_ID]);');
  assert.ok(i > 0 && i < j, 'الاستدعاء يجب أن يسبق startScheduler');
  const line = src.slice(src.lastIndexOf('\n', i) + 1, src.indexOf('\n', i));
  assert.ok(!/await\s/.test(line) && /\.catch\(/.test(line), 'يجب ألا يعطّل الإقلاع: بلا await ومع .catch');
});
