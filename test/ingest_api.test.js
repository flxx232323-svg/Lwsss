'use strict';
/**
 * 🧪 test/ingest_api.test.js — نقاط استقبال UserBot (المرحلة 2أ)
 *
 * بلا قاعدة بيانات حقيقية: قاعدة وهمية تُسجّل كل استعلام. يحرس:
 *  - المصادقة بالسر، والتحقق من الحمولة قبل أي استعلام.
 *  - فرض المالك (OWNER_ID) والنطاق (المواضيع) على جهة الخادم.
 *  - "تسجيل فقط": كل SQL يلمس جداول ingest_* حصراً (لا files ولا غيرها).
 *  - المعرّفات 64-بت تصل كما هي، وإعادة الإرسال لا تكرّر الأحداث.
 * (صحة جمل SQL نفسها تُختبر على PostgreSQL حقيقي خارج هذا الملف.)
 *
 * التشغيل: node --test test/ingest_api.test.js
 */
process.env.USERBOT_INTERNAL_SECRET = 'unit-test-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const internal = require('../routes/internal');
const { createRouter } = require('../routes/ingest_internal');

const OWNER = '111';
const SECRET = { 'X-Internal-Secret': 'unit-test-secret', 'Content-Type': 'application/json' };

function makeStub(state) {
  const calls = [];
  const q = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM ingest_sources s\b/.test(sql)) return { rows: state.configRows || [], rowCount: (state.configRows || []).length };
    if (/FROM ingest_sources WHERE id/.test(sql)) return { rows: state.source ? [state.source] : [], rowCount: state.source ? 1 : 0 };
    if (/FROM ingest_rules WHERE enabled = 1 AND source_id = ANY/.test(sql)) return { rows: state.configRules || [], rowCount: 0 };
    if (/FROM ingest_rules WHERE source_id/.test(sql)) return { rows: state.rules || [], rowCount: 0 };
    if (/INSERT INTO ingest_items/.test(sql)) { const n = params.length / 11; return { rows: [], rowCount: n - (state.preexisting || 0) }; }
    if (/INSERT INTO ingest_watermarks/.test(sql)) return { rows: [{ wm: String(params[1]) }], rowCount: 1 };
    if (/SELECT 1 FROM ingest_events/.test(sql)) return { rows: [], rowCount: state.dupError ? 1 : 0 };
    if (/INSERT INTO ingest_events/.test(sql)) return { rows: [], rowCount: 1 };
    throw new Error('unexpected sql: ' + sql.slice(0, 80));
  };
  return { query: q, connect: async () => ({ query: q, release() {} }), calls };
}

