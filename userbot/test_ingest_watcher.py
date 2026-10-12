"""
اختبارات مراقب الملفات (المرحلة 2ب) — بلا شبكة ولا تيليجرام ولا قاعدة بيانات.
عميل Telethon وهمي (يمنع أي استدعاء خارج get_entity / iter_dialogs / iter_messages)
وواجهة API وهمية. التشغيل من مجلد userbot:

    ./venv/bin/python -m unittest test_ingest_watcher -v
"""
import asyncio
import os
import re
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS
from unittest import mock

import ingest_watcher as w
from telethon.errors import FloodWaitError

OWNER = 111
CHAT = -1001234567890
NOW = datetime(2026, 10, 11, 12, 0, tzinfo=timezone.utc)
BIG = 9223372036854775807


def msg(i, *, sender=OWNER, doc=True, topic=None, days_ago=0.5, name=None, kind=None, caption=None, grouped=None):
    reply = None
    if topic is not None:
        reply = NS(forum_topic=True, reply_to_top_id=None, reply_to_msg_id=topic)
    m = NS(
        id=i, date=NOW - timedelta(days=days_ago), sender_id=sender,
        document=NS(id=BIG) if doc else None,
        sticker=kind == "sticker", voice=kind == "voice", video_note=kind == "video_note", gif=kind == "gif",
        file=NS(name=name or f"f{i}.pdf", mime_type="application/pdf", size=1000 + i) if doc else None,
        message=caption, grouped_id=grouped, reply_to=reply,
    )
    return m


class FakeClient:
    """يسمح فقط بثلاث دوال قراءة؛ أي استدعاء آخر (مثل send_message) يفشل الاختبار."""
    def __init__(self, chats, dialogs=None, entity_known=True):
        self.chats = chats                      # chat_id -> [msg ascending by id]
        self.dialogs = dialogs or []
        self.known = set(chats) if entity_known else set()
        self.calls = []

    def __getattr__(self, name):
        raise AssertionError(f"read-only violation: client.{name} was accessed")

    async def get_entity(self, chat_id):
        self.calls.append("get_entity")
        if chat_id not in self.known:
            raise ValueError("Could not find the input entity")
        return NS(id=chat_id)

    async def iter_dialogs(self, limit=None):
        self.calls.append("iter_dialogs")
        for d in self.dialogs:
            self.known.add(d)
            yield NS(id=d)

    async def iter_messages(self, ent, *, reverse=False, limit=None, min_id=0, offset_date=None):
        self.calls.append("iter_messages")
        rows = [m for m in self.chats.get(ent.id, []) if m.id > min_id and (offset_date is None or m.date > offset_date)]
        rows.sort(key=lambda m: m.id, reverse=not reverse)
        for n, m in enumerate(rows):
            if limit is not None and n >= limit:
                return
            yield m


class FakeApi:
    def __init__(self):
        self.posts, self.errors, self.statuses = [], [], []

    async def post_batch(self, payload):
        self.posts.append(payload)
        status = self.statuses.pop(0) if self.statuses else 200
        return status, {"inserted": len(payload.get("items", [])), "duplicates": 0, "watermark": payload.get("watermark")}

    async def report_error(self, source_id, text):
        self.errors.append((source_id, text))


def src(**over):
    base = {"id": 1, "chat_id": str(CHAT), "title": "G", "all_topics": True, "last_message_id": "0", "topics": []}
    base.update(over)
    return base


