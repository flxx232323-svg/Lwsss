// إعداد ESLint: يعرّف globals بيئة Node ليظهر الخطأ الحقيقي فقط (no-undef لأسماء غير معرّفة فعلاً)
const nodeGlobals = Object.fromEntries([
  ['require', 'readonly'], ['module', 'writable'], ['exports', 'writable'], ['__dirname', 'readonly'], ['__filename', 'readonly'],
  ['process', 'readonly'], ['console', 'readonly'], ['Buffer', 'readonly'], ['global', 'readonly'],
  ['setTimeout', 'readonly'], ['clearTimeout', 'readonly'], ['setInterval', 'readonly'], ['clearInterval', 'readonly'],
  ['setImmediate', 'readonly'], ['clearImmediate', 'readonly'], ['queueMicrotask', 'readonly'], ['structuredClone', 'readonly'],
  ['URL', 'readonly'], ['URLSearchParams', 'readonly'], ['TextEncoder', 'readonly'], ['TextDecoder', 'readonly'],
  ['AbortController', 'readonly'], ['fetch', 'readonly'],
]);

module.exports = [
  {
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: nodeGlobals },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'warn',
      'no-unreachable': 'error',
    },
  },
];
