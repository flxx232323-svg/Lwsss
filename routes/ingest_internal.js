'use strict';
/**
 * ════════════════════════════════════════════════════════════
 *  📥 routes/ingest_internal.js — المرحلة 2أ: استقبال ما يكتشفه UserBot
 * ════════════════════════════════════════════════════════════
 *  تُركَّب في index.js على /internal/ingest خلف requireInternalSecret (نفس سر النبضة).
 *
 *  تسجيل فقط: لا حفظ في المكتبة، لا نشر، لا إرسال أي رسالة، ولا كتابة في جدول files.
 *  تكتب في ingest_items / ingest_watermarks / ingest_events فقط.
 *
 *  GET  /config  → المصادر المفعّلة (mode=userbot) + نقطة تقدّم كل منها + مواضيعها
 *  POST /batch   → { source_id, items?, watermark?, error? }
 *
 *  ضمانات (يفرضها الخادم ولا يثق بالعميل):
 *   - الملفات التي مُرسِلها OWNER_ID فقط (أو مشرفو القروب إن فُعِّل INGEST_TRACK_ADMINS=1)، وفي نطاق المواضيع المفعّلة فقط.
 *   - إدراج مكرّر (نفس المصدر + نفس الرسالة) يُتجاهل: التسجيل idempotent.
 *   - نقطة التقدّم لا تتراجع أبداً (GREATEST)، ولا تتجاوز أكبر رسالة في الدفعة نفسها،
 *     وتُكتب مع العناصر في معاملة واحدة: لا يتقدّم المؤشر دون أن تُسجَّل عناصره.
 *   - المعرّفات 64-بت تُرسَل نصوصاً (JSON في Node يفقد الدقة فوق 2^53).
 */
const express = require('express');
const logger = require('../utils/logger');
const senders = require('../utils/ingest_senders');

const MAX_ITEMS = 200;
const DIGITS = /^\d{1,19}$/;

const isId = (v) => (typeof v === 'string' && DIGITS.test(v)) || (Number.isSafeInteger(v) && v >= 0);
const idStr = (v) => String(v);
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : null);
const bad = (res, field) => res.status(400).json({ error: 'invalid_payload', field });

