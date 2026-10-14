"""
مراقب الملفات — المرحلة 2ب: قراءة وتسجيل فقط.

- لا يرسل أي رسالة ولا يحذف ولا يعدّل: يستعمل فقط get_entity / iter_dialogs / iter_messages.
- لا حفظ في المكتبة ولا نشر: يرسل ما يكتشفه إلى /internal/ingest/batch في البوت الرئيسي (تسجيل فقط).
- مصدر الحقيقة نقطة التقدّم في PostgreSQL (يحفظها الخادم): كل مسح يبدأ منها، فالانقطاع وإعادة
  التشغيل والنشر لا تُضيّع شيئاً، ولا يتكرر شيء (الخادم يتجاهل المكرر).
- نقطة التقدّم لا تتقدّم إلا بعد نجاح تسجيل العناصر (الخادم يكتبهما في معاملة واحدة).
- مُفعَّل فقط عند INGEST_ENABLED=1 (الافتراضي: معطّل، فلا يتغيّر سلوك UserBot الحالي).

متغيرات اختيارية: INGEST_INTERVAL_SECONDS (60) · INGEST_MAX_PER_SWEEP (300) ·
INGEST_BACKFILL_DAYS (7) · INGEST_DIALOG_SCAN_LIMIT (3000)
"""
import asyncio
import os
import time
from datetime import datetime, timedelta, timezone

import aiohttp
from telethon.errors import ChannelPrivateError, FloodWaitError

from config import LWSS_INTERNAL_URL, USERBOT_INTERNAL_SECRET


def _env_int(name, default, lo, hi):
    try:
        v = int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


ENABLED = os.environ.get("INGEST_ENABLED", "0").strip() == "1"
INTERVAL = _env_int("INGEST_INTERVAL_SECONDS", 60, 10, 3600)
MAX_PER_SWEEP = _env_int("INGEST_MAX_PER_SWEEP", 300, 20, 2000)
BACKFILL_DAYS = _env_int("INGEST_BACKFILL_DAYS", 7, 1, 365)
DIALOG_SCAN_LIMIT = _env_int("INGEST_DIALOG_SCAN_LIMIT", 3000, 100, 20000)
BATCH_SIZE = 200  # يطابق MAX_ITEMS في routes/ingest_internal.js


# ── استخراج بيانات الرسالة ──────────────────────────────────────────────

def is_file(msg):
    """مستند (ملف/فيديو...) وليس ملصقاً ولا رسالة صوتية ولا فيديو دائري ولا GIF."""
    if getattr(msg, "document", None) is None:
        return False
    for kind in ("sticker", "voice", "video_note", "gif"):
        if getattr(msg, kind, None):
            return False
    return True


def topic_of(msg):
    """رقم الـ Topic (منتديات). None = القروب نفسه أو القسم General/قروب عادي.
    ملاحظة: يُتحقق من هذا الاستنتاج على قروب منتدى حقيقي في مرحلة Dry-run."""
    rt = getattr(msg, "reply_to", None)
    if rt is None or not getattr(rt, "forum_topic", False):
        return None
    return getattr(rt, "reply_to_top_id", None) or getattr(rt, "reply_to_msg_id", None)


def to_item(msg):
    f = getattr(msg, "file", None)
    gid = getattr(msg, "grouped_id", None)
    return {
        "message_id": int(msg.id),
        "sender_id": str(msg.sender_id),            # 64-بت كنص
        "topic_id": topic_of(msg),
        "grouped_id": str(gid) if gid else None,    # 64-بت كنص
        "file_name": (getattr(f, "name", None) or "") if f else "",
        "mime_type": getattr(f, "mime_type", None) if f else None,
        "size_bytes": getattr(f, "size", None) if f else None,
        "tg_doc_id": str(msg.document.id),          # 64-بت كنص
        "message_date": msg.date.isoformat() if getattr(msg, "date", None) else None,
        "caption": (getattr(msg, "message", None) or None),
    }


# ── عميل الـ API الداخلي ────────────────────────────────────────────────

class IngestApi:
    def __init__(self, base_url, secret):
        self._base = base_url.rstrip("/") + "/internal/ingest"
        self._headers = {"X-Internal-Secret": secret}
        self._session = None
        self._last_error = {}  # source_id -> (text, time) لتخفيف تكرار التقارير

    def _get_session(self):
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def close(self):
        if self._session is not None and not self._session.closed:
            await self._session.close()

    async def _call(self, method, path, payload=None):
        timeout = aiohttp.ClientTimeout(total=20)
        try:
            async with self._get_session().request(
                method, self._base + path, json=payload, headers=self._headers, timeout=timeout
            ) as resp:
                try:
                    body = await resp.json()
                except Exception:
                    body = {}
                return resp.status, body
        except Exception as e:  # شبكة/مهلة: يُعاد في المسح التالي
            return 0, {"error": f"{type(e).__name__}: {e}"}

    async def get_config(self):
        return await self._call("GET", "/config")

    async def post_batch(self, payload):
        return await self._call("POST", "/batch", payload)

    async def report_error(self, source_id, text):
        text = (text or "")[:300]
        prev = self._last_error.get(source_id)
        if prev and prev[0] == text and time.monotonic() - prev[1] < 600:
            return
        self._last_error[source_id] = (text, time.monotonic())
        print(f"[INGEST] source {source_id} error: {text}")
        await self.post_batch({"source_id": source_id, "error": text})


# ── حلّ المحادثة (ذاكرة الكيانات فارغة عند كل إقلاع مع StringSession) ───────

async def _warm_dialogs(client, wanted_ids):
    left = set(wanted_ids)
    async for d in client.iter_dialogs(limit=DIALOG_SCAN_LIMIT):
        left.discard(d.id)
        if not left:
            break


