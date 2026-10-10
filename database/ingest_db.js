'use strict';
/**
 * ════════════════════════════════════════════════════════════
 *  📥 database/ingest_db.js — مخطط استيراد الملفات (UserBot) — المرحلة 1
 * ════════════════════════════════════════════════════════════
 *
 *  هذه المرحلة: مخطط فقط. لا منطق عمل، ولا استعلامات، ولا أي مستهلك للجداول بعد.
 *  لا شيء يتغيّر في سلوك البوت الحالي.
 *
 *  قواعد التصميم (كل واحدة لها سبب):
 *  1) إضافي فقط: CREATE TABLE/INDEX IF NOT EXISTS، ولا يمسّ أي جدول موجود (files وغيره).
 *  2) لا مفاتيح أجنبية نحو جداول المكتبة (files/categories/...) عمداً:
 *     الاستعادة في utils/backup_full.js تنفّذ TRUNCATE ... CASCADE على جداول المكتبة،
 *     وأي FK نحوها كان سيمسح بيانات الاستيراد معها. المراجع نحو المكتبة "ناعمة" (أرقام فقط).
 *  3) المفاتيح الأجنبية بين جداول ingest_* نفسها فقط، وبدون CASCADE عند الحذف
 *     (لا يُحذف مصدر له عناصر؛ يُعطَّل بدل ذلك).
 *  4) الهجرة كلها في معاملة واحدة مع advisory lock: إمّا تكتمل كلها أو لا شيء،
 *     ولا تتسابق نسختان أثناء النشر (قد تعمل النسخة القديمة والجديدة معاً لحظة النشر).
 *  5) قيم افتراضية آمنة: ingest_sources.enabled = 0 (لا مراقبة حتى يفعّلها المالك).
 *  6) قيود على مستوى القاعدة تحرس قواعد الخطة، حتى لو أخطأ كود لاحق:
 *       - لا حفظ ولا نشر قبل موافقة (ck_ingest_items_approval_first)
 *       - لا تُوسَم خطوة "done" دون علامة إنجازها (library_file_id / published_message_id)
 *       - لا تُعالَج الرسالة نفسها مرتين (ux_ingest_items_msg)
 *  7) المراحل (staging / dry_run / production) ستُخزَّن لاحقاً في جدول settings الموجود،
 *     وأي قيمة غير موجودة يجب أن تُعامَل كـ dry_run (لا حفظ ولا نشر).
 *  8) أعمدة BIGINT تعود من مكتبة pg كنصوص — يُراعى ذلك في الكود اللاحق.
 *  9) أي جدول جديد هنا يجب أن يكون أيضاً في ALL_TABLES (utils/backup_full.js)
 *     بنفس الترتيب (الآباء قبل الأبناء)؛ يحرس ذلك test/ingest_schema.test.js.
 * ════════════════════════════════════════════════════════════
 */
const logger = require('../utils/logger');

// رقم ثابت اعتباطي لقفل الهجرة (pg_advisory_xact_lock)
const MIGRATION_LOCK_KEY = 7301001;

const ITEM_STATES = [
  'discovered', 'classified', 'needs_path', 'needs_review', 'duplicate_flagged',
  'in_batch', 'pending_approval', 'approved', 'rejected',
  'deferred_storage', 'too_large', 'completed',
];
const STEP_STATES = ['none', 'pending', 'done', 'failed_retryable', 'failed_permanent'];
const BATCH_STATES = ['open', 'closed', 'under_review', 'completed', 'partially_rejected'];

// ترتيب الآباء قبل الأبناء — نفس الترتيب في ALL_TABLES (backup_full.js)
const INGEST_TABLES = [
  'ingest_sources', 'ingest_batches', 'ingest_rules',
  'ingest_watermarks', 'ingest_items', 'ingest_events',
];

const list = (arr) => arr.map((s) => `'${s}'`).join(',');

