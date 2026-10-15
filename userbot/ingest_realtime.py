"""
الاستماع الفوري لملفات القروبات (قراءة وتسجيل فقط).

بدل انتظار المسح الدوري (حتى INGEST_INTERVAL_SECONDS)، يستمع UserBot إلى الرسائل الجديدة التي
تصل أصلاً عبر اتصاله الحالي بتلغرام، ويسجّل الملف خلال أجزاء من الثانية.

- لا استدعاءات إضافية إلى تلغرام (التحديثات تصل مجاناً عبر الاتصال نفسه)، فلا خطر FloodWait، ولا يتغيّر
  تسجيل الدخول ولا الجلسة ولا إعداد العميل. لا يرسل رسائل ولا يحذف ولا يعدّل.
- نفس قواعد المسح تماماً: المرسل ضمن allowed_senders (المالك دائماً + مشرفو القروب إن فُعِّل التتبع على
  الخادم)، ملف حقيقي فقط، ونطاق المواضيع المفعّلة. والخادم يعيد فرضها.
- لا يلمس نقطة التقدّم (watermark): تُرسَل العناصر بلا watermark، فلا يمكن أن يُتخطّى شيء بسبب ترتيب
  الأحداث. والمسح الدوري يبقى شبكة الأمان: يلتقط ما فات (انقطاع اتصال، إعادة نشر...) ويتقدّم بالنقطة،
  والخادم يتجاهل المكرر (نفس المصدر + نفس الرسالة).
- فشل الإرسال هنا لا يُعاد ولا يضيّع شيئاً: المسح التالي يسجّل الملف نفسه.
- تجميع قصير (0.3 ث) لدفعات الملفات المتتابعة (ألبوم أو عدة ملفات) في طلب واحد.

INGEST_REALTIME=0 يعطّله (يبقى المسح الدوري وحده). الافتراضي: مفعّل مع INGEST_ENABLED=1.
"""
import asyncio
import os

import ingest_watcher as w
from config import LWSS_INTERNAL_URL, USERBOT_INTERNAL_SECRET

FLUSH_DELAY = 0.3
REFRESH_SECONDS = 30


class Realtime:
    def __init__(self, api, flush_delay=FLUSH_DELAY, refresh_seconds=REFRESH_SECONDS):
        self._api = api
        self._delay = flush_delay
        self._refresh_seconds = refresh_seconds
        self._sources = {}       # chat_id(int) -> {"id", "senders": set, "topics": set|None}
        self._pending = {}       # source_id -> [items]
        self._flushing = set()   # source_id لها مهمة تفريغ مجدولة
        self._tasks = set()
        self._refresh_task = None
        self._handler = None
        self._client = None
        self._last_cfg_error = None

    # ── الإعداد (نفس مصدر المسح: /config على الخادم) ──

    async def refresh(self):
        status, cfg = await self._api.get_config()
        if status != 200 or not isinstance(cfg, dict) or "owner_id" not in cfg:
            text = f"HTTP {status}"
            if text != self._last_cfg_error:   # لا نكرر نفس الرسالة كل 30 ثانية
                print(f"[INGEST] realtime: cannot fetch config ({text}); keeping the previous one")
                self._last_cfg_error = text
            return False
        self._last_cfg_error = None
        owner = int(cfg["owner_id"])
        new = {}
        for s in cfg.get("sources", []):
            try:
                senders = {owner}
                for x in s.get("allowed_senders") or []:
                    try:
                        senders.add(int(x))
                    except (TypeError, ValueError):
                        pass
                topics = None
                if not s.get("all_topics"):
                    topics = {None if t is None else int(t) for t in s.get("topics", [])}
                new[int(s["chat_id"])] = {"id": s["id"], "senders": senders, "topics": topics}
            except (KeyError, TypeError, ValueError, AttributeError):
                continue   # مصدر مشوّه: نتجاهله ولا نُسقط البقية
        self._sources = new
        return True

    async def _refresh_loop(self):
        while True:
            try:
                await self.refresh()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[INGEST] realtime: config refresh failed: {type(e).__name__}: {e}")
            await asyncio.sleep(self._refresh_seconds)

    # ── الأحداث ──

    def _passes(self, msg, src):
        sender = getattr(msg, "sender_id", None)
        if sender is None or int(sender) not in src["senders"]:
            return False
        if not w.is_file(msg):
            return False
        if src["topics"] is not None and w.topic_of(msg) not in src["topics"]:
            return False
        return True

    async def on_message(self, event):
        try:
            msg = getattr(event, "message", None)
            if msg is None:
                return
            src = self._sources.get(getattr(event, "chat_id", None))
            if src is None or not self._passes(msg, src):
                return
            sid = src["id"]
            self._pending.setdefault(sid, []).append(w.to_item(msg))
            if sid not in self._flushing:
                self._flushing.add(sid)
                task = asyncio.ensure_future(self._flush_soon(sid))
                self._tasks.add(task)
                task.add_done_callback(self._tasks.discard)
        except Exception as e:   # معالج الأحداث لا يجوز أن يُسقط العميل أبداً
            print(f"[INGEST] realtime: handler error: {type(e).__name__}: {e}")

    async def _flush_soon(self, sid):
        try:
            await asyncio.sleep(self._delay)
        finally:
            self._flushing.discard(sid)   # رسائل تصل أثناء الإرسال تُجدول لها مهمة جديدة
        items = self._pending.pop(sid, [])
        for i in range(0, len(items), w.BATCH_SIZE):
            chunk = items[i:i + w.BATCH_SIZE]
            try:
                status, body = await self._api.post_batch({"source_id": sid, "items": chunk})  # بلا watermark عمداً
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[INGEST] realtime: source {sid} post failed: {type(e).__name__}: {e}")
                continue
            if status == 200:
                if body.get("inserted"):
                    print(f"[INGEST] realtime: source {sid}: recorded={body.get('inserted')} dup={body.get('duplicates')}")
            elif status != 409:   # 409 = المصدر معطّل على الخادم
                print(f"[INGEST] realtime: source {sid}: not recorded (HTTP {status}); the periodic sweep will pick it up")

    # ── التشغيل والإيقاف ──

    def start(self, client=None, handler_event=None):
        self._client = client
        self._handler = handler_event
        self._refresh_task = asyncio.ensure_future(self._refresh_loop())

    async def stop(self):
        if self._refresh_task is not None:
            self._refresh_task.cancel()
        for t in list(self._tasks):
            t.cancel()
        await asyncio.gather(*([self._refresh_task] if self._refresh_task else []), *self._tasks, return_exceptions=True)
        if self._client is not None and self._handler is not None:
            try:
                self._client.remove_event_handler(self.on_message, self._handler)
            except Exception:
                pass
        try:
            await self._api.close()
        except Exception:
            pass


def attach_realtime(client, api=None, events_module=None):
    """يسجّل المعالج على العميل ويشغّل تحديث الإعداد. يرجع None إن عُطِّل بـ INGEST_REALTIME=0."""
    if os.environ.get("INGEST_REALTIME", "1").strip() == "0":
        print("[INGEST] realtime disabled (INGEST_REALTIME=0): periodic sweep only")
        return None
    if events_module is None:
        from telethon import events as events_module
    rt = Realtime(api or w.IngestApi(LWSS_INTERNAL_URL, USERBOT_INTERNAL_SECRET))
    builder = events_module.NewMessage()    # واردة وصادرة (رسائلك أنت صادرة)
    client.add_event_handler(rt.on_message, builder)
    rt.start(client, builder)
    print("[INGEST] realtime listener attached (read-only)")
    return rt
