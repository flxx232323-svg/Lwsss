'use strict';
/**
 * ════════════════════════════════════════════════════════════
 *  💾 handlers/ingest_save.js — حفظ الملفات الموافق عليها في المكتبة (الطريقة A)
 * ════════════════════════════════════════════════════════════
 *  لكل عنصر state='approved' (approved_by موجود، والقسم محفوظ في suggested_category_id):
 *    1) القسم موجود؟  2) العنوان غير مكرر في القسم؟  3) forwardMessage إلى قناة التخزين → file_id للبوت
 *    4) النوع مدعوم والحجم يطابق الأصل؟  5) addFile (نفس دالة المكتبة)  6) قراءة الصف من files للتأكد
 *    7) حالة العنصر: completed / save_state=done / library_file_id.
 *
 *  الأوضاع (settings.ingest_stage، وغيابه أو أي قيمة غريبة = dry_run):
 *    dry_run     لا forward ولا كتابة إطلاقاً. /ingest_save يعرض فقط ما سيحدث.
 *    staging     لا شيء تلقائي. يدوياً فقط:  /ingest_save one [رقم]   (ملف واحد)
 *    production  عامل خلفي: 5 ملفات كل 30 ثانية بفاصل 3 ثوانٍ (حدود تلغرام)، + الأمر اليدوي.
 *
 *  الأوامر (المالك فقط، في الخاص فقط):
 *    /ingest_save                          حالة العمل وما ينتظر وآخر الإخفاقات
 *    /ingest_save stage <الوضع> [confirm]  تغيير الوضع (production يتطلب confirm + ملفاً محفوظاً واحداً على الأقل)
 *    /ingest_save one [رقم]                حفظ عنصر واحد الآن (أقدم المنتظرين إن لم يُحدَّد)
 *    /ingest_save retry <رقم>              إعادة عنصر فشل (بعد إصلاح السبب، مثل إعادة تسمية الملف المكرر)
 *
 *  ضمانات:
 *   - لا يلمس إلا state='approved' مع approved_by. لا يوافق ولا يرفض ولا ينشر.
 *   - الحجز ذرّي (UPDATE ... FOR UPDATE SKIP LOCKED + attempt_token)؛ والعالق pending > 10 دقائق يُستأنف.
 *   - إعادة محاولة بتأخير تصاعدي (حتى 5 محاولات)، وحدّ المعدّل يوقف العامل مؤقتاً.
 *   - كل نتيجة تُسجَّل في ingest_events (item_saved / item_save_failed).
 *   - الأنواع المدعومة الآن: document و video. غيرها يفشل بوضوح (unsupported_kind) بدل تخمين.
 *   - INGEST_SAVER_DISABLED=1 يمنع تشغيل العامل الخلفي حتى في production.
 * ════════════════════════════════════════════════════════════
 */

const probe = require('./ingest_probe');

const STAGES = ['dry_run', 'staging', 'production'];
const STAGE_KEY = 'ingest_stage';
const MAX_ATTEMPTS = 5;
const BACKOFF_SEC = [60, 300, 1800, 7200];
const GAP_MS = 3000;
const TICK_MS = 30000;
const TICK_BATCH = 5;
const SUPPORTED = { document: 'document', video: 'video' };

const ERR_AR = {
  duplicate_title: 'مكرر (نفس العنوان في نفس القسم)',
  protected: 'القروب يمنع forward (حماية المحتوى)',
  gone: 'الرسالة الأصلية محذوفة',
  chat: 'البوت لا يرى القروب المصدر',
  no_file: 'الرسالة المحوّلة بلا ملف',
  unsupported_kind: 'نوع ملف غير مدعوم بعد',
  size_mismatch: 'حجم الملف لا يطابق الأصل',
  verify_failed: 'فشل التحقق بعد الحفظ',
  category_missing: 'القسم محذوف أو غير موجود',
  source_missing: 'المصدر غير موجود',
  max_attempts: 'استُنفدت المحاولات',
  retry: 'خطأ مؤقت (ستُعاد المحاولة)',
};

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
function log(level, msg) { try { require('../utils/logger')[level](msg); } catch (_) { /* لا شيء */ } }
const clip = (s, n) => Array.from(String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, n).join('');
const normStage = (v) => (STAGES.includes(v) ? v : 'dry_run');
const codeOf = (lastError) => String(lastError || '').split(':')[0];
const arLabel = (lastError) => ERR_AR[codeOf(lastError)] || clip(lastError, 60) || '—';

