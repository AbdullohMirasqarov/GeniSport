"""GeniSport — battle.py

Real-time 1v1 workout battle rooms.

Architecture notes:
- Both players run MediaPipe Pose 100% client-side (pose.js + camera.js).
- Only lightweight JSON packets (reps, phase, ready state) cross the wire
  over WebSocket `/ws/battle/{room_code}`. The join message carries the JWT.
- The backend owns the room lifecycle: waiting -> countdown -> active ->
  finished, and persists the completed match into the `battles` table.
"""
import asyncio
import logging
import random
import threading
import time
import traceback
from datetime import datetime, timezone

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import auth
from database import SessionLocal, get_db
from models import Battle, Exercise, User
from schemas import BattleCreate, BattleRoomOut

logger = logging.getLogger("genisport")
router = APIRouter()

CODE_PREFIX = "GS"
MAX_BATTLE_SECONDS = 600  # hard cap so a target race can never hang forever


# ==================== REST auth helper ====================
# (kept local so this module can be imported without circular dependencies)
def _bearer_user(request: Request, db: Session) -> User | None:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    return auth.get_current_user(header.removeprefix("Bearer ").strip(), db)


def require_battle_user(request: Request, db: Session = Depends(get_db)) -> User:
    user = _bearer_user(request, db)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    return user


# ==================== In-memory room manager ====================
class Player:
    __slots__ = ("user_id", "username", "ws", "ready", "reps", "phase", "connected")

    def __init__(self, user_id: int, username: str):
        self.user_id = user_id
        self.username = username
        self.ws: WebSocket | None = None
        self.ready: bool = False
        self.reps: int = 0
        self.phase: str = "UP"
        self.connected: bool = False

    def as_dict(self) -> dict:
        return {
            "user_id": self.user_id,
            "username": self.username,
            "ready": self.ready,
            "reps": self.reps,
            "phase": self.phase,
            "connected": self.connected,
        }


class BattleRoom:
    __slots__ = (
        "code", "battle_id", "host", "guest", "config", "status",
        "started_at", "lock", "expire_task", "countdown_task",
    )

    def __init__(self, code: str, battle_id: int, host: Player, config: dict):
        self.code = code
        self.battle_id = battle_id
        self.host = host
        self.guest: Player | None = None
        self.config = config  # {exercise, mode, target}
        self.status = "waiting"
        self.started_at: float | None = None
        self.lock = threading.Lock()
        self.expire_task: asyncio.Task | None = None
        self.countdown_task: asyncio.Task | None = None  # single-flight 3-2-1


class BattleRoomManager:
    """Thread-safe in-memory registry of active battle rooms."""

    def __init__(self):
        self.rooms: dict[str, BattleRoom] = {}
        self._lock = threading.Lock()

    def register(self, room: BattleRoom) -> None:
        with self._lock:
            self.rooms[room.code] = room

    def get(self, code: str) -> BattleRoom | None:
        with self._lock:
            return self.rooms.get(code)

    def remove(self, code: str) -> None:
        with self._lock:
            self.rooms.pop(code, None)


manager = BattleRoomManager()


def _generate_code() -> str:
    """Room codes look like `GS-7482` (easy to read aloud and type)."""
    while True:
        code = f"{CODE_PREFIX}-{random.randint(100000, 999999)}"
        if code not in manager.rooms:
            return code


def normalize_code(raw: str) -> str:
    """Accept `GS-7482`, `gs7482` or plain `7482` from users."""
    cleaned = raw.strip().upper().replace(" ", "")
    digits = "".join(c for c in cleaned if c.isdigit())
    return f"{CODE_PREFIX}-{digits}" if digits else cleaned


# ==================== Broadcast helpers ====================
async def _send_to(player: Player | None, payload: dict) -> None:
    if player is None or player.ws is None or not player.connected:
        return
    try:
        await player.ws.send_json(payload)
    except Exception:  # pragma: no cover - connection already dying
        pass


async def broadcast(room: BattleRoom, payload: dict) -> None:
    await _send_to(room.host, payload)
    await _send_to(room.guest, payload)


# ==================== Match finalization ====================
def _persist_result(room: BattleRoom, winner: Player | None) -> None:
    """Write the completed match into the `battles` table."""
    db = SessionLocal()
    try:
        battle = db.get(Battle, room.battle_id)
        if battle is None:
            return
        battle.creator_reps = int(room.host.reps)
        battle.opponent_reps = int(room.guest.reps) if room.guest else 0
        battle.opponent_id = room.guest.user_id if room.guest else None
        battle.winner_id = winner.user_id if winner else None
        battle.completed_at = datetime.now(timezone.utc)
        db.commit()
    finally:
        db.close()


