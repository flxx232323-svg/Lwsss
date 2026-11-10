'use strict';
const { get, run, all } = require('../database/db');
const logger = require('../utils/logger');

function isGroup(ctx) { return ['group','supergroup'].includes(ctx.chat?.type); }

async function isChatAdmin(ctx) {
  if (ctx.isOwner || ctx.isAdmin) return true;
  try {
    const m = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return ['administrator','creator'].includes(m?.status);
  } catch(_) { return false; }
}

// ══════════════════════════════════════
// ⚡ كاش AFK في الذاكرة — يتجنّب استعلام قاعدة
// البيانات في كل رسالة عندما لا يوجد أحد AFK
// (الحالة الشائعة في 99% من الرسائل)
// ══════════════════════════════════════
let _afkSet = new Set();
let _afkSetReady = false;

async function _loadAfkSet() {
  try {
    const rows = await all('SELECT user_id FROM afk_users WHERE is_afk=1').catch(() => []);
    _afkSet = new Set(rows.map(r => r.user_id));
  } catch (_) { /* تجاهل */ }
  _afkSetReady = true;
}
_loadAfkSet();
setInterval(() => _loadAfkSet(), 5 * 60 * 1000).unref(); // مزامنة احتياطية كل 5 دقائق

// ══════════════════════════════════════
// 🌙 AFK
// ══════════════════════════════════════
async function handleAfk(ctx) {
  const uid = ctx.from?.id;
  const name = ctx.from?.first_name || 'مجهول';
  const reason = (ctx.message?.text||'').split(' ').slice(1).join(' ').trim();
  await run(
    'INSERT INTO afk_users(user_id,reason,since,is_afk) VALUES($1,$2,NOW(),1) ON CONFLICT(user_id) DO UPDATE SET reason=$2,since=NOW(),is_afk=1',
    [uid, reason]
  ).catch(()=>{});
  if (uid) _afkSet.add(uid);
  return ctx.reply(
    '🌙 *' + name + '* غائب الآن!' + (reason ? '\n📝 ' + reason : ''),
    { parse_mode:'Markdown', reply_to_message_id: ctx.message?.message_id }
  ).catch(()=>{});
}

async function checkAfkOnMessage(ctx) {
  if (!isGroup(ctx)) return;
  const uid = ctx.from?.id;
  const rep = ctx.message?.reply_to_message?.from;

  // ⚡ الحالة الشائعة: لا أحد AFK حالياً → لا استعلام قاعدة بيانات
  if (_afkSetReady && _afkSet.size === 0) return;
  if (_afkSetReady && !_afkSet.has(uid) && !(rep && _afkSet.has(rep.id))) return;

  // إذا كان AFK — أزله
  if (!_afkSetReady || _afkSet.has(uid)) {
    const afkRow = await get('SELECT * FROM afk_users WHERE user_id=$1 AND is_afk=1',[uid]).catch(()=>null);
    if (afkRow) {
      await run('UPDATE afk_users SET is_afk=0 WHERE user_id=$1',[uid]).catch(()=>{});
      _afkSet.delete(uid);
      const mins = Math.floor((Date.now()-new Date(afkRow.since).getTime())/60000);
      const t = mins < 60 ? mins+'د' : Math.floor(mins/60)+'س';
      ctx.reply(
        '👋 مرحباً *' + (ctx.from?.first_name||'') + '*! تم إزالة وضع الغياب.\n⏱ كنت غائباً: ' + t,
        { parse_mode:'Markdown', reply_to_message_id: ctx.message?.message_id }
      ).catch(()=>{});
    } else {
      _afkSet.delete(uid);
    }
  }
  // تحقق إذا رد على شخص AFK
  if (rep && !rep.is_bot && rep.id !== uid && (!_afkSetReady || _afkSet.has(rep.id))) {
    const repAfk = await get('SELECT * FROM afk_users WHERE user_id=$1 AND is_afk=1',[rep.id]).catch(()=>null);
    if (repAfk) {
      const mins = Math.floor((Date.now()-new Date(repAfk.since).getTime())/60000);
      const t = mins < 60 ? mins+'د' : Math.floor(mins/60)+'س';
      ctx.reply(
        '💤 *' + (rep.first_name||'هذا الشخص') + '* غائب منذ ' + t +
        (repAfk.reason ? '\n📝 ' + repAfk.reason : ''),
        { parse_mode:'Markdown', reply_to_message_id: ctx.message?.message_id }
      ).catch(()=>{});
    } else {
      _afkSet.delete(rep.id);
    }
  }
}

