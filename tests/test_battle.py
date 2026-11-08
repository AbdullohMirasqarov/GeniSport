"""GeniSport — battle WebSocket lifecycle tests (FastAPI TestClient).

Covers:
- REST room creation + unknown-room error handling
- join / ready / countdown / battle_start message flow
- live opponent update relay
- target-race finish, forfeit finish, and DB persistence
"""
import os
import sys
import uuid
import tempfile

_test_dir = tempfile.TemporaryDirectory()
os.environ.setdefault("GENISPORT_DB", os.path.join(_test_dir.name, "battle.db"))

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient

import main
from database import SessionLocal
from models import Battle

passed = 0


def check(cond, label):
    global passed
    if not cond:
        print(f"  FAIL - {label}")
        raise SystemExit(1)
    print(f"  ok - {label}")
    passed += 1


def make_user(client, username):
    r = client.post(
        "/api/auth/register",
        json={"username": username, "password": "hunter2", "weight_kg": 70},
    )
    assert r.status_code == 201, r.text
    return r.json()["access_token"]


def user_id(client, token):
    return client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).json()["id"]


def wait_for(ws, mtype, limit=30, predicate=None):
    """Read messages until one of the wanted type (matching predicate) arrives."""
    for _ in range(limit):
        m = ws.receive_json()
        if m["type"] == mtype and (predicate is None or predicate(m)):
            return m
    raise AssertionError(f"never received a '{mtype}' message matching conditions")


def run_battle_flow(client, tok1, tok2, id1, id2):
    """Target race: first to 1 rep wins. Returns the room code."""
    r = client.post(
        "/api/battles",
        json={"exercise_code": "push_ups", "mode": "first_to_target", "target": 1},
        headers={"Authorization": f"Bearer {tok1}"},
    )
    assert r.status_code == 201, r.text
    code = r.json()["room_code"]

    with client.websocket_connect(f"/ws/battle/{code}?token={tok1}") as ws1, \
         client.websocket_connect(f"/ws/battle/{code}?token={tok2}") as ws2:

        ws1.send_json({"type": "join"})
        joined = ws1.receive_json()
        check(joined["type"] == "joined" and joined["role"] == "host", "host joins and gets full room state")
        check(joined["config"]["mode"] == "first_to_target" and joined["config"]["target"] == 1,
              "room config relayed on join")

        ws2.send_json({"type": "join"})
        j2 = ws2.receive_json()
        check(j2["type"] == "joined" and j2["role"] == "guest", "guest joins with guest role")

        noticed = wait_for(ws1, "opponent_joined")
        check(noticed["username"].startswith("battle_b_"), "host notified when guest joins")

        # Host readies first → only a ready_state broadcast, no countdown yet.
        ws1.send_json({"type": "ready", "ready": True})
        rs = wait_for(ws2, "ready_state", predicate=lambda m: m["host_ready"] is True and m["guest_ready"] is False)
        check(rs["host_ready"] is True and rs["guest_ready"] is False, "ready toggle broadcast to guest")

        # Guest readies → both ready → server countdown 3-2-1 → battle_start.
        ws2.send_json({"type": "ready", "ready": True})
        rs2 = wait_for(ws1, "ready_state", predicate=lambda m: m["guest_ready"] is True)
        check(rs2["guest_ready"] is True and rs2["host_ready"] is True, "both-ready state broadcast")

        # Drain EVERY message until battle_start so the countdown sequence can
        # be asserted exactly: one tick per second value, in order, never
        # repeated (the "3-3-3" / "1-1-1-1" glitch).
        def drain_until_start(ws, limit=40):
            seq = []
            start = None
            for _ in range(limit):
                m = ws.receive_json()
                if m["type"] == "countdown":
                    seq.append(m["seconds"])
                elif m["type"] == "battle_start":
                    start = m
                    break
            assert start is not None, "battle_start never arrived"
            return seq, start

        seq1, start1 = drain_until_start(ws1)
        seq2, start2 = drain_until_start(ws2)
        check(seq1 == [3, 2, 1], f"host countdown ticks exactly 3-2-1 once (got {seq1})")
        check(seq2 == [3, 2, 1], f"guest countdown ticks exactly 3-2-1 once (got {seq2})")
        check(start1["type"] == "battle_start" and start1["config"]["target"] == 1,
              "host received battle_start with config")
        check(start2["type"] == "battle_start", "guest received battle_start")
        check(start1.get("duration") == 1 and isinstance(start1.get("start_time"), (int, float)),
              "battle_start carries authoritative duration + start_time")

        # Live update relay host → guest.
        ws1.send_json({"type": "update", "reps": 1, "phase": "UP"})
        upd = wait_for(ws2, "opponent_update")
        check(upd["reps"] == 1 and upd["phase"] == "UP", "opponent_update relays reps and phase")

        # Target hit → immediate game_over for both, host wins.
        go2 = wait_for(ws2, "game_over")
        go1 = wait_for(ws1, "game_over")
        check(go1["winner_id"] == id1 and go1["reason"] == "target", "host wins target race")
        check(go2["winner_id"] == id1, "guest sees same winner")

    # DB persistence
    db = SessionLocal()
    try:
        b = db.query(Battle).filter(Battle.room_code == code).one()
        check(b.winner_id == id1, "battle row winner_id persisted")
        check(b.creator_reps == 1 and b.opponent_id == id2, "battle reps + opponent persisted")
        check(b.completed_at is not None, "battle completed_at persisted")
    finally:
        db.close()
    return code


