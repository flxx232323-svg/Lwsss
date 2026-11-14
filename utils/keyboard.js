'use strict';
const { Markup } = require('telegraf');

// ── زر عادي ──
const btn = (text, data) => Markup.button.callback(text, data);

// ── زر ملون ──────────────────────────────────────
// color: 1=أحمر  4=أخضر (النمطان المقابلان في تيليجرام؛ 2/3/5 بلا نمط فتبقى أزراراً عادية)
// تيليجرام يلوّن الأزرار عبر الحقل style: danger=أحمر | success=أخضر | primary=أزرق (تطبيقات ما بعد 9 فبراير 2026؛
// الأقدم تعرض الزر بلا لون). كان الحقل المستخدم سابقاً color وهو غير موجود في واجهة تيليجرام فيُتجاهَل.
const STYLE_BY_COLOR = { 1: 'danger', 4: 'success' };
const btnC = (text, data, color) => {
  const b = { text, callback_data: data };
  if (STYLE_BY_COLOR[color]) b.style = STYLE_BY_COLOR[color];
  return b;
};

// ── اختصارات الألوان ──
const btnRed    = (text, data) => btnC(text, data, 1); // 🔴
const btnOrange = (text, data) => btnC(text, data, 2); // 🟠
const btnPurple = (text, data) => btnC(text, data, 3); // 🟣
const btnGreen  = (text, data) => btnC(text, data, 4); // 🟢
const btnGray   = (text, data) => btnC(text, data, 5); // ⚫

// ── أزرار تنقل ──
const back     = data => [btn('◀️ رجوع', data)];
const backMenu = data => [btn('◀️ رجوع', data), btn('🏠 الرئيسية', 'main_menu')];

// ── بناء الكيبورد (يقبل أزرار عادية وملونة معاً) ──
const build = rows => ({
  reply_markup: { inline_keyboard: rows }
});

// 🔵 أزرق (style=primary في تيليجرام) + إبراز تخصصات محددة بالاسم في قوائم اختيار التخصص
const btnBlue = (text, data) => ({ text, callback_data: data, style: 'primary' });
const HIGHLIGHT_SPECS = ['computer science'];
const btnSpec = (name, data) => (HIGHLIGHT_SPECS.includes(String(name || '').trim().toLowerCase())
  ? btnBlue('🎓 ' + name, data) : btn('🎓 ' + name, data));

module.exports = {
  btn, btnC,
  btnRed, btnOrange, btnPurple, btnGreen, btnGray,
  btnBlue, btnSpec,
  back, backMenu, build,
};
