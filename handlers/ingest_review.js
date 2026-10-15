'use strict';
/**
 * ════════════════════════════════════════════════════════════
 *  📋 handlers/ingest_review.js — مركز مراجعة الملفات المكتشفة (المالك فقط)
 * ════════════════════════════════════════════════════════════
 *  الشاشات: قائمة الدفعات (قروب + موضوع) ← شاشة الدفعة ← شاشة الملف، ومنتقي مسار المكتبة.
 *  الأمر: /ingest_review   ·   الأزرار: البادئة inr_
 *
 *  هذه الخطوة تسجّل القرارات فقط (موافقة / رفض / مسار). لا حفظ في المكتبة ولا نشر هنا:
 *  لا يُلمس جدول files ولا يُرسل شيء إلى أي قروب. الحفظ خطوة لاحقة منفصلة.
 *
 *  - المالك فقط (OWNER_ID) في كل ضغطة.
 *  - الكتابة في ingest_items / ingest_rules / ingest_events فقط، ولا DELETE.
 *  - المسار الفعّال للملف = مساره الخاص إن حُدّد، وإلا مسار قاعدة موضوعه (ingest_rules.category_id).
 *    عند الموافقة يُثبَّت المسار في suggested_category_id كي لا يتغيّر لاحقاً بتغيّر القاعدة.
 *  - الموافقة والرفض ذريّان ومشروطان بأن يكون الملف ما زال "بانتظار المراجعة" (لا أثر للضغط المزدوج).
 *  - لا موافقة بلا مسار صالح (قسم موجود وغير محذوف).
 *
 *  callback_data (≤ 64 بايت):
 *    inr_q · inr_b_<sid>_<tp>[_<page>] · inr_i_<id> · inr_ia_<id> · inr_ir_<id> · inr_ba_<sid>_<tp>
 *    inr_pk_<T>_<lvl>_<parent> · inr_pc_<T>_<cat>       (T = b<sid>.<tp> | i<id> ؛ tp 0 = القروب نفسه)
 * ════════════════════════════════════════════════════════════
 */
const logger = require('../utils/logger');
const { btn: kbBtn, build: kbBuild } = require('../utils/keyboard');

// يحرّك عامل الحفظ فور الموافقة (بلا انتظار دورته الدورية). فشل التحريك لا يؤثر على الموافقة.
function kickSaver() { try { require('./ingest_save').kick(); } catch (_) { /* لا شيء */ } }

const PENDING = ['discovered', 'classified', 'needs_path', 'needs_review', 'in_batch', 'pending_approval'];
const P = PENDING.map((s) => `'${s}'`).join(',');
const PAGE = 8;
const PICK_MAX = 30;

const RX = {
  queue: /^inr_q$/,
  batch: /^inr_b_(\d{1,9})_(\d{1,12})(?:_(\d{1,3}))?$/,
  item: /^inr_i_(\d{1,19})$/,
  itemApprove: /^inr_ia_(\d{1,19})$/,
  itemReject: /^inr_ir_(\d{1,19})$/,
  batchApprove: /^inr_ba_(\d{1,9})_(\d{1,12})$/,
  pick: /^inr_pk_([bi][\d.]{1,35})_([symuc])_(\d{1,9})$/,
  pickDone: /^inr_pc_([bi][\d.]{1,35})_(\d{1,9})$/,
};

function parseTarget(t) {
  let m;
  if ((m = /^b(\d{1,9})\.(\d{1,12})$/.exec(t))) return { kind: 'batch', sid: m[1], tp: m[2] };
  if ((m = /^i(\d{1,19})$/.exec(t))) return { kind: 'item', id: m[1] };
  return null;
}

function parseCb(data) {
  if (typeof data !== 'string' || data.length > 64) return null;
  let m;
  if (RX.queue.test(data)) return { a: 'queue' };
  if ((m = RX.batch.exec(data))) return { a: 'batch', sid: m[1], tp: m[2], page: m[3] ? Number(m[3]) : 0 };
  if ((m = RX.item.exec(data))) return { a: 'item', id: m[1] };
  if ((m = RX.itemApprove.exec(data))) return { a: 'itemApprove', id: m[1] };
  if ((m = RX.itemReject.exec(data))) return { a: 'itemReject', id: m[1] };
  if ((m = RX.batchApprove.exec(data))) return { a: 'batchApprove', sid: m[1], tp: m[2] };
  if ((m = RX.pick.exec(data))) { const t = parseTarget(m[1]); return t ? { a: 'pick', t, T: m[1], lvl: m[2], parent: m[3] } : null; }
  if ((m = RX.pickDone.exec(data))) { const t = parseTarget(m[1]); return t ? { a: 'pickDone', t, T: m[1], cat: m[2] } : null; }
  return null;
}