function buildStatements() {
  return [
    // ── المصادر: القروبات التي يفعّلها المالك فقط ──
    `CREATE TABLE IF NOT EXISTS ingest_sources (
       id          SERIAL PRIMARY KEY,
       chat_id     BIGINT NOT NULL UNIQUE,
       title       TEXT NOT NULL DEFAULT '',
       mode        TEXT NOT NULL DEFAULT 'userbot',
       enabled     SMALLINT NOT NULL DEFAULT 0,
       all_topics  SMALLINT NOT NULL DEFAULT 0,
       added_by    BIGINT,
       created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       CONSTRAINT ck_ingest_sources_mode    CHECK (mode IN ('userbot','bot')),
       CONSTRAINT ck_ingest_sources_enabled CHECK (enabled IN (0,1)),
       CONSTRAINT ck_ingest_sources_topics  CHECK (all_topics IN (0,1))
     )`,

    // ── الدفعات ──
    `CREATE TABLE IF NOT EXISTS ingest_batches (
       id           SERIAL PRIMARY KEY,
       source_id    INTEGER NOT NULL REFERENCES ingest_sources(id),
       category_id  INTEGER,
       kind         TEXT NOT NULL DEFAULT '',
       state        TEXT NOT NULL DEFAULT 'open',
       opened_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       closed_at    TIMESTAMPTZ,
       closed_by    TEXT,
       reviewed_by  BIGINT,
       reviewed_at  TIMESTAMPTZ,
       CONSTRAINT ck_ingest_batches_state     CHECK (state IN (${list(BATCH_STATES)})),
       CONSTRAINT ck_ingest_batches_closed_by CHECK (closed_by IS NULL OR closed_by IN ('auto','manual'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_ingest_batches_state ON ingest_batches(state)`,

    // ── قواعد التصنيف ووجهة النشر (Topic ← مسار المكتبة + وجهة) ──
    // category_id NULL = موضوع مراقَب بلا مسار بعد (الملف ينتظر needs_path ولا يُخمَّن)
    // topic_id NULL = القروب نفسه (غير منتدى)
    `CREATE TABLE IF NOT EXISTS ingest_rules (
       id               SERIAL PRIMARY KEY,
       source_id        INTEGER NOT NULL REFERENCES ingest_sources(id),
       topic_id         BIGINT,
       category_id      INTEGER,
       target_chat_id   BIGINT,
       target_topic_id  BIGINT,
       enabled          SMALLINT NOT NULL DEFAULT 1,
       created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       CONSTRAINT ck_ingest_rules_enabled CHECK (enabled IN (0,1))
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_ingest_rules_scope
       ON ingest_rules(source_id, COALESCE(topic_id, 0))`,

    // ── نقطة التقدّم لكل مصدر (للاسترجاع بعد الانقطاع) ──
    `CREATE TABLE IF NOT EXISTS ingest_watermarks (
       source_id        INTEGER PRIMARY KEY REFERENCES ingest_sources(id),
       last_message_id  BIGINT NOT NULL DEFAULT 0,
       updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,

    // ── العناصر: صف لكل ملف مكتشف ──
    `CREATE TABLE IF NOT EXISTS ingest_items (
       id                     BIGSERIAL PRIMARY KEY,
       source_id              INTEGER NOT NULL REFERENCES ingest_sources(id),
       source_message_id      BIGINT NOT NULL,
       topic_id               BIGINT,
       grouped_id             BIGINT,
       sender_id              BIGINT,
       file_name              TEXT NOT NULL DEFAULT '',
       mime_type              TEXT,
       size_bytes             BIGINT,
       tg_doc_id              BIGINT,
       file_unique_id         TEXT,
       sha256                 TEXT,
       rule_id                INTEGER,
       suggested_category_id  INTEGER,
       duplicate_of_file_id   INTEGER,
       state                  TEXT NOT NULL DEFAULT 'discovered',
       batch_id               INTEGER REFERENCES ingest_batches(id),
       download_state         TEXT NOT NULL DEFAULT 'none',
       save_state             TEXT NOT NULL DEFAULT 'none',
       publish_state          TEXT NOT NULL DEFAULT 'none',
       library_file_id        INTEGER,
       published_chat_id      BIGINT,
       published_topic_id     BIGINT,
       published_message_id   BIGINT,
       attempts               INTEGER NOT NULL DEFAULT 0,
       attempt_token          TEXT,
       last_error             TEXT,
       next_retry_at          TIMESTAMPTZ,
       approved_by            BIGINT,
       approved_at            TIMESTAMPTZ,
       discovered_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       CONSTRAINT ux_ingest_items_msg            UNIQUE (source_id, source_message_id),
       CONSTRAINT ck_ingest_items_state          CHECK (state          IN (${list(ITEM_STATES)})),
       CONSTRAINT ck_ingest_items_download       CHECK (download_state IN (${list(STEP_STATES)})),
       CONSTRAINT ck_ingest_items_save           CHECK (save_state     IN (${list(STEP_STATES)})),
       CONSTRAINT ck_ingest_items_publish        CHECK (publish_state  IN (${list(STEP_STATES)})),
       CONSTRAINT ck_ingest_items_save_marker    CHECK (save_state <> 'done' OR library_file_id IS NOT NULL),
       CONSTRAINT ck_ingest_items_publish_marker CHECK (publish_state <> 'done' OR published_message_id IS NOT NULL),
       CONSTRAINT ck_ingest_items_approval_first CHECK (
         (save_state = 'none' AND publish_state = 'none') OR approved_by IS NOT NULL
       )
     )`,
    `CREATE INDEX IF NOT EXISTS idx_ingest_items_state  ON ingest_items(state)`,
    `CREATE INDEX IF NOT EXISTS idx_ingest_items_batch  ON ingest_items(batch_id) WHERE batch_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_ingest_items_sha256 ON ingest_items(sha256) WHERE sha256 IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_ingest_items_dup    ON ingest_items(size_bytes, file_name)`,

    // ── سجل التدقيق: من وافق ومتى حُفظ ونُشر وأين حدث الخطأ ──
    // مراجع ناعمة (بلا FK) كي تبقى الأحداث حتى لو تغيّر ما تشير إليه
    `CREATE TABLE IF NOT EXISTS ingest_events (
       id          BIGSERIAL PRIMARY KEY,
       ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       actor_kind  TEXT NOT NULL,
       actor_id    BIGINT,
       event       TEXT NOT NULL,
       source_id   INTEGER,
       item_id     BIGINT,
       batch_id    INTEGER,
       detail      TEXT NOT NULL DEFAULT '{}',
       CONSTRAINT ck_ingest_events_actor CHECK (actor_kind IN ('owner','userbot','system'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_ingest_events_item ON ingest_events(item_id) WHERE item_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_ingest_events_ts   ON ingest_events(ts DESC)`,
  ];
}

/**
 * ينشئ الجداول. يرجع true عند النجاح، false إن لم تتوفر PostgreSQL.
 * يرمي الخطأ عند الفشل (بعد ROLLBACK) — المستدعي يسجّله ولا يوقف البوت.
 */
async function migrate() {
  const { getPg } = require('./db'); // تحميل متأخر: لا آثار جانبية عند require للاختبار
  const pg = getPg();
  if (!pg) return false;

  const client = await pg.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    for (const sql of buildStatements()) {
      await client.query(sql);
    }
    await client.query('COMMIT');
    logger.info('✅ [IngestDB] schema ready (' + INGEST_TABLES.length + ' tables)');
    return true;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* تجاهل */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  migrate,
  buildStatements,
  INGEST_TABLES,
  ITEM_STATES,
  STEP_STATES,
  BATCH_STATES,
};