async def finalize(room: BattleRoom, winner: Player | None, reason: str) -> None:
    """Finish a match exactly once: persist result + notify both players."""
    with room.lock:
        if room.status == "finished":
            return
        room.status = "finished"

    _cancel_expire(room)
    _persist_result(room, winner)

    payload = {
        "type": "game_over",
        "winner_id": winner.user_id if winner else None,
        "creator_reps": int(room.host.reps),
        "opponent_reps": int(room.guest.reps) if room.guest else 0,
        "reason": reason,
    }
    await broadcast(room, payload)
    manager.remove(room.code)
    logger.info("Battle %s finished (%s) — winner=%s", room.code, reason, winner.user_id if winner else "tie")


def _cancel_expire(room: BattleRoom) -> None:
    if room.expire_task is not None:
        if room.expire_task is not asyncio.current_task():
            room.expire_task.cancel()
        room.expire_task = None


# ==================== Countdown / expiry ====================
async def _run_countdown(room: BattleRoom) -> None:
    """3-2-1 → battle_start, with disconnect safeguarding."""
    try:
        # A player may have bailed between ready and countdown.
        if room.guest is None or not (room.host.connected and room.guest.connected):
            with room.lock:
                if room.status == "countdown":
                    room.status = "waiting"
                room.countdown_task = None
            await broadcast(room, {"type": "ready_state",
                                   "host_ready": room.host.ready,
                                   "guest_ready": room.guest.ready if room.guest else False})
            return

        for seconds in (3, 2, 1):
            await broadcast(room, {"type": "countdown", "seconds": seconds})
            await asyncio.sleep(1)
        logger.info("Battle %s → active (mode=%s target=%s)", room.code, room.config["mode"], room.config["target"])

        with room.lock:
            if room.status != "countdown":
                return
            room.status = "active"
            room.started_at = time.time()
            start_ts = room.started_at

        await broadcast(room, {
            "type": "battle_start",
            "config": room.config,
            # Authoritative match-clock inputs: both clients start their banner
            # from the SAME server timestamp, so the two screens stay in sync.
            "duration": room.config["target"],
            "start_time": start_ts,
            "start_ts": start_ts,
        })

        duration = room.config["target"] if room.config["mode"] == "time_attack" else MAX_BATTLE_SECONDS
        room.expire_task = asyncio.create_task(_expire_later(room, duration))
    except Exception:  # pragma: no cover
        logger.exception("Countdown task failed for room %s", room.code)


async def _expire_later(room: BattleRoom, seconds: int) -> None:
    await asyncio.sleep(seconds)
    with room.lock:
        still_active = room.status == "active"
    if still_active:
        winner = _leading_player(room)
        await finalize(room, winner, "time")


def _leading_player(room: BattleRoom) -> Player | None:
    host = room.host.reps
    guest = room.guest.reps if room.guest else 0
    if host > guest:
        return room.host
    if guest > host:
        return room.guest
    return None


# ==================== REST: create room ====================
@router.post("/api/battles", response_model=BattleRoomOut, status_code=201)
def create_room(
    payload: BattleCreate,
    current_user: User = Depends(require_battle_user),
    db: Session = Depends(get_db),
):
    """Create a battle room and return its shareable code."""
    exercise = db.query(Exercise).filter(Exercise.code == payload.exercise_code).first()
    if exercise is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown exercise '{payload.exercise_code}'")

    last_exc: Exception | None = None
    for _ in range(5):
        code = _generate_code()
        battle = Battle(
            room_code=code,
            creator_id=current_user.id,
            exercise_code=payload.exercise_code,
            mode=payload.mode,
            target_value=payload.target,
        )
        db.add(battle)
        try:
            db.commit()
            db.refresh(battle)
        except IntegrityError as exc:  # ultra-rare code collision
            db.rollback()
            last_exc = exc
            continue

        host = Player(current_user.id, current_user.username)
        room = BattleRoom(
            code=code,
            battle_id=battle.id,
            host=host,
            config={"exercise": payload.exercise_code, "mode": payload.mode, "target": payload.target},
        )
        manager.register(room)
        logger.info("Battle room %s created by %s", code, current_user.username)
        return BattleRoomOut(
            room_code=code,
            exercise_code=payload.exercise_code,
            mode=payload.mode,
            target_value=payload.target,
        )

    raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Could not allocate a room code")


