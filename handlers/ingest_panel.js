'use strict';
/**
 * ════════════════════════════════════════════════════════════
 *  📥 handlers/ingest_panel.js — شاشة «مراقبة الملفات (UserBot)» للمالك
 * ════════════════════════════════════════════════════════════
 *  زر داخل لوحة القروبات: يختار المالك القروب (والمواضيع) الذي يتتبّع UserBot ملفاتَه فيه.
 *
 *  - المالك فقط (OWNER_ID) في كل ضغطة؛ وغيره يُرفض قبل أي استعلام.
 *  - تكتب في ingest_sources و ingest_rules فقط. لا حفظ في المكتبة، لا نشر، ولا حذف صفوف
 *    (إيقاف موضوع = تعطيل قاعدته enabled=0 كي لا تضيع إعدادات لاحقة عليها).
 *  - الأزرار تحمل الحالة المطلوبة صراحةً (…_1 / …_0) لا "اقلب": ضغطتان متتاليتان لا تُلغي إحداهما الأخرى.
 *  - القروب يجب أن يكون مسجَّلاً ونشطاً في group_chats.
 *  - يُركَّب كمعترض callback_query يمرّر next() لأي بادئة أخرى، فلا يمسّ بقية الأزرار.
 *
 *  callback_data (≤ 64 بايت):
 *    ing_list · ing_g_<chat> · ing_en_<chat>_<0|1> · ing_at_<chat>_<0|1> · ing_tp_<chat>_<topic>_<0|1>
 *    (topic 0 = القروب نفسه/General)
 * ════════════════════════════════════════════════════════════
 */
const logger = require('../utils/logger');
const { btn: kbBtn, build: kbBuild } = require('../utils/keyboard');

const MAX_GROUPS = 40;
const MAX_TOPICS = 24;
const CHAT = '(-?\\d{1,20})';

function parseCb(data) {
  if (typeof data !== 'string' || data.length > 64) return null;
  if (data === 'ing_list') return { a: 'list' };
  let m;
  if ((m = new RegExp(`^ing_g_${CHAT}$`).exec(data))) return { a: 'group', chat: m[1] };
  if ((m = new RegExp(`^ing_en_${CHAT}_([01])$`).exec(data))) return { a: 'enable', chat: m[1], on: m[2] === '1' };
  if ((m = new RegExp(`^ing_at_${CHAT}_([01])$`).exec(data))) return { a: 'alltopics', chat: m[1], on: m[2] === '1' };
  if ((m = new RegExp(`^ing_tp_${CHAT}_(\\d{1,12})_([01])$`).exec(data))) return { a: 'topic', chat: m[1], topic: m[2], on: m[3] === '1' };
  return null;
}

function shortTitle(t, fallback) {
  const clean = String(t || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return Array.from(clean || fallback || '—').slice(0, 28).join('');
}

function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return `${s} ثانية`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m} دقيقة`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ساعة`;
  return `${Math.floor(h / 24)} يوم`;
}

// ── العروض (دوال نقية تُختبر بلا قاعدة بيانات) ───────────────────────────

function buildListView(groups) {
  const lines = [
    '📥 مراقبة الملفات (UserBot)',
    '',
    'اختر القروب الذي يتتبّع الـ UserBot ملفاتك فيه.',
    '✅ مُراقَب · ⏸ غير مُراقَب',
    '',
    'ملاحظات:',
    '• حساب الـ UserBot يجب أن يكون عضواً في القروب.',
    '• تُسجَّل فقط الملفات التي ترسلها أنت.',
    '• لا يُحفظ شيء في المكتبة ولا يُنشر قبل موافقتك.',
  ];
  const rows = groups.map((g) => [
    kbBtn(`${g.enabled === 1 ? '✅' : '⏸'} ${shortTitle(g.title, 'قروب ' + g.chat_id)}`, `ing_g_${g.chat_id}`),
  ]);
  if (!groups.length) lines.push('', 'لا توجد قروبات مسجَّلة بعد.');
  rows.push([kbBtn('◀️ رجوع', 'gp_botuser')]);
  return { text: lines.join('\n'), rows };
}

