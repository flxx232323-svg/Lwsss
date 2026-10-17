'use strict';
/**
 * 📊 handlers/poll_system.js
 * نظام التصويت الاحترافي
 */

const { get, all, run } = require('../database/db');
const logger = require('../utils/logger');

// FIX: options قد يكون JSONB (Array جاهز) أو TEXT
function _parseOpts(v) {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}
// FIX: نسب مجموعها 100% بالضبط
function _pcts(counts, total) {
  if (!total) return counts.map(() => 0);
  const raw = counts.map(c => c * 100 / total);
  const out = raw.map(Math.floor);
  const left = 100 - out.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]).slice(0, left).forEach(([, i]) => { out[i]++; });
  return out;
}
// FIX: BIGINT يرجع نص و ctx.from.id رقم
const _canManage = (ctx, poll) => String(poll && poll.created_by) === String(ctx.from && ctx.from.id) || !!ctx.isOwner || !!ctx.isAdmin;

// ══════════════════════════════════════════
// 🗄️ إنشاء الجداول
// ══════════════════════════════════════════
async function initTables() {
  await run(`CREATE TABLE IF NOT EXISTS polls (
    id SERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    created_by BIGINT NOT NULL,
    question TEXT NOT NULL,
    options JSONB NOT NULL DEFAULT '[]',
    is_active BOOLEAN DEFAULT TRUE,
    ends_at TIMESTAMP,
    msg_id BIGINT,
    created_at TIMESTAMP DEFAULT NOW()
  )`).catch(() => {});
  await run(`CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id INT NOT NULL,
    user_id BIGINT NOT NULL,
    option_id INT NOT NULL,
    voted_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY(poll_id, user_id)
  )`).catch(() => {});
}
initTables();

// ══════════════════════════════════════════
// 🏗️ State في الذاكرة
// ══════════════════════════════════════════
const pollDrafts = new Map(); // adminId → { chatId, question, options[], step }

// ══════════════════════════════════════════
// 🎨 بناء لوحة التصويت
// ══════════════════════════════════════════
async function buildPollKb(pollId, options) {
  const votes = await all(
    'SELECT option_id, COUNT(*) as cnt FROM poll_votes WHERE poll_id=$1 GROUP BY option_id',
    [pollId]
  ).catch(() => []);
  const total = votes.reduce((s, v) => s + parseInt(v.cnt), 0);
  const countMap = {};
  votes.forEach(v => { countMap[v.option_id] = parseInt(v.cnt); });

  // [تعديل] كل زر يعرض النسبة % فقط (بدون عدد الأصوات)
  const buttons = options.map((opt, i) => {
    const cnt = countMap[i] || 0;
    const pct = _pcts(options.map((_, k) => countMap[k] || 0), total)[i];
    return { text: `${opt} (${pct}%)`, callback_data: `poll_vote_${pollId}_${i}` };
  });

  // [تعديل] شبكة 2×2 بدل عمود واحد، وحذف سطر/زر "المجموع" نهائياً (النتائج التفصيلية صارت من لوحة الإدارة فقط)
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  return rows;
}

// [تعديل] رسالة أبسط وأقصر
function buildPollText(poll, ended = false) {
  const status = ended ? '🔴 منتهي' : '🟢 نشط';
  let txt = `📊 *تصويت* ${status}\n\n`;
  txt += `❓ *${poll.question}*`;
  if (poll.ends_at && !ended) {
    const d = new Date(poll.ends_at);
    txt += `\n⏰ ينتهي: ${d.toLocaleString('ar-DZ')}`;
  }
  return txt;
}

