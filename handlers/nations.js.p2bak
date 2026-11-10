'use strict';
/**
 * 🌍 handlers/nations.js — نظام الدول العالمي
 * ═══════════════════════════════════════════════
 * المراحل:
 *  1. إنشاء الدولة + تخصيص هويتها
 *  2. نظام المواطنين + الوظائف + الخبرة
 *  3. الحكومة + الوزراء + الصلاحيات
 *  4. الخزينة الوطنية + الضرائب
 *  5. المشاريع الوطنية
 *  6. الأراضي العالمية + التنافس
 *  7. الجيش + الحروب
 *  8. التكنولوجيا + الأبحاث
 *  9. التحالفات
 * 10. الشركات
 * 11. الانتخابات + رضا الشعب
 * 12. المواسم العالمية + الترتيب
 */

const { run, get, all } = require('../database/db');
const { cacheGet, cacheSet, cacheClear } = require('../utils/cache');
const logger = require('../utils/logger');

const OWNER_ID = parseInt(process.env.OWNER_ID || '0');

// ══════════════════════════════════════════════════════════
// 🗄️ Migration — إنشاء جميع الجداول
// ══════════════════════════════════════════════════════════
async function migrate() {
  const tables = [
    // الدول
    `CREATE TABLE IF NOT EXISTS nations (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      flag_file_id TEXT,
      emblem_file_id TEXT,
      description TEXT,
      capital TEXT,
      color TEXT DEFAULT '#3498db',
      president_id BIGINT,
      founded_at TIMESTAMP DEFAULT NOW(),
      -- اقتصاد
      treasury BIGINT DEFAULT 50000,
      gdp BIGINT DEFAULT 0,
      tax_rate INT DEFAULT 10,
      inflation FLOAT DEFAULT 2.0,
      unemployment FLOAT DEFAULT 5.0,
      -- عسكري
      military_power INT DEFAULT 0,
      -- شعبية
      approval FLOAT DEFAULT 70.0,
      -- حالة
      is_active BOOLEAN DEFAULT TRUE,
      season_wins INT DEFAULT 0,
      total_wars INT DEFAULT 0,
      war_wins INT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW()
    )`,

    // المواطنون
    `CREATE TABLE IF NOT EXISTS nation_citizens (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      username TEXT,
      first_name TEXT,
      level INT DEFAULT 1,
      xp INT DEFAULT 0,
      balance BIGINT DEFAULT 1000,
      job TEXT DEFAULT 'عاطل',
      job_last_work TIMESTAMP,
      island_name TEXT,
      island_level INT DEFAULT 1,
      is_minister BOOLEAN DEFAULT FALSE,
      minister_role TEXT,
      joined_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(chat_id, user_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_citizens ON nation_citizens(chat_id)`,

    // الحكومة - الوزراء
    `CREATE TABLE IF NOT EXISTS nation_ministers (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      role TEXT NOT NULL,
      appointed_by BIGINT,
      appointed_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(chat_id, role)
    )`,

    // المشاريع
    `CREATE TABLE IF NOT EXISTS nation_projects (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      project_type TEXT NOT NULL,
      level INT DEFAULT 1,
      built_at TIMESTAMP DEFAULT NOW(),
      last_income TIMESTAMP,
      UNIQUE(chat_id, project_type)
    )`,

    // الأراضي العالمية
    `CREATE TABLE IF NOT EXISTS world_lands (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      emoji TEXT,
      description TEXT,
      daily_income BIGINT DEFAULT 5000,
      owner_chat_id BIGINT,
      captured_at TIMESTAMP,
      capture_power INT DEFAULT 1000
    )`,

    // الجيش
    `CREATE TABLE IF NOT EXISTS nation_army (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT UNIQUE NOT NULL,
      police INT DEFAULT 0,
      infantry INT DEFAULT 0,
      snipers INT DEFAULT 0,
      tanks INT DEFAULT 0,
      air_force INT DEFAULT 0,
      navy INT DEFAULT 0,
      last_trained TIMESTAMP,
      last_maintained TIMESTAMP
    )`,

    // التكنولوجيا
    `CREATE TABLE IF NOT EXISTS nation_tech (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      tech_type TEXT NOT NULL,
      level INT DEFAULT 0,
      researched_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(chat_id, tech_type)
    )`,

    // التحالفات
    `CREATE TABLE IF NOT EXISTS nation_alliances (
      id SERIAL PRIMARY KEY,
      nation_a BIGINT NOT NULL,
      nation_b BIGINT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(nation_a, nation_b)
    )`,

    // الحروب
    `CREATE TABLE IF NOT EXISTS nation_wars (
      id SERIAL PRIMARY KEY,
      attacker_chat_id BIGINT NOT NULL,
      defender_chat_id BIGINT NOT NULL,
      status TEXT DEFAULT 'ongoing',
      attacker_power INT DEFAULT 0,
      defender_power INT DEFAULT 0,
      winner_chat_id BIGINT,
      loot BIGINT DEFAULT 0,
      started_at TIMESTAMP DEFAULT NOW(),
      ended_at TIMESTAMP
    )`,

    // الشركات
    `CREATE TABLE IF NOT EXISTS nation_companies (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      owner_id BIGINT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      level INT DEFAULT 1,
      balance BIGINT DEFAULT 0,
      employees INT DEFAULT 0,
      founded_at TIMESTAMP DEFAULT NOW()
    )`,

    // الانتخابات
    `CREATE TABLE IF NOT EXISTS nation_elections (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      candidate_id BIGINT NOT NULL,
      votes INT DEFAULT 0,
      election_date TIMESTAMP NOT NULL
    )`,

    // المواسم
    `CREATE TABLE IF NOT EXISTS nation_seasons (
      id SERIAL PRIMARY KEY,
      season_number INT NOT NULL,
      start_date TIMESTAMP NOT NULL,
      end_date TIMESTAMP NOT NULL,
      winner_chat_id BIGINT,
      category TEXT
    )`,

    // سجل الأحداث
    `CREATE TABLE IF NOT EXISTS nation_events (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      amount BIGINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_nation_events ON nation_events(chat_id, created_at DESC)`,
  ];

  for (const q of tables) {
    await run(q).catch(e => logger.debug('[Nations migrate]', e.message));
  }

  // إضافة الأراضي العالمية الافتراضية
  const lands = [
    ['⛰️ جبل الذهب', 'جبل ذهبي نادر يمنح دخلاً ضخماً', 15000, 5000],
    ['💎 منجم الألماس', 'منجم الألماس الوحيد في العالم', 12000, 4000],
    ['🌲 الغابة العظمى', 'غابة خشبية ضخمة للصناعة', 8000, 2500],
    ['🏝️ الجزيرة التجارية', 'موقع تجاري استراتيجي', 10000, 3000],
    ['⛽ حقل النفط', 'أكبر حقول النفط العالمية', 20000, 8000],
    ['⚛️ المفاعل النووي', 'مفاعل نووي للطاقة', 18000, 7000],
    ['🌊 الممر البحري', 'ممر بحري تجاري حيوي', 9000, 2800],
    ['🏔️ معقل الجليد', 'موارد نادرة تحت الجليد', 7000, 2000],
  ];
  for (const [name, desc, income, power] of lands) {
    await run(
      `INSERT INTO world_lands(name, description, daily_income, capture_power)
       VALUES($1,$2,$3,$4) ON CONFLICT(name) DO NOTHING`,
      [name, desc, income, power]
    ).catch(() => {});
  }

  logger.info('[Nations] ✅ Migration complete');
}

