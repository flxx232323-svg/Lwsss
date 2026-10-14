'use strict';
/**
 * 🧪 test/ingest_senders.test.js — تتبّع مشرفي القروبات (INGEST_TRACK_ADMINS)
 * بلا شبكة ولا قاعدة حقيقية ولا خادم HTTP: تُستدعى معالجات الراوتر مباشرة بقاعدة وهمية. يحرس:
 *  - الافتراضي (التتبع مطفأ): المالك فقط، ولا استدعاء لـ Bot API، و/config بلا allowed_senders.
 *  - التتبع مفعّل: المالك + مشرفو القروب فقط، والغريب يُتجاهل على الخادم نفسه.
 *  - فشل جلب المشرفين = المالك فقط (إغلاق على الأمان).
 *  - الكاش: استدعاء واحد لكل قروب، ويُعاد الجلب بعد انتهاء المدة، والمتزامن يُدمج.
 * التشغيل: node --test test/ingest_senders.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../utils/ingest_senders');
const { createRouter } = require('../routes/ingest_internal');

const OWNER = '111';
const CHAT = '-1001234567890';

// ── الوحدة النقية ──────────────────────────────────────────────

test('trackAdminsEnabled: قراءة المتغير', () => {
  const old = process.env.INGEST_TRACK_ADMINS;
  try {
    for (const [v, want] of [[undefined, false], ['', false], ['0', false], ['1', true], ['true', true], ['ON', true], ['no', false]]) {
      if (v === undefined) delete process.env.INGEST_TRACK_ADMINS; else process.env.INGEST_TRACK_ADMINS = v;
      assert.equal(S.trackAdminsEnabled(), want, String(v));
    }
  } finally {
    if (old === undefined) delete process.env.INGEST_TRACK_ADMINS; else process.env.INGEST_TRACK_ADMINS = old;
  }
});

test('allowedSenders: المالك دائماً، والمشرفون فقط عند التفعيل وتوفر القائمة', () => {
  assert.deepEqual([...S.allowedSenders({ owner: OWNER, trackAdmins: false, admins: new Set(['222']) })], ['111']);
  assert.deepEqual([...S.allowedSenders({ owner: OWNER, trackAdmins: true, admins: new Set(['222', 333]) })].sort(), ['111', '222', '333']);
  assert.deepEqual([...S.allowedSenders({ owner: OWNER, trackAdmins: true, admins: null })], ['111']);
  assert.equal(S.allowedSenders({ owner: '', trackAdmins: true, admins: null }).size, 0);
});

function fakeTg(impl) {
  const calls = [];
  return { calls, getChatAdministrators: async (id) => { calls.push(id); return impl(id); } };
}
const member = (id, extra = {}) => ({ status: 'administrator', user: { id, is_bot: false, ...extra } });

test('الجالب: يتجاهل البوتات، المعرّفات نصوص، والكاش يمنع الاستدعاء المتكرر', async () => {
  const tg = fakeTg(() => [member(222), member(5, { is_bot: true }), { status: 'creator', user: { id: 333 } }]);
  const get = S.createAdminResolver(() => tg);
  assert.deepEqual([...await get(CHAT)].sort(), ['222', '333']);
  await get(CHAT);
  assert.deepEqual(tg.calls, [CHAT]);
});

test('الجالب: ينتهي الكاش بعد المدة، وكاش الفشل أقصر', async () => {
  let t = 0;
  let fail = true;
  const tg = fakeTg(() => { if (fail) throw new Error('boom'); return [member(222)]; });
  const get = S.createAdminResolver(() => tg, { ttlOk: 1000, ttlFail: 100, now: () => t });
  assert.equal(await get(CHAT), null);
  t = 50; await get(CHAT);
  assert.equal(tg.calls.length, 1, 'الفشل يُخزَّن دقيقة قصيرة ولا يُعاد فوراً');
  fail = false; t = 200;
  assert.deepEqual([...await get(CHAT)], ['222']);
  t = 1100;
  await get(CHAT);
  assert.equal(tg.calls.length, 2, 'ما زال الكاش صالحاً (انتهى عند 1200)');
  t = 1300;
  await get(CHAT);
  assert.equal(tg.calls.length, 3, 'يُعاد الجلب بعد انتهاء مدة النجاح');
});

test('الجالب: الطلبات المتزامنة لنفس القروب تُدمج في استدعاء واحد', async () => {
  const tg = fakeTg(async () => [member(222)]);
  const get = S.createAdminResolver(() => tg);
  await Promise.all([get(CHAT), get(CHAT), get(CHAT)]);
  assert.equal(tg.calls.length, 1);
});

test('الجالب: بلا كائن telegram أو رد غير قائمة = null (لا استثناء)', async () => {
  assert.equal(await S.createAdminResolver(() => null)(CHAT), null);
  assert.equal(await S.createAdminResolver(() => fakeTg(() => 'x'))(CHAT), null);
});

// ── الراوتر: القاعدة تُفرض على الخادم ─────────────────────────

function makeStub(state) {
  const calls = [];
  const q = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM ingest_sources s\b/.test(sql)) return { rows: state.configRows || [], rowCount: (state.configRows || []).length };
    if (/FROM ingest_sources WHERE id/.test(sql)) return { rows: state.source ? [state.source] : [], rowCount: state.source ? 1 : 0 };
    if (/FROM ingest_rules WHERE enabled = 1 AND source_id = ANY/.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM ingest_rules WHERE source_id/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO ingest_items/.test(sql)) return { rows: [], rowCount: params.length / 11 };
    if (/INSERT INTO ingest_watermarks/.test(sql)) return { rows: [{ wm: String(params[1]) }], rowCount: 1 };
    if (/SELECT 1 FROM ingest_events/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO ingest_events/.test(sql)) return { rows: [], rowCount: 1 };
    throw new Error('unexpected sql: ' + sql.slice(0, 80));
  };
  return { query: q, connect: async () => ({ query: q, release() {} }), calls };
}

async function call(router, method, path, body) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `المسار ${method} ${path} غير موجود`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  let status = 200;
  let json;
  const res = { status(c) { status = c; return res; }, json(j) { json = j; return res; } };
  await handler({ body, query: {}, headers: {} }, res, (e) => { if (e) throw e; });
  return { status, json };
}

const SOURCE = { id: 1, enabled: 1, mode: 'userbot', all_topics: 1, chat_id: CHAT };
const item = (id, sender) => ({ message_id: id, sender_id: sender, topic_id: null, file_name: `f${id}.pdf` });
const BATCH = { source_id: 1, items: [item(1, '111'), item(2, '222'), item(3, '333')], watermark: 3 };

function build({ track, admins, source = SOURCE, configRows }) {
  const stub = makeStub({ source, configRows });
  const adminCalls = [];
  const router = createRouter({
    getPg: () => stub,
    getOwnerId: () => OWNER,
    trackAdmins: () => track,
    getAdmins: async (chatId) => { adminCalls.push(chatId); return admins; },
  });
  return { router, stub, adminCalls };
}

test('الراوتر، التتبع مطفأ (الافتراضي): المالك فقط ولا استدعاء لقائمة المشرفين', async () => {
  const t = build({ track: false, admins: new Set(['222']) });
  const r = await call(t.router, 'post', '/batch', BATCH);
  assert.equal(r.status, 200);
  assert.equal(r.json.inserted, 1);
  assert.equal(r.json.skipped_sender, 2);
  assert.equal(t.adminCalls.length, 0);
});

test('الراوتر، التتبع مفعّل: المالك والمشرف يُسجَّلان، والغريب يُتجاهل على الخادم', async () => {
  const t = build({ track: true, admins: new Set(['222']) });
  const r = await call(t.router, 'post', '/batch', BATCH);
  assert.equal(r.json.inserted, 2);
  assert.equal(r.json.skipped_sender, 1);
  assert.deepEqual(t.adminCalls, [CHAT]);
});

test('الراوتر، مرسل رقمي (Number) يُقارن كنص بشكل صحيح', async () => {
  const t = build({ track: true, admins: new Set(['222']) });
  const r = await call(t.router, 'post', '/batch', { ...BATCH, items: [item(1, 222), item(2, 333)], watermark: 2 });
  assert.equal(r.json.inserted, 1);
  assert.equal(r.json.skipped_sender, 1);
});

test('الراوتر، فشل جلب المشرفين: المالك فقط', async () => {
  const t = build({ track: true, admins: null });
  const r = await call(t.router, 'post', '/batch', BATCH);
  assert.equal(r.json.inserted, 1);
  assert.equal(r.json.skipped_sender, 2);
});

test('الراوتر، /config: allowed_senders تظهر عند التفعيل فقط (المالك + المشرفون)', async () => {
  const rows = [{ id: 1, chat_id: CHAT, title: 'G', all_topics: 1, last_message_id: '0' }];
  const on = build({ track: true, admins: new Set(['222']), configRows: rows });
  const a = await call(on.router, 'get', '/config');
  assert.deepEqual([...a.json.sources[0].allowed_senders].sort(), ['111', '222']);
  assert.equal(a.json.owner_id, OWNER);

  const off = build({ track: false, admins: new Set(['222']), configRows: rows });
  const b = await call(off.router, 'get', '/config');
  assert.equal('allowed_senders' in b.json.sources[0], false);
  assert.equal(off.adminCalls.length, 0);
});

test('الراوتر: لا كتابة خارج جداول ingest_* مع المشرفين', async () => {
  const t = build({ track: true, admins: new Set(['222']) });
  await call(t.router, 'post', '/batch', BATCH);
  for (const c of t.stub.calls) {
    if (/INSERT|UPDATE|DELETE/i.test(c.sql)) assert.match(c.sql, /ingest_(items|watermarks|events)/);
  }
});
