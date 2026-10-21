'use strict';
/**
 * 🧠⚡ التصنيف الذكي + الحفظ التلقائي لملفات UserBot (اختياري لكل موضوع).
 *
 *  لا يعمل إلا على مواضيع فعّلتَ لها مفتاح "ذكي" (ingest_rules.smart = 1)، ولها مسار محدد (المادة تُؤخذ منه).
 *  كل 30 ثانية يفحص العناصر الجديدة (state = discovered) في تلك المواضيع:
 *    - يقرأ نوع الملف من اسمه (أو تعليقه) ويطابقه مع أقسام المادة. لا مطابقة واضحة → needs_review (مراجعة يدوية).
 *    - مطابقة واضحة → يثبّت القسم في suggested_category_id (state = classified).
 *    - وإن كان مفتاح "تلقائي" مفعّلاً (auto_save = 1) وتحققت كل الشروط → يوافق باسم المالك فيحفظه saver.
 *  شروط الموافقة التلقائية (كلها لازمة): مرحلة الحفظ production، OWNER_ID صالح، الملف وصل خلال
 *  INGEST_AUTO_MAX_AGE_H ساعة (افتراضي 24) فلا تُحفظ الأرشيفات القديمة تلقائياً، لا عنوان مكرر في القسم،
 *  ولا ملف مطابق (tg_doc_id) محفوظ سابقاً.
 *  كل قرار يُسجَّل في ingest_events (item_auto_approved / item_auto_classified / item_auto_skipped).
 *  INGEST_AUTO_DISABLED=1 يوقف العامل كلياً.
 */

const classify = require('../utils/ingest_classify');

const TICK_MS = 30 * 1000;
const GRACE_SEC = 20;
const BATCH_LIMIT = 50;
const MAX_AGE_H = (() => {
  const n = parseInt(process.env.INGEST_AUTO_MAX_AGE_H, 10);
  return n >= 1 && n <= 720 ? n : 24;
})();

const CANDIDATES_SQL =
  "SELECT i.id, i.source_id, i.file_name, i.caption, i.tg_doc_id::text AS tg_doc_id, " +
  "       (i.message_date IS NOT NULL AND i.message_date >= NOW() - ($1::int * INTERVAL '1 hour')) AS fresh, " +
  "       r.auto_save, c.subject_id " +
  "  FROM ingest_items i " +
  "  JOIN ingest_rules r ON r.source_id = i.source_id AND COALESCE(r.topic_id, 0) = COALESCE(i.topic_id, 0) " +
  "  JOIN categories c ON c.id = r.category_id AND c.is_deleted = 0 " +
  " WHERE i.state = 'discovered' AND i.suggested_category_id IS NULL " +
  "   AND r.enabled = 1 AND r.smart = 1 " +
  "   AND i.discovered_at < NOW() - ($2::int * INTERVAL '1 second') " +
  " ORDER BY i.id LIMIT " + BATCH_LIMIT;

function log(level, msg) { try { require('../utils/logger')[level](msg); } catch (_) { /* لا شيء */ } }

async function writeEvent(pg, name, item, detail) {
  try {
    await pg.query(
      "INSERT INTO ingest_events (actor_kind, event, source_id, item_id, detail) VALUES ('system', $1, $2, $3, $4)",
      [name, item.source_id, item.id, JSON.stringify(detail)]);
  } catch (e) { log('error', '[ingest_auto] event: ' + (e && e.message)); }
}

async function duplicateReason(pg, item, catId, title) {
  const a = await pg.query('SELECT 1 FROM files WHERE category_id = $1 AND title = $2 AND is_deleted = 0 LIMIT 1', [catId, title]);
  if (a.rowCount) return 'duplicate_title';
  if (item.tg_doc_id) {
    const b = await pg.query("SELECT 1 FROM ingest_items WHERE tg_doc_id = $1::bigint AND id <> $2 AND save_state = 'done' LIMIT 1", [item.tg_doc_id, item.id]);
    if (b.rowCount) return 'duplicate_file';
  }
  return null;
}

