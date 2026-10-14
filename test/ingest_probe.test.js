'use strict';
/**
 * 🧪 test/ingest_probe.test.js — أمر /ingest_probe (مرحلة الحفظ، الخطوة 1)
 * بلا شبكة وبلا قاعدة حقيقية (كائنات وهمية). يحرس:
 *  - المالك فقط وفي الخاص فقط، قبل أي استعلام أو استدعاء Telegram.
 *  - لا شيء يُرسَل بلا INGEST_STORAGE_CHAT_ID صالح.
 *  - قراءة فقط: لا INSERT/UPDATE/DELETE في أي استعلام.
 *  - تصنيف أخطاء forward (حماية المحتوى، رسالة محذوفة، حدّ المعدّل...).
 *  - المسار الناجح: forward ثم إرسال بالـ file_id، والعبارات الصحيحة في التقرير.
 * التشغيل: node --test test/ingest_probe.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../handlers/ingest_probe');

const OWNER = '111';
const STORAGE = '-1001234567890';

function makeBot() {
  const cmds = {};
  return { command: (name, fn) => { cmds[name] = fn; }, cmds };
}

function makeEnv({ from = OWNER, chatType = 'private', text = '/ingest_probe', tg = {}, rows = [ITEM] } = {}) {
  const calls = { replies: [], queries: [], tg: [] };
  const track = (name, impl) => async (...a) => { calls.tg.push([name, ...a]); return impl(...a); };
  const telegram = {
    getChat: track('getChat', async () => ({ title: 'مخزن' })),
    getMe: track('getMe', async () => ({ id: 999 })),
    getChatMember: track('getChatMember', async () => ({ status: 'administrator', can_post_messages: true })),
    forwardMessage: track('forwardMessage', async () => ({ document: { file_id: 'FID', file_unique_id: 'UNI', file_name: 'a.pdf', file_size: 2048 } })),
    sendDocument: track('sendDocument', async () => ({})),
    sendVideo: track('sendVideo', async () => ({})),
    ...Object.fromEntries(Object.entries(tg).map(([k, v]) => [k, track(k, v)])),
  };
  const ctx = {
    from: { id: Number(from) },
    chat: { id: 5, type: chatType },
    message: { text },
    botInfo: { id: 999 },
    telegram,
    reply: async (t) => { calls.replies.push(t); },
  };
  const pg = { query: async (sql, params) => { calls.queries.push({ sql, params }); return { rows }; } };
  const deps = { ownerId: () => OWNER, getPg: () => pg, storageChatId: () => STORAGE };
  return { ctx, deps, calls };
}

const ITEM = { id: 7, message_id: '4321', file_name: 'a.pdf', size: '2048', chat_id: '-100999', title: 'قروب الدراسة' };

async function invoke(env) {
  const bot = makeBot();
  P.register(bot, env.deps);
  await bot.cmds.ingest_probe(env.ctx);
}

test('parseArgs: رقم و nosend وأي شيء آخر غير صالح', () => {
  assert.deepEqual(P.parseArgs('/ingest_probe'), { itemId: null, send: true, ok: true });
  assert.deepEqual(P.parseArgs('/ingest_probe@my_bot 55 nosend'), { itemId: '55', send: false, ok: true });
  assert.equal(P.parseArgs('/ingest_probe abc').ok, false);
  assert.equal(P.parseArgs('/ingest_probe 1 2').ok, false);
});

test('validStorageId: أرقام محادثات تلغرام فقط', () => {
  assert.equal(P.validStorageId('-1001234567890'), '-1001234567890');
  assert.equal(P.validStorageId(''), null);
  assert.equal(P.validStorageId('@channel'), null);
  assert.equal(P.validStorageId(undefined), null);
});

test('extractFile: GIF يُقرأ animation، والصورة أكبر حجم، وغير ذلك null', () => {
  const gif = { animation: { file_id: 'A' }, document: { file_id: 'D' } };
  assert.equal(P.extractFile(gif).kind, 'animation');
  const ph = { photo: [{ file_id: 's' }, { file_id: 'L', file_size: 9 }] };
  assert.equal(P.extractFile(ph).file_id, 'L');
  assert.equal(P.extractFile({ text: 'x' }), null);
  assert.equal(P.extractFile(null), null);
});

test('classifyError: كل حالة بنوعها', () => {
  const E = (description, extra = {}) => ({ response: { description, ...extra } });
  assert.equal(P.classifyError(E('Bad Request: CHAT_FORWARDS_RESTRICTED')).kind, 'protected');
  assert.equal(P.classifyError(E("Bad Request: forwards restricted")).kind, 'protected');
  assert.equal(P.classifyError(E("Bad Request: message can't be forwarded")).kind, 'protected');
  assert.equal(P.classifyError(E('Bad Request: something unexpected')).kind, 'other');
  assert.equal(P.classifyError(E('Bad Request: message to forward not found')).kind, 'gone');
  assert.equal(P.classifyError(E('Bad Request: chat not found')).kind, 'chat');
  assert.equal(P.classifyError(E('Bad Request: not enough rights to send')).kind, 'rights');
  const r = P.classifyError(E('Too Many Requests: retry after 7', { parameters: { retry_after: 7 } }));
  assert.deepEqual(r, { kind: 'rate', retry: 7 });
});

test('غير المالك: 🚫 بلا أي استعلام أو استدعاء تلغرام', async () => {
  const env = makeEnv({ from: '222' });
  await invoke(env);
  assert.deepEqual(env.calls.replies, ['🚫']);
  assert.equal(env.calls.queries.length, 0);
  assert.equal(env.calls.tg.length, 0);
});

test('خارج الخاص: رفض بلا أي استدعاء', async () => {
  const env = makeEnv({ chatType: 'supergroup' });
  await invoke(env);
  assert.equal(env.calls.tg.length, 0);
  assert.match(env.calls.replies[0], /الخاصة/);
});

test('بلا قناة تخزين: تعليمات فقط، لا forward ولا استعلام', async () => {
  const env = makeEnv();
  env.deps.storageChatId = () => '';
  await invoke(env);
  assert.match(env.calls.replies[0], /INGEST_STORAGE_CHAT_ID/);
  assert.equal(env.calls.tg.length, 0);
  assert.equal(env.calls.queries.length, 0);
});

test('المسار الناجح: forward بالمعرّفات الصحيحة ثم إرسال بالـ file_id، وقراءة فقط', async () => {
  const env = makeEnv();
  await invoke(env);
  const fwd = env.calls.tg.find((c) => c[0] === 'forwardMessage');
  assert.deepEqual(fwd.slice(1), [STORAGE, '-100999', 4321]);
  const send = env.calls.tg.find((c) => c[0] === 'sendDocument');
  assert.deepEqual(send.slice(1), [5, 'FID']);
  const out = env.calls.replies.join('\n');
  assert.match(out, /يطابق الأصل ✅/);
  assert.match(out, /الطريقة A تعمل/);
  for (const q of env.calls.queries) assert.doesNotMatch(q.sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
});

test('nosend: لا إرسال، والتقرير يقول ذلك', async () => {
  const env = makeEnv({ text: '/ingest_probe 7 nosend' });
  await invoke(env);
  assert.equal(env.calls.tg.some((c) => c[0] === 'sendDocument'), false);
  assert.deepEqual(env.calls.queries[0].params, ['7']);
  assert.match(env.calls.replies.join('\n'), /تخطّيت الإرسال/);
});

test('حجم مختلف عن الأصل: يُحذَّر في التقرير', async () => {
  const env = makeEnv({ rows: [{ ...ITEM, size: '9999' }] });
  await invoke(env);
  assert.match(env.calls.replies.join('\n'), /لا يطابق الأصل/);
});

test('قروب بحماية المحتوى: فشل واضح يوجّه إلى الطريقة B، بلا إرسال', async () => {
  const env = makeEnv({ tg: { forwardMessage: async () => { throw { response: { description: 'Bad Request: forwards restricted' } }; } } });
  await invoke(env);
  const out = env.calls.replies.join('\n');
  assert.match(out, /الطريقة B/);
  assert.equal(env.calls.tg.some((c) => c[0] === 'sendDocument'), false);
});

test('البوت غير مشرف في قناة التخزين: يتوقف قبل قراءة أي عنصر', async () => {
  const env = makeEnv({ tg: { getChatMember: async () => ({ status: 'left' }) } });
  await invoke(env);
  assert.match(env.calls.replies.join('\n'), /ليس مشرفاً/);
  assert.equal(env.calls.queries.length, 0);
  assert.equal(env.calls.tg.some((c) => c[0] === 'forwardMessage'), false);
});

test('عنصر غير موجود', async () => {
  const env = makeEnv({ rows: [] });
  await invoke(env);
  assert.match(env.calls.replies.join('\n'), /لا توجد عناصر|غير موجود/);
  assert.equal(env.calls.tg.some((c) => c[0] === 'forwardMessage'), false);
});
