'use strict';
/**
 * 📥 handlers/ingest_status.js — أمر /ingest_status (المالك فقط، قراءة فقط)
 * يعرض: حالة UserBot، ولكل مصدر: التفعيل، نقطة التقدّم وآخر مسح، عدد العناصر حسب الحالة، وآخر خطأ.
 */
const logger = require('../utils/logger');

function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return `${s} ثانية`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m} دقيقة`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ساعة`;
  return `${Math.floor(h / 24)} يوم`;
}

async function loadRows(pg) {
  const r = await pg.query(
    `SELECT s.id, s.chat_id::text AS chat_id, s.title, s.enabled, s.mode,
            w.last_message_id::text AS wm, w.updated_at AS wm_at,
            (SELECT json_object_agg(t.state, t.n)
               FROM (SELECT state, count(*)::int AS n FROM ingest_items WHERE source_id = s.id GROUP BY state) t) AS counts,
            (SELECT e.ts FROM ingest_events e WHERE e.source_id = s.id AND e.event = 'source_error'
              ORDER BY e.ts DESC LIMIT 1) AS err_at,
            (SELECT e.detail FROM ingest_events e WHERE e.source_id = s.id AND e.event = 'source_error'
              ORDER BY e.ts DESC LIMIT 1) AS err_detail
       FROM ingest_sources s
       LEFT JOIN ingest_watermarks w ON w.source_id = s.id
      ORDER BY s.id`
  );
  return r.rows;
}

function formatStatus({ userbot, rows, now }) {
  const lines = ['📥 حالة استيراد الملفات', ''];
  if (userbot && userbot.online) lines.push('UserBot: 🟢 متصل');
  else lines.push('UserBot: 🔴 غير متصل' + (userbot && userbot.secondsAgo != null ? ` (آخر نبضة منذ ${ago(userbot.secondsAgo * 1000)})` : ''));
  const active = rows.filter((r) => r.enabled === 1).length;
  lines.push(`المصادر: ${rows.length} (مفعّل: ${active})`);
  if (!rows.length) {
    lines.push('', 'لا توجد مصادر بعد.');
    return lines.join('\n');
  }
  for (const r of rows) {
    lines.push('', `#${r.id} «${r.title || '—'}» (${r.chat_id})`);
    lines.push(` الحالة: ${r.enabled === 1 ? '✅ مفعّل' : '⏸ معطّل'}${r.mode === 'userbot' ? '' : ' — الوضع: ' + r.mode}`);
    if (r.wm_at) lines.push(` نقطة التقدّم: ${r.wm} — آخر مسح ناجح منذ ${ago(now - new Date(r.wm_at).getTime())}`);
    else lines.push(' نقطة التقدّم: لم يبدأ المسح بعد');
    const c = r.counts && typeof r.counts === 'object' ? Object.entries(r.counts) : [];
    lines.push(` العناصر: ${c.length ? c.map(([k, v]) => `${k}=${v}`).join('، ') : 'لا شيء'}`);
    if (r.err_at) {
      const errTime = new Date(r.err_at).getTime();
      const recovered = r.wm_at && new Date(r.wm_at).getTime() > errTime;
      let msg = '';
      try { msg = JSON.parse(r.err_detail).error || ''; } catch (_) { msg = ''; }
      lines.push(` ${recovered ? '✔️ خطأ سابق (تعافى)' : '⚠️ آخر خطأ'} منذ ${ago(now - errTime)}: ${msg}`.slice(0, 300));
    }
  }
  return lines.join('\n').slice(0, 3900);
}

function register(bot) {
  bot.command('ingest_status', async (ctx) => {
    if (String(ctx.from?.id) !== String(process.env.OWNER_ID)) return ctx.reply('🚫').catch(() => {});
    try {
      const pg = require('../database/db').getPg();
      if (!pg) return ctx.reply('قاعدة PostgreSQL غير متاحة.').catch(() => {});
      const rows = await loadRows(pg);
      const userbot = require('../routes/internal').getUserbotStatus();
      await ctx.reply(formatStatus({ userbot, rows, now: Date.now() }));
    } catch (e) {
      logger.error('[ingest_status] ' + e.message);
      ctx.reply('⚠️ تعذّر جلب الحالة.').catch(() => {});
    }
  });
}

module.exports = { register, formatStatus, loadRows };
