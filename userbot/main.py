"""
نقطة الدخول لـ UserBot: تسجيل دخول + heartbeat دوري.
مراقبة الملفات (ingest_watcher) اختيارية ومعطّلة افتراضياً (INGEST_ENABLED=1)، وللقراءة والتسجيل فقط:
لا إرسال رسائل، لا auto-join، لا auto-admin، لا permissions management، لا broadcasting.
"""
import asyncio

from config import validate, HEARTBEAT_INTERVAL_SECONDS
from telegram_client import build_client, ensure_logged_in
from api_client import send_heartbeat, close_session
from ingest_watcher import ENABLED as INGEST_ENABLED, ingest_loop


async def heartbeat_loop(username):
    while True:
        await send_heartbeat(username)
        await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)


async def main():
    print("[USERBOT] Starting...")
    validate()

    client = build_client()
    print("[USERBOT] Connecting to Telegram...")
    await ensure_logged_in(client)
    print("[USERBOT] Connected successfully")

    me = await client.get_me()
    username = me.username or str(me.id)
    print(f"[USERBOT] Logged in as: @{username}")
    print("[USERBOT] Ready")

    hb_task = asyncio.create_task(heartbeat_loop(username))
    ingest_task = None
    if INGEST_ENABLED:
        ingest_task = asyncio.create_task(ingest_loop(client))
    else:
        print("[USERBOT] ingest watcher disabled (set INGEST_ENABLED=1 to enable)")
    try:
        await client.run_until_disconnected()
    finally:
        hb_task.cancel()
        if ingest_task is not None:
            ingest_task.cancel()
            await asyncio.gather(ingest_task, return_exceptions=True)
        await close_session()


if __name__ == "__main__":
    asyncio.run(main())
