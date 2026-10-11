'use strict';
/**
 * ════════════════════════════════════════════
 *  /internal — قنوات اتصال داخلية بين خدمات المشروع فقط
 *  (ليست جزءاً من الـ Mini App API العام، ولا تستخدم مصادقة Telegram WebApp)
 *
 *  المرحلة الأولى: heartbeat من UserBot (Telethon) فقط.
 * ════════════════════════════════════════════
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const SECRET = process.env.USERBOT_INTERNAL_SECRET || '';

// حالة الـ heartbeat الأخيرة — بالذاكرة فقط (كافٍ للمرحلة الأولى البسيطة؛
// تُعاد تهيئته عند إعادة تشغيل خدمة البوت الرئيسية، وهذا مقبول لأن UserBot
// يرسل heartbeat كل مدة قصيرة وسيُعاد ملؤها تلقائياً).
let lastHeartbeat = null; // { username, receivedAt }

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireInternalSecret(req, res, next) {
  if (!SECRET) {
    return res.status(503).json({ error: 'USERBOT_INTERNAL_SECRET not configured on server' });
  }
  const got = req.get('X-Internal-Secret') || '';
  if (!timingSafeEqual(got, SECRET)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

router.post('/userbot/heartbeat', requireInternalSecret, (req, res) => {
  const body = req.body || {};
  if (body.status !== 'online') {
    return res.status(400).json({ error: 'invalid payload: status must be "online"' });
  }
  lastHeartbeat = {
    username: typeof body.username === 'string' ? body.username.slice(0, 64) : '',
    receivedAt: Date.now(),
  };
  res.json({ ok: true });
});

// أونلاين إذا وصل آخر heartbeat خلال آخر 90 ثانية (٣ نبضات متتالية بمعدل
// كل 30 ثانية) — عتبة تسمح بتفويت نبضة واحدة عرضية دون اعتبار UserBot Offline.
const ONLINE_THRESHOLD_MS = 90 * 1000;

function getUserbotStatus() {
  if (!lastHeartbeat) return { online: false, secondsAgo: null, username: null };
  const secondsAgo = Math.floor((Date.now() - lastHeartbeat.receivedAt) / 1000);
  return {
    online: (Date.now() - lastHeartbeat.receivedAt) <= ONLINE_THRESHOLD_MS,
    secondsAgo,
    username: lastHeartbeat.username || null,
  };
}

module.exports = { router, getUserbotStatus, requireInternalSecret };