function buildGroupView({ group, source, counts, err, topics, ruleTopics, now }) {
  const chat = group.chat_id;
  const enabled = !!source && source.enabled === 1;
  const allTopics = !source || source.all_topics === 1;
  const on = new Set(ruleTopics); // نصوص؛ 'null' = القروب نفسه
  const lines = [`📥 «${shortTitle(group.title, 'قروب ' + chat)}»`, ''];
  lines.push(`الحالة: ${enabled ? '✅ مُراقَب' : '⏸ غير مُراقَب'}`);
  lines.push(`النطاق: ${allTopics ? 'كل المواضيع' : `مواضيع محددة (${on.size})`}`);
  if (source && source.wm_at) lines.push(`آخر مسح ناجح: منذ ${ago(now - new Date(source.wm_at).getTime())}`);
  else if (enabled) lines.push('آخر مسح: لم يبدأ بعد (ينتظر UserBot)');
  const c = counts && counts.length ? counts.map((r) => `${r.state}=${r.n}`).join('، ') : null;
  if (c) lines.push(`العناصر: ${c}`);
  if (err) {
    const errAt = new Date(err.ts).getTime();
    const recovered = source && source.wm_at && new Date(source.wm_at).getTime() > errAt;
    let msg = '';
    try { msg = JSON.parse(err.detail).error || ''; } catch (_) { msg = ''; }
    lines.push(`${recovered ? '✔️ خطأ سابق (تعافى)' : '⚠️ آخر خطأ'} منذ ${ago(now - errAt)}: ${msg}`.slice(0, 250));
  }
  if (enabled && !allTopics && on.size === 0) {
    lines.push('', '⚠️ لم تحدد أي موضوع: لن يُسجَّل شيء. فعّل «كل المواضيع» أو اختر موضوعاً.');
  }
  lines.push('', 'تُسجَّل فقط الملفات التي ترسلها أنت. لا حفظ ولا نشر قبل موافقتك.');

  const rows = [];
  rows.push([enabled
    ? kbBtn('⏸ إيقاف المراقبة', `ing_en_${chat}_0`)
    : kbBtn('✅ تفعيل المراقبة', `ing_en_${chat}_1`)]);
  rows.push([kbBtn(`🌐 كل المواضيع: ${allTopics ? 'نعم ✅' : 'لا'}`, `ing_at_${chat}_${allTopics ? 0 : 1}`)]);
  if (!allTopics) {
    const hasNull = on.has('null');
    rows.push([kbBtn(`${hasNull ? '☑️' : '☐'} القروب نفسه (أو General)`, `ing_tp_${chat}_0_${hasNull ? 0 : 1}`)]);
    const btns = topics.map((t) => {
      const sel = on.has(t.id);
      return kbBtn(`${sel ? '☑️' : '☐'} ${shortTitle(t.name, 'موضوع #' + t.id).slice(0, 22)}`, `ing_tp_${chat}_${t.id}_${sel ? 0 : 1}`);
    });
    for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
    if (!topics.length) lines.splice(lines.length - 2, 0, '', 'لا مواضيع معروفة لهذا القروب بعد (تُعرف عند ظهور رسائل فيها).');
  }
  rows.push([kbBtn('◀️ رجوع', 'ing_list')]);
  return { text: lines.join('\n'), rows };
}

// ── الوصول إلى قاعدة البيانات ───────────────────────────────────────────

async function loadList(pg) {
  const r = await pg.query(
    `SELECT g.chat_id::text AS chat_id, g.title, s.enabled
       FROM group_chats g
       LEFT JOIN ingest_sources s ON s.chat_id = g.chat_id
      WHERE g.is_active != 0
      ORDER BY g.title
      LIMIT ${MAX_GROUPS}`);
  return r.rows;
}

async function findGroup(pg, chat) {
  const r = await pg.query(
    `SELECT chat_id::text AS chat_id, title FROM group_chats WHERE chat_id = $1 AND is_active != 0`, [chat]);
  return r.rows[0] || null;
}

async function loadGroupView(pg, group, now) {
  const sr = await pg.query(
    `SELECT s.id, s.enabled, s.all_topics, w.updated_at AS wm_at
       FROM ingest_sources s
       LEFT JOIN ingest_watermarks w ON w.source_id = s.id
      WHERE s.chat_id = $1`, [group.chat_id]);
  const source = sr.rows[0] || null;
  let counts = [], err = null, ruleTopics = [];
  if (source) {
    counts = (await pg.query(
      `SELECT state, count(*)::int AS n FROM ingest_items WHERE source_id = $1 GROUP BY state ORDER BY state`, [source.id])).rows;
    err = (await pg.query(
      `SELECT ts, detail FROM ingest_events WHERE source_id = $1 AND event = 'source_error' ORDER BY ts DESC LIMIT 1`, [source.id])).rows[0] || null;
    ruleTopics = (await pg.query(
      `SELECT COALESCE(topic_id::text, 'null') AS t FROM ingest_rules WHERE source_id = $1 AND enabled = 1`, [source.id])).rows.map((r) => r.t);
  }
  const known = (await pg.query(
    `SELECT thread_id::text AS id, name FROM group_known_topics WHERE chat_id = $1 ORDER BY thread_id LIMIT ${MAX_TOPICS}`,
    [group.chat_id])).rows;
  // مواضيع لها قاعدة (مثلاً أُضيفت يدوياً) لكنها غير معروفة: تظهر أيضاً كي لا تختفي من الشاشة
  const seen = new Set(known.map((k) => k.id));
  for (const t of ruleTopics) if (t !== 'null' && !seen.has(t)) known.push({ id: t, name: null });
  return buildGroupView({ group, source, counts, err, topics: known.slice(0, MAX_TOPICS), ruleTopics, now });
}