// ══════════════════════════════════════════════════════════
// 🔧 مساعدات
// ══════════════════════════════════════════════════════════
function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
function isGroup(ctx) { return ['group', 'supergroup'].includes(ctx.chat?.type); }
async function isAdmin(ctx) {
  try {
    const m = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return ['administrator', 'creator'].includes(m?.status);
  } catch { return false; }
}

async function getNation(chatId) {
  const k = 'nation_' + chatId;
  let n = cacheGet(k);
  if (!n) { n = await get('SELECT * FROM nations WHERE chat_id=$1', [chatId]).catch(() => null); if (n) cacheSet(k, n, 60000); }
  return n;
}

async function getCitizen(chatId, userId) {
  return get('SELECT * FROM nation_citizens WHERE chat_id=$1 AND user_id=$2', [chatId, userId]).catch(() => null);
}

async function ensureCitizen(ctx) {
  const { id, first_name, username } = ctx.from;
  const chatId = ctx.chat.id;
  await run(
    `INSERT INTO nation_citizens(chat_id, user_id, username, first_name)
     VALUES($1,$2,$3,$4) ON CONFLICT(chat_id, user_id) DO UPDATE SET first_name=$4, username=$3`,
    [chatId, id, username || null, first_name || 'مواطن']
  ).catch(() => {});
  return getCitizen(chatId, id);
}

function calcMilitaryPower(army) {
  if (!army) return 0;
  return (army.police || 0) * 1 +
         (army.infantry || 0) * 3 +
         (army.snipers || 0) * 5 +
         (army.tanks || 0) * 20 +
         (army.air_force || 0) * 50 +
         (army.navy || 0) * 80;
}

function xpForLevel(lvl) { return lvl * lvl * 100; }

async function addXP(chatId, userId, xp) {
  const c = await getCitizen(chatId, userId);
  if (!c) return;
  const newXp = (c.xp || 0) + xp;
  const newLevel = Math.floor(Math.sqrt(newXp / 100)) + 1;
  await run('UPDATE nation_citizens SET xp=$1, level=$2 WHERE chat_id=$3 AND user_id=$4',
    [newXp, newLevel, chatId, userId]).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 1. 🏛️ إنشاء الدولة
// ══════════════════════════════════════════════════════════
const SETUP_STATES = new Map(); // chatId -> { step, data }

async function cmdFoundNation(ctx) {
  if (!isGroup(ctx)) return ctx.reply('🌍 هذا الأمر للقروبات فقط').catch(() => {});
  if (!await isAdmin(ctx)) return ctx.reply('🚫 للمشرفين فقط').catch(() => {});

  const existing = await getNation(ctx.chat.id);
  if (existing) {
    return ctx.reply(
      `🏛️ قروبكم لديه دولة بالفعل: *${existing.name}*\n\nاستخدم /nation لعرض معلومات الدولة`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }

  SETUP_STATES.set(ctx.chat.id, { step: 'name', founder: ctx.from.id, data: {} });
  ctx.reply(
    '🌍 *مرحباً بك في نظام الدول العالمي!*\n━━━━━━━━━━━━━━━\n\n' +
    '🏛️ سنبدأ بإنشاء دولتك.\n\n' +
    '*الخطوة 1/5:* اكتب اسم دولتك:\n\n' +
    '_مثال: الجمهورية التقنية_',
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

async function handleSetupText(ctx) {
  if (!isGroup(ctx)) return false;
  const state = SETUP_STATES.get(ctx.chat.id);
  if (!state || state.founder !== ctx.from.id) return false;

  const txt = ctx.message.text?.trim();
  if (!txt || txt.startsWith('/')) return false;

  if (state.step === 'name') {
    if (txt.length < 2 || txt.length > 40) {
      return ctx.reply('⚠️ الاسم بين 2 و40 حرف').catch(() => {});
    }
    state.data.name = txt;
    state.step = 'capital';
    ctx.reply('🏙️ *الخطوة 2/5:* اكتب اسم العاصمة:', { parse_mode: 'Markdown' }).catch(() => {});
    return true;
  }

  if (state.step === 'capital') {
    state.data.capital = txt.substring(0, 30);
    state.step = 'description';
    ctx.reply('📝 *الخطوة 3/5:* اكتب وصف دولتك (اختياري — أرسل . للتخطي):', { parse_mode: 'Markdown' }).catch(() => {});
    return true;
  }

  if (state.step === 'description') {
    state.data.description = txt === '.' ? null : txt.substring(0, 200);
    state.step = 'flag';
    ctx.reply('🏳️ *الخطوة 4/5:* أرسل صورة علم دولتك (أو . للتخطي):', { parse_mode: 'Markdown' }).catch(() => {});
    return true;
  }

  if (state.step === 'flag' && txt === '.') {
    state.step = 'color';
    ctx.reply(
      '🎨 *الخطوة 5/5:* اختر لون دولتك:',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '🔵 أزرق', callback_data: 'nation_color_blue' }, { text: '🔴 أحمر', callback_data: 'nation_color_red' }],
        [{ text: '🟢 أخضر', callback_data: 'nation_color_green' }, { text: '🟡 ذهبي', callback_data: 'nation_color_gold' }],
        [{ text: '🟣 بنفسجي', callback_data: 'nation_color_purple' }, { text: '⚫ أسود', callback_data: 'nation_color_black' }],
      ]}}
    ).catch(() => {});
    return true;
  }

  return false;
}

