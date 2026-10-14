'use strict';
/**
 * ════════════════════════════════════════════════════════════
 *  🧪 handlers/ingest_probe.js — فحص تحويل ملف إلى file_id خاص بالبوت (مرحلة الحفظ، الخطوة 1)
 * ════════════════════════════════════════════════════════════
 *  الأمر: /ingest_probe [رقم_العنصر] [nosend]      (المالك فقط، في الخاص فقط)
 *
 *  المشكلة: المكتبة (files) تخزّن file_id خاصاً بالبوت (Bot API)، ومعرّفات UserBot لا تصلح لها.
 *  الفكرة المختبَرة هنا (الطريقة A): البوت نفسه يعمل forwardMessage للرسالة الأصلية إلى قناة
 *  تخزين خاصة، فيعود الرد بـ file_id صالح للبوت. لا تنزيل ولا رفع.
 *
 *  هذا الأمر يثبت ذلك على ملف حقيقي واحد:
 *   1) قناة التخزين صالحة والبوت فيها.   2) forward ينجح من القروب المصدر.
 *   3) نوع الملف عند البوت + تطابق الاسم/الحجم مع الأصل.   4) إعادة إرساله إليك بالـ file_id.
 *
 *  ضمانات:
 *   - لا كتابة في أي جدول (قراءة SELECT فقط). لا يلمس files ولا ingest_*.
 *   - المالك فقط (OWNER_ID)، وفي المحادثة الخاصة فقط، وفحص واحد في الوقت نفسه.
 *   - بلا ملف تخزين مضبوط (INGEST_STORAGE_CHAT_ID) لا يُرسَل أي شيء إلى أي مكان.
 *
 *  بدون عنصر محدد: يختار أحدث عنصر غير مرفوض. المتغير: INGEST_STORAGE_CHAT_ID (مثل -1001234567890).
 * ════════════════════════════════════════════════════════════
 */

const SENDERS = {
  document: 'sendDocument',
  video: 'sendVideo',
  audio: 'sendAudio',
  animation: 'sendAnimation',
  photo: 'sendPhoto',
};

let busy = false;

function log(level, msg) {
  try { require('../utils/logger')[level](msg); } catch (_) { /* لا شيء */ }
}

// ── دوال نقية (قابلة للاختبار) ───────────────────────────────────────────

function parseArgs(text) {
  const parts = String(text || '').trim().split(/\s+/).slice(1); // أول كلمة هي الأمر نفسه
  const out = { itemId: null, send: true, ok: true };
  for (const p of parts) {
    if (/^\d{1,19}$/.test(p) && out.itemId === null) out.itemId = p;
    else if (p.toLowerCase() === 'nosend') out.send = false;
    else out.ok = false;
  }
  return out;
}

function validStorageId(v) {
  const s = String(v == null ? '' : v).trim();
  return /^-?\d{5,20}$/.test(s) ? s : null;
}

function pick(kind, o) {
  return {
    kind,
    file_id: o.file_id,
    file_unique_id: o.file_unique_id || '',
    file_name: o.file_name || '',
    mime_type: o.mime_type || null,
    size: o.file_size == null ? null : Number(o.file_size),
  };
}

// الترتيب مهم: رسالة GIF تحمل animation و document معاً
function extractFile(msg) {
  if (!msg) return null;
  if (msg.animation) return pick('animation', msg.animation);
  if (msg.video) return pick('video', msg.video);
  if (msg.audio) return pick('audio', msg.audio);
  if (msg.document) return pick('document', msg.document);
  if (Array.isArray(msg.photo) && msg.photo.length) {
    return pick('photo', Object.assign({ mime_type: 'image/jpeg' }, msg.photo[msg.photo.length - 1]));
  }
  return null;
}

function errText(e) {
  const r = (e && e.response) || {};
  return String(r.description || (e && e.description) || (e && e.message) || e || '').slice(0, 200);
}

