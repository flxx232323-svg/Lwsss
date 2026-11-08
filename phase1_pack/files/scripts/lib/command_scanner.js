'use strict';
/**
 * scripts/lib/command_scanner.js — محلل ثابت (بدون أي اعتمادية) لتسجيلات الأوامر.
 *
 * يكتشف: كل تسجيلات command/hears/action/start/inlineQuery، الأسماء المكررة،
 * الملفات التي تسجّل معالجات لكنها غير محمّلة من أي ملف (كود ميت)،
 * ومطابقة السجل المركزي (utils/command_registry.js) مع الكود الفعلي.
 *
 * حدود معروفة (مقصودة): تحليل نصي وليس تنفيذاً للكود، فلا يرى الأسماء المبنية
 * ديناميكياً (متغيرات)، ولا يقرّر وحده أي معالج "يفوز" عند التكرار (ذلك يعتمد على
 * ترتيب التسجيل واستدعاء next()). يُستخدم لرصد الخلل ثم يُحكم عليه بقراءة الكود.
 */
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', '_pre_rbac_backup', 'test', 'userbot', 'public', 'backups', 'phase1']);
const SELF = new Set(['scripts/lib/command_scanner.js', 'scripts/audit_commands.js']);
const KINDS = ['command', 'start', 'help', 'settings', 'hears', 'action', 'inlineQuery'];
const RECEIVERS = new Set(['bot', 'composer', 'app', 'b', 'this', 'tgBot', 'tg']);
const PAT = new RegExp('\\b(\\w+)\\.(' + KINDS.join('|') + ')\\s*\\(', 'g');

function walk(root) {
  const out = [];
  (function rec(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        rec(path.join(dir, ent.name));
      } else if (/\.(js|cjs)$/.test(ent.name)) {
        const rel = path.relative(root, path.join(dir, ent.name)).split(path.sep).join('/');
        if (!SELF.has(rel)) out.push(rel);
      }
    }
  })(root);
  return out.sort();
}

/** يقرأ أول وسيط (نص/مصفوفة/regex/تعبير) بعد قوس الاستدعاء. */
function firstArg(src, i) {
  const n = src.length;
  while (i < n && ' \n\t\r'.includes(src[i])) i++;
  if (i >= n) return [null, i];
  const c = src[i];
  if (c === "'" || c === '"' || c === '`') {
    let j = i + 1;
    while (j < n && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
    return [src.slice(i, j + 1), j + 1];
  }
  if (c === '[') {
    let depth = 0, j = i, q = null;
    while (j < n) {
      const ch = src[j];
      if (q) { if (ch === '\\') j++; else if (ch === q) q = null; }
      else if (ch === "'" || ch === '"' || ch === '`') q = ch;
      else if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) return [src.slice(i, j + 1), j + 1]; }
      j++;
    }
  }
  if (c === '/') {
    let j = i + 1, cls = false;
    while (j < n) {
      const ch = src[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === '[') cls = true;
      else if (ch === ']') cls = false;
      else if (ch === '/' && !cls) break;
      j++;
    }
    let k = j + 1;
    while (k < n && /[A-Za-z]/.test(src[k])) k++;
    return [src.slice(i, k), k];
  }
  let j = i;
  while (j < n && !',)\n'.includes(src[j])) j++;
  return [src.slice(i, j).trim(), j];
}

/** هل الموضع idx داخل تعليق (كتلة أو سطري)؟ تقدير نصي يتتبع حالة النصوص '...' "..." `...`. */
function inComment(src, idx) {
  const open = src.lastIndexOf('/*', idx), close = src.lastIndexOf('*/', idx);
  if (open !== -1 && open > close) return true;                  // داخل كتلة /* ... */ مفتوحة
  const p = src.slice(src.lastIndexOf('\n', idx - 1) + 1, idx);   // بداية السطر حتى الموضع
  let q = null;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; continue; }
    if (ch === '/' && p[i + 1] === '/') return true;              // // خارج أي نص
  }
  return false;
}

function scanSource(src, file) {
  const nl = [];
  for (let k = src.indexOf('\n'); k !== -1; k = src.indexOf('\n', k + 1)) nl.push(k);
  const lineOf = (idx) => { let lo = 0, hi = nl.length; while (lo < hi) { const m = (lo + hi) >> 1; if (nl[m] < idx) lo = m + 1; else hi = m; } return lo + 1; };
  const regs = [];
  PAT.lastIndex = 0;
  let m;
  while ((m = PAT.exec(src))) {
    const recv = m[1];
    if (!RECEIVERS.has(recv) && !recv.endsWith('bot')) continue;
    if (inComment(src, m.index)) continue;
    const [arg] = firstArg(src, PAT.lastIndex);
    regs.push({ file, line: lineOf(m.index), kind: m[2], arg });
  }
  return regs;
}

