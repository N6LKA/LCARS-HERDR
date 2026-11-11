"""End-to-end test of the web server against the live core (creates and removes one scratch shell)."""
import asyncio, json, sys
from pathlib import Path
import httpx, websockets

BASE = "http://127.0.0.1:7843"
env = dict(l.split("=", 1) for l in Path("/opt/lcars-herdr/.env").read_text().splitlines() if "=" in l)
TOKEN = env["LCARS_TOKEN"]

async def main():
    async with httpx.AsyncClient(base_url=BASE) as c:
        r = await c.post("/api/login", json={"token": TOKEN}); print("login:", r.status_code)
        cookie = c.cookies.get("lcars_session")
        print("status:", (await c.get("/api/status")).json().get("version"))
        r = await c.post("/api/terminals", json={"kind": "shell", "name": "lcars-e2e", "cwd": "/tmp"})
        print("create shell:", r.status_code, r.json().get("address") if r.status_code == 200 else r.text[:200])
        tid = r.json()["address"]
        names = [t.get("name") for t in (await c.get("/api/terminals")).json()["terminals"]]
        print("listed:", "lcars-e2e" in names)

        # live stream: attach, type a command, read the echo
        async with websockets.connect(f"ws://127.0.0.1:7843/ws/term?terminal={tid}&cols=100&rows=30",
                                      additional_headers={"Cookie": f"lcars_session={cookie}"}) as ws:
            print("attached:", json.loads(await ws.recv()))
            out = b""
            async def read_for(sec):
                nonlocal out
                end = asyncio.get_event_loop().time() + sec
                while (left := end - asyncio.get_event_loop().time()) > 0:
                    try: m = await asyncio.wait_for(ws.recv(), left)
                    except asyncio.TimeoutError: break
                    if isinstance(m, bytes): out += m
            await read_for(1.0)
            await ws.send(json.dumps({"type": "input", "data": "echo LCARS-$((6*7))-OK\r"}))
            await read_for(1.5)
            print("typed command echoed back:", b"LCARS-42-OK" in out, f"({len(out)} bytes of output)")
            await ws.send(json.dumps({"type": "resize", "cols": 90, "rows": 24}))
            await asyncio.sleep(0.3)

        # upload beside the terminal (image/doc drop path)
        r = await c.post("/api/terminals/upload", data={"terminal": tid}, files={"file": ("note.txt", b"hello from lcars\n")})
        print("upload:", r.status_code, r.json())

        # layout document round trip
        d = (await c.get("/api/doc/lcars-e2e")).json(); print("doc get:", d)
        r = await c.put("/api/doc/lcars-e2e", json={"value": {"panes": [tid]}, "version": d["version"]}); print("doc set:", r.status_code, r.text[:120])
        await c.put("/api/doc/lcars-e2e", json={"value": None, "version": (await c.get("/api/doc/lcars-e2e")).json()["version"]})

        # events feed sees the kill
        async with websockets.connect("ws://127.0.0.1:7843/ws/events",
                                      additional_headers={"Cookie": f"lcars_session={cookie}"}) as ev:
            snap = json.loads(await ev.recv()); print("events snapshot terminals:", len(snap["terminals"]))
            k = await c.delete("/api/terminals", params={"terminal": tid}); print("kill:", k.status_code)
            seen = []
            try:
                while True:
                    m = json.loads(await asyncio.wait_for(ev.recv(), 4))
                    if m.get("method") == "event": seen.append(m["params"]["type"])
            except asyncio.TimeoutError: pass
            print("events after kill:", seen)
        await c.post("/api/terminals/remove", params={"terminal": tid})
        left = [t.get("name") for t in (await c.get("/api/terminals", params={"all": True})).json()["terminals"]]
        print("scratch terminal gone:", "lcars-e2e" not in left)

        # cross-site WebSocket is refused
        try:
            async with websockets.connect(f"ws://127.0.0.1:7843/ws/events",
                    additional_headers={"Cookie": f"lcars_session={cookie}", "Origin": "https://evil.example"}) as bad:
                await bad.recv(); print("cross-origin ws: ALLOWED (bad)")
        except Exception as e: print("cross-origin ws refused:", type(e).__name__)
asyncio.run(main())