// ══════════════════════════════════════════
// 📝 بدء إنشاء تصويت
// ══════════════════════════════════════════
async function startCreate(ctx, chatId) {
  const adminId = ctx.from.id;
  pollDrafts.set(adminId, { chatId, question: null, options: [], step: 'question' });
  await ctx.reply(
    '📊 *إنشاء تصويت جديد*\n━━━━━━━━━━━━━━━━\n\n' +
    '✏️ أرسل *سؤال التصويت*:',
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

// ══════════════════════════════════════════
// 💬 معالجة رسائل الإنشاء
// ══════════════════════════════════════════
async function handleDraft(ctx) {
  // فقط في الخاص
  if (ctx.chat?.type !== 'private') return false;

  const adminId = ctx.from.id;
  const draft = pollDrafts.get(adminId);
  if (!draft) return false;

  const txt = ctx.message?.text?.trim();
  if (!txt) return false;

  // /done — إنهاء الخيارات
  if (txt === '/done' || txt === 'done' || txt === 'انهاء') {
    if (!draft.question) {
      await ctx.reply('⚠️ أدخل السؤال أولاً').catch(() => {});
      return true;
    }
    if (draft.options.length < 2) {
      await ctx.reply('⚠️ لازم تضيف خيارين على الأقل').catch(() => {});
      return true;
    }

    // عرض ملخص مع خيار المدة
    let summary = `📊 *ملخص التصويت*\n━━━━━━━━━━━━━━━━\n\n`;
    summary += `❓ *${draft.question}*\n\n`;
    draft.options.forEach((o, i) => { summary += `${i + 1}. ${o}\n`; });
    summary += '\n⏱ *اختر المدة:*';

    await ctx.reply(summary, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [
          { text: '⏱ ساعة', callback_data: `poll_dur_1h_${adminId}` },
          { text: '⏱ 6 ساعات', callback_data: `poll_dur_6h_${adminId}` },
          { text: '⏱ يوم', callback_data: `poll_dur_24h_${adminId}` },
        ],
        [
          { text: '⏱ 3 أيام', callback_data: `poll_dur_72h_${adminId}` },
          { text: '♾️ بدون وقت', callback_data: `poll_dur_0_${adminId}` },
        ],
      ]},
    }).catch(() => {});
    draft.step = 'duration';
    return true;
  }

  // سؤال
  if (draft.step === 'question') {
    draft.question = txt;
    draft.step = 'options';
    await ctx.reply(
      `✅ السؤال: *${txt}*\n\n➕ أرسل الخيارات واحداً واحداً\n_(أرسل /done عند الانتهاء)_`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
    return true;
  }

  // خيارات
  if (draft.step === 'options') {
    if (draft.options.length >= 8) {
      await ctx.reply('⚠️ الحد الأقصى 8 خيارات — أرسل /done').catch(() => {});
      return true;
    }
    draft.options.push(txt);
    await ctx.reply(
      `✅ الخيار ${draft.options.length}: *${txt}*\n\n` +
      `_(أرسل خياراً آخر أو /done للإنهاء)_`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
    return true;
  }

  return false;
}

// ══════════════════════════════════════════
// ⏱ معالجة المدة وإرسال التصويت
// ══════════════════════════════════════════
async function handleDuration(ctx, data) {
  const parts = data.replace('poll_dur_', '').split('_');
  const dur = parts[0];
  const adminId = parseInt(parts[1]);
  const draft = pollDrafts.get(adminId);
  if (!draft) return ctx.answerCbQuery('❌ انتهت الجلسة').catch(() => {});

  let endsAt = null;
  const durMap = { '1h': 60, '6h': 360, '24h': 1440, '72h': 4320, '0': 0 };
  const mins = durMap[dur] || 0;
  if (mins > 0) {
    endsAt = new Date(Date.now() + mins * 60000);
  }
  draft.endsAt = endsAt;

  await ctx.answerCbQuery('✅').catch(() => {});
  await ctx.editMessageText(
    ctx.callbackQuery.message.text + '\n\n✅ تم تحديد المدة',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '📤 إرسال للقروب', callback_data: `poll_send_${adminId}` }],
        [{ text: '❌ إلغاء', callback_data: `poll_cancel_${adminId}` }],
      ]},
    }
  ).catch(() => {});
}