async function start(state = {}, owner = OWNER) {
  const stub = makeStub(state);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/internal/ingest', internal.requireInternalSecret, createRouter({ getPg: () => stub, getOwnerId: () => owner }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/internal/ingest';
  const post = async (path, body, headers = SECRET) => {
    const r = await fetch(url + path, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const get = async (path, headers = SECRET) => {
    const r = await fetch(url + path, { headers });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { stub, post, get, close: () => new Promise((r) => server.close(r)) };
}

const src = (over = {}) => ({ id: 1, enabled: 1, mode: 'userbot', all_topics: 1, ...over });
const item = (id, over = {}) => ({ message_id: id, sender_id: OWNER, topic_id: null, file_name: `f${id}.pdf`, ...over });

test('المصادقة: بلا سر أو بسر خاطئ ← 401 ولا استعلام', async () => {
  const t = await start({ source: src() });
  for (const h of [{ 'Content-Type': 'application/json' }, { 'X-Internal-Secret': 'wrong', 'Content-Type': 'application/json' }]) {
    assert.equal((await t.get('/config', h)).status, 401);
    assert.equal((await t.post('/batch', { source_id: 1, watermark: 5 }, h)).status, 401);
  }
  assert.equal(t.stub.calls.length, 0);
  await t.close();
});

test('GET /config: يعيد owner_id والمصادر المفعّلة ومواضيعها', async () => {
  const t = await start({
    configRows: [{ id: 3, chat_id: '-1001234567890', title: 'G', all_topics: 0, last_message_id: '40' }],
    configRules: [{ source_id: 3, topic_id: '5' }, { source_id: 3, topic_id: null }],
  });
  const r = await t.get('/config');
  assert.equal(r.status, 200);
  assert.equal(r.json.owner_id, OWNER);
  assert.deepEqual(r.json.sources, [{ id: 3, chat_id: '-1001234567890', title: 'G', all_topics: false, last_message_id: '40', topics: ['5', null] }]);
  await t.close();
});

test('GET /config: 503 إن لم يُضبط OWNER_ID على الخادم', async () => {
  const t = await start({}, '');
  assert.equal((await t.get('/config')).status, 503);
  await t.close();
});

test('الحمولة غير الصالحة ← 400 قبل أي استعلام', async () => {
  const t = await start({ source: src() });
  const bads = [
    {}, { source_id: 'x', watermark: 1 }, { source_id: 1 },
    { source_id: 1, items: 'no' }, { source_id: 1, items: Array.from({ length: 201 }, (_, i) => item(i + 1)), watermark: 300 },
    { source_id: 1, items: [item(0)], watermark: 5 }, { source_id: 1, items: [{ ...item(1), sender_id: 1.5 }], watermark: 5 },
    { source_id: 1, items: [{ ...item(1), topic_id: -3 }], watermark: 5 }, { source_id: 1, items: [{ ...item(1), size_bytes: -1 }], watermark: 5 },
    { source_id: 1, watermark: 'abc' }, { source_id: 1, items: [item(10)], watermark: 9 },
    { source_id: 1, error: 'x', watermark: 4 }, { source_id: 1, error: 5 },
  ];
  for (const b of bads) assert.equal((await t.post('/batch', b)).status, 400, JSON.stringify(b).slice(0, 80));
  assert.equal(t.stub.calls.length, 0);
  await t.close();
});

test('المصدر: غير موجود ← 404، معطّل أو وضعه bot ← 409 (لا تسجيل)', async () => {
  let t = await start({ source: null });
  assert.equal((await t.post('/batch', { source_id: 1, watermark: 5 })).status, 404);
  await t.close();
  for (const s of [src({ enabled: 0 }), src({ mode: 'bot' })]) {
    t = await start({ source: s });
    assert.equal((await t.post('/batch', { source_id: 1, items: [item(1)], watermark: 1 })).status, 409);
    assert.ok(!t.stub.calls.some((c) => /INSERT INTO ingest_items|INSERT INTO ingest_watermarks/.test(c.sql)));
    await t.close();
  }
});

test('المالك فقط: ملفات غيره تُتجاهل ولا تدخل الإدراج', async () => {
  const t = await start({ source: src() });
  const r = await t.post('/batch', { source_id: 1, items: [item(1), item(2, { sender_id: '999' }), item(3)], watermark: 3 });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.inserted, r.json.skipped_sender, r.json.skipped_scope], [2, 1, 0]);
  const ins = t.stub.calls.find((c) => /INSERT INTO ingest_items/.test(c.sql));
  assert.equal(ins.params.length, 2 * 11);
  await t.close();
});

test('النطاق: مع all_topics=0 تُقبل المواضيع ذات القواعد فقط (وnull = القروب نفسه)', async () => {
  const t = await start({ source: src({ all_topics: 0 }), rules: [{ topic_id: '5' }, { topic_id: null }] });
  const r = await t.post('/batch', {
    source_id: 1, watermark: 4,
    items: [item(1, { topic_id: 5 }), item(2, { topic_id: '9' }), item(3, { topic_id: null }), item(4)],
  });
  assert.deepEqual([r.json.inserted, r.json.skipped_scope], [3, 1]);
  await t.close();
  const t2 = await start({ source: src({ all_topics: 0 }), rules: [] });
  const r2 = await t2.post('/batch', { source_id: 1, items: [item(1, { topic_id: 5 })], watermark: 1 });
  assert.deepEqual([r2.json.inserted, r2.json.skipped_scope], [0, 1]);
  assert.ok(!t2.stub.calls.some((c) => /INSERT INTO ingest_items/.test(c.sql)));
  await t2.close();
});

test('المعرّفات 64-بت تصل نصوصاً دون فقد دقة', async () => {
  const t = await start({ source: src() });
  const big = '9223372036854775807';
  await t.post('/batch', { source_id: 1, items: [item(1, { grouped_id: big, tg_doc_id: big, sender_id: OWNER })], watermark: 1 });
  const ins = t.stub.calls.find((c) => /INSERT INTO ingest_items/.test(c.sql));
  assert.ok(ins.params.includes(big));
  assert.equal(ins.params.filter((p) => p === big).length, 2);
  await t.close();
});

test('تسجيل فقط: كل SQL يلمس جداول ingest_* حصراً', async () => {
  const t = await start({ source: src() });
  await t.post('/batch', { source_id: 1, items: [item(1)], watermark: 1 });
  await t.post('/batch', { source_id: 1, error: 'boom' });
  await t.get('/config');
  assert.ok(t.stub.calls.length > 5);
  for (const c of t.stub.calls) {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(c.sql)) continue;
    const targets = [...c.sql.replace(/DO UPDATE\s+SET/gi, 'DO_SET').matchAll(/\b(?:FROM|INTO|JOIN|UPDATE)\s+(\w+)/gi)].map((m) => m[1]);
    assert.ok(targets.length > 0, c.sql.slice(0, 50));
    for (const tbl of targets) assert.match(tbl, /^ingest_/, 'جدول خارج ingest_*: ' + tbl);
    assert.doesNotMatch(c.sql, /\b(DELETE|DROP|TRUNCATE|ALTER)\b/i);
  }
  await t.close();
});