# ==================== WebSocket: /ws/battle/{room_code} ====================
def _room_state_payload(role: str, room: BattleRoom) -> dict:
    return {
        "type": "joined",
        "role": role,
        "code": room.code,
        "status": room.status,
        "config": room.config,
        "host": room.host.as_dict(),
        "guest": room.guest.as_dict() if room.guest else None,
    }


@router.websocket("/ws/battle/{room_code}")
async def battle_ws(
    websocket: WebSocket,
    room_code: str,
    token: str = Query(default=""),
):
    """Lightweight battle channel — join / ready / update / finish.

    Every message path is logged on disconnect/exception so a dropped room
    can always be diagnosed from the server log.
    """
    await websocket.accept()

    first_message = None
    if not token:
        try:
            first_message = await asyncio.wait_for(websocket.receive_json(), timeout=8)
        except (TimeoutError, ValueError, WebSocketDisconnect):
            return
        token = first_message.get("token", "") if isinstance(first_message, dict) else ""
        if not isinstance(token, str):
            token = ""
    user = None
    db = SessionLocal()
    try:
        user = auth.get_current_user(token.strip(), db)
    finally:
        db.close()

    if user is None:
        logger.warning("Battle WS: rejected unauthenticated client for room %s", room_code)
        await websocket.send_json({"type": "error", "detail": "Invalid or expired token — sign in again."})
        await websocket.close(code=4401)
        return

    logger.info("Battle WS: connection open — user=%s (sub=%s) room=%s", user.username, user.id, room_code)
    try:
        while True:
            msg = first_message if first_message is not None else await websocket.receive_json()
            first_message = None
            handled = await _handle_message(websocket, user, room_code, msg)
            if not handled:
                break
    except WebSocketDisconnect:
        logger.info("Battle WS: user disconnected normally: %s (sub=%s) room=%s", user.username, user.id, room_code)
        await _handle_disconnect(user, room_code, websocket)
    except Exception as exc:
        logger.error("FATAL WS EXCEPTION in room %s (user=%s): %s", room_code, user.username, exc)
        traceback.print_exc()
        try:
            await _handle_disconnect(user, room_code, websocket)
        except Exception:
            logger.error("Disconnect handler also failed for room %s:", room_code)
            traceback.print_exc()