def run_forfeit_flow(client, tok1, tok2, id1, id2):
    """Time attack: guest forfeits mid-battle → host wins by forfeit."""
    r = client.post(
        "/api/battles",
        json={"exercise_code": "push_ups", "mode": "time_attack", "target": 30},
        headers={"Authorization": f"Bearer {tok2}"},
    )
    assert r.status_code == 201, r.text
    code = r.json()["room_code"]

    with client.websocket_connect(f"/ws/battle/{code}?token={tok2}") as ws2, \
         client.websocket_connect(f"/ws/battle/{code}?token={tok1}") as ws1:

        ws2.send_json({"type": "join"})
        wait_for(ws2, "joined")
        ws1.send_json({"type": "join"})
        wait_for(ws1, "joined")
        wait_for(ws2, "opponent_joined")

        ws2.send_json({"type": "ready", "ready": True})
        wait_for(ws1, "ready_state")
        ws1.send_json({"type": "ready", "ready": True})

        wait_for(ws2, "battle_start")
        wait_for(ws1, "battle_start")

        # Guest forfeits by sending finish.
        ws1.send_json({"type": "finish"})
        go1 = wait_for(ws1, "game_over")
        go2 = wait_for(ws2, "game_over")
        check(go1["reason"] == "forfeit" and go1["winner_id"] == id2, "forfeit awards win to remaining player")
        check(go2["winner_id"] == id2, "host game_over consistent")

    db = SessionLocal()
    try:
        b = db.query(Battle).filter(Battle.room_code == code).one()
        check(b.winner_id == id2, "forfeit winner persisted")
        check(b.mode == "time_attack" and b.target_value == 30, "time_attack mode persisted")
    finally:
        db.close()
    return code


def main_tests():
    with TestClient(main.app) as client:
        suffix = uuid.uuid4().hex[:6]
        tok1 = make_user(client, f"battle_a_{suffix}")
        tok2 = make_user(client, f"battle_b_{suffix}")
        id1 = user_id(client, tok1)
        id2 = user_id(client, tok2)

        print("== full target race lifecycle ==")
        run_battle_flow(client, tok1, tok2, id1, id2)

        print("== forfeit during active battle ==")
        run_forfeit_flow(client, tok1, tok2, id1, id2)

        print("== unknown room / invalid token ==")
        with client.websocket_connect(f"/ws/battle/GS-9999?token={tok1}") as ws:
            ws.send_json({"type": "join"})
            m = ws.receive_json()
            check(m["type"] == "error" and "not found" in m["detail"], "joining unknown room errors cleanly")

        with client.websocket_connect("/ws/battle/GS-1234?token=garbage") as ws:
            ws.send_json({"type": "join"})
            m = ws.receive_json()
            check(m["type"] == "error", "invalid token rejected")

        print("== unauthenticated REST ==")
        r = client.post("/api/battles", json={"exercise_code": "push_ups", "mode": "time_attack", "target": 60})
        check(r.status_code == 401, "room creation requires auth")

        print("== lobby departures (player_left) ==")
        # Host leaving a waiting room tears it down entirely.
        r = client.post(
            "/api/battles",
            json={"exercise_code": "push_ups", "mode": "time_attack", "target": 60},
            headers={"Authorization": f"Bearer {tok1}"},
        )
        code3 = r.json()["room_code"]
        with client.websocket_connect(f"/ws/battle/{code3}?token={tok1}") as ws:
            ws.send_json({"type": "join"})
            wait_for(ws, "joined")
        with client.websocket_connect(f"/ws/battle/{code3}?token={tok1}") as ws:
            ws.send_json({"type": "join"})
            m = ws.receive_json()
            check(m["type"] == "error" and "not found" in m["detail"],
                  "host lobby departure removes the room")

        # Guest leaving a waiting room only notifies the host.
        r = client.post(
            "/api/battles",
            json={"exercise_code": "push_ups", "mode": "time_attack", "target": 60},
            headers={"Authorization": f"Bearer {tok1}"},
        )
        code4 = r.json()["room_code"]
        with client.websocket_connect(f"/ws/battle/{code4}?token={tok1}") as ws1:
            ws1.send_json({"type": "join"})
            wait_for(ws1, "joined")
            with client.websocket_connect(f"/ws/battle/{code4}?token={tok2}") as ws2:
                ws2.send_json({"type": "join"})
                wait_for(ws2, "joined")
                wait_for(ws1, "opponent_joined")
                # ws2 leaves by ending its context — ws1 must be told.
            left = wait_for(ws1, "opponent_left")
            check("left" in left["detail"].lower(), "host notified when guest departs lobby")


if __name__ == "__main__":
    main_tests()
    print(f"ALL BATTLE TESTS PASSED ({passed} checks)")