class WatcherTests(unittest.IsolatedAsyncioTestCase):
    async def run_sweep(self, client, api, s, cache=None):
        return await w.sweep_source(client, api, s, OWNER, cache or w.EntityCache(), {CHAT}, now=NOW)

    # ── استخراج الحقول ──
    def test_is_file_and_topic(self):
        self.assertTrue(w.is_file(msg(1)))
        for kind in ("sticker", "voice", "video_note", "gif"):
            self.assertFalse(w.is_file(msg(1, kind=kind)))
        self.assertFalse(w.is_file(msg(1, doc=False)))
        self.assertIsNone(w.topic_of(msg(1)))
        self.assertEqual(w.topic_of(msg(1, topic=5)), 5)
        reply_in_topic = NS(reply_to=NS(forum_topic=True, reply_to_top_id=7, reply_to_msg_id=99))
        self.assertEqual(w.topic_of(reply_in_topic), 7)
        plain_reply = NS(reply_to=NS(forum_topic=False, reply_to_top_id=None, reply_to_msg_id=99))
        self.assertIsNone(w.topic_of(plain_reply))

    def test_env_int_clamps(self):
        with mock.patch.dict(os.environ, {"X_T": "99999"}):
            self.assertEqual(w._env_int("X_T", 5, 1, 100), 100)
        with mock.patch.dict(os.environ, {"X_T": "abc"}):
            self.assertEqual(w._env_int("X_T", 5, 1, 100), 5)

    # ── التصفية والحقول ──
    async def test_filters_and_payload(self):
        chat = [
            msg(1, topic=5, caption="Chapter 1", grouped=BIG),
            msg(2, sender=999, topic=5),                  # غير المالك
            msg(3, doc=False, topic=5),                   # نص
            msg(4, kind="sticker", topic=5),              # ملصق
            msg(5, topic=9),                              # موضوع خارج النطاق
            msg(6, topic=None),                           # القروب نفسه (مسموح بقاعدة null)
            msg(7, kind="voice", topic=5),
        ]
        api, client = FakeApi(), FakeClient({CHAT: chat})
        more = await self.run_sweep(client, api, src(all_topics=False, topics=["5", None]))
        self.assertFalse(more)
        self.assertEqual(len(api.posts), 1)
        p = api.posts[0]
        self.assertEqual([i["message_id"] for i in p["items"]], [1, 6])
        self.assertEqual(p["watermark"], "7")             # آخر رسالة فُحصت (حتى المتجاهَلة)
        first = p["items"][0]
        self.assertEqual((first["sender_id"], first["topic_id"], first["caption"]), ("111", 5, "Chapter 1"))
        self.assertEqual((first["grouped_id"], first["tg_doc_id"]), (str(BIG), str(BIG)))
        self.assertEqual((first["file_name"], first["mime_type"], first["size_bytes"]), ("f1.pdf", "application/pdf", 1001))
        self.assertTrue(first["message_date"].startswith("2026-10-11"))

    async def test_all_topics_accepts_everything_from_owner(self):
        chat = [msg(1, topic=5), msg(2, topic=9), msg(3)]
        api = FakeApi()
        await self.run_sweep(FakeClient({CHAT: chat}), api, src(all_topics=True))
        self.assertEqual([i["message_id"] for i in api.posts[0]["items"]], [1, 2, 3])

    # ── التقسيم والمؤشر ──
    async def test_chunking_and_monotonic_watermark(self):
        chat = [msg(i) for i in range(1, 451)]
        orig = w.MAX_PER_SWEEP
        w.MAX_PER_SWEEP = 2000
        try:
            api = FakeApi()
            await self.run_sweep(FakeClient({CHAT: chat}), api, src())
        finally:
            w.MAX_PER_SWEEP = orig
        self.assertEqual([len(p["items"]) for p in api.posts], [200, 200, 50])
        wms = [int(p["watermark"]) for p in api.posts]
        self.assertEqual(wms, sorted(wms))
        for p in api.posts:
            self.assertGreaterEqual(int(p["watermark"]), max(i["message_id"] for i in p["items"]))
        self.assertEqual(wms[-1], 450)

    async def test_cap_then_continue_without_loss_or_duplicates(self):
        chat = [msg(i) for i in range(1, 701)]
        client, api = FakeClient({CHAT: chat}), FakeApi()
        s = src()
        seen, sweeps = [], 0
        while True:
            more = await self.run_sweep(client, api, s)
            sweeps += 1
            for p in api.posts:
                seen += [i["message_id"] for i in p["items"]]
            s["last_message_id"] = api.posts[-1]["watermark"]
            api.posts.clear()
            if not more or sweeps > 10:
                break
        self.assertEqual(sweeps, 3)                       # 300 + 300 + 100
        self.assertEqual(seen, list(range(1, 701)))       # بلا فقد ولا تكرار

    # ── نافذة الاسترجاع ──
    async def test_first_run_uses_backfill_window_only(self):
        chat = [msg(1, days_ago=30), msg(2, days_ago=20), msg(3, days_ago=2), msg(4, days_ago=0.1)]
        api = FakeApi()
        await self.run_sweep(FakeClient({CHAT: chat}), api, src())
        self.assertEqual([i["message_id"] for i in api.posts[0]["items"]], [3, 4])

    async def test_recovery_skips_old_messages_but_advances_watermark(self):
        chat = [msg(10, days_ago=40), msg(11, days_ago=39), msg(12, days_ago=1)]
        api = FakeApi()
        await self.run_sweep(FakeClient({CHAT: chat}), api, src(last_message_id="9"))
        self.assertEqual([i["message_id"] for i in api.posts[0]["items"]], [12])
        self.assertEqual(api.posts[0]["watermark"], "12")

    async def test_empty_window_sets_baseline_to_latest_message(self):
        chat = [msg(5, days_ago=60), msg(6, days_ago=59)]
        api = FakeApi()
        await self.run_sweep(FakeClient({CHAT: chat}), api, src())
        self.assertEqual(api.posts[0]["items"], [])
        self.assertEqual(api.posts[0]["watermark"], "6")
        api2 = FakeApi()
        await self.run_sweep(FakeClient({CHAT: []}), api2, src())
        self.assertEqual(api2.posts[0]["watermark"], "0")

    async def test_nothing_new_still_reports_watermark_as_liveness(self):
        api = FakeApi()
        await self.run_sweep(FakeClient({CHAT: [msg(1), msg(2)]}), api, src(last_message_id="2"))
        self.assertEqual((api.posts[0]["items"], api.posts[0]["watermark"]), ([], "2"))

    # ── الفشل والإعادة ──
    async def test_failed_post_stops_and_retry_resends_same_items(self):
        chat = [msg(i) for i in range(1, 6)]
        client, api = FakeClient({CHAT: chat}), FakeApi()
        api.statuses = [500]
        more = await self.run_sweep(client, api, src())
        self.assertFalse(more)
        self.assertEqual(len(api.posts), 1)               # توقّف فوراً بعد الفشل
        first = [i["message_id"] for i in api.posts[0]["items"]]
        await self.run_sweep(client, api, src())          # المؤشر لم يتغيّر (0): يعيد المحاولة
        second = [i["message_id"] for i in api.posts[1]["items"]]
        self.assertEqual(first, second)
        self.assertEqual(second, [1, 2, 3, 4, 5])

    async def test_disabled_source_409_is_not_an_error(self):
        api = FakeApi()
        api.statuses = [409]
        await self.run_sweep(FakeClient({CHAT: [msg(1)]}), api, src())
        self.assertEqual(api.errors, [])

    async def test_inaccessible_chat_reports_error_and_posts_nothing(self):
        api = FakeApi()
        client = FakeClient({}, entity_known=False)
        await self.run_sweep(client, api, src())
        self.assertEqual(len(api.errors), 1)
        self.assertEqual(api.posts, [])

    async def test_entity_resolved_by_scanning_dialogs(self):
        client = FakeClient({CHAT: [msg(1)]}, dialogs=[-100777, CHAT], entity_known=False)
        api = FakeApi()
        await self.run_sweep(client, api, src())
        self.assertIn("iter_dialogs", client.calls)
        self.assertEqual(api.errors, [])
        self.assertEqual([i["message_id"] for i in api.posts[0]["items"]], [1])

    async def test_floodwait_reports_and_continues_with_next_source(self):
        class Flaky(FakeClient):
            async def iter_messages(self, ent, **kw):
                if ent.id == CHAT:
                    raise FloodWaitError(None, capture=30)
                async for m in super().iter_messages(ent, **kw):
                    yield m
        other = -1009999999999
        client = Flaky({CHAT: [msg(1)], other: [msg(1)]})
        class ApiWithConfig(FakeApi):
            async def get_config(self):
                return 200, {"owner_id": str(OWNER), "sources": [src(), src(id=2, chat_id=str(other))]}
        api = ApiWithConfig()
        with mock.patch.object(w.asyncio, "sleep", new=mock.AsyncMock()):
            await w.sweep_once(client, api, w.EntityCache())
        self.assertEqual([e[0] for e in api.errors], [1])
        self.assertEqual([p["source_id"] for p in api.posts], [2])

    # ── للقراءة فقط ──
    def test_client_cannot_send_anything(self):
        c = FakeClient({})
        for name in ("send_message", "send_file", "delete_messages", "edit_message", "forward_messages", "download_media"):
            with self.assertRaises(AssertionError):
                getattr(c, name)

    def test_watcher_source_never_references_write_apis(self):
        code = open(os.path.join(os.path.dirname(w.__file__), "ingest_watcher.py"), encoding="utf-8").read()
        banned = r"\.(send_\w+|delete_\w+|edit_\w+|forward_\w+|download_\w+|kick_\w+|pin_\w+|action|upload_\w+)\(|JoinChannel|LeaveChannel|\(\s*functions\."
        self.assertIsNone(re.search(banned, code), "المراقب يجب أن يبقى للقراءة فقط")

    async def test_whole_sweep_only_uses_read_calls(self):
        client = FakeClient({CHAT: [msg(i) for i in range(1, 30)]})
        await self.run_sweep(client, FakeApi(), src())
        self.assertTrue(set(client.calls) <= {"get_entity", "iter_dialogs", "iter_messages"})


if __name__ == "__main__":
    unittest.main()