async function handleSetupPhoto(ctx) {
  if (!isGroup(ctx)) return false;
  const state = SETUP_STATES.get(ctx.chat.id);
  if (!state || state.founder !== ctx.from.id) return false;
  if (state.step !== 'flag' && state.step !== 'emblem') return false;

  const photo = ctx.message.photo;
  if (!photo || !photo.length) return false;
  const fileId = photo[photo.length - 1].file_id;

  if (state.step === 'flag') {
    state.data.flag_file_id = fileId;
    state.step = 'emblem';
    ctx.reply('🛡️ *اختياري:* أرسل صورة شعار دولتك (أو . للتخطي):', { parse_mode: 'Markdown' }).catch(() => {});
    return true;
  }

  if (state.step === 'emblem') {
    state.data.emblem_file_id = fileId;
    state.step = 'color';
    ctx.reply(
      '🎨 *الخطوة 5/5:* اختر لون دولتك:',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '🔵 أزرق', callback_data: 'nation_color_blue' }, { text: '🔴 أحمر', callback_data: 'nation_color_red' }],
        [{ text: '🟢 أخضر', callback_data: 'nation_color_green' }, { text: '🟡 ذهبي', callback_data: 'nation_color_gold' }],
        [{ text: '🟣 بنفسجي', callback_data: 'nation_color_purple' }, { text: '⚫ أسود', callback_data: 'nation_color_black' }],
      ]}}
    ).catch(() => {});
    return true;
  }

  return false;
}

const COLORS = { blue: '#3498db', red: '#e74c3c', green: '#2ecc71', gold: '#f1c40f', purple: '#9b59b6', black: '#2c3e50' };

