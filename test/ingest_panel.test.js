'use strict';
/**
 * 🧪 test/ingest_panel.test.js — شاشة اختيار القروبات لمراقبة الملفات (المرحلة 3أ)
 *
 * بلا قاعدة بيانات حقيقية (قاعدة وهمية تسجّل الاستعلامات) وبـ Telegraf الحقيقي بلا شبكة. يحرس:
 *  - تحليل callback_data (رفض كل ما لا يطابق الصيغة) وحدّ 64 بايت لكل الأزرار.
 *  - المالك فقط: غيره يُرفض قبل أي استعلام.
 *  - الإجراءات تحمل الحالة صراحةً (idempotent)، ولا DELETE إطلاقاً، والكتابة في ingest_sources/ingest_rules فقط.
 *  - المعترض لا يمسّ أزرار البوت الأخرى (تمرّ إلى المعالج التالي).
 * (دلالات SQL نفسها تُختبر على PostgreSQL حقيقي خارج هذا الملف.)
 *
 * التشغيل: node --test test/ingest_panel.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Telegraf, Telegram } = require('telegraf');
const panel = require('../handlers/ingest_panel');

const OWNER = '111';
const CHAT = '-1001234567890';

function makeStub({ registered = [CHAT], source = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/FROM group_chats WHERE chat_id = \$1/.test(sql)) {
        return { rows: registered.includes(params[0]) ? [{ chat_id: params[0], title: 'Group A' }] : [] };
      }
      if (/FROM group_chats g/.test(sql)) return { rows: registered.map((c) => ({ chat_id: c, title: 'Group ' + c, enabled: source ? source.enabled : null })) };
      if (/INSERT INTO ingest_sources[\s\S]*RETURNING id/.test(sql)) return { rows: [{ id: 7 }] };
      if (/FROM ingest_sources s/.test(sql)) return { rows: source ? [{ id: 7, enabled: source.enabled, all_topics: source.all_topics, wm_at: null }] : [] };
      if (/FROM ingest_items/.test(sql)) return { rows: [] };
      if (/FROM ingest_events/.test(sql)) return { rows: [] };
      if (/FROM ingest_rules/.test(sql)) return { rows: [] };
      if (/FROM group_known_topics/.test(sql)) return { rows: [{ id: '5', name: 'Algo' }, { id: '9', name: null }] };
      if (/^\s*(INSERT|UPDATE)/.test(sql)) return { rows: [], rowCount: 1 };
      throw new Error('unexpected sql: ' + sql.slice(0, 70));
    },
  };
}

function makeCtx(data, fromId = OWNER) {
  const out = { toasts: [], edits: [], replies: [] };
  return {
    out,
    from: { id: Number(fromId) },
    callbackQuery: { id: 'cb1', data, message: { message_id: 5, text: 'x' } },
    answerCbQuery: async (t) => { out.toasts.push(t || ''); },
    editMessageText: async (text, extra) => { out.edits.push({ text, extra }); },
    reply: async (text, extra) => { out.replies.push({ text, extra }); },
  };
}

const writes = (stub) => stub.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)/i.test(c.sql));
const run = async (data, stub, fromId = OWNER) => {
  const ctx = makeCtx(data, fromId);
  await panel.handle(ctx, data, { getPg: () => stub, ownerId: () => OWNER, now: () => Date.UTC(2026, 9, 11) });
  return ctx.out;
};

test('parseCb: يقبل الصيغ الصحيحة فقط', () => {
  assert.deepEqual(panel.parseCb('ing_list'), { a: 'list' });
  assert.deepEqual(panel.parseCb('ing_g_-1001234567890'), { a: 'group', chat: '-1001234567890' });
  assert.deepEqual(panel.parseCb('ing_en_-100123_1'), { a: 'enable', chat: '-100123', on: true });
  assert.deepEqual(panel.parseCb('ing_at_-100123_0'), { a: 'alltopics', chat: '-100123', on: false });
  assert.deepEqual(panel.parseCb('ing_tp_-100123_5_1'), { a: 'topic', chat: '-100123', topic: '5', on: true });
  for (const bad of ['', 'ing_', 'ing_g_', 'ing_g_abc', 'ing_en_-100123_2', 'ing_tp_-100123_x_1', 'ing_tp_-100123_5',
    "ing_g_-100123'; DROP TABLE files;--", 'ing_g_' + '9'.repeat(30), 'ing_list ', 'xing_list', null, undefined, 5]) {
    assert.equal(panel.parseCb(bad), null, String(bad));
  }
});

test('كل callback_data في كل الشاشات ≤ 64 بايت (حتى مع أكبر المعرّفات)', () => {
  const chat = '-100' + '9'.repeat(13);
  const groups = Array.from({ length: 40 }, (_, i) => ({ chat_id: chat, title: 'G' + i, enabled: i % 2 }));
  const topics = Array.from({ length: 24 }, (_, i) => ({ id: '9'.repeat(12), name: 'T' + i }));
  const views = [
    panel.buildListView(groups),
    panel.buildGroupView({ group: { chat_id: chat, title: 'T' }, source: { enabled: 1, all_topics: 0, wm_at: null }, counts: [], err: null, topics, ruleTopics: ['null'], now: 0 }),
    panel.buildGroupView({ group: { chat_id: chat, title: 'T' }, source: null, counts: [], err: null, topics: [], ruleTopics: [], now: 0 }),
  ];
  let n = 0;
  for (const v of views) for (const row of v.rows) for (const b of row) {
    n++;
    assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
    assert.ok(panel.parseCb(b.callback_data) || b.callback_data === 'gp_panel', 'زر لا يفهمه المعالج: ' + b.callback_data);
  }
  assert.ok(n > 50);
});

test('غير المالك: يُرفض فوراً بلا أي استعلام', async () => {
  const stub = makeStub();
  for (const d of ['ing_list', `ing_g_${CHAT}`, `ing_en_${CHAT}_1`, `ing_tp_${CHAT}_5_1`]) {
    const out = await run(d, stub, '999');
    assert.deepEqual(out.toasts, ['🚫']);
    assert.equal(out.edits.length + out.replies.length, 0);
  }
  assert.equal(stub.calls.length, 0);
});

test('بيانات غير صالحة ← رفض بلا استعلام', async () => {
  const stub = makeStub();
  const out = await run("ing_g_1; DROP TABLE x", stub);
  assert.match(out.toasts[0], /غير صالحة/);
  assert.equal(stub.calls.length, 0);
});

test('قائمة القروبات والشاشة الفردية تُعرضان (قراءة فقط)', async () => {
  const stub = makeStub();
  let out = await run('ing_list', stub);
  assert.match(out.edits[0].text, /مراقبة الملفات/);
  out = await run(`ing_g_${CHAT}`, stub);
  assert.match(out.edits[0].text, /Group A/);
  assert.equal(writes(stub).length, 0);
});

test('قروب غير مسجَّل ← تنبيه ولا كتابة', async () => {
  const stub = makeStub({ registered: [] });
  const out = await run(`ing_en_${CHAT}_1`, stub);
  assert.match(out.toasts[0], /غير مسجَّل/);
  assert.equal(writes(stub).length, 0);
});

test('تفعيل/إيقاف: حالة صريحة (idempotent) وبلا DELETE', async () => {
  const stub = makeStub();
  await run(`ing_en_${CHAT}_1`, stub);
  await run(`ing_en_${CHAT}_1`, stub); // ضغطتان متتاليتان: نفس الأثر
  await run(`ing_en_${CHAT}_0`, stub);
  const w = writes(stub);
  assert.equal(w.length, 3);
  assert.match(w[0].sql, /INSERT INTO ingest_sources[\s\S]*VALUES \(\$1, \$2, 1, 1, \$3\)/);
  assert.deepEqual(w[0].params, [CHAT, 'Group A', OWNER]);
  assert.equal(w[0].sql, w[1].sql);
  assert.match(w[2].sql, /UPDATE ingest_sources SET enabled = 0/);
});

test('كل المواضيع والمواضيع المحددة: تنشئ المصدر معطّلاً إن لم يوجد، ولا تحذف قواعد', async () => {
  const stub = makeStub();
  await run(`ing_at_${CHAT}_0`, stub);
  await run(`ing_tp_${CHAT}_5_1`, stub);
  await run(`ing_tp_${CHAT}_5_0`, stub);
  await run(`ing_tp_${CHAT}_0_1`, stub);
  const w = writes(stub);
  assert.ok(w.some((c) => /INSERT INTO ingest_sources[\s\S]*VALUES \(\$1, \$2, 0, 1, \$3\)/.test(c.sql)), 'ensureSource بحالة معطّلة');
  assert.ok(w.some((c) => /UPDATE ingest_sources SET all_topics = \$2/.test(c.sql) && c.params[1] === 0));
  const add = w.find((c) => /INSERT INTO ingest_rules/.test(c.sql));
  assert.deepEqual(add.params, [7, '5']);
  assert.match(add.sql, /ON CONFLICT \(source_id, \(COALESCE\(topic_id, 0\)\)\)/);
  const off = w.find((c) => /UPDATE ingest_rules SET enabled = 0/.test(c.sql));
  assert.deepEqual(off.params, [7, '5']);
  const general = w.filter((c) => /INSERT INTO ingest_rules/.test(c.sql))[1];
  assert.deepEqual(general.params, [7, null]); // 0 = القروب نفسه = NULL
});

test('كل الكتابة في ingest_sources/ingest_rules فقط، ولا DELETE ولا DROP', async () => {
  const stub = makeStub();
  for (const d of [`ing_en_${CHAT}_1`, `ing_en_${CHAT}_0`, `ing_at_${CHAT}_1`, `ing_tp_${CHAT}_5_1`, `ing_tp_${CHAT}_5_0`]) await run(d, stub);
  for (const c of writes(stub)) {
    assert.match(c.sql, /^\s*(INSERT INTO|UPDATE)\s+(ingest_sources|ingest_rules)\b/i, c.sql.slice(0, 50));
  }
  for (const c of stub.calls) assert.doesNotMatch(c.sql, /\b(DELETE|DROP|TRUNCATE|ALTER)\b/i);
});

// ── المعترض مع Telegraf الحقيقي ──
let restoreApi = () => {};
test.afterEach(() => restoreApi());

function makeBot(stub) {
  const bot = new Telegraf('123456:TEST');
  const calls = [];
  // Telegraf ينشئ كائن Telegram جديداً لكل تحديث، فيُعترض على مستوى الصنف (ويُستعاد بعد كل اختبار)
  const orig = Telegram.prototype.callApi;
  Telegram.prototype.callApi = async function (method, payload) { calls.push({ method, payload }); return true; };
  restoreApi = () => { Telegram.prototype.callApi = orig; };
  bot.botInfo = { id: 1, is_bot: true, first_name: 'b', username: 'b' };
  panel.register(bot, { getPg: () => stub, ownerId: () => OWNER });
  const generic = [];
  bot.on('callback_query', (ctx) => { generic.push(ctx.callbackQuery.data); });
  const press = (data, fromId = Number(OWNER)) => bot.handleUpdate({
    update_id: Math.floor(Math.random() * 1e9),
    callback_query: {
      id: 'q' + Math.random(), chat_instance: 'c', data,
      from: { id: fromId, is_bot: false, first_name: 'u' },
      message: { message_id: 5, date: 1, chat: { id: fromId, type: 'private' }, text: 'x' },
    },
  });
  return { press, calls, generic };
}

test('المعترض: أزرار ing_ يعالجها وحده، وغيرها تصل للمعالج التالي كما هي', async () => {
  const stub = makeStub();
  const b = makeBot(stub);
  await b.press('ing_list');
  assert.deepEqual(b.generic, []);                                   // لم يصل شيء للمعالج العام
  assert.ok(b.calls.some((c) => c.method === 'editMessageText'));
  await b.press('gp_panel');
  await b.press('mg_menu');
  await b.press('ww:j:1');
  assert.deepEqual(b.generic, ['gp_panel', 'mg_menu', 'ww:j:1']);    // البقية تمرّ سليمة
  assert.equal(stub.calls.length > 0 && stub.calls.every((c) => /group_chats|ingest_/.test(c.sql)), true);
});

test('المعترض: غير المالك يُرفض ولا يصل شيء للمعالج العام ولا لقاعدة البيانات', async () => {
  const stub = makeStub();
  const b = makeBot(stub);
  await b.press(`ing_en_${CHAT}_1`, 999);
  assert.deepEqual(b.generic, []);
  assert.equal(stub.calls.length, 0);
  assert.ok(b.calls.some((c) => c.method === 'answerCallbackQuery' && c.payload.text === '🚫'));
});

test('المعترض: خطأ داخلي لا ينهار ولا يمسّ المعالج العام', async () => {
  const stub = makeStub();
  stub.query = async () => { throw new Error('db down'); };
  const b = makeBot(stub);
  await b.press('ing_list');
  assert.deepEqual(b.generic, []);
  assert.ok(b.calls.some((c) => c.method === 'answerCallbackQuery'));
});