test('نقطة التقدّم: تُكتب مع العناصر، وبدونها لا يُستعلم عنها', async () => {
  let t = await start({ source: src() });
  const r = await t.post('/batch', { source_id: 1, watermark: 77 });
  assert.equal(r.json.watermark, '77');
  assert.ok(t.stub.calls.some((c) => /INSERT INTO ingest_watermarks/.test(c.sql)));
  assert.ok(!t.stub.calls.some((c) => /INSERT INTO ingest_events/.test(c.sql)), 'لا حدث عند عدم وجود عناصر جديدة');
  await t.close();
  t = await start({ source: src() });
  await t.post('/batch', { source_id: 1, items: [item(1)] });
  assert.ok(!t.stub.calls.some((c) => /INSERT INTO ingest_watermarks/.test(c.sql)));
  await t.close();
});

test('إعادة الإرسال: العناصر الموجودة تُعدّ مكرّرة ولا حدث جديد', async () => {
  const t = await start({ source: src(), preexisting: 2 });
  const r = await t.post('/batch', { source_id: 1, items: [item(1), item(2)], watermark: 2 });
  assert.deepEqual([r.json.inserted, r.json.duplicates], [0, 2]);
  assert.ok(!t.stub.calls.some((c) => /INSERT INTO ingest_events/.test(c.sql)));
  await t.close();
});

test('تقرير الخطأ: يُسجَّل مرة، ولا يتكرر نفس الخطأ خلال ساعة', async () => {
  let t = await start({ source: src() });
  let r = await t.post('/batch', { source_id: 1, error: 'entity not found' });
  assert.deepEqual([r.status, r.json.recorded], [200, true]);
  assert.equal(t.stub.calls.filter((c) => /INSERT INTO ingest_events/.test(c.sql)).length, 1);
  await t.close();
  t = await start({ source: src(), dupError: true });
  r = await t.post('/batch', { source_id: 1, error: 'entity not found' });
  assert.deepEqual([r.status, r.json.recorded], [200, false]);
  assert.equal(t.stub.calls.filter((c) => /INSERT INTO ingest_events/.test(c.sql)).length, 0);
  await t.close();
});
