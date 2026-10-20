'use strict';
/**
 * 🧠 تصنيف ذكي بالاسم — يستنتج نوع الملف (كورس / TD / TP / امتحان) من اسمه أو تعليقه،
 * ثم يطابقه مع أقسام المادة الموجودة فعلاً. لا يخمّن أبداً:
 * غموض (نوعان في اسم واحد) أو غياب مطابقة أو قسمان متشابهان = null → مراجعة يدوية.
 */

const KIND_WORDS = {
  course: ['cours', 'course', 'courses', 'lecture', 'lectures', 'lec', 'chapitre', 'chapitres', 'chapter', 'chapters', 'chap',
    'محاضره', 'محاضرات', 'كورس', 'كور', 'درس', 'دروس'],
  td: ['td', 'tds', 'serie', 'series', 'exercice', 'exercices', 'exercise', 'exercises', 'exo', 'exos',
    'تمرين', 'تمارين', 'سلسله', 'سلاسل'],
  tp: ['tp', 'tps', 'lab', 'labs', 'مخبر'],
  exam: ['exam', 'exams', 'examen', 'examens', 'ds', 'controle', 'rattrapage', 'partiel',
    'امتحان', 'امتحانات', 'اختبار', 'فرض'],
};

const WORD_TO_KIND = new Map();
Object.keys(KIND_WORDS).forEach((k) => KIND_WORDS[k].forEach((w) => WORD_TO_KIND.set(w, k)));

function normalize(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/([a-z])([A-Z])/g, '$1 $2');
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  t = t.replace(/[\u064B-\u065F\u0670\u0640]/g, '');
  t = t.replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
  t = t.toLowerCase();
  t = t.replace(/(\p{L})(\p{N})/gu, '$1 $2').replace(/(\p{N})(\p{L})/gu, '$1 $2');
  t = t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return t;
}

function tokens(s) {
  const n = normalize(s);
  return n ? n.split(' ') : [];
}

function kindsOf(text) {
  const out = new Set();
  for (const tk of tokens(text)) {
    let k = WORD_TO_KIND.get(tk);
    if (!k && tk.length > 3 && tk.startsWith('ال')) k = WORD_TO_KIND.get(tk.slice(2));
    if (k) out.add(k);
  }
  return out;
}

function sectionKind(name) {
  const k = kindsOf(name);
  return k.size === 1 ? Array.from(k)[0] : null;
}

// children: [{ id, name }] = أقسام المادة. يرجع { ok, kind, categoryId, via } أو { ok:false, reason }
function chooseCategory(fileName, caption, children) {
  let kinds = kindsOf(fileName);
  let via = 'name';
  if (kinds.size === 0) {
    kinds = kindsOf(String(caption == null ? '' : caption).split('\n')[0].slice(0, 120));
    via = 'caption';
  }
  if (kinds.size !== 1) return { ok: false, reason: kinds.size === 0 ? 'no_kind' : 'ambiguous_kind' };
  const kind = Array.from(kinds)[0];
  const hit = (children || []).filter((c) => sectionKind(c.name) === kind);
  if (hit.length !== 1) return { ok: false, reason: hit.length === 0 ? 'no_section' : 'ambiguous_section', kind };
  return { ok: true, kind, categoryId: hit[0].id, via };
}

module.exports = { KIND_WORDS, normalize, tokens, kindsOf, sectionKind, chooseCategory };