// ══════════════════════════════════════════
// 📤 إرسال التصويت للقروب
// ══════════════════════════════════════════
async function sendPoll(ctx, adminId) {
  const draft = pollDrafts.get(adminId);
  if (!draft) return ctx.answerCbQuery('❌ انتهت الجلسة').catch(() => {});

  // احفظ في DB
  const { run: _run, get: _get } = require('../database/db');
  const pollId = await _get(
    `INSERT INTO polls(chat_id, created_by, question, options, ends_at)
     VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [draft.chatId, adminId, draft.question, JSON.stringify(draft.options), draft.endsAt || null]
  ).catch(e => { require('../utils/logger').error('[Poll insert]', e.message); return null; });

  if (!pollId) return ctx.answerCbQuery('❌ خطأ في الحفظ', { show_alert: true }).catch(() => {});
  const poll = await _get('SELECT * FROM polls WHERE id=$1', [pollId.id]).catch(() => null);
  if (!poll) return ctx.answerCbQuery('❌ خطأ في الحفظ', { show_alert: true }).catch(() => {});

  pollDrafts.delete(adminId);

  const kb = await buildPollKb(poll.id, draft.options);
  const pollText = buildPollText(poll);

  // أرسل للقروب
  const msg = await ctx.telegram.sendMessage(draft.chatId, pollText, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb },
  }).catch(e => { logger.error('[Poll] send error:', e.message); return null; });

  if (msg) {
    await _run('UPDATE polls SET msg_id=$1 WHERE id=$2', [msg.message_id, poll.id]).catch(() => {});
  }

  // إذا فيه وقت — جدول إنهاء تلقائي
  if (draft.endsAt) {
    const delay = draft.endsAt - Date.now();
    if (delay > 0) {
      setTimeout(() => endPoll(ctx.telegram, poll.id), delay);
    }
  }

  await ctx.answerCbQuery('✅ تم الإرسال!').catch(() => {});
  await ctx.editMessageText(
    `✅ *تم إرسال التصويت للقروب!*\n\nID: \`${poll.id}\`\n\nلعرض النتائج أرسل: /poll_results_${poll.id}`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

// ══════════════════════════════════════════
// 🗳️ معالجة التصويت
// ══════════════════════════════════════════
async function handleVote(ctx, pollId, optionIdx) {
  const userId = ctx.from.id;
  const poll = await get('SELECT * FROM polls WHERE id=$1', [pollId]).catch(() => null);
  if (!poll) return ctx.answerCbQuery('❌ التصويت غير موجود', { show_alert: true }).catch(() => {});
  if (!poll.is_active) return ctx.answerCbQuery('🔴 التصويت انتهى', { show_alert: true }).catch(() => {});

  // تحقق من التصويت السابق
  const existing = await get('SELECT option_id FROM poll_votes WHERE poll_id=$1 AND user_id=$2', [pollId, userId]).catch(() => null);
  if (existing) {
    const opts = _parseOpts(poll.options);
    return ctx.answerCbQuery(`⚠️ صوّتت مسبقاً على: ${opts[existing.option_id]}`, { show_alert: true }).catch(() => {});
  }

  // سجّل الصوت
  let _ins = true;
  await run('INSERT INTO poll_votes(poll_id, user_id, option_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [pollId, userId, optionIdx]).catch(e => { _ins = false; logger.error('[Poll vote] ' + e.message); });
  if (!_ins) return ctx.answerCbQuery('⚠️ تعذّر تسجيل صوتك، حاول مجدداً', { show_alert: true }).catch(() => {});

  const opts = _parseOpts(poll.options);
  await ctx.answerCbQuery(`✅ صوّتت على: ${opts[optionIdx]}`).catch(() => {});

  // حدّث الأزرار
  const kb = await buildPollKb(pollId, opts);
  await ctx.editMessageReplyMarkup({ inline_keyboard: kb }).catch(() => {});
}

// ══════════════════════════════════════════
// 📊 عرض النتائج
// ══════════════════════════════════════════
async function showResults(ctx, pollId) {
  const poll = await get('SELECT * FROM polls WHERE id=$1', [pollId]).catch(() => null);
  if (!poll) return ctx.answerCbQuery('❌ غير موجود', { show_alert: true }).catch(() => {});

  const opts = _parseOpts(poll.options);
  const votes = await all('SELECT option_id, COUNT(*) as cnt FROM poll_votes WHERE poll_id=$1 GROUP BY option_id', [pollId]).catch(() => []);
  const total = votes.reduce((s, v) => s + parseInt(v.cnt), 0);
  const countMap = {};
  votes.forEach(v => { countMap[v.option_id] = parseInt(v.cnt); });

  let txt = `📊 *نتائج التصويت*\n━━━━━━━━━━━━━━━━\n\n❓ *${poll.question}*\n\n`;
  opts.forEach((opt, i) => {
    const cnt = countMap[i] || 0;
    const pct = _pcts(opts.map((_, k) => countMap[k] || 0), total)[i];
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    txt += `${i + 1}. *${opt}*\n   ${bar} ${pct}% (${cnt})\n\n`;
  });
  txt += `👥 المجموع: *${total}* صوت\n`;
  txt += poll.is_active ? '🟢 نشط' : '🔴 منتهي';

  await ctx.answerCbQuery('').catch(() => {});

  const kb = poll.is_active && _canManage(ctx, poll) ? [
    [{ text: '🔴 إنهاء التصويت', callback_data: `poll_end_${pollId}` }],
  ] : [];

  await ctx.reply(txt, { parse_mode: 'Markdown', reply_markup: kb.length ? { inline_keyboard: kb } : undefined }).catch(() => {});
}

// ══════════════════════════════════════════
// 🔴 إنهاء التصويت
// ══════════════════════════════════════════
async function endPoll(telegram, pollId) {
  const poll = await get('SELECT * FROM polls WHERE id=$1 AND is_active=TRUE', [pollId]).catch(() => null);
  if (!poll) return;

  await run('UPDATE polls SET is_active=FALSE WHERE id=$1', [pollId]).catch(() => {});

  const opts = _parseOpts(poll.options);
  const votes = await all('SELECT option_id, COUNT(*) as cnt FROM poll_votes WHERE poll_id=$1 GROUP BY option_id', [pollId]).catch(() => []);
  const total = votes.reduce((s, v) => s + parseInt(v.cnt), 0);
  const countMap = {};
  votes.forEach(v => { countMap[v.option_id] = parseInt(v.cnt); });

  let winner = null;
  let maxVotes = 0;
  opts.forEach((opt, i) => {
    if ((countMap[i] || 0) > maxVotes) {
      maxVotes = countMap[i] || 0;
      winner = opt;
    }
  });

  // ترتيب الخيارات من الأكثر للأقل
  const sortedOpts = opts.map((opt, i) => ({
    opt, cnt: countMap[i] || 0,
    pct: _pcts(opts.map((_, k) => countMap[k] || 0), total)[i]
  })).sort((a, b) => b.cnt - a.cnt);

  let txt = `📋 *${poll.question}*\n`;
  txt += '─'.repeat(20) + '\n\n';
  sortedOpts.forEach((o, i) => {
    const medal = i === 0 && total > 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '▪️';
    const filled = total > 0 ? Math.round(o.pct / 10) : 0;
    const bar = '■'.repeat(filled) + '□'.repeat(10 - filled);
    txt += `${medal} *${o.opt}*\n`;
    txt += `   ${bar} *${o.pct}%* — ${o.cnt} صوت\n\n`;
  });
  txt += '─'.repeat(20) + '\n';
  txt += `👥 *الأصوات:* ${total}`;
  if (winner && total > 0) txt += `  |  🏆 *${winner}*`;

  if (poll.msg_id) {
    await telegram.editMessageText(poll.chat_id, poll.msg_id, undefined, txt, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  } else {
    await telegram.sendMessage(poll.chat_id, txt, { parse_mode: 'Markdown' }).catch(() => {});
  }
}

// ══════════════════════════════════════════
// 🔁 موجّه Callbacks
// ══════════════════════════════════════════
async function handleCallback(ctx, data) {
  if (!data.startsWith('poll_')) return false;

  if (data.startsWith('poll_dur_'))     { await handleDuration(ctx, data); return true; }
  if (data.startsWith('poll_send_'))    { await sendPoll(ctx, parseInt(data.replace('poll_send_', ''))); return true; }
  if (data.startsWith('poll_cancel_')) {
    pollDrafts.delete(parseInt(data.replace('poll_cancel_', '')));
    await ctx.answerCbQuery('❌ تم الإلغاء').catch(() => {});
    await ctx.editMessageText('❌ تم إلغاء التصويت').catch(() => {});
    return true;
  }
  if (data.startsWith('poll_vote_')) {
    const parts = data.replace('poll_vote_', '').split('_');
    await handleVote(ctx, parseInt(parts[0]), parseInt(parts[1]));
    return true;
  }
  if (data.startsWith('poll_results_')) {
    await showResults(ctx, parseInt(data.replace('poll_results_', '')));
    return true;
  }
  if (data.startsWith('poll_end_')) {
    const pollId = parseInt(data.replace('poll_end_', ''));
    const poll = await get('SELECT created_by FROM polls WHERE id=$1', [pollId]).catch(() => null);
    if (!_canManage(ctx, poll)) return ctx.answerCbQuery('🚫', { show_alert: true }).catch(() => {});
    await ctx.answerCbQuery('✅ تم إنهاء التصويت').catch(() => {});
    await endPoll(ctx.telegram, pollId);
    return true;
  }

  return false;
}

module.exports = { startCreate, handleDraft, handleCallback, endPoll, showResults };