function titleFor(item) {
  return clip(item.file_name, 200) || clip(String(item.caption || '').split('\n')[0], 120) || `ملف ${item.id}`;
}

function parseArgs(text) {
  const parts = String(text || '').trim().split(/\s+/).slice(1);
  const cmd = (parts[0] || 'status').toLowerCase();
  if (cmd === 'status' && parts.length <= 1) return { cmd: 'status' };
  if (cmd === 'stage' && STAGES.includes(parts[1]) && (parts.length === 2 || (parts.length === 3 && parts[2] === 'confirm'))) {
    return { cmd: 'stage', stage: parts[1], confirm: parts[2] === 'confirm' };
  }
  if (cmd === 'one' && parts.length <= 2 && (parts[1] === undefined || /^\d{1,18}$/.test(parts[1]))) return { cmd: 'one', id: parts[1] || null };
  if (cmd === 'retry' && parts.length === 2 && /^\d{1,18}$/.test(parts[1])) return { cmd: 'retry', id: parts[1] };
  return { cmd: 'usage' };
}

// ── الاستعلامات ───────────────────────────────────────────────────────────

const CLAIM_WHERE = `x.state = 'approved' AND x.approved_by IS NOT NULL
      AND ((x.save_state IN ('none','failed_retryable') AND (x.next_retry_at IS NULL OR x.next_retry_at <= NOW()))
        OR (x.save_state = 'pending' AND x.updated_at < NOW() - INTERVAL '10 minutes'))`;

async function claim(pg, token, itemId) {
  const byId = itemId ? ' AND x.id = $2' : '';
  const r = await pg.query(
    `UPDATE ingest_items i
        SET save_state = 'pending', attempts = i.attempts + 1, attempt_token = $1, updated_at = NOW()
      WHERE i.id = (SELECT x.id FROM ingest_items x WHERE ${CLAIM_WHERE}${byId} ORDER BY x.id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING i.id, i.source_id, i.source_message_id::text AS message_id, i.file_name, i.caption,
                i.size_bytes::text AS size, i.suggested_category_id AS category_id,
                i.approved_by::text AS approved_by, i.attempts`,
    itemId ? [token, itemId] : [token]);
  const row = r.rows[0];
  if (!row) return null;
  const s = await pg.query('SELECT chat_id::text AS chat_id FROM ingest_sources WHERE id = $1', [row.source_id]);
  return Object.assign({}, row, { token, chat_id: s.rows[0] ? s.rows[0].chat_id : null });
}

async function writeEvent(pg, actor, event, item, detail) {
  try {
    await pg.query(
      `INSERT INTO ingest_events(actor_kind, actor_id, event, source_id, item_id, detail) VALUES ($1, $2, $3, $4, $5, $6)`,
      [actor.kind, actor.id, event, item.source_id || null, item.id, JSON.stringify(detail)]);
  } catch (e) { log('error', '[ingest_save] event: ' + (e && e.message)); }
}

// ── المعالجة ──────────────────────────────────────────────────────────────