function scanProject(root) {
  const files = walk(root);
  const sources = {};
  const registrations = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    sources[f] = src;
    registrations.push(...scanSource(src, f));
  }
  return { files, sources, registrations };
}

/** أسماء الأوامر الحرفية داخل وسيط التسجيل (بدون "/" وبأحرف صغيرة). */
function namesOf(arg) {
  const out = [];
  const re = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(arg || ''))) out.push(m[1].toLowerCase().replace(/^\//, ''));
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** الملفات التي تسجّل معالجات لكن لا يحمّلها (require) أي ملف آخر. */
function findUnloadedModules(scan) {
  const withRegs = new Set(scan.registrations.map(r => r.file));
  const unloaded = [];
  for (const f of withRegs) {
    if (f === 'index.js') continue; // نقطة الدخول
    const base = path.basename(f, path.extname(f));
    const dir = path.basename(path.dirname(f));
    const re = new RegExp("require\\(\\s*['\"][^'\"]*(?:/" + esc(base) + ")(?:\\.js)?['\"]\\s*\\)");
    const reDir = base === 'index' ? new RegExp("require\\(\\s*['\"][^'\"]*/" + esc(dir) + "['\"]\\s*\\)") : null;
    const loaded = Object.entries(scan.sources).some(([p, s]) => p !== f && (re.test(s) || (reDir && reDir.test(s))));
    if (!loaded) unloaded.push(f);
  }
  return unloaded.sort();
}

/** أسماء أوامر مسجّلة أكثر من مرة (تجاهل التكرار داخل نفس المصفوفة)، مع استبعاد ملفات اختيارية. */
function findDuplicateCommands(scan, excludeFiles = new Set()) {
  const map = new Map();
  for (const r of scan.registrations) {
    if (r.kind !== 'command' || excludeFiles.has(r.file)) continue;
    for (const n of new Set(namesOf(r.arg))) {
      if (!map.has(n)) map.set(n, []);
      map.get(n).push(r);
    }
  }
  const dups = [];
  for (const [name, list] of map) {
    const distinct = new Set(list.map(r => r.file + ':' + r.line));
    if (distinct.size > 1) dups.push({ name, at: [...distinct] });
  }
  return dups.sort((a, b) => a.name.localeCompare(b.name));
}

/** يطابق السجل المركزي مع الكود: مفقود / ميت فقط / اسم بديل غير موجود بنفس التسجيل / غير موثّق. */
function auditRegistry(registry, scan, unloadedFiles = []) {
  const dead = new Set(unloadedFiles);
  const cmdRegs = scan.registrations.filter(r => r.kind === 'command');
  const live = cmdRegs.filter(r => !dead.has(r.file)).map(r => ({ r, names: namesOf(r.arg) }));
  const deadOnly = cmdRegs.filter(r => dead.has(r.file)).map(r => ({ r, names: namesOf(r.arg) }));
  const res = { missing: [], onlyInUnloaded: [], aliasMismatch: [], undocumentedLatin: [] };

  for (const c of registry.COMMANDS) {
    const hits = live.filter(x => x.names.includes(c.name));
    if (!hits.length) {
      (deadOnly.some(x => x.names.includes(c.name)) ? res.onlyInUnloaded : res.missing).push(c.name);
      continue;
    }
    for (const a of c.aliases || []) {
      if (!hits.some(x => x.names.includes(a.toLowerCase()))) res.aliasMismatch.push(c.name + ' ↔ ' + a);
    }
  }
  const documented = new Set();
  for (const c of registry.COMMANDS) { documented.add(c.name); (c.aliases || []).forEach(a => documented.add(a.toLowerCase())); }
  const latin = new Set();
  for (const x of live) for (const n of x.names) if (/^[a-z0-9_]+$/.test(n) && !documented.has(n)) latin.add(n);
  res.undocumentedLatin = [...latin].sort();
  return res;
}

module.exports = { walk, firstArg, scanSource, scanProject, namesOf, findUnloadedModules, findDuplicateCommands, auditRegistry, KINDS };