function createAuto(d) {
  let running = false;

  async function tick() {
    if (running) return { skipped: true };
    running = true;
    try {
      const pg = d.getPg();
      if (!pg) return { processed: 0 };
      const owner = String(d.ownerId() || '');
      const ownerOk = /^\d{1,18}$/.test(owner);
      const production = (await d.stage()) === 'production';
      const rows = (await pg.query(CANDIDATES_SQL, [MAX_AGE_H, GRACE_SEC])).rows;
      const stats = { processed: rows.length, approved: 0, classified: 0, review: 0 };
      const kids = new Map();

      for (const it of rows) {
        let ch = kids.get(it.subject_id);
        if (!ch) {
          ch = (await pg.query('SELECT id, name FROM categories WHERE subject_id = $1 AND is_deleted = 0 ORDER BY id', [it.subject_id])).rows;
          kids.set(it.subject_id, ch);
        }
        const pick = classify.chooseCategory(it.file_name, it.caption, ch);

        if (!pick.ok) {
          const u = await pg.query(
            "UPDATE ingest_items SET state = 'needs_review', updated_at = NOW() WHERE id = $1 AND state = 'discovered' AND suggested_category_id IS NULL", [it.id]);
          if (u.rowCount) { stats.review++; await writeEvent(pg, 'item_auto_skipped', it, { reason: pick.reason, kind: pick.kind, sections: ch.map((c) => String(c.name).slice(0, 30)) }); }
          continue;
        }

        let why;
        if (Number(it.auto_save) !== 1) why = 'auto_off';
        else if (!ownerOk) why = 'owner_missing';
        else if (!production) why = 'stage_not_production';
        else if (!it.fresh) why = 'too_old';
        else why = await duplicateReason(pg, it, pick.categoryId, d.titleFor(it));

        if (!why) {
          const u = await pg.query(
            "UPDATE ingest_items SET state = 'approved', suggested_category_id = $2, approved_by = $3::bigint, approved_at = NOW(), updated_at = NOW() " +
            "WHERE id = $1 AND state = 'discovered' AND suggested_category_id IS NULL", [it.id, pick.categoryId, owner]);
          if (u.rowCount) { stats.approved++; await writeEvent(pg, 'item_auto_approved', it, { kind: pick.kind, category_id: pick.categoryId, via: pick.via }); }
        } else {
          const u = await pg.query(
            "UPDATE ingest_items SET state = 'classified', suggested_category_id = $2, updated_at = NOW() " +
            "WHERE id = $1 AND state = 'discovered' AND suggested_category_id IS NULL", [it.id, pick.categoryId]);
          if (u.rowCount) { stats.classified++; await writeEvent(pg, 'item_auto_classified', it, { kind: pick.kind, category_id: pick.categoryId, why_not_auto: why }); }
        }
      }
      if (stats.approved > 0) d.kick();
      return stats;
    } finally { running = false; }
  }

  return { tick };
}

function register(bot, deps = {}) {
  if (process.env.INGEST_AUTO_DISABLED === '1') return null;
  const d = {
    getPg: deps.getPg || (() => require('../database/db').getPg()),
    ownerId: deps.ownerId || (() => process.env.OWNER_ID || ''),
    stage: deps.stage || (async () => {
      const v = await require('../database/db').getSetting('ingest_stage').catch(() => null);
      return require('./ingest_save').normStage(v);
    }),
    kick: deps.kick || (() => { try { require('./ingest_save').kick(); } catch (_) { /* لا شيء */ } }),
    titleFor: deps.titleFor || ((it) => require('./ingest_save').titleFor(it)),
  };
  const auto = createAuto(d);
  let lastErr = '';
  const run = () => auto.tick().then(() => { lastErr = ''; }).catch((e) => {
    const m = String((e && e.message) || e);
    if (m !== lastErr) { lastErr = m; log('error', '[ingest_auto] ' + m); }
  });
  const t = setInterval(run, TICK_MS);
  if (t.unref) t.unref();
  const t0 = setTimeout(run, 20000);
  if (t0.unref) t0.unref();
  return auto;
}

module.exports = { register, createAuto, MAX_AGE_H };