function classifyError(e) {
  const t = errText(e).toLowerCase();
  const retry = e && e.response && e.response.parameters && e.response.parameters.retry_after;
  if (retry || /too many requests/.test(t)) return { kind: 'rate', retry: retry || null };
  if (/forwards? (is |are )?restricted|can't be forwarded|protected content|forward.*restrict/.test(t)) return { kind: 'protected' };
  if (/message to forward not found|message_id_invalid|message not found/.test(t)) return { kind: 'gone' };
  if (/not enough rights|need administrator|have no rights|chat_write_forbidden|can't write|not allowed to send/.test(t)) return { kind: 'rights' };
  if (/chat not found|bot was kicked|not a member|bot is not a member/.test(t)) return { kind: 'chat' };
  return { kind: 'other' };
}

const HINTS = {
  rate: (c) => `حدّ معدّل Telegram${c.retry ? ` (انتظر ${c.retry} ث)` : ''}. المرحلة القادمة ستبطّئ الإرسال تلقائياً.`,
  protected: () => 'القروب مفعّل عليه «تقييد حفظ المحتوى»: forward ممنوع. هذه الحالة تحتاج الطريقة B (UserBot).',
  gone: () => 'الرسالة الأصلية محذوفة أو غير موجودة. جرّب عنصراً آخر.',
  rights: () => 'صلاحيات البوت لا تكفي. تأكد أنه مشرف في قناة التخزين ويستطيع النشر.',
  chat: () => 'البوت لا يرى القروب المصدر (ليس عضواً فيه؟) أو رقم المحادثة غير صحيح.',
  other: () => 'خطأ غير متوقع من Telegram.',
};

function fmtSize(b) {
  const n = Number(b);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / (1024 * 1024)).toFixed(1) + ' MB';
}

const short = (s, n) => Array.from(String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, n).join('');

// ── القراءة (SELECT فقط) ─────────────────────────────────────────────────

const ITEM_SQL = `SELECT i.id, i.source_message_id::text AS message_id, i.file_name, i.size_bytes::text AS size,
                          s.chat_id::text AS chat_id, s.title
                     FROM ingest_items i JOIN ingest_sources s ON s.id = i.source_id`;

async function loadItem(pg, itemId) {
  const r = itemId
    ? await pg.query(`${ITEM_SQL} WHERE i.id = $1`, [itemId])
    : await pg.query(`${ITEM_SQL} WHERE i.state <> 'rejected' ORDER BY i.id DESC LIMIT 1`);
  return r.rows[0] || null;
}

// ── التنفيذ ──────────────────────────────────────────────────────────────

async function run(ctx, deps) {
  const lines = ['🧪 فحص التحويل إلى file_id', ''];
  const finish = (verdict) => {
    if (verdict) lines.push('', verdict);
    return ctx.reply(lines.join('\n')).catch(() => {});
  };

  const args = parseArgs(ctx.message && ctx.message.text);
  if (!args.ok) return finish('الاستعمال: /ingest_probe [رقم_العنصر] [nosend]');

  const storage = validStorageId(deps.storageChatId ? deps.storageChatId() : process.env.INGEST_STORAGE_CHAT_ID);
  if (!storage) {
    return finish('⚠️ لم تُضبط قناة التخزين.\nأنشئ قناة خاصة، أضف البوت مشرفاً فيها، ثم ضع رقمها (مثل -1001234567890) في متغير INGEST_STORAGE_CHAT_ID.');
  }

  const tg = ctx.telegram;

  // 1) قناة التخزين
  try {
    const chat = await tg.getChat(storage);
    const me = ctx.botInfo && ctx.botInfo.id ? ctx.botInfo : await tg.getMe();
    const m = await tg.getChatMember(storage, me.id);
    const okStatus = ['administrator', 'creator', 'member'].includes(m.status);
    const cantPost = m.status === 'administrator' && m.can_post_messages === false;
    if (!okStatus || cantPost) {
      lines.push(`1) قناة التخزين «${short(chat.title, 30)}»: ❌ البوت ليس مشرفاً يستطيع النشر (الحالة: ${m.status}).`);
      return finish('النتيجة: أصلح صلاحيات القناة ثم أعد الفحص.');
    }
    lines.push(`1) قناة التخزين «${short(chat.title, 30)}»: ✅`);
  } catch (e) {
    lines.push(`1) قناة التخزين: ❌ ${short(errText(e), 100)}`);
    return finish('النتيجة: رقم القناة خاطئ أو البوت ليس فيها.');
  }

  // 2) العنصر
  const pg = deps.getPg ? deps.getPg() : require('../database/db').getPg();
  if (!pg) return finish('قاعدة PostgreSQL غير متاحة.');
  const item = await loadItem(pg, args.itemId);
  if (!item) return finish(args.itemId ? '⚠️ العنصر غير موجود.' : '⚠️ لا توجد عناصر مكتشفة بعد للفحص.');
  lines.splice(1, 0, `الملف: ${short(item.file_name, 40) || '#' + item.id} · ${fmtSize(item.size)}`, `القروب: ${short(item.title, 30) || '—'}`);

  // 3) forward
  let fwd;
  try {
    fwd = await tg.forwardMessage(storage, item.chat_id, Number(item.message_id));
    lines.push('2) forward من القروب المصدر: ✅');
  } catch (e) {
    const c = classifyError(e);
    lines.push(`2) forward من القروب المصدر: ❌ ${short(errText(e), 100)}`);
    return finish('النتيجة: ' + HINTS[c.kind](c));
  }

  // 4) ماذا رأى البوت
  const f = extractFile(fwd);
  if (!f) return finish('3) ❌ الرسالة المحوّلة لا تحمل ملفاً يفهمه البوت.\nالنتيجة: هذا النوع يحتاج الطريقة B.');
  const sameSize = item.size && f.size != null ? Number(item.size) === f.size : null;
  const sameName = item.file_name && f.file_name ? item.file_name === f.file_name : null;
  const match = sameSize === false || sameName === false ? '⚠️ لا يطابق الأصل' : (sameSize || sameName ? 'يطابق الأصل ✅' : 'لم يُتحقق من التطابق');
  lines.push(`3) نوع الملف عند البوت: ${f.kind} · ${fmtSize(f.size)} · ${match}`);
  lines.push(`   file_unique_id: ${short(f.file_unique_id, 40) || '—'}`);

  // 5) إعادة الإرسال بالـ file_id (الدليل أنه يعمل فعلاً)
  if (!args.send) return finish('النتيجة: forward يعمل ✅ (تخطّيت الإرسال بطلبك).');
  try {
    await tg[SENDERS[f.kind]](ctx.chat.id, f.file_id);
    lines.push('4) إعادة الإرسال إليك بالـ file_id: ✅ (يجب أن تجد الملف أعلاه)');
  } catch (e) {
    lines.push(`4) إعادة الإرسال بالـ file_id: ❌ ${short(errText(e), 100)}`);
    return finish('النتيجة: الـ file_id لم يعمل. لا نعتمد الطريقة A قبل فهم السبب.');
  }
  return finish('النتيجة: الطريقة A تعمل لهذا الملف ✅');
}

function register(bot, deps = {}) {
  bot.command('ingest_probe', async (ctx) => {
    const ownerId = String(deps.ownerId ? deps.ownerId() : process.env.OWNER_ID || '');
    if (!ownerId || String(ctx.from && ctx.from.id) !== ownerId) return ctx.reply('🚫').catch(() => {});
    if (!ctx.chat || ctx.chat.type !== 'private') return ctx.reply('استعمل هذا الأمر في المحادثة الخاصة مع البوت.').catch(() => {});
    if (busy) return ctx.reply('⏳ فحص آخر قيد التنفيذ.').catch(() => {});
    busy = true;
    try {
      await run(ctx, deps);
    } catch (e) {
      log('error', '[ingest_probe] ' + (e && e.message));
      ctx.reply('⚠️ تعذّر إكمال الفحص.').catch(() => {});
    } finally {
      busy = false;
    }
  });
}

module.exports = { register, run, parseArgs, validStorageId, extractFile, classifyError, errText };