async function processItem(d, item, actor) {
  const pg = d.getPg();
  const title = titleFor(item);

  const fail = async (code, detail, opt = {}) => {
    const attempts = Number(item.attempts) || 1;
    let retrySec = null;
    if (opt.retry) {
      if (attempts >= MAX_ATTEMPTS) { code = 'max_attempts'; detail = detail || ''; }
      else retrySec = opt.retrySec || BACKOFF_SEC[Math.min(attempts - 1, BACKOFF_SEC.length - 1)];
    }
    const state = retrySec ? 'failed_retryable' : 'failed_permanent';
    const lastError = detail ? `${code}: ${clip(detail, 150)}` : code;
    await pg.query(
      `UPDATE ingest_items
          SET save_state = $2, last_error = $3, duplicate_of_file_id = COALESCE($4::int, duplicate_of_file_id),
              next_retry_at = CASE WHEN $5::int IS NULL THEN NULL ELSE NOW() + ($5::int * INTERVAL '1 second') END,
              attempt_token = NULL, updated_at = NOW()
        WHERE id = $1 AND attempt_token = $6`,
      [item.id, state, lastError, opt.dupOf || null, retrySec, item.token]);
    await writeEvent(pg, actor, 'item_save_failed', item, { code, state, attempts, detail: clip(detail, 150), title });
    log('warn', `[ingest_save] item ${item.id}: ${lastError}`);
    return { outcome: retrySec ? 'retry' : 'failed', code, detail: lastError, title };
  };

  try {
    const cat = item.category_id ? (await pg.query('SELECT id FROM categories WHERE id = $1 AND is_deleted = 0', [item.category_id])).rows[0] : null;
    if (!cat) return await fail('category_missing');
    if (!item.chat_id) return await fail('source_missing');

    const dup = (await pg.query('SELECT id FROM files WHERE category_id = $1 AND title = $2 AND is_deleted = 0 LIMIT 1', [item.category_id, title])).rows[0];
    if (dup) return await fail('duplicate_title', '', { dupOf: dup.id });

    let fwd;
    try {
      fwd = await d.telegram.forwardMessage(d.storageChatId, item.chat_id, Number(item.message_id));
    } catch (e) {
      const c = probe.classifyError(e);
      const msg = probe.errText(e);
      if (c.kind === 'rate') { const s = (Number(c.retry) || 30) + 2; d.pauseUntil = d.now() + s * 1000; return await fail('retry', msg, { retry: true, retrySec: s }); }
      if (c.kind === 'rights') { d.pauseUntil = d.now() + 600000; return await fail('retry', msg, { retry: true }); }
      if (c.kind === 'protected' || c.kind === 'gone' || c.kind === 'chat') return await fail(c.kind, msg);
      return await fail('retry', msg, { retry: true });
    }

    const f = probe.extractFile(fwd);
    if (!f) return await fail('no_file');
    if (!SUPPORTED[f.kind]) return await fail('unsupported_kind', f.kind);
    if (item.size && f.size != null && Number(item.size) !== f.size) return await fail('size_mismatch', `${item.size} != ${f.size}`);

    let added;
    try {
      added = await d.addFile(item.category_id, title, '', f.file_id, SUPPORTED[f.kind], item.approved_by);
    } catch (e) {
      if (e && e.message === 'exists') return await fail('duplicate_title');
      return await fail('retry', e && e.message, { retry: true });
    }

    // التحقق: نقرأ الصف من files (بالرقم، وإلا بالقسم+العنوان) ونطابق file_id الذي مرّرناه
    const chk = added && added.id
      ? (await pg.query('SELECT id, file_id, is_deleted FROM files WHERE id = $1', [added.id])).rows[0]
      : (await pg.query('SELECT id, file_id, is_deleted FROM files WHERE category_id = $1 AND title = $2 AND is_deleted = 0 ORDER BY id DESC LIMIT 1', [item.category_id, title])).rows[0];
    if (!chk || chk.file_id !== f.file_id || Number(chk.is_deleted) !== 0) return await fail('verify_failed', chk ? `file ${chk.id}` : 'no row');

    const ok = await pg.query(
      `UPDATE ingest_items
          SET state = 'completed', save_state = 'done', download_state = 'done', library_file_id = $2,
              file_unique_id = COALESCE(file_unique_id, $3), last_error = NULL, next_retry_at = NULL,
              attempt_token = NULL, updated_at = NOW()
        WHERE id = $1 AND attempt_token = $4`,
      [item.id, chk.id, f.file_unique_id || null, item.token]);
    if (!ok.rowCount) log('warn', `[ingest_save] item ${item.id}: attempt_token تغيّر أثناء الحفظ (file ${chk.id})`);
    await writeEvent(pg, actor, 'item_saved', item, { library_file_id: chk.id, category_id: item.category_id, title, file_type: SUPPORTED[f.kind], attempts: item.attempts });
    return { outcome: 'done', code: 'saved', libId: chk.id, title };
  } catch (e) {
    try { return await fail('retry', e && e.message, { retry: true }); } catch (e2) { log('error', '[ingest_save] ' + (e2 && e2.message)); return { outcome: 'error', code: 'exception', detail: e2 && e2.message, title }; }
  }
}

// ── العامل ────────────────────────────────────────────────────────────────