// ── تنسيق ────────────────────────────────────────────────────────────────

const short = (s, n) => Array.from(String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, n).join('');
const topicLabel = (tp, name) => (String(tp) === '0' ? 'القروب نفسه/General' : (short(name, 20) || '#' + tp));
function fmtSize(b) {
  const n = Number(b);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
const itemLabel = (it) => short(it.file_name, 40) || short(it.caption, 30) || 'ملف #' + (it.source_message_id || it.id);

// ── العروض (دوال نقية) ───────────────────────────────────────────────────

function buildQueueView({ counts, batches }) {
  const lines = [
    '📋 مراجعة الملفات',
    '',
    `بانتظار المراجعة: ${counts.pending} · موافَق عليها: ${counts.approved} · مرفوضة: ${counts.rejected}`,
    'الموافقة تحفظ الملف في المكتبة تلقائياً خلال ثوانٍ.',
  ];
  const rows = batches.map((b) => [kbBtn(
    `${b.no_path > 0 ? '⚠️' : '📂'} ${short(b.title, 18) || 'قروب'} · ${topicLabel(b.tp, b.topic_name)} · ${b.n}`,
    `inr_b_${b.source_id}_${b.tp}`)]);
  if (!batches.length) lines.push('', 'لا توجد ملفات بانتظار المراجعة.', 'تأكد أن المراقبة مفعّلة للقروب وأن الملفات مرسلة من حسابك.');
  else lines.push('', '⚠️ = دفعة فيها ملفات بلا مسار.', 'اختر دفعة:');
  rows.push([kbBtn('◀️ رجوع', 'gp_panel')]);
  return { text: lines.join('\n'), rows };
}

function buildBatchView({ sid, tp, title, topicName, pathText, items, page, total, noPath }) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const lines = [
    `📂 «${short(title, 30) || 'قروب'}» · ${topicLabel(tp, topicName)}`,
    '',
    `المسار: ${pathText || '⚠️ غير محدد'}`,
    `الملفات: ${total}${noPath > 0 ? ` (منها ${noPath} بلا مسار)` : ''}${pages > 1 ? ` · صفحة ${page + 1}/${pages}` : ''}`,
  ];
  const rows = items.map((it) => [kbBtn(
    `${(it.own_cat || it.rule_cat) ? '📄' : '⚠️'} ${itemLabel(it)}${fmtSize(it.size) ? ' · ' + fmtSize(it.size) : ''}`.slice(0, 60),
    `inr_i_${it.id}`)]);
  const nav = [];
  if (page > 0) nav.push(kbBtn('⬅️', `inr_b_${sid}_${tp}_${page - 1}`));
  if (page + 1 < pages) nav.push(kbBtn('➡️', `inr_b_${sid}_${tp}_${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([kbBtn('📂 تحديد مسار الموضوع', `inr_pk_b${sid}.${tp}_s_0`)]);
  rows.push([kbBtn(`✅ موافقة على الكل (${total - noPath})`, `inr_ba_${sid}_${tp}`)]);
  rows.push([kbBtn('◀️ رجوع', 'inr_q')]);
  return { text: lines.join('\n'), rows };
}

function buildItemView({ item, srcTitle, topicName, pathText, ownPath, dupCount }) {
  const lines = [
    `📄 ${itemLabel(item)}`,
    '',
    `القروب: ${short(srcTitle, 30) || '—'} · ${topicLabel(item.tp, topicName)}`,
  ];
  if (fmtSize(item.size)) lines.push(`الحجم: ${fmtSize(item.size)}${item.mime_type ? ' · ' + short(item.mime_type, 30) : ''}`);
  if (item.message_date) lines.push(`التاريخ: ${new Date(item.message_date).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  if (item.caption) lines.push(`التعليق: ${short(item.caption, 120)}`);
  lines.push(`المسار: ${pathText || '⚠️ غير محدد'}${pathText && ownPath ? ' (خاص بهذا الملف)' : ''}`);
  if (dupCount > 0) lines.push(`⚠️ ملف مشابه (نفس الاسم والحجم) مسجَّل ${dupCount} مرة سابقاً.`);
  lines.push(`الحالة: ${PENDING.includes(item.state) ? 'بانتظار المراجعة' : item.state}`);
  const rows = [];
  if (PENDING.includes(item.state)) {
    rows.push([kbBtn('✅ موافقة', `inr_ia_${item.id}`), kbBtn('❌ رفض', `inr_ir_${item.id}`)]);
    rows.push([kbBtn('📂 مسار هذا الملف فقط', `inr_pk_i${item.id}_s_0`)]);
  }
  rows.push([kbBtn('◀️ رجوع', `inr_b_${item.source_id}_${item.tp}`)]);
  return { text: lines.join('\n'), rows };
}

function buildPickView({ T, lvl, parent, crumb, children, backCb, cancelCb }) {
  const names = { s: 'التخصص', y: 'السنة', m: 'الفصل', u: 'المادة', c: 'القسم' };
  const next = { s: 'y', y: 'm', m: 'u', u: 'c' };
  const lines = ['📂 تحديد المسار', '', crumb ? `الحالي: ${crumb}` : 'ابدأ من التخصص.', `اختر ${names[lvl]}:`];
  const btns = children.slice(0, PICK_MAX).map((c) => kbBtn(
    short(c.name, 24) || '#' + c.id,
    lvl === 'c' ? `inr_pc_${T}_${c.id}` : `inr_pk_${T}_${next[lvl]}_${c.id}`));
  if (!children.length) lines.push('', '(لا عناصر هنا)');
  if (children.length > PICK_MAX) lines.push('', `يظهر أول ${PICK_MAX} فقط.`);
  const rows = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  if (backCb) rows.push([kbBtn('⬆️ المستوى السابق', backCb)]);
  rows.push([kbBtn('✖️ إلغاء', cancelCb)]);
  return { text: lines.join('\n'), rows };
}

// ── الوصول إلى قاعدة البيانات ───────────────────────────────────────────

const RULE_JOIN = `LEFT JOIN ingest_rules r ON r.source_id = i.source_id AND COALESCE(r.topic_id, 0) = COALESCE(i.topic_id, 0)`;

async function loadCounts(pg) {
  const rows = (await pg.query(`SELECT state, count(*)::int AS n FROM ingest_items GROUP BY state`)).rows;
  const c = { pending: 0, approved: 0, rejected: 0 };
  for (const r of rows) {
    if (PENDING.includes(r.state)) c.pending += r.n;
    else if (r.state === 'approved' || r.state === 'completed') c.approved += r.n;
    else if (r.state === 'rejected') c.rejected += r.n;
  }
  return c;
}

async function loadBatches(pg) {
  const r = await pg.query(
    `SELECT i.source_id, COALESCE(i.topic_id, 0)::text AS tp, s.title, t.name AS topic_name,
            count(*)::int AS n,
            count(*) FILTER (WHERE COALESCE(i.suggested_category_id, r.category_id) IS NULL)::int AS no_path
       FROM ingest_items i
       JOIN ingest_sources s ON s.id = i.source_id
       ${RULE_JOIN}
       LEFT JOIN group_known_topics t ON t.chat_id = s.chat_id AND t.thread_id = i.topic_id
      WHERE i.state IN (${P})
      GROUP BY i.source_id, COALESCE(i.topic_id, 0), s.title, t.name
      ORDER BY s.title, COALESCE(i.topic_id, 0)
      LIMIT 40`);
  return r.rows;
}

async function pathText(pg, catId) {
  if (!catId) return null;
  const r = await pg.query(
    `SELECT sp.name AS a, y.name AS b, se.name AS c, su.name AS d, c.name AS e
       FROM categories c
       JOIN subjects su ON su.id = c.subject_id
       JOIN semesters se ON se.id = su.semester_id
       JOIN years y ON y.id = se.year_id
       JOIN specialties sp ON sp.id = y.specialty_id
      WHERE c.id = $1 AND c.is_deleted = 0`, [catId]);
  const x = r.rows[0];
  return x ? [x.a, x.b, x.c, x.d, x.e].map((s) => short(s, 18)).join(' › ') : null;
}

async function loadBatch(pg, sid, tp, page) {
  const src = (await pg.query(`SELECT s.id, s.title, s.chat_id FROM ingest_sources s WHERE s.id = $1`, [sid])).rows[0];
  if (!src) return null;
  const topicName = tp === '0' ? null : ((await pg.query(
    `SELECT name FROM group_known_topics WHERE chat_id = $1 AND thread_id = $2::bigint`, [src.chat_id, tp])).rows[0] || {}).name || null;
  const rule = (await pg.query(
    `SELECT category_id FROM ingest_rules WHERE source_id = $1 AND COALESCE(topic_id, 0) = $2::bigint`, [sid, tp])).rows[0];
  const cond = `i.source_id = $1 AND COALESCE(i.topic_id, 0) = $2::bigint AND i.state IN (${P})`;
  const stats = (await pg.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE COALESCE(i.suggested_category_id, r.category_id) IS NULL)::int AS no_path
       FROM ingest_items i ${RULE_JOIN} WHERE ${cond}`, [sid, tp])).rows[0];
  const items = (await pg.query(
    `SELECT i.id, i.source_message_id::text AS source_message_id, i.file_name, i.caption, i.size_bytes::text AS size,
            i.suggested_category_id AS own_cat, r.category_id AS rule_cat
       FROM ingest_items i ${RULE_JOIN} WHERE ${cond}
      ORDER BY i.message_date NULLS LAST, i.id LIMIT ${PAGE} OFFSET $3`, [sid, tp, page * PAGE])).rows;
  return { src, topicName, rulePath: await pathText(pg, rule && rule.category_id), items, total: stats.total, noPath: stats.no_path };
}

async function loadItem(pg, id) {
  const r = await pg.query(
    `SELECT i.id, i.source_id, COALESCE(i.topic_id, 0)::text AS tp, i.source_message_id::text AS source_message_id,
            i.file_name, i.caption, i.size_bytes::text AS size, i.mime_type, i.message_date, i.state,
            i.suggested_category_id AS own_cat, r.category_id AS rule_cat, s.title AS src_title, s.chat_id
       FROM ingest_items i ${RULE_JOIN} JOIN ingest_sources s ON s.id = i.source_id WHERE i.id = $1`, [id]);
  const it = r.rows[0];
  if (!it) return null;
  const topicName = it.tp === '0' ? null : ((await pg.query(
    `SELECT name FROM group_known_topics WHERE chat_id = $1 AND thread_id = $2::bigint`, [it.chat_id, it.tp])).rows[0] || {}).name || null;
  const dup = (await pg.query(
    `SELECT count(*)::int AS n FROM ingest_items WHERE id <> $1 AND file_name = $2 AND size_bytes IS NOT DISTINCT FROM $3::bigint AND $2 <> ''`,
    [it.id, it.file_name, it.size])).rows[0].n;
  const eff = it.own_cat || it.rule_cat;
  return { item: it, srcTitle: it.src_title, topicName, pathText: await pathText(pg, eff), ownPath: !!it.own_cat, dupCount: dup };
}

// مستويات المنتقي: [جدول الأبناء، عمود الأب، جدول الأب لحساب "المستوى السابق"]
const LEVELS = {
  s: { table: 'specialties', parentCol: null },
  y: { table: 'years', parentCol: 'specialty_id' },
  m: { table: 'semesters', parentCol: 'year_id' },
  u: { table: 'subjects', parentCol: 'semester_id' },
  c: { table: 'categories', parentCol: 'subject_id' },
};

async function pickView(pg, T, lvl, parent) {
  const L = LEVELS[lvl];
  const children = L.parentCol
    ? (await pg.query(`SELECT id, name FROM ${L.table} WHERE ${L.parentCol} = $1 AND is_deleted = 0 ORDER BY id LIMIT ${PICK_MAX + 1}`, [parent])).rows
    : (await pg.query(`SELECT id, name FROM ${L.table} WHERE is_deleted = 0 ORDER BY id LIMIT ${PICK_MAX + 1}`)).rows;
  let crumb = '';
  let backCb = null;
  if (lvl === 'y') {
    const r = (await pg.query(`SELECT name FROM specialties WHERE id = $1`, [parent])).rows[0];
    crumb = r ? short(r.name, 18) : '';
    backCb = `inr_pk_${T}_s_0`;
  } else if (lvl === 'm') {
    const r = (await pg.query(`SELECT sp.name AS a, y.name AS b, y.specialty_id AS up FROM years y JOIN specialties sp ON sp.id = y.specialty_id WHERE y.id = $1`, [parent])).rows[0];
    if (r) { crumb = [r.a, r.b].map((s) => short(s, 18)).join(' › '); backCb = `inr_pk_${T}_y_${r.up}`; }
  } else if (lvl === 'u') {
    const r = (await pg.query(`SELECT sp.name AS a, y.name AS b, se.name AS c, se.year_id AS up FROM semesters se JOIN years y ON y.id = se.year_id JOIN specialties sp ON sp.id = y.specialty_id WHERE se.id = $1`, [parent])).rows[0];
    if (r) { crumb = [r.a, r.b, r.c].map((s) => short(s, 18)).join(' › '); backCb = `inr_pk_${T}_m_${r.up}`; }
  } else if (lvl === 'c') {
    const r = (await pg.query(`SELECT sp.name AS a, y.name AS b, se.name AS c, su.name AS d, su.semester_id AS up FROM subjects su JOIN semesters se ON se.id = su.semester_id JOIN years y ON y.id = se.year_id JOIN specialties sp ON sp.id = y.specialty_id WHERE su.id = $1`, [parent])).rows[0];
    if (r) { crumb = [r.a, r.b, r.c, r.d].map((s) => short(s, 18)).join(' › '); backCb = `inr_pk_${T}_u_${r.up}`; }
  }
  const t = parseTarget(T);
  const cancelCb = t.kind === 'batch' ? `inr_b_${t.sid}_${t.tp}` : `inr_i_${t.id}`;
  return buildPickView({ T, lvl, parent, crumb, children: children.slice(0, PICK_MAX + 1), backCb, cancelCb });
}

// ── القرارات (كتابة في ingest_* فقط) ─────────────────────────────────────

const EFF_CAT_OK = `x.cat IS NOT NULL AND EXISTS (SELECT 1 FROM categories c WHERE c.id = x.cat AND c.is_deleted = 0)`;

async function approveItem(pg, id, ownerId) {
  const r = await pg.query(
    `UPDATE ingest_items i
        SET state = 'approved', suggested_category_id = x.cat, approved_by = $2, approved_at = NOW(), updated_at = NOW()
       FROM (SELECT i2.id, COALESCE(i2.suggested_category_id, r.category_id) AS cat
               FROM ingest_items i2
               LEFT JOIN ingest_rules r ON r.source_id = i2.source_id AND COALESCE(r.topic_id, 0) = COALESCE(i2.topic_id, 0)
              WHERE i2.id = $1 AND i2.state IN (${P})) x
      WHERE i.id = x.id AND ${EFF_CAT_OK}
      RETURNING i.id, i.source_id`, [id, ownerId]);
  if (r.rowCount) {
    await pg.query(
      `INSERT INTO ingest_events (actor_kind, actor_id, event, source_id, item_id, detail) VALUES ('owner', $1, 'item_approved', $2, $3, '{}')`,
      [ownerId, r.rows[0].source_id, id]);
  }
  return r.rowCount;
}

async function approveBatch(pg, sid, tp, ownerId) {
  const r = await pg.query(
    `UPDATE ingest_items i
        SET state = 'approved', suggested_category_id = x.cat, approved_by = $3, approved_at = NOW(), updated_at = NOW()
       FROM (SELECT i2.id, COALESCE(i2.suggested_category_id, r.category_id) AS cat
               FROM ingest_items i2
               LEFT JOIN ingest_rules r ON r.source_id = i2.source_id AND COALESCE(r.topic_id, 0) = COALESCE(i2.topic_id, 0)
              WHERE i2.source_id = $1 AND COALESCE(i2.topic_id, 0) = $2::bigint AND i2.state IN (${P})) x
      WHERE i.id = x.id AND ${EFF_CAT_OK}
      RETURNING i.id`, [sid, tp, ownerId]);
  if (r.rowCount) {
    await pg.query(
      `INSERT INTO ingest_events (actor_kind, actor_id, event, source_id, detail) VALUES ('owner', $1, 'batch_approved', $2, $3)`,
      [ownerId, sid, JSON.stringify({ topic: tp, count: r.rowCount })]);
  }
  return r.rowCount;
}

async function rejectItem(pg, id, ownerId) {
  const r = await pg.query(
    `UPDATE ingest_items SET state = 'rejected', updated_at = NOW() WHERE id = $1 AND state IN (${P}) RETURNING id, source_id`, [id]);
  if (r.rowCount) {
    await pg.query(
      `INSERT INTO ingest_events (actor_kind, actor_id, event, source_id, item_id, detail) VALUES ('owner', $1, 'item_rejected', $2, $3, '{}')`,
      [ownerId, r.rows[0].source_id, id]);
  }
  return r.rowCount;
}

async function setPath(pg, t, catId, ownerId) {
  const ok = await pg.query(`SELECT 1 FROM categories WHERE id = $1 AND is_deleted = 0`, [catId]);
  if (!ok.rowCount) return false;
  if (t.kind === 'batch') {
    await pg.query(
      `INSERT INTO ingest_rules (source_id, topic_id, category_id) VALUES ($1, NULLIF($2::bigint, 0), $3)
       ON CONFLICT (source_id, (COALESCE(topic_id, 0))) DO UPDATE SET category_id = EXCLUDED.category_id, updated_at = NOW()`,
      [t.sid, t.tp, catId]);
    await pg.query(
      `INSERT INTO ingest_events (actor_kind, actor_id, event, source_id, detail) VALUES ('owner', $1, 'rule_path_set', $2, $3)`,
      [ownerId, t.sid, JSON.stringify({ topic: t.tp, category_id: Number(catId) })]);
    return true;
  }
  const r = await pg.query(
    `UPDATE ingest_items SET suggested_category_id = $2, updated_at = NOW() WHERE id = $1 AND state IN (${P}) RETURNING id, source_id`, [t.id, catId]);
  if (r.rowCount) {
    await pg.query(
      `INSERT INTO ingest_events (actor_kind, actor_id, event, source_id, item_id, detail) VALUES ('owner', $1, 'item_path_set', $2, $3, $4)`,
      [ownerId, r.rows[0].source_id, t.id, JSON.stringify({ category_id: Number(catId) })]);
  }
  return r.rowCount > 0;
}

// ── المعالج ──────────────────────────────────────────────────────────────

async function render(ctx, view) {
  const extra = kbBuild(view.rows);
  if (!ctx.callbackQuery) return ctx.reply(view.text, extra).catch(() => {});
  try {
    await ctx.editMessageText(view.text, extra);
  } catch (e) {
    const d = (e && (e.description || e.message)) || '';
    if (d.indexOf('not modified') !== -1) return;
    await ctx.reply(view.text, extra).catch(() => {});
  }
}

async function queueView(pg) {
  return buildQueueView({ counts: await loadCounts(pg), batches: await loadBatches(pg) });
}

async function batchScreen(pg, sid, tp, page) {
  const b = await loadBatch(pg, sid, tp, page);
  if (!b) return null;
  if (b.total === 0) return queueView(pg); // الدفعة فرغت: ارجع للقائمة
  const maxPage = Math.max(0, Math.ceil(b.total / PAGE) - 1);
  if (page > maxPage) return batchScreen(pg, sid, tp, maxPage);
  return buildBatchView({ sid, tp, title: b.src.title, topicName: b.topicName, pathText: b.rulePath, items: b.items, page, total: b.total, noPath: b.noPath });
}

async function handle(ctx, data, deps = {}) {
  const ownerId = String(deps.ownerId ? deps.ownerId() : process.env.OWNER_ID || '');
  if (!ownerId || String(ctx.from && ctx.from.id) !== ownerId) return ctx.answerCbQuery('🚫').catch(() => {});
  const cb = parseCb(data);
  if (!cb) return ctx.answerCbQuery('❌ بيانات غير صالحة.').catch(() => {});
  const pg = deps.getPg ? deps.getPg() : require('../database/db').getPg();
  if (!pg) return ctx.answerCbQuery('قاعدة PostgreSQL غير متاحة.', { show_alert: true }).catch(() => {});
  const ack = (t, alert) => ctx.answerCbQuery(t, alert ? { show_alert: true } : undefined).catch(() => {});

  if (cb.a === 'queue') { await ack(); return render(ctx, await queueView(pg)); }

  if (cb.a === 'batch') {
    await ack();
    const v = await batchScreen(pg, cb.sid, cb.tp, cb.page);
    return v ? render(ctx, v) : ack('⚠️ المصدر غير موجود.', true);
  }

  if (cb.a === 'item') {
    const v = await loadItem(pg, cb.id);
    if (!v) return ack('⚠️ الملف غير موجود.', true);
    await ack();
    return render(ctx, buildItemView(v));
  }

  if (cb.a === 'itemApprove' || cb.a === 'itemReject') {
    const v = await loadItem(pg, cb.id);
    if (!v) return ack('⚠️ الملف غير موجود.', true);
    const n = cb.a === 'itemApprove' ? await approveItem(pg, cb.id, ownerId) : await rejectItem(pg, cb.id, ownerId);
    if (!n) {
      const pending = PENDING.includes(v.item.state);
      await ack(pending ? '⚠️ حدّد مساراً صالحاً أولاً.' : 'تمت معالجته مسبقاً.', true);
    } else {
      await ack(cb.a === 'itemApprove' ? '✅ تمت الموافقة' : '❌ تم الرفض');
      if (cb.a === 'itemApprove') kickSaver();
    }
    const back = await batchScreen(pg, String(v.item.source_id), v.item.tp, 0);
    return render(ctx, back || await queueView(pg));
  }

  if (cb.a === 'batchApprove') {
    const n = await approveBatch(pg, cb.sid, cb.tp, ownerId);
    if (n) kickSaver();
    const b = await loadBatch(pg, cb.sid, cb.tp, 0);
    const left = b ? b.total : 0;
    await ack(n ? `✅ وُوفق على ${n} ملف${left ? ` · بقي ${left} بلا مسار` : ''}` : '⚠️ لا ملفات لها مسار صالح. حدّد المسار أولاً.', !n);
    const v = await batchScreen(pg, cb.sid, cb.tp, 0);
    return render(ctx, v || await queueView(pg));
  }

  if (cb.a === 'pick') {
    await ack();
    return render(ctx, await pickView(pg, cb.T, cb.lvl, cb.parent));
  }

  if (cb.a === 'pickDone') {
    const ok = await setPath(pg, cb.t, cb.cat, ownerId);
    if (!ok) return ack('⚠️ القسم غير موجود أو الملف لم يعد بانتظار المراجعة.', true);
    await ack('📂 حُفظ المسار');
    if (cb.t.kind === 'batch') {
      const v = await batchScreen(pg, cb.t.sid, cb.t.tp, 0);
      return render(ctx, v || await queueView(pg));
    }
    const iv = await loadItem(pg, cb.t.id);
    return render(ctx, iv ? buildItemView(iv) : await queueView(pg));
  }
  return ack();
}

function register(bot, deps = {}) {
  bot.command('ingest_review', async (ctx) => {
    const ownerId = String(deps.ownerId ? deps.ownerId() : process.env.OWNER_ID || '');
    if (!ownerId || String(ctx.from && ctx.from.id) !== ownerId) return ctx.reply('🚫').catch(() => {});
    try {
      const pg = deps.getPg ? deps.getPg() : require('../database/db').getPg();
      if (!pg) return ctx.reply('قاعدة PostgreSQL غير متاحة.').catch(() => {});
      await render(ctx, await queueView(pg));
    } catch (e) {
      logger.error('[ingest_review] ' + e.message);
      ctx.reply('⚠️ تعذّر فتح مركز المراجعة.').catch(() => {});
    }
  });
  bot.on('callback_query', async (ctx, next) => {
    const data = (ctx.callbackQuery && ctx.callbackQuery.data) || '';
    if (!data.startsWith('inr_')) return next();
    try {
      await handle(ctx, data, deps);
    } catch (e) {
      logger.error('[ingest_review] ' + e.message);
      ctx.answerCbQuery('⚠️ حدث خطأ').catch(() => {});
    }
  });
}

module.exports = {
  register, handle, parseCb, parseTarget,
  buildQueueView, buildBatchView, buildItemView, buildPickView,
  approveItem, approveBatch, rejectItem, setPath, PENDING,
};
