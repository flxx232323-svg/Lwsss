'use strict';
/**
 * database/seq_resync.js — مزامنة عدّادات الـ id (sequences) مع البيانات الفعلية.
 * يُستدعى بعد الاستعادة لمنع: duplicate key value violates unique constraint "..._pkey"
 * آمن لو تكرر: لا يغيّر أي بيانات، فقط يضبط العدّادات.
 */
const logger = require('../utils/logger');

const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';

const SEQ_QUERY = `
  SELECT c.oid::regclass::text AS seq_name, t.relname AS table_name, a.attname AS col_name
  FROM pg_class c
  JOIN pg_depend d ON d.objid = c.oid AND d.deptype IN ('a','i')
  JOIN pg_class t ON t.oid = d.refobjid
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
  WHERE c.relkind = 'S'`;

async function resyncSequences(pgOverride) {
  const pg = pgOverride || require('./db').getPg();
  if (!pg) return { skipped: true, total: 0, ok: 0, failed: 0 };

  const { rows } = await pg.query(SEQ_QUERY);
  let ok = 0, failed = 0;
  for (const r of rows) {
    try {
      await pg.query(
        `SELECT setval($1, COALESCE((SELECT MAX(${q(r.col_name)}) FROM ${q(r.table_name)}), 1))`,
        [r.seq_name]
      );
      ok++;
    } catch (e) {
      failed++;
      logger.debug('[SeqResync] ' + r.table_name + '.' + r.col_name + ': ' + e.message);
    }
  }
  logger.info('[DB] ✅ Sequences resynced after restore: ' + ok + '/' + rows.length);
  return { skipped: false, total: rows.length, ok, failed };
}

module.exports = { resyncSequences };