function createSaver(deps) {
  const d = Object.assign({
    now: Date.now,
    sleep: sleepReal,
    newToken: () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
    storageChatId: null,
    pauseUntil: 0,
  }, deps);
  let running = false;

  const getStage = async () => normStage(await d.getSetting(STAGE_KEY).catch(() => null));
  const storageOk = () => !!probe.validStorageId(d.storageChatId);

  async function runBatch({ limit, itemId, actor }) {
    const out = { done: 0, retry: 0, failed: 0, last: null };
    for (let n = 0; n < limit; n++) {
      if (d.pauseUntil > d.now()) break;
      const item = await claim(d.getPg(), d.newToken(), itemId);
      if (!item) break;
      const r = await processItem(d, item, actor);
      out.last = Object.assign({ id: item.id }, r);
      if (r.outcome === 'done') out.done++; else if (r.outcome === 'retry') out.retry++; else out.failed++;
      if (itemId) break;
      if (n < limit - 1) await d.sleep(GAP_MS);
    }
    return out;
  }

  async function tick() {
    if (running) return null;
    running = true;
    try {
      if ((await getStage()) !== 'production' || !storageOk() || !d.getPg()) return null;
      return await runBatch({ limit: TICK_BATCH, actor: { kind: 'system', id: null } });
    } catch (e) {
      log('error', '[ingest_save] tick: ' + (e && e.message));
      return null;
    } finally {
      running = false;
    }
  }

  async function one(itemId, ownerId) {
    if (running) return { busy: true };
    running = true;
    try {
      return await runBatch({ limit: 1, itemId, actor: { kind: 'owner', id: ownerId } });
    } finally {
      running = false;
    }
  }

  async function savedCount() {
    const r = await d.getPg().query(`SELECT COUNT(*)::int AS n FROM ingest_items WHERE state = 'completed' AND save_state = 'done'`);
    return r.rows[0] ? Number(r.rows[0].n) : 0;
  }

  async function status() {
    const pg = d.getPg();
    const stage = await getStage();
    const c = (await pg.query(
      `SELECT COUNT(*) FILTER (WHERE state = 'approved' AND save_state IN ('none','failed_retryable','pending'))::int AS waiting,
              COUNT(*) FILTER (WHERE state = 'approved' AND save_state = 'failed_retryable')::int AS retrying,
              COUNT(*) FILTER (WHERE state = 'approved' AND save_state = 'failed_permanent')::int AS failed,
              COUNT(*) FILTER (WHERE state = 'completed' AND save_state = 'done')::int AS saved
         FROM ingest_items`)).rows[0] || {};
    const next = (await pg.query(
      `SELECT i.id, i.file_name, COALESCE(s.name, '؟') AS subj, COALESCE(c.name, '؟') AS cat,
              EXISTS(SELECT 1 FROM files f WHERE f.category_id = i.suggested_category_id AND f.title = i.file_name AND f.is_deleted = 0) AS dup
         FROM ingest_items i
         LEFT JOIN categories c ON c.id = i.suggested_category_id
         LEFT JOIN subjects s ON s.id = c.subject_id
        WHERE i.state = 'approved' AND i.approved_by IS NOT NULL AND i.save_state IN ('none','failed_retryable')
        ORDER BY i.id LIMIT 3`)).rows;
    const bad = (await pg.query(
      `SELECT id, last_error FROM ingest_items WHERE state = 'approved' AND save_state = 'failed_permanent' ORDER BY updated_at DESC LIMIT 3`)).rows;

    const L = ['💾 حفظ الملفات في المكتبة', ''];
    L.push(`الوضع: ${stage}${stage === 'dry_run' ? ' (لا حفظ فعلي)' : stage === 'staging' ? ' (يدوي: /ingest_save one)' : ' (تلقائي)'}`);
    L.push(`قناة التخزين: ${storageOk() ? '✅ مضبوطة' : '⚠️ غير مضبوطة (INGEST_STORAGE_CHAT_ID)'}`);
    L.push('', `بانتظار الحفظ: ${c.waiting || 0}  (منها تنتظر إعادة محاولة: ${c.retrying || 0})`, `فشل نهائي: ${c.failed || 0}`, `محفوظ: ${c.saved || 0}`);
    if (next.length) {
      L.push('', 'التالي:');
      for (const n of next) L.push(`#${n.id} ${clip(n.file_name, 40) || '—'} ← ${clip(n.subj, 20)} › ${clip(n.cat, 20)}${n.dup ? '  ⚠️ مكرر' : ''}`);
    }
    if (bad.length) {
      L.push('', 'آخر الإخفاقات:');
      for (const b of bad) L.push(`#${b.id} ${arLabel(b.last_error)}`);
      L.push('بعد إصلاح السبب: /ingest_save retry <رقم>');
    }
    return L.join('\n');
  }

  async function retry(id) {
    const r = await d.getPg().query(
      `UPDATE ingest_items
          SET save_state = 'none', attempts = 0, next_retry_at = NULL, last_error = NULL, attempt_token = NULL, updated_at = NOW()
        WHERE id = $1 AND state = 'approved' AND save_state IN ('failed_permanent','failed_retryable')
        RETURNING id`, [id]);
    return r.rowCount > 0;
  }

  async function setStage(stage, confirm) {
    if (stage === 'production') {
      if (!confirm) return { ok: false, why: 'اكتب: /ingest_save stage production confirm' };
      if (!storageOk()) return { ok: false, why: 'قناة التخزين غير مضبوطة (INGEST_STORAGE_CHAT_ID).' };
      if ((await savedCount()) < 1) return { ok: false, why: 'لم يُحفظ أي ملف بعد. جرّب في staging أولاً: /ingest_save one' };
    }
    await d.setSetting(STAGE_KEY, stage);
    return { ok: true };
  }

  return { tick, one, status, retry, setStage, getStage, _d: d };
}

