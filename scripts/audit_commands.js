#!/usr/bin/env node
'use strict';
/**
 * scripts/audit_commands.js — تقرير صحة الأوامر لمشروعك الحي.
 *
 * التشغيل من جذر المشروع:
 *   node scripts/audit_commands.js            # تقرير مقروء
 *   node scripts/audit_commands.js --json     # نفس البيانات كـ JSON
 *   node scripts/audit_commands.js /path/to/other/checkout
 *
 * رمز الخروج 1 إذا كان السجل المركزي يشير لأمر غير موجود/ميت/اسم بديل خاطئ
 * (أي أن التوثيق انحرف عن الكود)، وإلا 0. التكرارات وغير الموثّق للمعلومة فقط.
 */
const path = require('path');
const S = require('./lib/command_scanner');
const registry = require('../utils/command_registry');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const root = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..'));

const scan = S.scanProject(root);
const unloaded = S.findUnloadedModules(scan);
const dups = S.findDuplicateCommands(scan, new Set(unloaded));
const reg = S.auditRegistry(registry, scan, unloaded);

const kinds = {};
scan.registrations.forEach(r => { kinds[r.kind] = (kinds[r.kind] || 0) + 1; });
const unloadedRegs = {};
scan.registrations.filter(r => unloaded.includes(r.file)).forEach(r => { unloadedRegs[r.file] = (unloadedRegs[r.file] || 0) + 1; });

const report = {
  root, files: scan.files.length, registrations: scan.registrations.length, kinds,
  unloadedModules: unloadedRegs, duplicateCommands: dups, registry: {
    documented: registry.COMMANDS.length, ...reg,
  },
};
const failed = reg.missing.length + reg.onlyInUnloaded.length + reg.aliasMismatch.length > 0;

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const line = '─'.repeat(54);
  console.log('تقرير صحة الأوامر\n' + line);
  console.log('الجذر            :', root);
  console.log('ملفات JS ممسوحة   :', report.files);
  console.log('تسجيلات المعالجات :', report.registrations, JSON.stringify(kinds));
  console.log('\n[1] ملفات تسجّل معالجات لكنها غير محمّلة من أي ملف (كود ميت أو سكربتات يدوية):');
  const ul = Object.entries(unloadedRegs);
  console.log(ul.length ? ul.map(([f, n]) => '   - ' + f + ' (' + n + ' تسجيل)').join('\n') : '   لا شيء');
  console.log('\n[2] أسماء أوامر مسجّلة أكثر من مرة بين ملفات محمّلة (' + dups.length + '):');
  console.log('   (ليست كلها خطأ: بعضها سلاسل مقصودة تمرّر next()، راجع الكود قبل الحذف)');
  dups.slice(0, 40).forEach(d => console.log('   /' + d.name.padEnd(14) + d.at.join('  |  ')));
  if (dups.length > 40) console.log('   … و' + (dups.length - 40) + ' أخرى (استخدم --json)');
  console.log('\n[3] السجل المركزي (' + registry.COMMANDS.length + ' أمراً موثّقاً) مقابل الكود:');
  console.log('   مفقود من الكود          :', reg.missing.length ? reg.missing.join(', ') : '0');
  console.log('   موجود في ملف ميت فقط    :', reg.onlyInUnloaded.length ? reg.onlyInUnloaded.join(', ') : '0');
  console.log('   اسم بديل غير موجود      :', reg.aliasMismatch.length ? reg.aliasMismatch.join(', ') : '0');
  console.log('   أوامر لاتينية غير موثّقة :', reg.undocumentedLatin.length, '(هدف المراحل القادمة)');
  console.log('\n' + line + '\n' + (failed ? '✖ التوثيق منحرف عن الكود — أصلح السجل أو الكود' : '✔ السجل المركزي متطابق مع الكود'));
}
process.exit(failed ? 1 : 0);