async def _handle_message(ws: WebSocket, user: User, room_code: str, msg: dict) -> bool:
    """Process one client message. Returns False to drop the connection."""
    if not isinstance(msg, dict):
        return True
    mtype = msg.get("type")

    # ---------- join ----------
    # NOTE: joining NEVER removes the room — guest arrival only appends state.
    # Room teardown happens solely on host lobby departure or match completion.
    if mtype == "join":
        code = normalize_code(room_code)
        room = manager.get(code)
        if room is None:
            logger.info("Battle join: room %s not found (requester=%s)", code, user.username)
            await _safe_send(ws, {"type": "error", "detail": f"Room '{code}' not found or already closed."})
            return False

        # Socket handlers share one event loop. Assign the slot before the first await.
        existing = _find_player(room, user.id)
        if room.status != "waiting":
            await _safe_send(ws, {"type": "error", "detail": "This battle has already started."})
            return False
        if existing is None:
            if room.guest is not None:
                await _safe_send(ws, {"type": "error", "detail": "Room is full."})
                return False
            room.guest = Player(user.id, user.username)
            existing = room.guest
        role = "host" if existing is room.host else "guest"
        existing.ws = ws
        existing.connected = True
        existing.ready = False
        my_state = _room_state_payload(role, room)

        if role == "guest":
            logger.info("Battle join: guest=%s (sub=%s) joined room %s", user.username, user.id, room.code)
            await _send_to(room.host, {
                "type": "opponent_joined",
                "username": user.username,
            })

        await _safe_send(ws, my_state)
        return True

    room = manager.get(normalize_code(room_code))
    player = _find_player(room, user.id) if room else None
    if player is None or player.ws is not ws:
        return False

    # ---------- ready ----------
    if mtype == "ready":
        room = manager.get(normalize_code(room_code))
        if room is None:
            return False
        with room.lock:
            if room.status != "waiting":
                return True  # toggles are locked once the countdown starts

            is_host = user.id == room.host.user_id
            me = room.host if is_host else (room.guest if room.guest and room.guest.user_id == user.id else None)
            if me is None:
                return True
            me.ready = bool(msg.get("ready", not me.ready))
            both_ready = room.guest is not None and room.host.ready and room.guest.ready
            if both_ready:
                room.status = "countdown"
            payload = {"type": "ready_state",
                       "host_ready": room.host.ready,
                       "guest_ready": room.guest.ready if room.guest else False}

        await broadcast(room, payload)
        # Single-flight guard: duplicate ready events (double-clicks, replayed
        # messages) can never spawn a second overlapping countdown task —
        # that is what produces repeating ticks like "3-3-3" / "1-1-1-1".
        if both_ready and (room.countdown_task is None or room.countdown_task.done()):
            room.countdown_task = asyncio.create_task(_run_countdown(room))
        return True

    # ---------- update ----------
    if mtype == "update":
        room = manager.get(normalize_code(room_code))
        if room is None:
            return False
        with room.lock:
            me = _find_player(room, user.id)
            opp = _find_opponent(room, user.id)
            if me is None:
                return True
            reps = msg.get("reps", me.reps)
            if room.status != "active" or type(reps) is not int or not me.reps <= reps <= 100000:
                return True
            me.reps = reps
            me.phase = str(msg.get("phase", me.phase))[:24]
            target = room.config["target"]
            hit_target = (
                room.status == "active"
                and room.config["mode"] == "first_to_target"
                and me.reps >= target
            )
        if opp is not None:
            await _send_to(opp, {"type": "opponent_update", "reps": me.reps, "phase": me.phase})
        if hit_target:
            await finalize(room, me, "target")
        return True

    # ---------- finish (client-initiated, e.g. explicit forfeit) ----------
    if mtype == "finish":
        room = manager.get(normalize_code(room_code))
        if room is None:
            return False
        with room.lock:
            waiting = room.status == "waiting"
            if waiting:
                opp = _find_opponent(room, user.id)
            else:
                opp = None
        if waiting:
            # Same as a clean lobby departure.
            await _depart_waiting(room, user.id)
            return True
        me = _find_player(room, user.id)
        await finalize(room, _find_opponent(room, user.id), "forfeit")
        return False

    # ---------- unknown ----------
    await _safe_send(ws, {"type": "error", "detail": f"Unknown message type '{mtype}'."})
    return True


def _find_player(room: BattleRoom, user_id: int) -> Player | None:
    if room.host.user_id == user_id:
        return room.host
    if room.guest and room.guest.user_id == user_id:
        return room.guest
    return None


def _find_opponent(room: BattleRoom, user_id: int) -> Player | None:
    if room.host.user_id == user_id:
        return room.guest
    return room.host


async def _depart_waiting(room: BattleRoom, user_id: int) -> None:
    """Clean removal from a lobby that never started."""
    with room.lock:
        leaving_host = room.host.user_id == user_id
        if room.status != "waiting":
            return
        if leaving_host:
            room.host.connected = False
            room.host.ws = None
            manager.remove(room.code)
            notify = room.guest
            room.guest = None
        else:
            if room.guest:
                room.guest.ws = None
                room.guest.connected = False
            room.guest = None
            room.host.ready = False
            notify = room.host
    await _send_to(notify, {
        "type": "opponent_left",
        "detail": "Left the room." if not leaving_host else "Host closed the room.",
        "closed": leaving_host,
    })


async def _handle_disconnect(user: User, room_code: str, ws: WebSocket) -> None:
    code = normalize_code(room_code)
    room = manager.get(code)
    if room is None:
        return

    with room.lock:
        player = _find_player(room, user.id)
        if player is None or player.ws is not ws:
            return
        waiting = room.status == "waiting"
        if waiting:
            me = _find_player(room, user.id)
            if me is not None:
                me.connected = False
                me.ws = None
        else:
            active = room.status in ("countdown", "active")
            me = _find_player(room, user.id)
            if me is not None:
                me.connected = False
                me.ws = None
            opp = _find_opponent(room, user.id) if me else None

    if waiting:
        await _depart_waiting(room, user.id)
        return

    if active:  # battle in progress → forfeit win for whoever stayed
        await finalize(room, opp, "forfeit")


async def _safe_send(ws: WebSocket, payload: dict) -> None:
    try:
        await ws.send_json(payload)
    except Exception:  # pragma: no cover
        pass