class EntityCache:
    def __init__(self):
        self._ents = {}
        self._last_scan = None  # None = لم يُمسح بعد (monotonic يبدأ من إقلاع الجهاز فلا يصلح صفراً)

    async def get(self, client, chat_id, wanted_ids):
        ent = self._ents.get(chat_id)
        if ent is not None:
            return ent
        try:
            ent = await client.get_entity(chat_id)
        except ValueError:
            ent = None
        if ent is None and (self._last_scan is None or time.monotonic() - self._last_scan > 600):
            self._last_scan = time.monotonic()
            await _warm_dialogs(client, wanted_ids)
            try:
                ent = await client.get_entity(chat_id)
            except ValueError:
                ent = None
        if ent is not None:
            self._ents[chat_id] = ent
        return ent


async def _latest_id(client, ent):
    async for m in client.iter_messages(ent, limit=1):
        return int(m.id)
    return 0


# ── مسح مصدر واحد ────────────────────────────────────────────────────────

async def _post(api, source_id, items, watermark):
    status, body = await api.post_batch(
        {"source_id": source_id, "items": items, "watermark": str(watermark)}
    )
    if status == 200:
        if body.get("inserted"):
            print(f"[INGEST] source {source_id}: recorded={body.get('inserted')} "
                  f"dup={body.get('duplicates')} watermark={body.get('watermark')}")
        return True
    if status == 409:
        print(f"[INGEST] source {source_id} is disabled on the server; skipping")
    else:
        print(f"[INGEST] source {source_id}: batch not recorded (HTTP {status}): {body}")
    return False


async def sweep_source(client, api, src, owner_id, cache, wanted_ids, now=None):
    """يمسح الرسائل الأحدث من نقطة التقدّم. يرجع True إن بقي المزيد (بلغ حدّ المسح)."""
    sid = src["id"]
    chat_id = int(src["chat_id"])
    wm = int(src["last_message_id"])
    # المرسلون المسموحون: المالك دائماً + ما يرسله الخادم في allowed_senders (مشرفو القروب إن فُعِّل التتبع)
    senders = {owner_id}
    for x in src.get("allowed_senders") or []:
        try:
            senders.add(int(x))
        except (TypeError, ValueError):
            pass
    allowed = None
    if not src.get("all_topics"):
        allowed = {None if t is None else int(t) for t in src.get("topics", [])}
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=BACKFILL_DAYS)

    ent = await cache.get(client, chat_id, wanted_ids)
    if ent is None:
        await api.report_error(sid, "chat not found or not accessible by this account (not a member?)")
        return False

    kwargs = {"reverse": True, "limit": MAX_PER_SWEEP}
    if wm > 0:
        kwargs["min_id"] = wm          # مع reverse: الرسائل ذات المعرّف الأكبر، تصاعدياً
    else:
        kwargs["offset_date"] = cutoff  # أول مرة: من آخر BACKFILL_DAYS يوماً فقط

    items = []
    last_id = wm
    examined = 0
    async for msg in client.iter_messages(ent, **kwargs):
        examined += 1
        last_id = max(last_id, int(msg.id))
        # الترتيب تصاعدي: كل ما دون last_id تم فحصه، سواء سُجِّل أم تُجوهل
        if getattr(msg, "date", None) and msg.date < cutoff:
            continue
        if msg.sender_id is None or int(msg.sender_id) not in senders:
            continue
        if not is_file(msg):
            continue
        if allowed is not None and topic_of(msg) not in allowed:
            continue
        items.append(to_item(msg))
        if len(items) >= BATCH_SIZE:
            if not await _post(api, sid, items, last_id):
                return False   # فشل: لا تتقدّم نقطة التقدّم، يُعاد من نفس المكان
            items = []

    if examined == 0 and wm == 0:
        # لا رسائل في النافذة: اجعل خط الأساس آخر رسالة حالية كي لا يُعاد مسح التاريخ كل مرة
        last_id = await _latest_id(client, ent)

    if not await _post(api, sid, items, last_id):
        return False
    return examined >= MAX_PER_SWEEP


async def sweep_once(client, api, cache):
    status, cfg = await api.get_config()
    if status != 200:
        print(f"[INGEST] cannot fetch config (HTTP {status}): {cfg}")
        return False
    owner_id = int(cfg["owner_id"])
    sources = cfg.get("sources", [])
    wanted = {int(s["chat_id"]) for s in sources}
    more = False
    for s in sources:
        try:
            more = (await sweep_source(client, api, s, owner_id, cache, wanted)) or more
        except asyncio.CancelledError:
            raise
        except FloodWaitError as e:
            wait = min(int(getattr(e, "seconds", 60)), 300)
            await api.report_error(s["id"], f"FloodWait {wait}s")
            await asyncio.sleep(wait + 1)
        except ChannelPrivateError:
            await api.report_error(s["id"], "no access to this chat (removed or private)")
        except Exception as e:
            await api.report_error(s["id"], f"{type(e).__name__}: {e}")
    return more


async def ingest_loop(client):
    api = IngestApi(LWSS_INTERNAL_URL, USERBOT_INTERNAL_SECRET)
    cache = EntityCache()
    print(f"[INGEST] watcher started (read-only): interval={INTERVAL}s max_per_sweep={MAX_PER_SWEEP} "
          f"backfill_days={BACKFILL_DAYS}")
    try:
        while True:
            more = False
            try:
                more = await sweep_once(client, api, cache)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[INGEST] sweep failed: {type(e).__name__}: {e}")
            await asyncio.sleep(2 if more else INTERVAL)
    finally:
        await api.close()