function toIso(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function createRouter(deps = {}) {
  const getPg = deps.getPg || (() => require('../database/db').getPg());
  const getOwnerId = deps.getOwnerId || (() => String(process.env.OWNER_ID || ''));
  const trackAdmins = deps.trackAdmins || senders.trackAdminsEnabled;
  const getAdmins = deps.getAdmins || senders.defaultResolver;
  // المرسلون المسموحون لقروب: المالك دائماً، ومشرفوه إن فُعِّل التتبع (فشل جلب المشرفين = المالك فقط)
  const allowedFor = async (chatId, owner) => {
    const on = !!trackAdmins();
    return senders.allowedSenders({ owner, trackAdmins: on, admins: on ? await getAdmins(chatId) : null });
  };
  const router = express.Router();

  // ── الإعداد: ماذا يراقب UserBot ──
  router.get('/config', async (req, res) => {
    const pg = getPg();
    if (!pg) return res.status(503).json({ error: 'database_unavailable' });
    const owner = getOwnerId();
    if (!owner) return res.status(503).json({ error: 'owner_not_configured' });
    try {
      const s = await pg.query(
        `SELECT s.id, s.chat_id::text AS chat_id, s.title, s.all_topics,
                COALESCE(w.last_message_id, 0)::text AS last_message_id
           FROM ingest_sources s
           LEFT JOIN ingest_watermarks w ON w.source_id = s.id
          WHERE s.enabled = 1 AND s.mode = 'userbot'
          ORDER BY s.id`
      );
      const ids = s.rows.map((r) => r.id);
      const rules = ids.length
        ? (await pg.query(
            `SELECT source_id, topic_id::text AS topic_id
               FROM ingest_rules WHERE enabled = 1 AND source_id = ANY($1::int[])`, [ids])).rows
        : [];
      const sources = s.rows.map((r) => ({
        id: r.id,
        chat_id: r.chat_id,
        title: r.title,
        all_topics: r.all_topics === 1,
        last_message_id: r.last_message_id,
        topics: rules.filter((x) => x.source_id === r.id).map((x) => x.topic_id), // null = القروب نفسه
      }));
      if (trackAdmins()) {
        for (const x of sources) x.allowed_senders = [...(await allowedFor(x.chat_id, owner))];
      }
      res.json({ owner_id: owner, sources });
    } catch (e) {
      logger.error('[IngestAPI] config: ' + e.message);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // ── الدفعة: عناصر مكتشفة + نقطة تقدّم، أو تقرير خطأ ──
  router.post('/batch', async (req, res) => {
    const b = req.body || {};
    if (!Number.isInteger(b.source_id) || b.source_id <= 0) return bad(res, 'source_id');
    const items = b.items === undefined || b.items === null ? [] : b.items;
    if (!Array.isArray(items) || items.length > MAX_ITEMS) return bad(res, 'items');
    const hasWm = b.watermark !== undefined && b.watermark !== null;
    if (hasWm && !isId(b.watermark)) return bad(res, 'watermark');
    const hasErr = b.error !== undefined && b.error !== null;
    if (hasErr && typeof b.error !== 'string') return bad(res, 'error');
    if (hasErr && (items.length || hasWm)) return bad(res, 'error_is_exclusive');
    if (!hasErr && !items.length && !hasWm) return bad(res, 'empty');

    let maxId = 0n;
    for (const it of items) {
      if (!it || typeof it !== 'object') return bad(res, 'item');
      if (!isId(it.message_id) || BigInt(idStr(it.message_id)) <= 0n) return bad(res, 'item.message_id');
      if (!isId(it.sender_id)) return bad(res, 'item.sender_id');
      for (const k of ['topic_id', 'grouped_id', 'tg_doc_id']) {
        if (it[k] !== undefined && it[k] !== null && !isId(it[k])) return bad(res, 'item.' + k);
      }
      if (it.size_bytes !== undefined && it.size_bytes !== null &&
          !(Number.isSafeInteger(it.size_bytes) && it.size_bytes >= 0)) return bad(res, 'item.size_bytes');
      const id = BigInt(idStr(it.message_id));
      if (id > maxId) maxId = id;
    }
    if (hasWm && BigInt(idStr(b.watermark)) < maxId) return bad(res, 'watermark_below_items');

    const owner = getOwnerId();
    if (!owner) return res.status(503).json({ error: 'owner_not_configured' });
    const pg = getPg();
    if (!pg) return res.status(503).json({ error: 'database_unavailable' });

    let client;
    try {
      const sr = await pg.query(`SELECT id, enabled, mode, all_topics, chat_id::text AS chat_id FROM ingest_sources WHERE id = $1`, [b.source_id]);
      const src = sr.rows[0];
      if (!src) return res.status(404).json({ error: 'source_not_found' });
      if (src.enabled !== 1 || src.mode !== 'userbot') return res.status(409).json({ error: 'source_disabled' });

      // تقرير خطأ: حدث تدقيق واحد، بلا تكرار نفس الخطأ خلال ساعة
      if (hasErr) {
        const detail = JSON.stringify({ error: clip(b.error, 300) });
        const dup = await pg.query(
          `SELECT 1 FROM ingest_events
            WHERE source_id = $1 AND event = 'source_error' AND detail = $2
              AND ts > NOW() - INTERVAL '1 hour' LIMIT 1`, [src.id, detail]);
        if (!dup.rowCount) {
          await pg.query(
            `INSERT INTO ingest_events (actor_kind, event, source_id, detail) VALUES ('userbot', 'source_error', $1, $2)`,
            [src.id, detail]);
        }
        return res.json({ ok: true, recorded: !dup.rowCount });
      }

      // نطاق المواضيع
      let inScope = () => true;
      if (src.all_topics !== 1) {
        const rr = await pg.query(
          `SELECT topic_id::text AS topic_id FROM ingest_rules WHERE source_id = $1 AND enabled = 1`, [src.id]);
        const allowed = new Set(rr.rows.map((r) => (r.topic_id === null ? 'null' : r.topic_id)));
        inScope = (it) => allowed.has(it.topic_id === undefined || it.topic_id === null ? 'null' : idStr(it.topic_id));
      }

      const allowedSenders = await allowedFor(src.chat_id, owner);
      let skippedSender = 0;
      let skippedScope = 0;
      const keep = [];
      for (const it of items) {
        if (!allowedSenders.has(idStr(it.sender_id))) { skippedSender++; continue; }
        if (!inScope(it)) { skippedScope++; continue; }
        keep.push(it);
      }

      client = await pg.connect();
      await client.query('BEGIN');
      let inserted = 0;
      if (keep.length) {
        const cols = ['source_id', 'source_message_id', 'topic_id', 'grouped_id', 'sender_id', 'file_name',
          'mime_type', 'size_bytes', 'tg_doc_id', 'message_date', 'caption'];
        const params = [];
        const rowsSql = [];
        for (const it of keep) {
          const base = params.length;
          params.push(
            src.id, idStr(it.message_id),
            it.topic_id == null ? null : idStr(it.topic_id),
            it.grouped_id == null ? null : idStr(it.grouped_id),
            idStr(it.sender_id),
            clip(it.file_name, 500) || '',
            clip(it.mime_type, 100),
            it.size_bytes == null ? null : it.size_bytes,
            it.tg_doc_id == null ? null : idStr(it.tg_doc_id),
            it.message_date == null ? null : toIso(it.message_date),
            clip(it.caption, 2000)
          );
          rowsSql.push('(' + cols.map((_, i) => '$' + (base + i + 1)).join(',') + ')');
        }
        const r = await client.query(
          `INSERT INTO ingest_items (${cols.join(',')}) VALUES ${rowsSql.join(',')}
           ON CONFLICT (source_id, source_message_id) DO NOTHING`, params);
        inserted = r.rowCount;
      }

      let watermark = null;
      if (hasWm) {
        const w = await client.query(
          `INSERT INTO ingest_watermarks (source_id, last_message_id) VALUES ($1, $2)
           ON CONFLICT (source_id) DO UPDATE
             SET last_message_id = GREATEST(ingest_watermarks.last_message_id, EXCLUDED.last_message_id),
                 updated_at = NOW()
           RETURNING last_message_id::text AS wm`, [src.id, idStr(b.watermark)]);
        watermark = w.rows[0].wm;
      }

      if (inserted > 0) {
        await client.query(
          `INSERT INTO ingest_events (actor_kind, event, source_id, detail) VALUES ('userbot', 'items_recorded', $1, $2)`,
          [src.id, JSON.stringify({ inserted, duplicates: keep.length - inserted, skipped_sender: skippedSender,
            skipped_scope: skippedScope, watermark })]);
      }
      await client.query('COMMIT');
      res.json({ ok: true, inserted, duplicates: keep.length - inserted,
        skipped_sender: skippedSender, skipped_scope: skippedScope, watermark });
    } catch (e) {
      if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* تجاهل */ } }
      logger.error('[IngestAPI] batch: ' + e.message);
      res.status(500).json({ error: 'internal_error' });
    } finally {
      if (client) client.release();
    }
  });

  return router;
}

module.exports = { createRouter, router: createRouter() };
