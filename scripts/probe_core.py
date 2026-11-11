"""Read-only probe of the live herdr-core with app.core_client."""
import asyncio, sys, time
sys.path.insert(0, "/opt/lcars-herdr")
from app.core_client import Core, DATA, CLOSE, RESIZE

async def main():
    core = await Core().connect()
    h = core.hello
    print("connected:", core.path)
    print("hello keys:", sorted(h.keys()))
    print("core:", h.get("core"), "| features:", h.get("features"))

    lst = await core.call("terminal.list")
    print("\nterminals:")
    for t in lst["terminals"]:
        print("  ", t["address"], t.get("name"), t.get("status"), t.get("state"), t.get("where"))

    target = next((t["address"] for t in lst["terminals"] if t.get("state") == "live"), None)
    if target:
        stream, res = await core.attach(target, 120, 30, observe=True, history=0)
        print(f"\nattached (observe) to {target}: channel={res['channel']} "
              f"resize_notifications={res['resize_notifications']} automatic_input={res['automatic_input']}")
        total, first = 0, None
        t0 = time.time()
        while time.time() - t0 < 1.5:
            try:
                kind, payload = await asyncio.wait_for(stream.recv(), 0.5)
            except asyncio.TimeoutError:
                break
            if kind == DATA:
                total += len(payload); first = first or payload
            elif kind == RESIZE:
                print("  RESIZE", payload)
            elif kind == CLOSE:
                print("  CLOSE", stream.close_reason); break
        print(f"first paint: {total} bytes; starts: {first[:120]!r}")
        await stream.detach()

    snap, feed = await core.subscribe()
    print(f"\nsubscribed: seq={snap['seq']} terminals={len(snap['terminals'])}")
    try:
        ev = await asyncio.wait_for(feed.next(), 17)
        print("first notification:", str(ev)[:200])
    except asyncio.TimeoutError:
        print("no notification in 17s")
    await feed.close()
    await core.close()

asyncio.run(main())
