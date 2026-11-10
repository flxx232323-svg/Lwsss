'use strict';
// ══════════════════════════════════════════════════════════════
//  🐺 Loup-Garou — المحرك الرئيسي (اللوبي + دورة الليل/النهار)
// ══════════════════════════════════════════════════════════════

const CFG = require('./config');
const { ROLES, assignRoles } = require('./roles');
const wwdb = require('./db');
const texts = require('./texts');
const kb = require('./keyboards');
const { prepareChat, lockChat, unlockChat } = require('./permissions');
const state = require('./state');
const logger = require('../../utils/logger');

let BOT = null;
function init(bot) { BOT = bot; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeSend(chatId, text, extra) {
  try {
    return await BOT.telegram.sendMessage(chatId, text, Object.assign({ parse_mode: 'Markdown' }, extra));
  } catch (e) {
    logger.warn('[Werewolf] sendMessage: ' + e.message);
    return null;
  }
}

async function sendDM(game, userId, text, kbObj) {
  try {
    return await BOT.telegram.sendMessage(userId, text, { parse_mode: 'Markdown', reply_markup: kbObj });
  } catch (e) {
    const p = state.getPlayer(game, userId);
    if (p) p.dmOk = false;
    return null;
  }
}

function isOver(game) {
  return game.status === 'ended' || !state.games.has(game.gameId);
}

async function checkpoint(game) {
  if (isOver(game)) return true;
  if (game.pendingEnd) { await endGame(game, game.pendingEnd); return true; }
  return false;
}

// ══════════════════ اللوبي ══════════════════
async function createLobby(ctx) {
  if (!['group', 'supergroup'].includes(ctx.chat?.type)) {
    return ctx.reply('🐺 لعبة لوب غارو تُلعب داخل القروبات فقط!').catch(() => {});
  }
  if (state.getGameByChat(ctx.chat.id)) {
    return ctx.reply('⚠️ توجد غرفة/لعبة لوب غارو نشطة في هذا القروب بالفعل.\nاضغط "📋 حالة اللعبة" من القائمة لمعرفة التفاصيل.').catch(() => {});
  }
  const uid = ctx.from.id;
  if (state.isPlayerBusy(uid)) {
    return ctx.reply('⚠️ أنت مشارك في لعبة لوب غارو أخرى حالياً في قروب آخر! أنهِ تلك اللعبة أولاً.').catch(() => {});
  }
  const creator = { id: uid, first_name: ctx.from.first_name, username: ctx.from.username };
  const game = state.createGame(ctx.chat.id, ctx.chat.title, creator);
  await prepareChat(BOT, game);
  // reply_to_message_id: رد على رسالة "لوب غارو" مباشرةً
  const replyOpts = { parse_mode: 'Markdown', reply_markup: kb.lobbyKeyboard(game) };
  if (ctx.message?.message_id) replyOpts.reply_to_message_id = ctx.message.message_id;
  const msg = await ctx.reply(texts.lobbyText(game), replyOpts);
  game.lobbyMsgId = msg.message_id;
  scheduleLobbyTimeout(game);
}

function scheduleLobbyTimeout(game) {
  setTimeout(async () => {
    if (!state.games.has(game.gameId) || game.status !== 'lobby') return;
    if (game.players.size < CFG.MIN_PLAYERS) {
      state.destroyGame(game);
      await editLobby(game, texts.lobbyCancelledText(`لم يكتمل العدد الأدنى (${CFG.MIN_PLAYERS} لاعبين) خلال الوقت المحدد.`));
    } else {
      await safeSend(game.chatId, '⏰ *تذكير:* العدد كافٍ للبدء! يمكن لمنشئ الغرفة أو أحد المشرفين الضغط على 🚀 *ابدأ اللعبة*.');
    }
  }, CFG.TIMERS.LOBBY_TIMEOUT_MS || 180000);
}

async function refreshLobby(game) {
  if (!game.lobbyMsgId) return;
  await BOT.telegram.editMessageText(game.chatId, game.lobbyMsgId, undefined, texts.lobbyText(game), {
    parse_mode: 'Markdown', reply_markup: kb.lobbyKeyboard(game),
  }).catch(() => {});
}

async function editLobby(game, text) {
  if (!game.lobbyMsgId) return;
  await BOT.telegram.editMessageText(game.chatId, game.lobbyMsgId, undefined, text, { parse_mode: 'Markdown' }).catch(() => {});
}

async function isGroupAdmin(chatId, uid) {
  try {
    const m = await BOT.telegram.getChatMember(chatId, uid);
    return m.status === 'creator' || m.status === 'administrator';
  } catch (_) { return false; }
}

async function handleLobbyAction(ctx, game, parsed) {
  switch (parsed.verb) {
    case 'j': return handleJoin(ctx, game);
    case 'lv': return handleLeave(ctx, game);
    case 'st': return handleStart(ctx, game);
    case 'cn': return handleCancel(ctx, game);
    default: return ctx.answerCbQuery();
  }
}

async function handleJoin(ctx, game) {
  if (game.status !== 'lobby') return ctx.answerCbQuery('🚫 بدأت اللعبة، لا يمكن الانضمام الآن.', { show_alert: true });
  const uid = ctx.from.id;
  if (game.players.has(uid)) return ctx.answerCbQuery('✅ أنت داخل الغرفة بالفعل.');
  if (state.isPlayerBusy(uid)) return ctx.answerCbQuery('⚠️ أنت مشارك في لعبة لوب غارو أخرى حالياً!', { show_alert: true });
  if (game.players.size >= CFG.MAX_PLAYERS) return ctx.answerCbQuery('🚫 الغرفة مكتملة!', { show_alert: true });
  state.addPlayer(game, { id: uid, first_name: ctx.from.first_name, username: ctx.from.username });
  await ctx.answerCbQuery('✅ انضممت إلى اللعبة! بالتوفيق 🍀');
  await refreshLobby(game);
}

async function handleLeave(ctx, game) {
  if (game.status !== 'lobby') return ctx.answerCbQuery('🚫 لا يمكن الخروج بعد بدء الجولة!', { show_alert: true });
  const uid = ctx.from.id;
  if (!game.players.has(uid)) return ctx.answerCbQuery('أنت لست داخل الغرفة.');
  state.removePlayer(game, uid);
  if (game.players.size === 0) {
    state.destroyGame(game);
    await ctx.answerCbQuery('🚪 خرجت — وأُلغيت الغرفة (لا يوجد لاعبون).');
    return editLobby(game, texts.lobbyCancelledText('غادر جميع اللاعبين الغرفة.'));
  }
  if (game.creatorId === uid) game.creatorId = game.playerOrder[0];
  await ctx.answerCbQuery('🚪 خرجت من الغرفة.');
  await refreshLobby(game);
}

async function handleStart(ctx, game) {
  if (game.status !== 'lobby') return ctx.answerCbQuery('بدأت اللعبة مسبقاً.');
  const uid = ctx.from.id;
  if (uid !== game.creatorId && !(await isGroupAdmin(game.chatId, uid))) {
    return ctx.answerCbQuery('🚫 فقط منشئ الغرفة أو مشرفو القروب يمكنهم بدء اللعبة.', { show_alert: true });
  }
  if (game.players.size < CFG.MIN_PLAYERS) {
    return ctx.answerCbQuery(`🚫 العدد غير كافٍ! المطلوب ${CFG.MIN_PLAYERS} على الأقل (الحاليون: ${game.players.size}).`, { show_alert: true });
  }
  await ctx.answerCbQuery('🚀 بدء اللعبة...');
  game.status = 'starting';
  await editLobby(game, '🚀 *بدأت اللعبة!* جارٍ توزيع الأدوار عبر الخاص...');
  beginGame(game).then(() => runGameLoop(game)).catch(e => {
    logger.error('[Werewolf] runGameLoop crashed: ' + e.message);
    safeSend(game.chatId, '⚠️ حدث خطأ غير متوقع وتم إيقاف اللعبة.');
    unlockChat(BOT, game).catch(() => {});
    state.destroyGame(game);
  });
}

async function handleCancel(ctx, game) {
  if (game.status !== 'lobby') return ctx.answerCbQuery('🚫 لا يمكن الإلغاء بعد البدء.', { show_alert: true });
  const uid = ctx.from.id;
  if (uid !== game.creatorId && !(await isGroupAdmin(game.chatId, uid))) {
    return ctx.answerCbQuery('🚫 فقط منشئ الغرفة أو مشرفو القروب.', { show_alert: true });
  }
  state.destroyGame(game);
  await ctx.answerCbQuery('❌ تم إلغاء الغرفة.');
  await editLobby(game, texts.lobbyCancelledText('أُلغيت بواسطة ' + (ctx.from.first_name || 'مستخدم') + '.'));
}

// ══════════════════ بدء اللعبة وتوزيع الأدوار ══════════════════
async function beginGame(game) {
  const players = [...game.players.values()].map(p => ({ id: p.id, name: p.name }));
  const { roleByUser, loversPair, mayorId, composition } = assignRoles(players);
  game.composition = composition;
  game.loversPair = loversPair;
  game.mayorId = mayorId;
  for (const p of game.players.values()) {
    const roleId = roleByUser.get(p.id);
    const def = ROLES[roleId];
    p.role = roleId; p.team = def.team; p.revealTeam = def.revealTeam;
    p.isLover = !!(loversPair && loversPair.includes(p.id));
    p.isMayor = mayorId === p.id;
  }
  game.gameRowId = await wwdb.recordGameStart(game.chatId, game.players.size);
  state.pushEvent(game, `🎮 بدأت اللعبة بعدد ${game.players.size} لاعبين.`);

  const failed = [];
  for (const p of game.players.values()) {
    const msg = await sendDM(game, p.id, texts.roleDmText(game, p));
    if (!msg) failed.push(p.name);
  }
  await safeSend(game.chatId, texts.rolesAnnouncedText(game));
  if (failed.length) {
    await safeSend(game.chatId, '⚠️ تعذّر إرسال الدور بالخاص لـ: ' + failed.map(texts.esc).join('، ') +
      '\nيرجى فتح محادثة خاصة مع البوت (Start) — وإلا تُحتسب أفعالهم "تجاهل" تلقائياً عند انتهاء الوقت.');
  }
}

// ══════════════════ حلقة اللعبة الرئيسية ══════════════════
async function runGameLoop(game) {
  while (true) {
    if (await checkpoint(game)) return;
    game.round++;
    game.status = 'night';
    state.nextEpoch(game);
    await lockChat(BOT, game);
    await safeSend(game.chatId, texts.nightStartText(game));
    await sleep(CFG.TIMERS.NIGHT_INTRO_DELAY);

    await guardianPhase(game);   if (await checkpoint(game)) return;
    await seerPhase(game);       if (await checkpoint(game)) return;
    await detectivePhase(game);  if (await checkpoint(game)) return;
    await foxPhase(game);        if (await checkpoint(game)) return;
    await wolvesPhase(game);     if (await checkpoint(game)) return;
    game.nightActions.wolvesVictimId = computeWolvesVictim(game);
    await skPhase(game);         if (await checkpoint(game)) return;
    await vampirePhase(game);    if (await checkpoint(game)) return;
    await witchPhase(game);      if (await checkpoint(game)) return;

    const initialDeaths = resolveNight(game);
    const finalized = await resolveDeathChain(game, initialDeaths);
    if (await checkpoint(game)) return;

    game.status = 'day';
    await safeSend(game.chatId, texts.dayStartText(game, finalized, []));
    await sleep(CFG.TIMERS.DAY_INTRO_DELAY);

    let win = checkWin(game);
    if (win) { await endGame(game, win); return; }

    // 🗣️ النقاش
    game.status = 'discussion';
    await unlockChat(BOT, game);
    await safeSend(game.chatId, texts.discussionStartText(CFG.TIMERS.DISCUSSION));
    await sleep(Math.max(0, CFG.TIMERS.DISCUSSION - CFG.TIMERS.DISCUSSION_WARN));
    if (await checkpoint(game)) return;
    await safeSend(game.chatId, texts.discussionTimeLeftText(Math.round(CFG.TIMERS.DISCUSSION_WARN / 1000)));
    await sleep(CFG.TIMERS.DISCUSSION_WARN);
    if (await checkpoint(game)) return;
    await safeSend(game.chatId, texts.discussionEndedText());

    // 🗳️ التصويت
    await votingPhase(game);
    if (await checkpoint(game)) return;

    win = checkWin(game);
    if (win) { await endGame(game, win); return; }

    await sleep(CFG.TIMERS.BETWEEN_ROUNDS);
  }
}

// ══════════════════ مراحل الليل ══════════════════
async function singleTargetPhase(game, roleId, verb, key, extraExclude, timer) {
  const actor = state.getAliveByRole(game, roleId)[0];
  if (!actor) return;
  if (roleId === 'fox' && !actor.foxActive) return;
  state.nextEpoch(game);
  const exclude = [actor.id, ...(extraExclude ? extraExclude(game) : [])];
  const kbObj = kb.targetKeyboard(game, verb, exclude);
  if (!kbObj.inline_keyboard.length) return;
  await sendDM(game, actor.id, texts.nightPromptText(key), kbObj);
  await state.createWaiter(game, key, [actor.id], timer);
}

function guardianPhase(game) {
  return singleTargetPhase(game, 'guardian', 'gp', 'guardian',
    g => g.lastGuardianTarget ? [g.lastGuardianTarget] : [], CFG.TIMERS.GUARDIAN);
}
function seerPhase(game) {
  return singleTargetPhase(game, 'seer', 'sv', 'seer', null, CFG.TIMERS.SEER);
}
function skPhase(game) {
  return singleTargetPhase(game, 'serial_killer', 'skv', 'sk', null, CFG.TIMERS.WOLVES);
}
function vampirePhase(game) {
  return singleTargetPhase(game, 'vampire', 'vpv', 'vampire', null, CFG.TIMERS.WOLVES);
}

async function detectivePhase(game) {
  const actor = state.getAliveByRole(game, 'detective')[0];
  if (!actor) return;
  if (state.getAlivePlayers(game).length - 1 < 2) return;
  state.nextEpoch(game);
  game.pending[actor.id] = { type: 'detective', picks: [] };
  const kbObj = kb.multiSelectKeyboard(game, 'dtp', 'dtc', [actor.id], [], 2);
  await sendDM(game, actor.id, texts.nightPromptText('detective'), kbObj);
  await state.createWaiter(game, 'detective', [actor.id], CFG.TIMERS.DETECTIVE);
}

async function foxPhase(game) {
  const actor = state.getAliveByRole(game, 'fox')[0];
  if (!actor || !actor.foxActive) return;
  if (state.getAlivePlayers(game).length - 1 < 3) return;
  state.nextEpoch(game);
  game.pending[actor.id] = { type: 'fox', picks: [] };
  const kbObj = kb.multiSelectKeyboard(game, 'fxp', 'fxc', [actor.id], [], 3);
  await sendDM(game, actor.id, texts.nightPromptText('fox'), kbObj);
  await state.createWaiter(game, 'fox', [actor.id], CFG.TIMERS.FOX);
}

async function wolvesPhase(game) {
  const wolves = state.getAliveByRole(game, 'wolf');
  game.nightActions.wolfVotes = {};
  if (!wolves.length) return;
  state.nextEpoch(game);
  const wolfPackIds = state.getAlivePlayers(game).filter(p => ROLES[p.role].isWolfPack).map(p => p.id);
  const kbObj = kb.targetKeyboard(game, 'wk', wolfPackIds);
  if (!kbObj.inline_keyboard.length) return;
  for (const w of wolves) await sendDM(game, w.id, texts.nightPromptText('wolves'), kbObj);
  await state.createWaiter(game, 'wolves', wolves.map(w => w.id), CFG.TIMERS.WOLVES);
}

function computeWolvesVictim(game) {
  const tally = game.nightActions.wolfVotes || {};
  const counts = {};
  for (const targetId of Object.values(tally)) counts[targetId] = (counts[targetId] || 0) + 1;
  const keys = Object.keys(counts);
  if (!keys.length) return null;
  const max = Math.max(...keys.map(k => counts[k]));
  const top = keys.filter(k => counts[k] === max);
  return Number(top[Math.floor(Math.random() * top.length)]);
}

async function witchPhase(game) {
  const witch = state.getAliveByRole(game, 'witch')[0];
  game.nightActions.witchSave = false;
  game.nightActions.witchIgnore = false;
  game.nightActions.witchPoisonTarget = null;
  if (!witch) return;
  if (game.witch.saveUsed && game.witch.poisonUsed) return;
  state.nextEpoch(game);
  const victimId = game.nightActions.wolvesVictimId;
  const victim = victimId ? state.getPlayer(game, victimId) : null;
  const canSave = !game.witch.saveUsed && !!victim;
  const canPoison = !game.witch.poisonUsed;
  const kbObj = kb.witchKeyboard(game, witch.id, victim?.id, canSave, canPoison);
  if (!kbObj.inline_keyboard.length) return;
  await sendDM(game, witch.id, texts.witchPromptText(victim), kbObj);
  await state.createWaiter(game, 'witch', [witch.id], CFG.TIMERS.WITCH);
}

// ══════════════════ تحليل نتائج الليل ══════════════════
function resolveNight(game) {
  const deaths = [];
  const guardianTarget = game.nightActions.guardianTarget ?? null;
  const wolvesVictimId = game.nightActions.wolvesVictimId ?? null;

  let wolfKillHappens = !!wolvesVictimId;
  if (wolfKillHappens && guardianTarget === wolvesVictimId) {
    wolfKillHappens = false;
    const guardian = state.getAliveByRole(game, 'guardian')[0];
    if (guardian) guardian.guardianSaves++;
  }
  if (wolfKillHappens && game.nightActions.witchSave) {
    wolfKillHappens = false;
    const witch = state.getAliveByRole(game, 'witch')[0];
    if (witch) { witch.witchSaves++; game.witch.saveUsed = true; }
  } else if (game.nightActions.witchSave) {
    game.witch.saveUsed = true;
  }
  if (wolfKillHappens) deaths.push({ id: wolvesVictimId, cause: 'wolves' });

  const poisonTarget = game.nightActions.witchPoisonTarget;
  if (poisonTarget) {
    game.witch.poisonUsed = true;
    deaths.push({ id: poisonTarget, cause: 'poison' });
  }

  const skTarget = game.nightActions.skTarget;
  if (skTarget) {
    if (guardianTarget === skTarget) {
      const guardian = state.getAliveByRole(game, 'guardian')[0];
      if (guardian) guardian.guardianSaves++;
    } else {
      deaths.push({ id: skTarget, cause: 'sk' });
    }
  }

  const vampTarget = game.nightActions.vampireTarget;
  if (vampTarget) {
    if (guardianTarget === vampTarget) {
      const guardian = state.getAliveByRole(game, 'guardian')[0];
      if (guardian) guardian.guardianSaves++;
    } else {
      deaths.push({ id: vampTarget, cause: 'vampire' });
    }
  }

  game.lastGuardianTarget = guardianTarget;
  game.nightActions = {};
  return deaths;
}

function deathEventText(p, cause) {
  const map = {
    wolves:     `🐺 الذئاب قتلوا ${texts.esc(p.name)}.`,
    poison:     `🧪 الساحرة سمّمت ${texts.esc(p.name)}.`,
    sk:         `☠️ القاتل المتسلسل قتل ${texts.esc(p.name)}.`,
    vampire:    `🧛 مصاص الدماء نهش ${texts.esc(p.name)}.`,
    heartbreak: `💔 مات ${texts.esc(p.name)} حزناً على فقدان حبيبه/حبيبته.`,
    hunter:     `🔫 الصياد قتل ${texts.esc(p.name)} برصاصته الأخيرة.`,
    execution:  `⚖️ أُعدم ${texts.esc(p.name)} (${texts.roleLine(p.role)}).`,
    left:       `🚪 غادر ${texts.esc(p.name)} القروب أثناء اللعبة.`,
  };
  return map[cause] || `💀 مات ${texts.esc(p.name)}.`;
}

async function askHunterRevenge(game, hunter) {
  if (state.getAlivePlayers(game).length === 0) return null;
  state.nextEpoch(game);
  const kbObj = kb.targetKeyboard(game, 'hv', [hunter.id], { extraText: '⏭️ تجاهل (لا تطلق النار)', extraVerb: 'hv', extraArg: 'x' });
  if (!kbObj.inline_keyboard.length) return null;
  game.nightActions.hunterTarget = undefined;
  await sendDM(game, hunter.id, texts.hunterRevengeText(), kbObj);
  await state.createWaiter(game, 'hunter', [hunter.id], CFG.TIMERS.HUNTER);
  return game.nightActions.hunterTarget || null;
}

async function resolveDeathChain(game, initialDeaths) {
  const finalized = [];
  const queue = [...initialDeaths];
  const processed = new Set();
  while (queue.length) {
    const d = queue.shift();
    const pid = Number(d.id);
    if (processed.has(pid)) continue;
    const p = state.getPlayer(game, pid);
    if (!p || !p.alive) continue;
    processed.add(pid);
    p.alive = false;
    p.deathCause = d.cause;
    const entry = { id: pid, name: p.name, cause: d.cause, revealRole: d.cause === 'hunter' ? p.role : null };
    finalized.push(entry);
    state.pushEvent(game, deathEventText(p, d.cause));

    if (game.loversPair && game.loversPair.includes(pid)) {
      const partnerId = game.loversPair.find(x => x !== pid);
      const partner = state.getPlayer(game, partnerId);
      if (partner && partner.alive && !processed.has(partnerId)) {
        queue.push({ id: partnerId, cause: 'heartbreak' });
      }
    }

    if (p.role === 'hunter' && !p.hunterUsed) {
      p.hunterUsed = true;
      const revengeId = await askHunterRevenge(game, p);
      if (revengeId) queue.push({ id: revengeId, cause: 'hunter' });
    }
  }
  return finalized;
}

// ══════════════════ التصويت النهاري ══════════════════
function tallyVotes(game) {
  const tally = new Map();
  for (const [voterIdStr, targetKey] of Object.entries(game.votes)) {
    const voter = state.getPlayer(game, Number(voterIdStr));
    if (!voter || !voter.alive) continue;
    const weight = voter.isMayor ? 2 : 1;
    if (!tally.has(targetKey)) {
      const name = targetKey === 'x' ? '' : (state.getPlayer(game, Number(targetKey))?.name || '؟');
      tally.set(targetKey, { name, count: 0, hasMayor: false });
    }
    const entry = tally.get(targetKey);
    entry.count += weight;
    if (voter.isMayor) entry.hasMayor = true;
  }
  return tally;
}

async function votingPhase(game) {
  game.status = 'voting';
  await lockChat(BOT, game);
  state.nextEpoch(game);
  game.votes = {};
  const alive = state.getAlivePlayers(game);
  const kbObj = kb.dayVoteKeyboard(game, []);
  const msg = await safeSend(game.chatId, texts.voteStartText(game, 0), { reply_markup: kbObj });
  game.voteMsgId = msg?.message_id;
  await state.createWaiter(game, 'dayVote', alive.map(p => p.id), CFG.TIMERS.VOTE);
  if (isOver(game)) return;

  const tally = tallyVotes(game);
  await safeSend(game.chatId, texts.voteResultsText(game, tally));

  let maxCount = -1, maxKeys = [];
  for (const [key, v] of tally.entries()) {
    if (v.count > maxCount) { maxCount = v.count; maxKeys = [key]; }
    else if (v.count === maxCount) maxKeys.push(key);
  }

  if (!tally.size || maxKeys.length !== 1 || maxKeys[0] === 'x') {
    if (tally.size && maxKeys.length > 1 && !maxKeys.includes('x')) {
      const names = maxKeys.map(k => state.getPlayer(game, Number(k))?.name).filter(Boolean);
      await safeSend(game.chatId, texts.tieText(names));
    } else {
      await safeSend(game.chatId, texts.noExecutionText());
    }
    state.pushEvent(game, '🤝 لم يُعدم أحد هذه الجولة.');
    return;
  }

  const executedId = Number(maxKeys[0]);
  const executed = state.getPlayer(game, executedId);
  if (!executed) return;

  if (ROLES[executed.role].team !== 'village') {
    for (const [voterIdStr, targetKey] of Object.entries(game.votes)) {
      if (targetKey === String(executedId)) {
        const voter = state.getPlayer(game, Number(voterIdStr));
        if (voter) voter.correctExecutions = (voter.correctExecutions || 0) + 1;
      }
    }
  }

  game.deadRolesRevealed.set(executedId, executed.role);
  await safeSend(game.chatId, texts.executionText(executed));
  if (executed.role === 'jester') game.jesterWon = executedId;

  await resolveDeathChain(game, [{ id: executedId, cause: 'execution' }]);
}

// ══════════════════ شروط الفوز ══════════════════
function checkWin(game) {
  const alive = state.getAlivePlayers(game);

  if (game.loversPair) {
    const [a, b] = game.loversPair;
    const pa = state.getPlayer(game, a), pb = state.getPlayer(game, b);
    if (pa && pb && pa.alive && pb.alive && alive.length === 2) {
      return { winType: 'lovers', winners: [pa, pb] };
    }
  }
  if (alive.length === 0) return { winType: 'draw', winTeam: 'none', winners: [] };
  if (alive.length === 1) return { winType: 'solo', winTeam: alive[0].team, winners: [alive[0]] };

  const wolvesAlive = alive.filter(p => p.team === 'wolves').length;
  const skAlive = alive.filter(p => p.team === 'solo_sk').length;
  const vampAlive = alive.filter(p => p.team === 'solo_vampire').length;
  const villageAlive = alive.filter(p => p.team === 'village').length;

  if (wolvesAlive === 0 && skAlive === 0 && vampAlive === 0) {
    return { winType: 'team', winTeam: 'village', winners: alive.filter(p => p.team === 'village') };
  }
  if (villageAlive === 0 && skAlive === 0 && vampAlive === 0 && wolvesAlive > 0) {
    return { winType: 'team', winTeam: 'wolves', winners: alive.filter(p => p.team === 'wolves') };
  }
  return null;
}

// ══════════════════ نهاية اللعبة ══════════════════
async function endGame(game, result) {
  if (game.status === 'ended') return;
  game.status = 'ended';
  for (const w of Object.values(game.waiters)) { try { w.finish(); } catch (_) {} }
  await unlockChat(BOT, game).catch(() => {});
  await safeSend(game.chatId, texts.gameEndText(game, result));
  await wwdb.recordGameEnd(game.gameRowId, result.winType === 'lovers' ? 'lovers' : (result.winTeam || 'none'), game.round);

  let winnerIds = new Set();
  if (result.winType === 'lovers' || result.winType === 'solo') {
    winnerIds = new Set(result.winners.map(w => w.id));
  } else if (result.winType === 'team') {
    winnerIds = new Set([...game.players.values()].filter(p => p.team === result.winTeam).map(p => p.id));
  }

  for (const p of game.players.values()) {
    const isJesterWin = game.jesterWon === p.id;
    const won = winnerIds.has(p.id) || isJesterWin;
    const isWolfWin = won && p.team === 'wolves';
    const isVillageWin = won && p.team === 'village' && !isJesterWin;
    const isSkWin = won && p.team === 'solo_sk';
    const isVampireWin = won && p.team === 'solo_vampire';

    const statsRow = await wwdb.applyPlayerResult({
      userId: p.id, firstName: p.name, username: p.username, role: p.role, team: p.team,
      won, isWolfWin, isVillageWin, isSkWin, isVampireWin, isJesterWin,
      seerInvestigations: p.seerInvestigations, seerCorrect: p.seerCorrect,
      witchSaves: p.witchSaves, guardianSaves: p.guardianSaves, correctExecutions: p.correctExecutions,
    });
    if (!statsRow) continue;

    let coins = CFG.ECONOMY.PARTICIPATION;
    if (won) coins += CFG.ECONOMY.WIN_BASE;
    if (isWolfWin) coins += CFG.ECONOMY.WIN_WOLF_BONUS;
    if (CFG.SPECIAL_ROLES.includes(p.role)) coins += CFG.ECONOMY.SPECIAL_ROLE_BONUS;

    const achievements = await wwdb.checkNewAchievements(p.id, statsRow);
    if (achievements.length) coins += achievements.length * CFG.ECONOMY.ACHIEVEMENT_BONUS;

    const oldWins = statsRow.wins - (won ? 1 : 0);
    const oldRank = wwdb.getRank(oldWins);
    const newRank = wwdb.getRank(statsRow.wins);
    const rankedUp = newRank.key !== oldRank.key;
    if (rankedUp) coins += CFG.ECONOMY.RANK_UP_BONUS;

    await wwdb.awardCoins(p.id, p.name, p.username, coins, '🐺 نتيجة لعبة لوب غارو');

    let dm = (won ? '🎉 *لقد فزت في لوب غارو!*' : '😔 *لقد خسرت هذه المرة في لوب غارو.*') +
      `\n\n💰 حصلت على *${coins}* عملة في حسابك البنكي.`;
    if (rankedUp) dm += '\n' + texts.rankUpText(newRank);
    dm += texts.newAchievementsText(achievements);
    await sendDM(game, p.id, dm);
  }

  state.destroyGame(game);
}

// ══════════════════ مغادرة/طرد لاعب أثناء اللعبة ══════════════════
async function handlePlayerLeft(chatId, userId) {
  const game = state.getGameByChat(chatId);
  if (!game) return;

  if (game.status === 'lobby') {
    if (game.players.has(userId)) {
      state.removePlayer(game, userId);
      if (game.players.size === 0) {
        state.destroyGame(game);
        await editLobby(game, texts.lobbyCancelledText('غادر جميع اللاعبين الغرفة.'));
      } else {
        if (game.creatorId === userId) game.creatorId = game.playerOrder[0];
        await refreshLobby(game);
      }
    }
    return;
  }

  if (game.status === 'ended') return;
  const p = state.getPlayer(game, userId);
  if (!p || !p.alive) return;

  await resolveDeathChain(game, [{ id: userId, cause: 'left' }]);
  await safeSend(game.chatId, `🚪 *${texts.esc(p.name)}* غادر القروب أو تم طرده أثناء اللعبة — تم استبعاده من اللعبة.`);
  for (const key of Object.keys(game.waiters)) state.notifyWaiter(game, key, userId);

  const win = checkWin(game);
  if (win) game.pendingEnd = win;
}

// ══════════════════ أوامر القائمة العامة (wwx:) ══════════════════
async function handleMenuAction(ctx, parsed) {
  switch (parsed.action) {
    case 'status':     return cmdStatus(ctx, true);
    case 'log':        return cmdLog(ctx, true);
    case 'rules':      return cmdRules(ctx, true);
    case 'mystats':    return cmdStats(ctx, true);
    case 'ach':        return cmdAchievements(ctx, true);
    case 'season':     return cmdSeason(ctx, true);
    case 'back_lobby': return cmdBackLobby(ctx);
    default:           return ctx.answerCbQuery();
  }
}

async function cmdStatus(ctx, isCb) {
  const game = state.getGameByChat(ctx.chat.id);
  if (isCb) await ctx.answerCbQuery();
  if (!game) return ctx.reply('ℹ️ لا توجد لعبة لوب غارو نشطة في هذا القروب حالياً.\nاكتب 🎮 لإنشاء غرفة جديدة.').catch(() => {});
  return ctx.reply(texts.statusText(game), { parse_mode: 'Markdown' }).catch(() => {});
}

async function cmdLog(ctx, isCb) {
  const game = state.getGameByChat(ctx.chat.id);
  if (isCb) await ctx.answerCbQuery();
  if (!game) return ctx.reply('ℹ️ لا توجد لعبة نشطة لعرض سجلها.').catch(() => {});
  return ctx.reply(texts.eventLogText(game), { parse_mode: 'Markdown' }).catch(() => {});
}

async function cmdRules(ctx, isCb) {
  const backBtn = { inline_keyboard: [[{ text: '🔙 رجوع للوبي', callback_data: require('./codec').cbx('back_lobby') }]] };
  if (isCb) {
    await ctx.answerCbQuery();
    // تعديل الرسالة الحالية بدل إرسال رسالة جديدة
    return ctx.editMessageText(texts.rulesText(), { parse_mode: 'Markdown', reply_markup: backBtn })
      .catch(() => ctx.reply(texts.rulesText(), { parse_mode: 'Markdown' }).catch(() => {}));
  }
  return ctx.reply(texts.rulesText(), { parse_mode: 'Markdown' }).catch(() => {});
}

// رجوع من صفحة القوانين إلى لوبي اللعبة
async function cmdBackLobby(ctx) {
  await ctx.answerCbQuery();
  const game = state.getGameByChat(ctx.chat.id);
  if (!game || game.status !== 'lobby') {
    return ctx.editMessageText('ℹ️ لا توجد غرفة انتظار نشطة حالياً.\nاكتب *لوب غارو* لإنشاء غرفة جديدة.', { parse_mode: 'Markdown' })
      .catch(() => {});
  }
  return ctx.editMessageText(texts.lobbyText(game), { parse_mode: 'Markdown', reply_markup: kb.lobbyKeyboard(game) })
    .catch(() => {});
}

async function cmdStats(ctx, isCb) {
  if (isCb) await ctx.answerCbQuery();
  const row = await wwdb.getStatsForUser(ctx.from.id);
  const rank = wwdb.getRank(row.wins);
  const ach = await wwdb.getUserAchievements(ctx.from.id);
  return ctx.reply(texts.statsText(row, rank, ach.length), { parse_mode: 'Markdown' }).catch(() => {});
}

async function cmdAchievements(ctx, isCb) {
  if (isCb) await ctx.answerCbQuery();
  const earned = await wwdb.getUserAchievements(ctx.from.id);
  return ctx.reply(texts.achievementsText(earned, CFG.ACHIEVEMENTS), { parse_mode: 'Markdown' }).catch(() => {});
}

async function cmdSeason(ctx, isCb) {
  if (isCb) await ctx.answerCbQuery();
  const season = wwdb.getSeasonKey();
  const board = await wwdb.getSeasonLeaderboard(season);
  return ctx.reply(texts.seasonText(season, board, wwdb.seasonLabel(season)), { parse_mode: 'Markdown' }).catch(() => {});
}

async function cmdMenu(ctx) {
  return ctx.reply('🐺 *قائمة لوب غارو*', { parse_mode: 'Markdown', reply_markup: kb.mainMenuKeyboard() }).catch(() => {});
}

module.exports = {
  init, createLobby, handleLobbyAction, handleMenuAction, handlePlayerLeft,
  cmdStatus, cmdLog, cmdRules, cmdStats, cmdAchievements, cmdSeason, cmdMenu, cmdBackLobby,
};