async function ensureSource(pg, group, ownerId) {
  const r = await pg.query(
    `INSERT INTO ingest_sources (chat_id, title, enabled, all_topics, added_by)
     VALUES ($1, $2, 0, 1, $3)
     ON CONFLICT (chat_id) DO UPDATE SET title = EXCLUDED.title, updated_at = NOW()
     RETURNING id`, [group.chat_id, group.title || '', ownerId]);
  return r.rows[0].id;
}

// ── المعالج ──────────────────────────────────────────────────────────────

async function render(ctx, view) {
  const extra = kbBuild(view.rows);
  try {
    await ctx.editMessageText(view.text, extra);
  } catch (e) {
    const d = (e && (e.description || e.message)) || '';
    if (d.indexOf('not modified') !== -1) return;
    await ctx.reply(view.text, extra).catch(() => {});
  }
}

async function handle(ctx, data, deps = {}) {
  const ownerId = String(deps.ownerId ? deps.ownerId() : process.env.OWNER_ID || '');
  if (!ownerId || String(ctx.from && ctx.from.id) !== ownerId) {
    return ctx.answerCbQuery('🚫').catch(() => {});
  }
  const cb = parseCb(data);
  if (!cb) return ctx.answerCbQuery('❌ بيانات غير صالحة.').catch(() => {});
  const pg = deps.getPg ? deps.getPg() : require('../database/db').getPg();
  if (!pg) return ctx.answerCbQuery('قاعدة PostgreSQL غير متاحة.', { show_alert: true }).catch(() => {});
  const now = deps.now ? deps.now() : Date.now();

  if (cb.a === 'list') {
    await ctx.answerCbQuery().catch(() => {});
    return render(ctx, buildListView(await loadList(pg)));
  }

  const group = await findGroup(pg, cb.chat);
  if (!group) return ctx.answerCbQuery('⚠️ هذا القروب غير مسجَّل أو غير نشط.', { show_alert: true }).catch(() => {});

  if (cb.a === 'enable') {
    if (cb.on) {
      await pg.query(
        `INSERT INTO ingest_sources (chat_id, title, enabled, all_topics, added_by)
         VALUES ($1, $2, 1, 1, $3)
         ON CONFLICT (chat_id) DO UPDATE SET enabled = 1, title = EXCLUDED.title, updated_at = NOW()`,
        [group.chat_id, group.title || '', ownerId]);
    } else {
      await pg.query(`UPDATE ingest_sources SET enabled = 0, updated_at = NOW() WHERE chat_id = $1`, [group.chat_id]);
    }
    await ctx.answerCbQuery(cb.on ? '✅ فُعِّلت المراقبة' : '⏸ أُوقفت المراقبة').catch(() => {});
  } else if (cb.a === 'alltopics') {
    await ensureSource(pg, group, ownerId);
    await pg.query(`UPDATE ingest_sources SET all_topics = $2, updated_at = NOW() WHERE chat_id = $1`,
      [group.chat_id, cb.on ? 1 : 0]);
    await ctx.answerCbQuery(cb.on ? '🌐 كل المواضيع' : '🎯 مواضيع محددة').catch(() => {});
  } else if (cb.a === 'topic') {
    const sourceId = await ensureSource(pg, group, ownerId);
    const topic = cb.topic === '0' ? null : cb.topic;
    if (cb.on) {
      await pg.query(
        `INSERT INTO ingest_rules (source_id, topic_id) VALUES ($1, $2)
         ON CONFLICT (source_id, (COALESCE(topic_id, 0))) DO UPDATE SET enabled = 1, updated_at = NOW()`,
        [sourceId, topic]);
    } else {
      await pg.query(
        `UPDATE ingest_rules SET enabled = 0, updated_at = NOW() WHERE source_id = $1 AND COALESCE(topic_id, 0) = COALESCE($2::bigint, 0)`,
        [sourceId, topic]);
    }
    await ctx.answerCbQuery(cb.on ? '☑️ أُضيف' : '☐ أُزيل').catch(() => {});
  } else {
    await ctx.answerCbQuery().catch(() => {});
  }
  return render(ctx, await loadGroupView(pg, group, now));
}

function register(bot, deps = {}) {
  bot.on('callback_query', async (ctx, next) => {
    const data = (ctx.callbackQuery && ctx.callbackQuery.data) || '';
    if (!data.startsWith('ing_')) return next();
    try {
      await handle(ctx, data, deps);
    } catch (e) {
      logger.error('[ingest_panel] ' + e.message);
      ctx.answerCbQuery('⚠️ حدث خطأ').catch(() => {});
    }
  });
}

module.exports = { register, handle, parseCb, buildListView, buildGroupView, shortTitle };
