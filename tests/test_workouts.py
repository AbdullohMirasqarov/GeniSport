"""Exercise catalogue upgrade, workout retries, account isolation and battle timers."""
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient


class WorkoutFlow(unittest.TestCase):
    def test_workout_lifecycle(self):
        with tempfile.TemporaryDirectory() as directory:
            os.environ["GENISPORT_DB"] = str(Path(directory) / "test.db")
            from main import app
            from database import engine
            with TestClient(app) as client:
                def account(name):
                    data = {"username": name, "password": "training-pass"}
                    token = client.post("/api/auth/register", json=data).json()["access_token"]
                    self.assertEqual(client.post("/api/auth/login", json=data).status_code, 200)
                    return {"Authorization": "Bearer " + token}

                me = account("athlete_one")
                friend = account("athlete_two")
                client.patch("/api/auth/me", headers=me, json={"weight_kg": 80}).raise_for_status()
                for i in range(12):
                    exercise = ["push_ups", "squats", "pull_ups"][i % 3]
                    payload = dict(exercise_code=exercise, duration_seconds=60, reps_count=i+1,
                                   calories_burned=999, session_key=str(uuid.uuid4()))
                    first = client.post("/api/workouts", headers=me, json=payload).json()
                    again = client.post("/api/workouts", headers=me, json=payload).json()
                    self.assertEqual(first["id"], again["id"])
                    self.assertAlmostEqual(first["calories_burned"], 7.7 if exercise == "squats" else 11.2)
                self.assertEqual(client.get("/api/user/stats",headers=friend).json()["total_reps"], 0)
                stats = client.get("/api/user/stats",headers=me).json()
                self.assertEqual(stats["total_reps"], 78)
                self.assertEqual(stats["records"]["squats"], 11)
                self.assertEqual(len(stats["week"]), 7)
                self.assertEqual(sum(day["reps"] for day in stats["week"]), 78)
                self.assertEqual(len(client.get("/api/user/history?offset=10",headers=me).json()["items"]), 2)
                self.assertEqual(client.get("/api/leaderboard").json()["daily"][0]["total_reps"], 78)
                export = client.get("/api/user/workouts.csv", headers=me)
                self.assertEqual(len(export.text.splitlines()), 13)
                self.assertEqual(len(client.get("/api/user/workouts.csv", headers=friend).text.splitlines()), 1)
                room = client.post("/api/battles",headers=me,json=dict(mode="time_attack",target=1,exercise_code="squats")).json()
                url = "/ws/battle/" + room["room_code"]
                with client.websocket_connect(url) as host, client.websocket_connect(url) as guest:
                    for ws, headers in [(host,me),(guest,friend)]:
                        ws.send_json({"type":"join","token":headers["Authorization"].split()[1]})
                        self.assertEqual(ws.receive_json()["type"], "joined")
                    for ws in (host,guest):
                        ws.send_json({"type":"ready","ready":True})
                    for ws in (host,guest):
                        while (msg := ws.receive_json())["type"] != "game_over":
                            pass
                        self.assertEqual(msg["reason"], "time")
                        self.assertIsNone(msg["winner_id"])
                matches = client.get("/api/user/battles",headers=friend).json()["items"]
                self.assertEqual(matches[0]["result"], "Draw")
                self.assertEqual(matches[0]["opponent"], "athlete_one")
            engine.dispose()


if __name__ == "__main__":
    unittest.main()