// ── الأمر ─────────────────────────────────────────────────────────────────

function register(bot, deps = {}) {
  const db = () => require('../database/db');
  const saver = createSaver(Object.assign({
    getPg: () => db().getPg(),
    getSetting: (k) => db().getSetting(k),
    setSetting: (k, v) => db().setSetting(k, v),
    addFile: (...a) => require('../database/files').addFile(...a),
    telegram: bot.telegram,
    storageChatId: process.env.INGEST_STORAGE_CHAT_ID,
  }, deps));

  if (process.env.INGEST_SAVER_DISABLED !== '1') {
    const t = setInterval(() => { saver.tick().catch(() => {}); }, TICK_MS);
    if (t.unref) t.unref();
  }

  bot.command('ingest_save', async (ctx) => {
    const ownerId = String(deps.ownerId ? deps.ownerId() : process.env.OWNER_ID || '');
    if (!ownerId || String(ctx.from && ctx.from.id) !== ownerId) return ctx.reply('🚫').catch(() => {});
    if (!ctx.chat || ctx.chat.type !== 'private') return ctx.reply('استعمل هذا الأمر في المحادثة الخاصة مع البوت.').catch(() => {});
    const reply = (t) => ctx.reply(t).catch(() => {});
    try {
      if (!saver._d.getPg()) return reply('قاعدة PostgreSQL غير متاحة.');
      const a = parseArgs(ctx.message && ctx.message.text);
      if (a.cmd === 'usage') return reply('الاستعمال:\n/ingest_save\n/ingest_save stage dry_run|staging|production [confirm]\n/ingest_save one [رقم]\n/ingest_save retry <رقم>');
      if (a.cmd === 'status') return reply(await saver.status());
      if (a.cmd === 'stage') {
        const r = await saver.setStage(a.stage, a.confirm);
        return reply(r.ok ? `✅ الوضع الآن: ${a.stage}` : `⚠️ لم يتغيّر الوضع. ${r.why}`);
      }
      if (a.cmd === 'retry') return reply((await saver.retry(a.id)) ? `✅ أُعيد العنصر #${a.id} إلى الطابور.` : `⚠️ العنصر #${a.id} ليس في حالة فشل.`);
      if (a.cmd === 'one') {
        if ((await saver.getStage()) === 'dry_run') return reply('الوضع dry_run: لا حفظ فعلي. غيّره أولاً: /ingest_save stage staging');
        if (!probe.validStorageId(saver._d.storageChatId)) return reply('⚠️ قناة التخزين غير مضبوطة (INGEST_STORAGE_CHAT_ID).');
        const r = await saver.one(a.id, ownerId);
        if (r.busy) return reply('⏳ عملية حفظ أخرى قيد التنفيذ.');
        if (!r.last) return reply(a.id ? '⚠️ العنصر غير موجود أو ليس جاهزاً للحفظ.' : 'لا عناصر جاهزة للحفظ الآن.');
        const x = r.last;
        if (x.outcome === 'done') return reply(`✅ حُفظ #${x.id} «${clip(x.title, 50)}» في المكتبة (ملف رقم ${x.libId}). افتح القسم وتأكد.`);
        return reply(`${x.outcome === 'retry' ? '🔁' : '❌'} #${x.id}: ${arLabel(x.detail)}`);
      }
    } catch (e) {
      log('error', '[ingest_save] ' + (e && e.message));
      reply('⚠️ تعذّر تنفيذ الأمر.');
    }
  });
  return saver;
}

module.exports = { register, createSaver, parseArgs, titleFor, normStage, STAGES, MAX_ATTEMPTS };
