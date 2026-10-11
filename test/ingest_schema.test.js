'use strict';
/**
 * 🧪 test/ingest_schema.test.js — حرّاس مخطط استيراد الملفات (المرحلة 1)
 *
 * بلا قاعدة بيانات: يفحص نص الـ DDL والملفات المرتبطة به. يحرس أربعة أشياء:
 *  1) الهجرة إضافية فقط (لا DROP/TRUNCATE/DELETE/UPDATE/INSERT، وALTER فقط بصيغة ADD COLUMN IF NOT EXISTS لجداول ingest_*).
 *  2) لا مفتاح أجنبي نحو جداول المكتبة (الاستعادة تنفّذ TRUNCATE ... CASCADE عليها).
 *  3) الجداول مرتبة آباء قبل أبناء، وبنفس الترتيب داخل ALL_TABLES في backup_full.js.
 *  4) الهجرة مستدعاة عند الإقلاع بعد initSchema ولا تُبتلع أخطاؤها بصمت.
 *
 * التشغيل: node --test test/ingest_schema.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ingest = require(path.join(ROOT, 'database', 'ingest_db.js'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const statements = ingest.buildStatements();

// الاستثناء الوحيد المسموح من "إضافي فقط": إضافة عمود لجدول ingest_* (بلا حذف ولا تعديل نوع)
const ADD_COLUMN = /^\s*ALTER TABLE ingest_\w+ ADD COLUMN IF NOT EXISTS \w+ [A-Z]+\s*$/i;

test('الهجرة إضافية فقط ومتكررة التنفيذ', () => {
  for (const sql of statements) {
    if (ADD_COLUMN.test(sql)) continue;
    assert.doesNotMatch(sql, /\b(DROP|ALTER|TRUNCATE|DELETE|UPDATE|INSERT)\b/i, 'عبارة غير إضافية: ' + sql.slice(0, 60));
    if (/^\s*CREATE\s/i.test(sql)) {
      assert.match(sql, /IF NOT EXISTS/i, 'CREATE بلا IF NOT EXISTS: ' + sql.slice(0, 60));
    }
  }
});

test('كل جدول في INGEST_TABLES له CREATE TABLE، ولا جداول أخرى تُنشأ', () => {
  const created = statements
    .map((s) => s.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i))
    .filter(Boolean)
    .map((m) => m[1]);
  assert.deepEqual(created, ingest.INGEST_TABLES);
});

test('المفاتيح الأجنبية: نحو جداول ingest_* فقط وإلى جدول مُنشأ قبلها', () => {
  const order = ingest.INGEST_TABLES;
  for (const sql of statements) {
    const m = sql.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
    if (!m) continue;
    const table = m[1];
    for (const ref of sql.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
      const target = ref[1];
      assert.ok(order.includes(target), `${table} يشير إلى جدول خارج ingest_*: ${target} (يُمسح بـ TRUNCATE CASCADE عند الاستعادة)`);
      assert.ok(order.indexOf(target) < order.indexOf(table), `${table} يشير إلى ${target} المُنشأ بعده`);
      assert.doesNotMatch(sql.slice(ref.index, ref.index + 120), /ON DELETE CASCADE/i, `${table}: ON DELETE CASCADE غير مسموح`);
    }
  }
});

test('ALL_TABLES في backup_full.js تضم الجداول بنفس الترتيب (الآباء أولاً)', () => {
  const src = read('utils/backup_full.js');
  const block = src.match(/const ALL_TABLES = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'تعذّر العثور على ALL_TABLES');
  const names = [...block[1].replace(/\/\/.*$/gm, '').matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
  const positions = ingest.INGEST_TABLES.map((t) => names.indexOf(t));
  assert.ok(positions.every((p) => p >= 0), 'جدول ingest_* غير موجود في ALL_TABLES: ' + JSON.stringify(positions));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'ترتيب ingest_* في ALL_TABLES غير مطابق للآباء-قبل-الأبناء');
  assert.equal(new Set(names).size, names.length, 'ALL_TABLES فيها تكرار');
});

test('الإقلاع: الهجرة بعد initSchema، وخطؤها يُسجَّل لا يُبتلع', () => {
  const src = read('index.js');
  const iInit = src.indexOf('await initSchema();');
  const iIngest = src.indexOf("require('./database/ingest_db').migrate()");
  assert.ok(iInit > 0 && iIngest > iInit, 'استدعاء ingest migrate يجب أن يأتي بعد initSchema()');
  const line = src.slice(iIngest, src.indexOf('\n', iIngest));
  assert.match(line, /\.catch\(\(e\) => logger\.error\(/, 'يجب تسجيل خطأ الهجرة');
});