// ══════════════════════════════════════
// 📝 Notes
// ══════════════════════════════════════
async function saveNote(ctx) {
  if (!isGroup(ctx)) return;
  if (!(await isChatAdmin(ctx))) return ctx.reply('🚫 للمشرفين فقط').catch(()=>{});
  const args = (ctx.message?.text||'').split(' ');
  const name = args[1]?.toLowerCase();
  const rep = ctx.message?.reply_to_message;
  const content = args.slice(2).join(' ').trim() || rep?.text || rep?.caption || '';
  const file_id = rep?.sticker?.file_id || rep?.photo?.[rep.photo.length-1]?.file_id || rep?.video?.file_id || rep?.document?.file_id || null;
  const note_type = rep?.sticker ? 'sticker' : rep?.photo ? 'photo' : rep?.video ? 'video' : rep?.document ? 'document' : 'text';
  if (!name) return ctx.reply('📝 /note [اسم] [محتوى]\nأو رد على رسالة: /note [اسم]', { reply_to_message_id: ctx.message?.message_id }).catch(()=>{});
  if (!content && !file_id) return ctx.reply('❌ لا يوجد محتوى للحفظ!', { reply_to_message_id: ctx.message?.message_id }).catch(()=>{});
  await run(
    'INSERT INTO notes(chat_id,name,content,file_id,note_type,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(chat_id,name) DO UPDATE SET content=$3,file_id=$4,note_type=$5',
    [ctx.chat.id, name, content, file_id, note_type, ctx.from?.id]
  ).catch(()=>{});
  return ctx.reply('✅ تم حفظ الملاحظة: *#' + name + '*', { parse_mode:'Markdown', reply_to_message_id: ctx.message?.message_id }).catch(()=>{});
}

async function getNote(ctx, name) {
  const note = await get('SELECT * FROM notes WHERE chat_id=$1 AND name=$2',[ctx.chat?.id, name.toLowerCase()]).catch(()=>null);
  if (!note) return ctx.reply('❌ الملاحظة *#' + name + '* غير موجودة!', { parse_mode:'Markdown', reply_to_message_id: ctx.message?.message_id }).catch(()=>{});
  const opts = { reply_to_message_id: ctx.message?.message_id };
  if (note.note_type === 'sticker' && note.file_id) return ctx.telegram.sendSticker(ctx.chat.id, note.file_id, opts).catch(()=>{});
  if (note.note_type === 'photo' && note.file_id) return ctx.telegram.sendPhoto(ctx.chat.id, note.file_id, { ...opts, caption: note.content||undefined, parse_mode:'Markdown' }).catch(()=>{});
  if (note.note_type === 'video' && note.file_id) return ctx.telegram.sendVideo(ctx.chat.id, note.file_id, { ...opts, caption: note.content||undefined, parse_mode:'Markdown' }).catch(()=>{});
  if (note.note_type === 'document' && note.file_id) return ctx.telegram.sendDocument(ctx.chat.id, note.file_id, { ...opts, caption: note.content||undefined, parse_mode:'Markdown' }).catch(()=>{});
  return ctx.reply(note.content||'_فارغة_', { parse_mode:'Markdown', ...opts }).catch(()=>{});
}

async function listNotes(ctx) {
  if (!isGroup(ctx)) return;
  const notes = await all('SELECT name FROM notes WHERE chat_id=$1 ORDER BY name',[ctx.chat?.id]).catch(()=>[]);
  if (!notes.length) return ctx.reply('📭 لا توجد ملاحظات محفوظة', { reply_to_message_id: ctx.message?.message_id }).catch(()=>{});
  const txt = '📝 *الملاحظات المحفوظة:*\n━━━━━━━━━━━━━━━\n\n' + notes.map(n=>'• #'+n.name).join('\n');
  return ctx.reply(txt, { parse_mode:'Markdown', reply_to_message_id: ctx.message?.message_id }).catch(()=>{});
}

async function delNote(ctx) {
  if (!isGroup(ctx)) return;
  if (!(await isChatAdmin(ctx))) return ctx.reply('🚫 للمشرفين فقط').catch(()=>{});
  const name = (ctx.message?.text||'').split(' ')[1]?.toLowerCase();
  if (!name) return ctx.reply('❌ /delnote [اسم]', { reply_to_message_id: ctx.message?.message_id }).catch(()=>{});
  await run('DELETE FROM notes WHERE chat_id=$1 AND name=$2',[ctx.chat?.id, name]).catch(()=>{});
  return ctx.reply('🗑 تم حذف *#' + name + '*', { parse_mode:'Markdown', reply_to_message_id: ctx.message?.message_id }).catch(()=>{});
}

module.exports = {
  handleAfk, checkAfkOnMessage,
  saveNote, getNote, listNotes, delNote,
};
