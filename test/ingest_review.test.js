'use strict';
/**
 * 🧪 test/ingest_review.test.js — مركز مراجعة الملفات (المرحلة 4أ)
 *
 * بلا قاعدة بيانات حقيقية، وبـ Telegraf الحقيقي بلا شبكة. يحرس:
 *  - صيغة callback_data (رفض كل ما لا يطابق) وحدّ 64 بايت لكل أزرار كل الشاشات.
 *  - المالك فقط (أمر وأزرار) قبل أي استعلام.
 *  - عبارات الكتابة: ingest_items/ingest_rules/ingest_events فقط، ومشروطة بحالة "بانتظار المراجعة"،
 *    ولا موافقة بلا قسم موجود وغير محذوف، ولا DELETE/DROP/ALTER.
 *  - المعترض لا يمسّ أزرار البوت الأخرى.
 * (دلالات SQL نفسها تُختبر على PostgreSQL حقيقي خارج هذا الملف.)
 *
 * التشغيل: node --test test/ingest_review.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Telegraf, Telegram } = require('telegraf');
const rev = require('../handlers/ingest_review');

const OWNER = '111';

function recStub(rowsFor) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      const r = rowsFor ? rowsFor(sql, params) : null;
      return r || { rows: [], rowCount: 0 };
    },
  };
}

test('parseCb: يقبل الصيغ الصحيحة فقط', () => {
  assert.deepEqual(rev.parseCb('inr_q'), { a: 'queue' });
  assert.deepEqual(rev.parseCb('inr_b_3_5'), { a: 'batch', sid: '3', tp: '5', page: 0 });
  assert.deepEqual(rev.parseCb('inr_b_3_0_2'), { a: 'batch', sid: '3', tp: '0', page: 2 });
  assert.deepEqual(rev.parseCb('inr_i_77'), { a: 'item', id: '77' });
  assert.deepEqual(rev.parseCb('inr_ia_77'), { a: 'itemApprove', id: '77' });
  assert.deepEqual(rev.parseCb('inr_ir_77'), { a: 'itemReject', id: '77' });
  assert.deepEqual(rev.parseCb('inr_ba_3_5'), { a: 'batchApprove', sid: '3', tp: '5' });
  const pk = rev.parseCb('inr_pk_b3.5_y_12');
  assert.deepEqual([pk.a, pk.lvl, pk.parent, pk.t.kind, pk.t.sid, pk.t.tp], ['pick', 'y', '12', 'batch', '3', '5']);
  const pi = rev.parseCb('inr_pk_i77_s_0');
  assert.deepEqual([pi.t.kind, pi.t.id], ['item', '77']);
  const pc = rev.parseCb('inr_pc_b3.5_9');
  assert.deepEqual([pc.a, pc.cat], ['pickDone', '9']);
  for (const bad of ['', 'inr_', 'inr_b_x_5', 'inr_i_', "inr_i_1; DROP TABLE files", 'inr_ba_3', 'inr_pk_b3.5_z_1', 'inr_pk_x3_s_0',
    'inr_pk_b3.5_s', 'inr_pc_b3.5_', 'inr_ia_' + '9'.repeat(25), 'inr_b_1_2_3_4', 'inr_q ', 'xinr_q', null, undefined, 7]) {
    assert.equal(rev.parseCb(bad), null, String(bad));
  }
});

test('كل callback_data في كل الشاشات ≤ 64 بايت ويفهمها المعالج (حتى مع أكبر القيم)', () => {
  const sid = '9'.repeat(9), tp = '9'.repeat(12), id = '9'.repeat(19);
  const item = { id, source_id: sid, tp, state: 'discovered', file_name: 'x'.repeat(200), caption: 'c'.repeat(300), size: '9999999999', mime_type: 'application/pdf', message_date: new Date(0), source_message_id: '1' };
  const items = Array.from({ length: 8 }, () => ({ id, file_name: 'f', size: '1', own_cat: null, rule_cat: null, source_message_id: '1' }));
  const children = Array.from({ length: 31 }, (_, i) => ({ id: '9'.repeat(9), name: 'N' + i }));
  const T1 = `b${sid}.${tp}`, T2 = `i${id}`;
  const views = [
    rev.buildQueueView({ counts: { pending: 1, approved: 0, rejected: 0 }, batches: Array.from({ length: 40 }, () => ({ source_id: sid, tp, title: 'T', topic_name: 'N', n: 3, no_path: 1 })) }),
    rev.buildBatchView({ sid, tp, title: 'T', topicName: 'N', pathText: 'a › b', items, page: 5, total: 100, noPath: 2 }),
    rev.buildItemView({ item, srcTitle: 'T', topicName: 'N', pathText: 'p', ownPath: true, dupCount: 2 }),
    ...['s', 'y', 'm', 'u', 'c'].map((lvl) => rev.buildPickView({ T: T1, lvl, parent: '9'.repeat(9), crumb: 'a', children, backCb: `inr_pk_${T1}_s_0`, cancelCb: `inr_b_${sid}_${tp}` })),
    rev.buildPickView({ T: T2, lvl: 'c', parent: '1', crumb: 'a', children, backCb: `inr_pk_${T2}_u_${'9'.repeat(9)}`, cancelCb: `inr_i_${id}` }),
  ];
  let n = 0;
  for (const v of views) for (const row of v.rows) for (const b of row) {
    n++;
    assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
    assert.ok(rev.parseCb(b.callback_data) || b.callback_data === 'gp_panel', 'زر لا يفهمه المعالج: ' + b.callback_data);
  }
  assert.ok(n > 100);
});

test('غير المالك: يُرفض بلا أي استعلام (كل أنواع الأزرار)', async () => {
  const stub = recStub();
  for (const d of ['inr_q', 'inr_b_1_5', 'inr_i_1', 'inr_ia_1', 'inr_ir_1', 'inr_ba_1_5', 'inr_pk_b1.5_s_0', 'inr_pc_b1.5_9']) {
    const toasts = [];
    const ctx = { from: { id: 999 }, callbackQuery: { data: d }, answerCbQuery: async (t) => { toasts.push(t); }, editMessageText: async () => {}, reply: async () => {} };
    await rev.handle(ctx, d, { getPg: () => stub, ownerId: () => OWNER });
    assert.deepEqual(toasts, ['🚫'], d);
  }
  assert.equal(stub.calls.length, 0);
});

test('بيانات غير صالحة ← رفض بلا استعلام', async () => {
  const stub = recStub();
  const toasts = [];
  const ctx = { from: { id: 111 }, callbackQuery: { data: 'x' }, answerCbQuery: async (t) => { toasts.push(t); } };
  await rev.handle(ctx, 'inr_i_1; DROP TABLE files', { getPg: () => stub, ownerId: () => OWNER });
  assert.match(toasts[0], /غير صالحة/);
  assert.equal(stub.calls.length, 0);
});

test('الموافقة والرفض: مشروطان بحالة "بانتظار المراجعة" وبقسم موجود، وفي جداول ingest_* فقط', async () => {
  const stub = recStub(() => ({ rows: [{ id: 5, source_id: 1 }], rowCount: 1 }));
  await rev.approveItem(stub, '5', OWNER);
  await rev.approveBatch(stub, '1', '5', OWNER);
  await rev.rejectItem(stub, '5', OWNER);
  await rev.setPath(stub, { kind: 'batch', sid: '1', tp: '5' }, '9', OWNER);
  await rev.setPath(stub, { kind: 'item', id: '5' }, '9', OWNER);
  const writes = stub.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)/i.test(c.sql));
  assert.ok(writes.length >= 9);
  for (const c of writes) {
    const target = /^\s*(?:INSERT INTO|UPDATE)\s+(\w+)/i.exec(c.sql)[1];
    assert.match(target, /^ingest_(items|rules|events)$/, 'كتابة خارج ingest_*: ' + target);
  }
  for (const c of stub.calls) assert.doesNotMatch(c.sql, /\b(DELETE|DROP|TRUNCATE|ALTER)\b/i);
  const approve = stub.calls.find((c) => /SET state = 'approved'/.test(c.sql) && /i2\.id = \$1/.test(c.sql));
  assert.match(approve.sql, /i2\.state IN \('discovered'/);
  assert.match(approve.sql, /EXISTS \(SELECT 1 FROM categories c WHERE c\.id = x\.cat AND c\.is_deleted = 0\)/);
  assert.match(approve.sql, /x\.cat IS NOT NULL/);
  const batch = stub.calls.find((c) => /SET state = 'approved'/.test(c.sql) && /i2\.source_id = \$1/.test(c.sql));
  assert.match(batch.sql, /i2\.state IN \('discovered'/);
  assert.match(batch.sql, /x\.cat IS NOT NULL/);
  const reject = stub.calls.find((c) => /SET state = 'rejected'/.test(c.sql));
  assert.match(reject.sql, /AND state IN \('discovered'/);
  assert.equal(stub.calls.some((c) => /\b(files|categories|subjects)\b/.test((/^\s*(?:INSERT INTO|UPDATE)\s+(\w+)/i.exec(c.sql) || [])[1] || '')), false);
});

test('لا يُحفظ مسار لقسم غير موجود أو محذوف', async () => {
  const stub = recStub((sql) => (/FROM categories WHERE id/.test(sql) ? { rows: [], rowCount: 0 } : null));
  assert.equal(await rev.setPath(stub, { kind: 'batch', sid: '1', tp: '5' }, '9', OWNER), false);
  assert.equal(stub.calls.filter((c) => /^\s*(INSERT|UPDATE)/i.test(c.sql)).length, 0);
});

// ── Telegraf الحقيقي ──
let restoreApi = () => {};
test.afterEach(() => restoreApi());

function makeBot(stub) {
  const bot = new Telegraf('123456:TEST');
  const calls = [];
  const orig = Telegram.prototype.callApi;
  Telegram.prototype.callApi = async function (method, payload) { calls.push({ method, payload }); return { message_id: 1 }; };
  restoreApi = () => { Telegram.prototype.callApi = orig; };
  bot.botInfo = { id: 1, is_bot: true, first_name: 'b', username: 'b' };
  rev.register(bot, { getPg: () => stub, ownerId: () => OWNER });
  const generic = [];
  bot.on('callback_query', (ctx) => { generic.push(ctx.callbackQuery.data); });
  const press = (data, fromId = Number(OWNER)) => bot.handleUpdate({
    update_id: Math.floor(Math.random() * 1e9),
    callback_query: { id: 'q' + Math.random(), chat_instance: 'c', data, from: { id: fromId, is_bot: false, first_name: 'u' },
      message: { message_id: 5, date: 1, chat: { id: fromId, type: 'private' }, text: 'x' } },
  });
  const command = (text, fromId = Number(OWNER)) => bot.handleUpdate({
    update_id: Math.floor(Math.random() * 1e9),
    message: { message_id: 9, date: 1, chat: { id: fromId, type: 'private' }, from: { id: fromId, is_bot: false, first_name: 'u' },
      text, entities: [{ type: 'bot_command', offset: 0, length: text.length }] },
  });
  return { press, command, calls, generic };
}

test('المعترض: أزرار inr_ يعالجها وحده، وغيرها (ومنها ing_ وgp_) تمرّ للمعالج التالي', async () => {
  const stub = recStub();
  const b = makeBot(stub);
  await b.press('inr_q');
  assert.deepEqual(b.generic, []);
  assert.ok(b.calls.some((c) => c.method === 'editMessageText'));
  await b.press('gp_panel'); await b.press('ing_list'); await b.press('mg_menu');
  assert.deepEqual(b.generic, ['gp_panel', 'ing_list', 'mg_menu']);
});

test('المعترض: غير المالك يُرفض فلا استعلام ولا وصول للمعالج العام', async () => {
  const stub = recStub();
  const b = makeBot(stub);
  await b.press('inr_ba_1_5', 999);
  assert.deepEqual(b.generic, []);
  assert.equal(stub.calls.length, 0);
  assert.ok(b.calls.some((c) => c.method === 'answerCallbackQuery' && c.payload.text === '🚫'));
});

test('أمر /ingest_review: المالك يرى القائمة، وغيره يُرفض بلا استعلام', async () => {
  const stub = recStub();
  const b = makeBot(stub);
  await b.command('/ingest_review');
  const sent = b.calls.find((c) => c.method === 'sendMessage');
  assert.match(sent.payload.text, /مراجعة الملفات/);
  assert.ok(stub.calls.length > 0);
  const stub2 = recStub();
  const b2 = makeBot(stub2);
  await b2.command('/ingest_review', 999);
  assert.equal(stub2.calls.length, 0);
  assert.equal(b2.calls.find((c) => c.method === 'sendMessage').payload.text, '🚫');
});

test('المعترض: خطأ داخلي لا ينهار ولا يمسّ المعالج العام', async () => {
  const stub = recStub();
  stub.query = async () => { throw new Error('db down'); };
  const b = makeBot(stub);
  await b.press('inr_q');
  assert.deepEqual(b.generic, []);
  assert.ok(b.calls.some((c) => c.method === 'answerCallbackQuery'));
});
