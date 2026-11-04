'use strict';

// ── LRU In-Memory Cache — O(1) ──
const store = new Map();
const MAX   = 50000;
const TTL   = {
  SEARCH:  600000,
  FILE:    1800000,
  CONTENT: 86400000,
  RATING:  7200000,
  USER:    600000,
  AI:      3600000,
  STATIC:  86400000,
};

function cacheGet(key) {
  const e = store.get(key);
  if (!e) return null;
  if (e.exp && Date.now() > e.exp) { store.delete(key); return null; }
  store.delete(key); store.set(key, e); // move to tail (LRU)
  return e.val;
}

function cacheSet(key, val, ttl) {
  ttl = ttl || TTL.FILE;
  store.delete(key);
  store.set(key, { val, exp: Date.now() + ttl });
  if (store.size > MAX) _evictLRU();
}

function cacheClear(key)         { store.delete(key); }
function cacheClearPrefix(pfx)   { for (const k of store.keys()) if (k.startsWith(pfx)) store.delete(k); }
function cacheStats()            { return { size: store.size, max: MAX }; }
function getCacheSize()          { return store.size; }
function getCacheKeys()          { return Array.from(store.keys()); }

function _evictLRU() {
  const iter = store.keys();
  while (store.size > MAX) store.delete(iter.next().value);
}

function cachePurgeExpired() {
  const now = Date.now();
  for (const [k, e] of store) if (e.exp && now > e.exp) store.delete(k);
}

// ── Upstash Redis Layer (للكاش المهم فقط) ──
const { getRedisClient } = require('./redisClient');
const _getUpstash = getRedisClient;

// مفاتيح مهمة تُخزَّن في Upstash (تبقى بعد restart)
const PERSIST_PREFIXES = ['precomp_', 'ban_', 'sub_ok_', 'adm_', 'admin_stats'];

function _shouldPersist(key) {
  return PERSIST_PREFIXES.some(p => key.startsWith(p));
}

async function cacheGetAsync(key) {
  const mem = cacheGet(key);
  if (mem !== null) return mem;
  if (!_shouldPersist(key)) return null;
  const r = _getUpstash();
  if (!r) return null;
  try {
    const val = await r.get(key);
    if (val !== null && val !== undefined) {
      cacheSet(key, val, TTL.CONTENT); // ضعه في الذاكرة
      return val;
    }
  } catch(err) { require('./logger').debug('[catch]', err.message); }
  return null;
}

async function cacheSetAsync(key, val, ttl) {
  ttl = ttl || TTL.FILE;
  cacheSet(key, val, ttl);
  if (!_shouldPersist(key)) return;
  const r = _getUpstash();
  if (!r) return;
  try {
    await r.set(key, val, { ex: Math.floor(ttl / 1000) });
  } catch(err) { require('./logger').debug('[catch]', err.message); }
}

// ── Warmup: يجلب من Upstash أولاً ──
async function cacheWarmup() {
  const r = _getUpstash();
  if (r) {
    try {
      const keys = await r.keys('precomp_*');
      if (keys.length) {
        await Promise.all(keys.map(async k => {
          try {
            const val = await r.get(k);
            if (val) cacheSet(k, val, TTL.CONTENT);
          } catch(err) { require('./logger').debug('[catch]', err.message); }
        }));
        require('./logger').info('⚡ Warmup من Upstash: ' + keys.length + ' مفتاح');
        return;
      }
    } catch(err) { require('./logger').debug('[catch]', err.message); }
  }
  // Fallback: warmup من DB
  try {
    const CONC = 15;
    const content = require('../database/content');
    const specs = await content.getSpecs();
    if (!specs?.length) return;
    // ✅ متوازي حقيقي بدل sequential
    const years  = await Promise.all(specs.map(sp => content.getYears(sp.id).catch(() => [])));
    const allYears = years.flat();
    const sems   = await Promise.all(allYears.map(yr => content.getSemesters(yr.id).catch(() => [])));
    const allSems = sems.flat();
    const subs   = await Promise.all(allSems.map(sm => content.getSubjects(sm.id).catch(() => [])));
    const allSubs = subs.flat();
    await Promise.all(allSubs.map(sb => content.getCategories(sb.id).catch(err => { require('./logger').debug("[silent]", err.message); })));
    const tasks = { length: specs.length + allYears.length + allSems.length + allSubs.length };
    require('./logger').info('⚡ Warmed: ' + tasks.length + ' keys');
    _evictLRU();
  } catch(err) { require('./logger').debug('[catch]', err.message); }
}


// ── Batch Cache Read — pipeline لتقليل roundtrips ───────────────
async function cacheMGet(keys) {
  // أولاً: كل اللي موجود في الـ memory
  const results = keys.map(k => cacheGet(k));
  const missing = keys.reduce((acc, k, i) => { if (results[i] === null) acc.push(i); return acc; }, []);

  if (!missing.length) return results;

  // الناقص: اجلبه من Upstash بـ pipeline
  try {
    const r = _getUpstash ? _getUpstash() : null;
    if (!r) return results;
    const pipe = r.pipeline();
    missing.forEach(i => pipe.get(keys[i]));
    const raw = await pipe.exec();
    missing.forEach((idx, j) => {
      if (raw[j] !== null) {
        try { results[idx] = JSON.parse(raw[j]); }
        catch { results[idx] = raw[j]; }
      }
    });
  } catch(err) { require('./logger').debug('[catch]', err.message); }

  return results;
}

function clearAllSubCache() { for (const k of store.keys()) if (k.startsWith("sub_ok_")) store.delete(k); }

function cacheClearAll() { store.clear(); }

module.exports = { cacheMGet, clearAllSubCache,
  cacheGet, cacheSet, cacheClear, cacheClearPrefix, cacheClearAll,
  cacheGetAsync, cacheSetAsync,
  cacheWarmup, cacheStats, getCacheSize, getCacheKeys,
  cachePurgeExpired, TTL,
};
