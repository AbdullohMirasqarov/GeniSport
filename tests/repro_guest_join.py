"""Repro for: 'Battle room closes immediately when guest joins'.

Two REAL users hit a REAL uvicorn server:
  1. user A: POST /api/battles  -> room code
  2. user A: WS join            -> stays open in lobby
  3. user B: WS join            -> guest
  4. hold 5s: neither socket may close; host must get opponent_joined
"""
import asyncio
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import websockets

BASE = "http://127.0.0.1:8017"
WS_BASE = "ws://127.0.0.1:8017"


def api(path, payload=None, token=None):
    req = urllib.request.Request(BASE + path, method="POST" if payload else "GET")
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    data = json.dumps(payload).encode() if payload else None
    with urllib.request.urlopen(req, data=data) as res:
        return json.loads(res.read().decode())


async def main():
    # Two distinct users (reused if they already exist from a previous run).
    users = {}
    for name in ("repro_host", "repro_guest"):
        try:
            res = api("/api/auth/register", {"username": name, "password": "hunter2", "weight_kg": 70})
        except Exception:
            res = api("/api/auth/login", {"username": name, "password": "hunter2"})
        users[name] = res["access_token"]

    room = api("/api/battles", {"exercise_code": "push_ups", "mode": "time_attack", "target": 60},
               users["repro_host"])
    code = room["room_code"]
    print(f"room created: {code}")

    closed = []

    async def watch(name, ws):
        try:
            async for _ in ws:
                pass
        except websockets.ConnectionClosed:
            closed.append(name)

    host_ws = await websockets.connect(f"{WS_BASE}/ws/battle/{code}?token={users['repro_host']}")
    wt = asyncio.create_task(watch("host", host_ws))
    await host_ws.send(json.dumps({"type": "join"}))
    msg = json.loads(await host_ws.recv())
    print("host after join:", msg["type"])
    assert msg["type"] == "joined", msg

    guest_ws = await websockets.connect(f"{WS_BASE}/ws/battle/{code}?token={users['repro_guest']}")
    wg = asyncio.create_task(watch("guest", guest_ws))
    await guest_ws.send(json.dumps({"type": "join"}))
    msg = json.loads(await guest_ws.recv())
    print("guest after join:", msg["type"])
    assert msg["type"] == "joined", msg

    # opponent_joined should reach the host.
    noticed = json.loads(await asyncio.wait_for(host_ws.recv(), 5))
    print("host receives:", noticed["type"])
    assert noticed["type"] == "opponent_joined", noticed

    print("holding 5s to prove sockets stay open…")
    await asyncio.sleep(5)

    if closed:
        print(f"FAILED — sockets closed prematurely: {closed}")
        raise SystemExit(1)

    for ws, name in ((host_ws, "host"), (guest_ws, "guest")):
        await ws.send(json.dumps({"type": "ready", "ready": False}))
        echo = json.loads(await asyncio.wait_for(ws.recv(), 5))
        print(f"{name} still exchangeable:", echo["type"])
    assert closed == [], closed

    print("REPRO OK — both sockets survived guest join + 5s hold")
    wt.cancel()
    wg.cancel()
    await host_ws.close()
    await guest_ws.close()


if __name__ == "__main__":
    asyncio.run(main())