async function handleColorCallback(ctx, colorKey) {
  const state = SETUP_STATES.get(ctx.chat.id);
  if (!state || state.step !== 'color') return ctx.answerCbQuery().catch(() => {});
  if (state.founder !== ctx.from.id) return ctx.answerCbQuery('🚫 مش أنت المؤسس').catch(() => {});

  state.data.color = COLORS[colorKey] || '#3498db';
  SETUP_STATES.delete(ctx.chat.id);

  // إنشاء الدولة
  await run(
    `INSERT INTO nations(chat_id, name, capital, description, flag_file_id, emblem_file_id, color, president_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.chat.id, state.data.name, state.data.capital, state.data.description,
     state.data.flag_file_id || null, state.data.emblem_file_id || null,
     state.data.color, ctx.from.id]
  ).catch(() => {});

  // تسجيل المؤسس كمواطن ورئيس
  await run(
    `INSERT INTO nation_citizens(chat_id, user_id, username, first_name, level, xp, balance)
     VALUES($1,$2,$3,$4,5,2500,10000) ON CONFLICT(chat_id, user_id) DO UPDATE SET level=5, balance=10000`,
    [ctx.chat.id, ctx.from.id, ctx.from.username || null, ctx.from.first_name]
  ).catch(() => {});

  // إنشاء الجيش
  await run(`INSERT INTO nation_army(chat_id) VALUES($1) ON CONFLICT DO NOTHING`, [ctx.chat.id]).catch(() => {});

  ctx.answerCbQuery('✅ تم إنشاء الدولة!').catch(() => {});

  const welcomeText =
    `🎉 *تم تأسيس دولة جديدة!*\n━━━━━━━━━━━━━━━\n\n` +
    `🏛️ *${state.data.name}*\n` +
    `🏙️ العاصمة: ${state.data.capital}\n` +
    `👑 الرئيس: [${ctx.from.first_name}](tg://user?id=${ctx.from.id})\n` +
    (state.data.description ? `📝 ${state.data.description}\n` : '') +
    `\n💰 الخزينة الابتدائية: 50,000\n` +
    `👥 المواطنون: اكتب *مواطن* للانضمام!\n\n` +
    `🌍 انضم للعالم بـ /nation`;

  if (state.data.flag_file_id) {
    ctx.editMessageMedia?.({ type: 'photo', media: state.data.flag_file_id, caption: welcomeText, parse_mode: 'Markdown' }).catch(() => {});
    ctx.reply(welcomeText, { parse_mode: 'Markdown' }).catch(() => {});
  } else {
    ctx.editMessageText(welcomeText, { parse_mode: 'Markdown' }).catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════
// 2. 👁 عرض الدولة /nation
// ══════════════════════════════════════════════════════════
async function cmdNation(ctx) {
  if (!isGroup(ctx)) return;
  const n = await getNation(ctx.chat.id);
  if (!n) return ctx.reply('🌍 لا توجد دولة بعد!\n\nاستخدم /found_nation لتأسيس دولتك', { parse_mode: 'Markdown' }).catch(() => {});

  const citizensCount = await get('SELECT COUNT(*) as cnt FROM nation_citizens WHERE chat_id=$1', [ctx.chat.id]).catch(() => ({ cnt: 0 }));
  const army = await get('SELECT * FROM nation_army WHERE chat_id=$1', [ctx.chat.id]).catch(() => null);
  const projects = await all('SELECT project_type, level FROM nation_projects WHERE chat_id=$1', [ctx.chat.id]).catch(() => []);
  const lands = await all('SELECT name FROM world_lands WHERE owner_chat_id=$1', [ctx.chat.id]).catch(() => []);
  const president = n.president_id ? `[${n.president_id}](tg://user?id=${n.president_id})` : 'شاغر';

  const power = calcMilitaryPower(army);
  const approvalBar = '█'.repeat(Math.floor((n.approval || 0) / 10)) + '░'.repeat(10 - Math.floor((n.approval || 0) / 10));

  let text =
    `🏛️ *${n.name}*\n━━━━━━━━━━━━━━━\n\n` +
    `🏙️ العاصمة: *${n.capital || 'غير محددة'}*\n` +
    `👑 الرئيس: ${president}\n` +
    `👥 المواطنون: *${citizensCount.cnt}*\n\n` +
    `💰 الخزينة: *${fmt(n.treasury)} DA*\n` +
    `📈 الناتج المحلي: *${fmt(n.gdp)} DA*\n` +
    `💸 معدل الضريبة: *${n.tax_rate}%*\n\n` +
    `⚔️ القوة العسكرية: *${fmt(power)}*\n` +
    `🏗️ المشاريع: *${projects.length}*\n` +
    `🌍 الأراضي: *${lands.length}*\n\n` +
    `😊 رضا الشعب:\n\`${approvalBar}\` ${Math.round(n.approval || 0)}%\n\n` +
    (n.description ? `📝 _${n.description}_\n\n` : '') +
    `🏆 انتصارات: ${n.war_wins || 0}/${n.total_wars || 0} حرب`;

  const kb = [
    [{ text: '👥 المواطنون', callback_data: 'nat_citizens' }, { text: '🏛️ الحكومة', callback_data: 'nat_gov' }],
    [{ text: '💰 الخزينة', callback_data: 'nat_treasury' }, { text: '🏗️ المشاريع', callback_data: 'nat_projects' }],
    [{ text: '⚔️ الجيش', callback_data: 'nat_army' }, { text: '🔬 التكنولوجيا', callback_data: 'nat_tech' }],
    [{ text: '🌍 الأراضي', callback_data: 'nat_lands' }, { text: '🤝 التحالفات', callback_data: 'nat_alliances' }],
    [{ text: '📊 الترتيب العالمي', callback_data: 'nat_ranking' }],
  ];

  if (n.flag_file_id) {
    ctx.replyWithPhoto(n.flag_file_id, { caption: text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(() => {});
  } else {
    ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════
// 3. 👥 الانضمام كمواطن
// ══════════════════════════════════════════════════════════
async function cmdJoinNation(ctx) {
  if (!isGroup(ctx)) return;
  const n = await getNation(ctx.chat.id);
  if (!n) return ctx.reply('🌍 لا توجد دولة في هذا القروب').catch(() => {});

  const existing = await getCitizen(ctx.chat.id, ctx.from.id);
  if (existing) return ctx.reply(`✅ أنت مواطن بالفعل في *${n.name}*!`, { parse_mode: 'Markdown' }).catch(() => {});

  await run(
    `INSERT INTO nation_citizens(chat_id, user_id, username, first_name)
     VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [ctx.chat.id, ctx.from.id, ctx.from.username || null, ctx.from.first_name]
  ).catch(() => {});

  ctx.reply(
    `🎉 مرحباً *${ctx.from.first_name}* في *${n.name}*!\n\n` +
    `💰 رصيدك الابتدائي: 1,000 DA\n` +
    `📊 مستواك: 1\n` +
    `💼 وظيفتك: عاطل\n\n` +
    `_اكتب /me لعرض ملفك الشخصي_`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 4. 👤 الملف الشخصي /me
// ══════════════════════════════════════════════════════════
async function cmdMe(ctx) {
  if (!isGroup(ctx)) return;
  const citizen = await ensureCitizen(ctx);
  const n = await getNation(ctx.chat.id);

  const xpNeeded = xpForLevel(citizen.level);
  const xpBar = '█'.repeat(Math.min(10, Math.floor((citizen.xp % xpNeeded) / xpNeeded * 10))) + '░'.repeat(Math.max(0, 10 - Math.floor((citizen.xp % xpNeeded) / xpNeeded * 10)));

  const company = await get('SELECT name, type FROM nation_companies WHERE chat_id=$1 AND owner_id=$2', [ctx.chat.id, ctx.from.id]).catch(() => null);

  const text =
    `👤 *${citizen.first_name}*\n━━━━━━━━━━━━━━━\n\n` +
    `🏛️ الدولة: *${n?.name || 'بدون دولة'}*\n` +
    `📊 المستوى: *${citizen.level}*\n` +
    `⭐ XP: \`${xpBar}\` ${citizen.xp}/${xpNeeded}\n\n` +
    `💰 الرصيد: *${fmt(citizen.balance)} DA*\n` +
    `💼 الوظيفة: *${citizen.job || 'عاطل'}*\n` +
    (company ? `🏭 الشركة: *${company.name}* (${company.type})\n` : '') +
    `🏝️ الجزيرة: *${citizen.island_name || 'بدون اسم'}* (مستوى ${citizen.island_level})\n` +
    (citizen.minister_role ? `\n👑 *وزير ${citizen.minister_role}*\n` : '');

  ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
    [{ text: '💼 العمل', callback_data: 'nat_work' }, { text: '🏝️ جزيرتي', callback_data: 'nat_island' }],
    [{ text: '📈 استثمار', callback_data: 'nat_invest' }, { text: '🏭 شركتي', callback_data: 'nat_company' }],
  ]}}).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 5. 💼 العمل
// ══════════════════════════════════════════════════════════
const JOBS = {
  'مزارع': { income: 200, xp: 10, cooldown: 3600 },
  'عمال بناء': { income: 350, xp: 15, cooldown: 3600 },
  'تاجر': { income: 500, xp: 20, cooldown: 7200 },
  'مهندس': { income: 800, xp: 30, cooldown: 7200 },
  'طبيب': { income: 1200, xp: 40, cooldown: 14400 },
  'وزير': { income: 2000, xp: 60, cooldown: 14400 },
};

async function cmdWork(ctx) {
  if (!isGroup(ctx)) return;
  const n = await getNation(ctx.chat.id);
  if (!n) return;

  const citizen = await ensureCitizen(ctx);
  const job = citizen.job || 'مزارع';
  const jobData = JOBS[job] || JOBS['مزارع'];

  if (citizen.job_last_work) {
    const diff = Date.now() - new Date(citizen.job_last_work).getTime();
    if (diff < jobData.cooldown * 1000) {
      const remaining = Math.ceil((jobData.cooldown * 1000 - diff) / 60000);
      return ctx.reply(`⏳ يمكنك العمل مرة أخرى بعد *${remaining}* دقيقة`, { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }).catch(() => {});
    }
  }

  // حساب الضريبة
  const tax = Math.floor(jobData.income * (n.tax_rate || 10) / 100);
  const netIncome = jobData.income - tax;

  await run('UPDATE nation_citizens SET balance=balance+$1, job_last_work=NOW() WHERE chat_id=$2 AND user_id=$3',
    [netIncome, ctx.chat.id, ctx.from.id]).catch(() => {});
  await run('UPDATE nations SET treasury=treasury+$1, gdp=gdp+$2 WHERE chat_id=$3',
    [tax, jobData.income, ctx.chat.id]).catch(() => {});
  await addXP(ctx.chat.id, ctx.from.id, jobData.xp);

  ctx.reply(
    `💼 *عملت كـ ${job}!*\n\n` +
    `💰 أجرك: +${fmt(netIncome)} DA\n` +
    `🏛️ ضريبة للدولة: ${fmt(tax)} DA (${n.tax_rate}%)\n` +
    `⭐ XP: +${jobData.xp}`,
    { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
  ).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 6. 🏗️ المشاريع الوطنية
// ══════════════════════════════════════════════════════════
const PROJECTS = {
  'bank': { name: '🏦 البنك المركزي', cost: 50000, income: 2000, effect: 'يرفع الحد الأقصى للقروض' },
  'university': { name: '🏫 الجامعة الوطنية', cost: 40000, income: 1000, effect: 'يضاعف XP المكتسب' },
  'hospital': { name: '🏥 المستشفى المركزي', cost: 35000, income: 500, effect: 'يرفع رضا الشعب' },
  'factory': { name: '🏭 المجمع الصناعي', cost: 60000, income: 3000, effect: 'يزيد دخل العمال' },
  'power_plant': { name: '⚡ محطة الطاقة', cost: 45000, income: 1500, effect: 'يدعم جميع المشاريع' },
  'port': { name: '🚢 الميناء التجاري', cost: 70000, income: 4000, effect: 'يفتح التجارة الدولية' },
  'airport': { name: '✈️ المطار الدولي', cost: 80000, income: 5000, effect: 'يجلب الاستثمارات' },
  'military_base': { name: '🪖 قاعدة عسكرية', cost: 55000, income: 0, effect: 'يضاعف قوة الجيش' },
};

async function cmdProjects(ctx) {
  if (!isGroup(ctx)) return;
  const n = await getNation(ctx.chat.id);
  if (!n) return;

  const built = await all('SELECT project_type, level FROM nation_projects WHERE chat_id=$1', [ctx.chat.id]).catch(() => []);
  const builtMap = {};
  built.forEach(p => builtMap[p.project_type] = p.level);

  let text = '🏗️ *المشاريع الوطنية*\n━━━━━━━━━━━━━━━\n\n';
  text += `💰 الخزينة: *${fmt(n.treasury)} DA*\n\n`;

  const rows = [];
  for (const [key, p] of Object.entries(PROJECTS)) {
    const lvl = builtMap[key] || 0;
    const cost = p.cost * (lvl + 1);
    const status = lvl > 0 ? `✅ مستوى ${lvl}` : '🔴 غير مبني';
    text += `${p.name}\n${status} | التكلفة: ${fmt(cost)} DA\n_${p.effect}_\n\n`;
    rows.push([{ text: (lvl > 0 ? `⬆️ ترقية ` : `🔨 بناء `) + p.name, callback_data: `nat_build_${key}` }]);
  }

  ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }).catch(() => {});
}

async function handleBuildProject(ctx, projectKey) {
  if (!await isAdmin(ctx)) return ctx.answerCbQuery('🚫 للمشرفين فقط').catch(() => {});
  const n = await getNation(ctx.chat.id);
  if (!n) return ctx.answerCbQuery('🌍 لا توجد دولة').catch(() => {});

  const p = PROJECTS[projectKey];
  if (!p) return ctx.answerCbQuery('❌ مشروع غير موجود').catch(() => {});

  const existing = await get('SELECT level FROM nation_projects WHERE chat_id=$1 AND project_type=$2', [ctx.chat.id, projectKey]).catch(() => null);
  const lvl = existing?.level || 0;
  const cost = p.cost * (lvl + 1);

  if (n.treasury < cost) {
    return ctx.answerCbQuery(`❌ الخزينة غير كافية! تحتاج ${fmt(cost)} DA`, { show_alert: true }).catch(() => {});
  }

  await run('UPDATE nations SET treasury=treasury-$1 WHERE chat_id=$2', [cost, ctx.chat.id]).catch(() => {});
  await run(
    `INSERT INTO nation_projects(chat_id, project_type, level) VALUES($1,$2,1)
     ON CONFLICT(chat_id, project_type) DO UPDATE SET level=nation_projects.level+1`,
    [ctx.chat.id, projectKey]
  ).catch(() => {});
  await run(`INSERT INTO nation_events(chat_id, type, description, amount) VALUES($1,'project','بناء ${p.name}',$2)`, [ctx.chat.id, cost]).catch(() => {});
  cacheClear('nation_' + ctx.chat.id);

  ctx.answerCbQuery(`✅ تم ${lvl > 0 ? 'ترقية' : 'بناء'} ${p.name}!`).catch(() => {});
  ctx.reply(`🏗️ *${p.name}* ${lvl > 0 ? `رُقِّي للمستوى ${lvl + 1}` : 'بُني بنجاح'}!\n💰 التكلفة: ${fmt(cost)} DA`, { parse_mode: 'Markdown' }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 7. ⚔️ الجيش
// ══════════════════════════════════════════════════════════
const UNITS = {
  police: { name: '👮 شرطة', cost: 100, power: 1 },
  infantry: { name: '🪖 مشاة', cost: 300, power: 3 },
  snipers: { name: '🏹 قناصة', cost: 500, power: 5 },
  tanks: { name: '🚜 دبابات', cost: 2000, power: 20 },
  air_force: { name: '✈️ سلاح جو', cost: 5000, power: 50 },
  navy: { name: '🚢 بحرية', cost: 8000, power: 80 },
};

async function cmdArmy(ctx) {
  if (!isGroup(ctx)) return;
  const n = await getNation(ctx.chat.id);
  if (!n) return;

  const army = await get('SELECT * FROM nation_army WHERE chat_id=$1', [ctx.chat.id]).catch(() => null);
  const power = calcMilitaryPower(army);

  let text = `⚔️ *جيش ${n.name}*\n━━━━━━━━━━━━━━━\n\n`;
  text += `💪 القوة الإجمالية: *${fmt(power)}*\n\n`;

  const rows = [];
  for (const [key, u] of Object.entries(UNITS)) {
    const count = army?.[key] || 0;
    text += `${u.name}: *${fmt(count)}* وحدة\n`;
    rows.push([{ text: `➕ تجنيد ${u.name} (${fmt(u.cost)} DA)`, callback_data: `nat_recruit_${key}` }]);
  }
  text += `\n💰 الخزينة: *${fmt(n.treasury)} DA*`;

  ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }).catch(() => {});
}

async function handleRecruit(ctx, unit, amount = 10) {
  if (!await isAdmin(ctx)) return ctx.answerCbQuery('🚫 للمشرفين فقط').catch(() => {});
  const n = await getNation(ctx.chat.id);
  if (!n) return ctx.answerCbQuery('🌍 لا توجد دولة').catch(() => {});

  const u = UNITS[unit];
  if (!u) return ctx.answerCbQuery('❌ وحدة غير موجودة').catch(() => {});

  const totalCost = u.cost * amount;
  if (n.treasury < totalCost) {
    return ctx.answerCbQuery(`❌ تحتاج ${fmt(totalCost)} DA`, { show_alert: true }).catch(() => {});
  }

  await run('UPDATE nations SET treasury=treasury-$1 WHERE chat_id=$2', [totalCost, ctx.chat.id]).catch(() => {});
  await run(`UPDATE nation_army SET ${unit}=${unit}+$1, last_trained=NOW() WHERE chat_id=$2`, [amount, ctx.chat.id]).catch(() => {});

  const army = await get('SELECT * FROM nation_army WHERE chat_id=$1', [ctx.chat.id]).catch(() => null);
  const newPower = calcMilitaryPower(army);
  await run('UPDATE nations SET military_power=$1 WHERE chat_id=$2', [newPower, ctx.chat.id]).catch(() => {});
  cacheClear('nation_' + ctx.chat.id);

  ctx.answerCbQuery(`✅ تم تجنيد ${amount} ${u.name}`).catch(() => {});
  ctx.reply(`🪖 تم تجنيد *${amount}* ${u.name}\n💰 التكلفة: ${fmt(totalCost)} DA\n💪 القوة الجديدة: ${fmt(newPower)}`, { parse_mode: 'Markdown' }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 8. ⚔️ إعلان الحرب
// ══════════════════════════════════════════════════════════
async function cmdDeclareWar(ctx) {
  if (!isGroup(ctx)) return;
  if (!await isAdmin(ctx)) return ctx.reply('🚫 للمشرفين فقط').catch(() => {});

  const n = await getNation(ctx.chat.id);
  if (!n) return ctx.reply('🌍 لا توجد دولة').catch(() => {});

  // البحث عن دول أخرى
  const others = await all(
    'SELECT chat_id, name, military_power, treasury FROM nations WHERE chat_id!=$1 AND is_active=TRUE ORDER BY military_power DESC LIMIT 10',
    [ctx.chat.id]
  ).catch(() => []);

  if (!others.length) return ctx.reply('🌍 لا توجد دول أخرى للحرب').catch(() => {});

  let text = '⚔️ *إعلان حرب*\n━━━━━━━━━━━━━━━\n\n';
  text += `💪 قوتك العسكرية: *${fmt(n.military_power)}*\n\n`;
  text += '_اختر الدولة التي تريد مهاجمتها:_\n\n';

  const rows = others.map(o => [{
    text: `⚔️ ${o.name} (قوة: ${fmt(o.military_power)})`,
    callback_data: `nat_attack_${o.chat_id}`
  }]);

  ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }).catch(() => {});
}

async function handleAttack(ctx, targetChatId) {
  if (!await isAdmin(ctx)) return ctx.answerCbQuery('🚫 للمشرفين فقط').catch(() => {});

  const attacker = await getNation(ctx.chat.id);
  const defender = await getNation(targetChatId);
  if (!attacker || !defender) return ctx.answerCbQuery('❌ دولة غير موجودة').catch(() => {});

  // التحقق من عدم وجود حرب نشطة
  const activeWar = await get(
    'SELECT id FROM nation_wars WHERE (attacker_chat_id=$1 OR defender_chat_id=$1) AND status=\'ongoing\'',
    [ctx.chat.id]
  ).catch(() => null);
  if (activeWar) return ctx.answerCbQuery('⚔️ أنت في حرب بالفعل!', { show_alert: true }).catch(() => {});

  // حساب نتيجة الحرب
  const attackPower = attacker.military_power + Math.floor(Math.random() * 1000);
  const defendPower = defender.military_power + Math.floor(Math.random() * 1000);
  const attackerWins = attackPower > defendPower;

  const loot = attackerWins ? Math.floor(defender.treasury * 0.2) : 0;
  const winnerChatId = attackerWins ? ctx.chat.id : targetChatId;

  // تسجيل الحرب
  await run(
    `INSERT INTO nation_wars(attacker_chat_id, defender_chat_id, status, attacker_power, defender_power, winner_chat_id, loot, ended_at)
     VALUES($1,$2,'ended',$3,$4,$5,$6,NOW())`,
    [ctx.chat.id, targetChatId, attackPower, defendPower, winnerChatId, loot]
  ).catch(() => {});

  // تطبيق النتائج
  if (attackerWins) {
    await run('UPDATE nations SET treasury=treasury+$1, war_wins=war_wins+1, total_wars=total_wars+1 WHERE chat_id=$2', [loot, ctx.chat.id]).catch(() => {});
    await run('UPDATE nations SET treasury=treasury-$1, total_wars=total_wars+1, approval=GREATEST(approval-10,0) WHERE chat_id=$2', [loot, targetChatId]).catch(() => {});
  } else {
    await run('UPDATE nations SET total_wars=total_wars+1, approval=GREATEST(approval-15,0) WHERE chat_id=$1', [ctx.chat.id]).catch(() => {});
    await run('UPDATE nations SET war_wins=war_wins+1, total_wars=total_wars+1 WHERE chat_id=$2', [targetChatId]).catch(() => {});
  }

  cacheClear('nation_' + ctx.chat.id);
  cacheClear('nation_' + targetChatId);
  ctx.answerCbQuery('⚔️ الحرب انتهت!').catch(() => {});

  const result =
    `⚔️ *نتيجة الحرب!*\n━━━━━━━━━━━━━━━\n\n` +
    `🗡️ *${attacker.name}* vs 🛡️ *${defender.name}*\n\n` +
    `💪 قوة الهجوم: ${fmt(attackPower)}\n` +
    `🛡️ قوة الدفاع: ${fmt(defendPower)}\n\n` +
    (attackerWins
      ? `🏆 *${attacker.name}* فازت!\n💰 غنيمة: ${fmt(loot)} DA`
      : `🏆 *${defender.name}* دافعت بنجاح!\n🛡️ صمدت أمام الهجوم`);

  ctx.reply(result, { parse_mode: 'Markdown' }).catch(() => {});

  // إشعار القروب المدافع
  ctx.telegram.sendMessage(targetChatId,
    `⚠️ *تعرضت دولتكم للهجوم!*\n\n` +
    `🗡️ المهاجم: *${attacker.name}*\n` +
    (attackerWins ? `❌ خسرتم ${fmt(loot)} DA من الخزينة` : `✅ نجحتم في الدفاع!`),
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 9. 🌍 الأراضي العالمية
// ══════════════════════════════════════════════════════════
async function cmdLands(ctx) {
  if (!isGroup(ctx)) return;
  const lands = await all('SELECT *, (SELECT name FROM nations WHERE chat_id=world_lands.owner_chat_id) as owner_name FROM world_lands ORDER BY daily_income DESC').catch(() => []);

  let text = '🌍 *الأراضي العالمية*\n━━━━━━━━━━━━━━━\n\n';
  const rows = [];
  for (const l of lands) {
    const owner = l.owner_name ? `🏴 ${l.owner_name}` : '🟢 متاحة';
    text += `${l.name}\n${owner} | دخل: ${fmt(l.daily_income)} DA/يوم\n\n`;
    if (!l.owner_chat_id || l.owner_chat_id === ctx.chat.id) {
      rows.push([{ text: `🏴 الاستيلاء على ${l.name}`, callback_data: `nat_capture_${l.id}` }]);
    }
  }

  ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }).catch(() => {});
}

async function handleCapture(ctx, landId) {
  if (!await isAdmin(ctx)) return ctx.answerCbQuery('🚫 للمشرفين فقط').catch(() => {});
  const n = await getNation(ctx.chat.id);
  if (!n) return ctx.answerCbQuery('🌍 لا توجد دولة').catch(() => {});

  const land = await get('SELECT * FROM world_lands WHERE id=$1', [landId]).catch(() => null);
  if (!land) return ctx.answerCbQuery('❌ أرض غير موجودة').catch(() => {});

  if (n.military_power < land.capture_power) {
    return ctx.answerCbQuery(`❌ تحتاج قوة ${fmt(land.capture_power)} للاستيلاء! قوتك: ${fmt(n.military_power)}`, { show_alert: true }).catch(() => {});
  }

  if (land.owner_chat_id && land.owner_chat_id !== ctx.chat.id) {
    // معركة للاستيلاء
    const ownerNation = await getNation(land.owner_chat_id);
    const attackPow = n.military_power + Math.floor(Math.random() * 500);
    const defendPow = (ownerNation?.military_power || 0) + Math.floor(Math.random() * 500);
    if (attackPow <= defendPow) {
      return ctx.answerCbQuery(`❌ فشل الاستيلاء! القوة غير كافية`, { show_alert: true }).catch(() => {});
    }
  }

  await run('UPDATE world_lands SET owner_chat_id=$1, captured_at=NOW() WHERE id=$2', [ctx.chat.id, landId]).catch(() => {});
  ctx.answerCbQuery(`✅ تم الاستيلاء على ${land.name}!`).catch(() => {});
  ctx.reply(`🏴 *${n.name}* استولت على *${land.name}*!\n💰 دخل يومي: +${fmt(land.daily_income)} DA`, { parse_mode: 'Markdown' }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 10. 📊 الترتيب العالمي
// ══════════════════════════════════════════════════════════
async function cmdRanking(ctx) {
  const nations = await all(
    `SELECT n.name, n.treasury, n.military_power, n.war_wins,
     (SELECT COUNT(*) FROM nation_citizens WHERE chat_id=n.chat_id) as citizens,
     (SELECT COUNT(*) FROM world_lands WHERE owner_chat_id=n.chat_id) as lands
     FROM nations n WHERE n.is_active=TRUE
     ORDER BY n.treasury + n.military_power*100 DESC LIMIT 10`,
    []
  ).catch(() => []);

  if (!nations.length) return ctx.reply('🌍 لا توجد دول بعد').catch(() => {});

  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  let text = '🏆 *الترتيب العالمي*\n━━━━━━━━━━━━━━━\n\n';
  nations.forEach((n, i) => {
    text += `${medals[i]} *${n.name}*\n`;
    text += `   💰 ${fmt(n.treasury)} | ⚔️ ${fmt(n.military_power)} | 👥 ${n.citizens} | 🌍 ${n.lands} أراضٍ\n\n`;
  });

  ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 11. 💰 تبرع للخزينة
// ══════════════════════════════════════════════════════════
async function cmdDonate(ctx) {
  if (!isGroup(ctx)) return;
  const n = await getNation(ctx.chat.id);
  if (!n) return;

  const args = ctx.message.text.split(' ').slice(1);
  const amount = parseInt(args[0]);
  if (!amount || amount < 100) return ctx.reply('⚠️ الصيغة: /donate [مبلغ]\nالحد الأدنى: 100 DA').catch(() => {});

  const citizen = await ensureCitizen(ctx);
  if (citizen.balance < amount) return ctx.reply('❌ رصيدك غير كافٍ').catch(() => {});

  await run('UPDATE nation_citizens SET balance=balance-$1 WHERE chat_id=$2 AND user_id=$3', [amount, ctx.chat.id, ctx.from.id]).catch(() => {});
  await run('UPDATE nations SET treasury=treasury+$1 WHERE chat_id=$2', [amount, ctx.chat.id]).catch(() => {});
  await addXP(ctx.chat.id, ctx.from.id, Math.floor(amount / 100));

  ctx.reply(`🎁 *${ctx.from.first_name}* تبرع بـ *${fmt(amount)} DA* للخزينة!\n🏛️ إجمالي الخزينة: ${fmt(n.treasury + amount)} DA`, { parse_mode: 'Markdown' }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 12. 🗳️ الانتخابات
// ══════════════════════════════════════════════════════════
async function cmdElection(ctx) {
  if (!isGroup(ctx)) return;
  if (!await isAdmin(ctx)) return ctx.reply('🚫 للمشرفين فقط').catch(() => {});

  const n = await getNation(ctx.chat.id);
  if (!n) return;

  // بدء انتخابات لمدة 24 ساعة
  const endDate = new Date(Date.now() + 86400000);
  await run('DELETE FROM nation_elections WHERE chat_id=$1', [ctx.chat.id]).catch(() => {});

  ctx.reply(
    `🗳️ *بدأت الانتخابات في ${n.name}!*\n━━━━━━━━━━━━━━━\n\n` +
    `📅 تنتهي في: ${endDate.toLocaleString('ar-DZ')}\n\n` +
    `للترشح: /candidate\n` +
    `للتصويت: /vote @مرشح`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 13. ⚙️ إعدادات الضريبة (وزير المالية أو الرئيس)
// ══════════════════════════════════════════════════════════
async function cmdSetTax(ctx) {
  if (!isGroup(ctx)) return;
  if (!await isAdmin(ctx)) return ctx.reply('🚫 للمشرفين فقط').catch(() => {});

  const args = ctx.message.text.split(' ').slice(1);
  const rate = parseInt(args[0]);
  if (isNaN(rate) || rate < 0 || rate > 50) return ctx.reply('⚠️ نسبة الضريبة بين 0% و50%\nمثال: /tax 15').catch(() => {});

  await run('UPDATE nations SET tax_rate=$1 WHERE chat_id=$2', [rate, ctx.chat.id]).catch(() => {});
  cacheClear('nation_' + ctx.chat.id);

  // تأثير على رضا الشعب
  const effect = rate > 20 ? -5 : rate < 10 ? 5 : 0;
  if (effect !== 0) await run('UPDATE nations SET approval=LEAST(GREATEST(approval+$1,0),100) WHERE chat_id=$2', [effect, ctx.chat.id]).catch(() => {});

  ctx.reply(`💸 تم تعديل معدل الضريبة إلى *${rate}%*${effect !== 0 ? `\n${effect > 0 ? '😊 ارتفع' : '😠 انخفض'} رضا الشعب` : ''}`, { parse_mode: 'Markdown' }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// Daily income من الأراضي والمشاريع (يشغّل كل يوم)
// ══════════════════════════════════════════════════════════
async function runDailyIncome(bot) {
  try {
    // دخل الأراضي
    const lands = await all('SELECT * FROM world_lands WHERE owner_chat_id IS NOT NULL').catch(() => []);
    for (const land of lands) {
      await run('UPDATE nations SET treasury=treasury+$1 WHERE chat_id=$2', [land.daily_income, land.owner_chat_id]).catch(() => {});
      await run(`INSERT INTO nation_events(chat_id, type, description, amount) VALUES($1,'land_income','دخل ${land.name}',$2)`, [land.owner_chat_id, land.daily_income]).catch(() => {});
    }

    // دخل المشاريع
    const projects = await all('SELECT np.*, n.chat_id FROM nation_projects np JOIN nations n ON np.chat_id=n.chat_id').catch(() => []);
    for (const p of projects) {
      const proj = PROJECTS[p.project_type];
      if (!proj || !proj.income) continue;
      const income = proj.income * p.level;
      await run('UPDATE nations SET treasury=treasury+$1 WHERE chat_id=$2', [income, p.chat_id]).catch(() => {});
    }

    // تحديث approval بناءً على الاقتصاد
    await run(`UPDATE nations SET approval = LEAST(GREATEST(
      approval + CASE WHEN treasury > 100000 THEN 1 ELSE -2 END,
      0), 100)`).catch(() => {});

    logger.info('[Nations] Daily income processed');
  } catch(e) {
    logger.error('[Nations] Daily income error:', e.message);
  }
}

// ══════════════════════════════════════════════════════════
// Callbacks handler
// ══════════════════════════════════════════════════════════
async function handleCallback(ctx, data) {
  if (!data.startsWith('nat_') && !data.startsWith('nation_')) return false;
  ctx.answerCbQuery('').catch(() => {});

  if (data.startsWith('nation_color_')) return handleColorCallback(ctx, data.replace('nation_color_', ''));
  if (data === 'nat_citizens') return showCitizens(ctx);
  if (data === 'nat_gov') return showGovernment(ctx);
  if (data === 'nat_treasury') return showTreasury(ctx);
  if (data === 'nat_projects') return cmdProjects(ctx);
  if (data === 'nat_army') return cmdArmy(ctx);
  if (data === 'nat_lands') return cmdLands(ctx);
  if (data === 'nat_ranking') return cmdRanking(ctx);
  if (data === 'nat_work') return cmdWork(ctx);
  if (data.startsWith('nat_build_')) return handleBuildProject(ctx, data.replace('nat_build_', ''));
  if (data.startsWith('nat_recruit_')) return handleRecruit(ctx, data.replace('nat_recruit_', ''));
  if (data.startsWith('nat_attack_')) return handleAttack(ctx, data.replace('nat_attack_', ''));
  if (data.startsWith('nat_capture_')) return handleCapture(ctx, data.replace('nat_capture_', ''));

  return true;
}

async function showCitizens(ctx) {
  const citizens = await all(
    'SELECT * FROM nation_citizens WHERE chat_id=$1 ORDER BY level DESC, xp DESC LIMIT 15',
    [ctx.chat.id]
  ).catch(() => []);

  if (!citizens.length) return ctx.reply('👥 لا يوجد مواطنون بعد').catch(() => {});

  const medals = ['🥇', '🥈', '🥉'];
  let text = '👥 *المواطنون*\n━━━━━━━━━━━━━━━\n\n';
  citizens.forEach((c, i) => {
    const badge = medals[i] || `${i + 1}.`;
    text += `${badge} [${c.first_name}](tg://user?id=${c.user_id}) — مستوى ${c.level} | ${fmt(c.balance)} DA\n`;
  });

  ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => {});
}

async function showGovernment(ctx) {
  const n = await getNation(ctx.chat.id);
  if (!n) return;

  const ministers = await all('SELECT * FROM nation_ministers WHERE chat_id=$1', [ctx.chat.id]).catch(() => []);
  const roles = {
    'المالية': '💰', 'الدفاع': '⚔️', 'التنمية': '🏗️',
    'الإعلام': '📢', 'العدل': '⚖️', 'الاستخبارات': '🕵️'
  };

  let text = `🏛️ *حكومة ${n.name}*\n━━━━━━━━━━━━━━━\n\n`;
  text += `👑 الرئيس: [${n.president_id}](tg://user?id=${n.president_id})\n\n`;
  text += `*الوزراء:*\n`;

  for (const [role, emoji] of Object.entries(roles)) {
    const m = ministers.find(x => x.role === role);
    text += `${emoji} وزير ${role}: ${m ? `[مُعيَّن](tg://user?id=${m.user_id})` : '_شاغر_'}\n`;
  }

  ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
    [{ text: '👑 تعيين وزير', callback_data: 'nat_appoint' }]
  ]}}).catch(() => {});
}

async function showTreasury(ctx) {
  const n = await getNation(ctx.chat.id);
  if (!n) return;

  const events = await all(
    'SELECT type, description, amount, created_at FROM nation_events WHERE chat_id=$1 ORDER BY created_at DESC LIMIT 10',
    [ctx.chat.id]
  ).catch(() => []);

  let text = `💰 *خزينة ${n.name}*\n━━━━━━━━━━━━━━━\n\n`;
  text += `💵 الرصيد الحالي: *${fmt(n.treasury)} DA*\n`;
  text += `📈 الناتج المحلي: *${fmt(n.gdp)} DA*\n`;
  text += `💸 معدل الضريبة: *${n.tax_rate}%*\n\n`;

  if (events.length) {
    text += `*آخر العمليات:*\n`;
    events.forEach(e => {
      text += `• ${e.description}: ${e.amount > 0 ? '+' : ''}${fmt(e.amount)} DA\n`;
    });
  }

  ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 🔌 تسجيل الأوامر
// ══════════════════════════════════════════════════════════
function setup(bot) {
  bot.command(['found_nation', 'تأسيس_دولة', 'انشاء_دولة'], ctx => cmdFoundNation(ctx));
  bot.command(['nation', 'دولة', 'دولتي'], ctx => cmdNation(ctx));
  bot.command(['join_nation', 'مواطن', 'انضم'], ctx => cmdJoinNation(ctx));
  bot.command(['me', 'ملفي', 'حسابي_الدولة'], ctx => cmdMe(ctx));
  bot.command(['work', 'اعمل', 'شغل'], ctx => cmdWork(ctx));
  bot.command(['projects', 'مشاريع'], ctx => cmdProjects(ctx));
  bot.command(['army', 'الجيش', 'جيشي'], ctx => cmdArmy(ctx));
  bot.command(['declare_war', 'حرب', 'هجوم'], ctx => cmdDeclareWar(ctx));
  bot.command(['lands', 'اراضي', 'الأراضي'], ctx => cmdLands(ctx));
  bot.command(['world', 'ترتيب', 'ranking'], ctx => cmdRanking(ctx));
  bot.command(['donate', 'تبرع'], ctx => cmdDonate(ctx));
  bot.command(['election', 'انتخابات'], ctx => cmdElection(ctx));
  bot.command(['tax', 'ضريبة'], ctx => cmdSetTax(ctx));

  // text triggers
  bot.hears(/^مواطن$/i, ctx => cmdJoinNation(ctx));
  bot.hears(/^اعمل$/, ctx => cmdWork(ctx));
  bot.hears(/^دولتي$/, ctx => cmdNation(ctx));

  // setup flow
  bot.on('message', async (ctx, next) => {
    if (ctx.message?.photo) {
      const handled = await handleSetupPhoto(ctx).catch(() => false);
      if (handled) return;
    }
    if (ctx.message?.text) {
      const handled = await handleSetupText(ctx).catch(() => false);
      if (handled) return;
    }
    return next();
  });

  logger.info('[Nations] ✅ Commands registered');
}

module.exports = {
  migrate, setup, handleCallback, runDailyIncome,
  cmdNation, cmdWork, cmdArmy, cmdProjects, cmdLands, cmdRanking,
};
