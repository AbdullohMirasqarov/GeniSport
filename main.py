"""GeniSport — AI push-up counter web app (FastAPI entrypoint)."""
import csv
import io
import asyncio
import logging
import os
import sqlite3
import tempfile
import hmac
from contextlib import asynccontextmanager, closing, suppress
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, Query, UploadFile, status
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func
from sqlalchemy.orm import Session

import auth
import httpx
from battle import router as battle_router
from database import DB_PATH, engine, get_db, init_db
from models import Battle, Exercise, User, Workout, WorkoutReceipt
from schemas import (
    ExerciseBadge,
    HistoryOut,
    LeaderboardEntry,
    LeaderboardOut,
    LoginRequest,
    RegisterRequest,
    StatsOut,
    TokenResponse,
    UserOut,
    WeightUpdate,
    WorkoutCreate,
    WorkoutOut,
)

logger = logging.getLogger("genisport")

async def send_database_backup() -> bool:
    token = os.getenv("BACKUP_BOT_TOKEN")
    chat_id = os.getenv("BACKUP_CHAT_ID")
    if not token or not chat_id:
        logger.info("Daily database backup is not configured yet.")
        return False

    source = engine.raw_connection()
    backup_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False) as backup_file:
            backup_path = backup_file.name
        with closing(sqlite3.connect(backup_path)) as target:
            source.driver_connection.backup(target)

        name = f"genisport-backup-{datetime.now(ZoneInfo('Asia/Tashkent')).date()}.sqlite3"
        async with httpx.AsyncClient(timeout=30) as client:
            with open(backup_path, "rb") as backup_file:
                response = await client.post(
                    f"https://api.telegram.org/bot{token}/sendDocument",
                    data={"chat_id": chat_id, "caption": f"GeniSport daily backup · {name}"},
                    files={"document": (name, backup_file, "application/vnd.sqlite3")},
                )
            response.raise_for_status()
            if not response.json().get("ok"):
                raise RuntimeError("Telegram rejected the database backup.")
        logger.info("Daily database backup sent to the configured private Telegram chat.")
        return True
    except Exception:
        logger.exception("The GeniSport database backup could not be sent.")
        return False
    finally:
        source.close()
        if backup_path:
            Path(backup_path).unlink(missing_ok=True)


async def daily_backup_loop() -> None:
    while True:
        if not await send_database_backup():
            # Retry configuration/network failures without waiting for the next day.
            await asyncio.sleep(15 * 60)
            continue
        now = datetime.now(ZoneInfo("Asia/Tashkent"))
        tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        await asyncio.sleep((tomorrow - now).total_seconds())


@asynccontextmanager
async def lifespan(app):
    init_db()
    backup_task = asyncio.create_task(daily_backup_loop())
    try:
        yield
    finally:
        backup_task.cancel()
        with suppress(asyncio.CancelledError):
            await backup_task


app = FastAPI(title="GeniSport API", version="2.0.0", lifespan=lifespan)

app.include_router(battle_router)


@app.get("/health", include_in_schema=False)
def health():
    """Lightweight liveness probe. It intentionally does not query the database."""
    return {"status": "ok"}


@app.post("/admin/database/restore", include_in_schema=False)
async def restore_database(
    backup: UploadFile = File(...),
    restore_key: str = Header(default="", alias="X-Backup-Restore-Key"),
):
    """Restore a private Telegram backup. Keep RESTORE_KEY secret."""
    expected_key = os.getenv("RESTORE_KEY", "")
    if not expected_key or not hmac.compare_digest(restore_key.encode(), expected_key.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid restore key.")
    if engine.dialect.name != "sqlite":
        raise HTTPException(status.HTTP_409_CONFLICT, "Restore endpoint requires SQLite.")
    if backup.filename is None or not backup.filename.endswith(".sqlite3"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Upload a .sqlite3 backup file.")

    content = await backup.read(50 * 1024 * 1024 + 1)
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Backup must be smaller than 50 MB.")

    candidate_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False) as candidate_file:
            candidate_path = candidate_file.name
            candidate_file.write(content)

        with closing(sqlite3.connect(candidate_path)) as candidate:
            integrity = candidate.execute("PRAGMA integrity_check").fetchone()
            tables = {row[0] for row in candidate.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )}
            required = {"users", "workouts", "exercises", "battles"}
            if integrity != ("ok",) or not required.issubset(tables):
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "This GeniSport backup is invalid.")

            with closing(sqlite3.connect(DB_PATH)) as current:
                candidate.backup(current)
                current.commit()

        init_db()
        return {"status": "restored"}
    finally:
        if candidate_path:
            Path(candidate_path).unlink(missing_ok=True)


# --- Static files ---
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

@app.get("/manifest.webmanifest", include_in_schema=False)
def serve_manifest():
    return FileResponse(os.path.join(STATIC_DIR, "manifest.webmanifest"),
                        media_type="application/manifest+json")


@app.get("/service-worker.js", include_in_schema=False)
def serve_service_worker():
    return FileResponse(os.path.join(STATIC_DIR, "service-worker.js"),
                        media_type="application/javascript",
                        headers={"Service-Worker-Allowed": "/"})


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def serve_index():
    """Serve the SPA entrypoint."""
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


# --- Dependency: resolve current user from Authorization header ---
def require_user(request: Request, db: Session = Depends(get_db)) -> User:
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = auth_header.removeprefix("Bearer ").strip()
    user = auth.get_current_user(token, db)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


# ==================== AUTH ====================

@app.post("/api/auth/register", response_model=TokenResponse, status_code=201)
def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    """Create a new account and return a JWT immediately."""
    exists = db.query(User).filter(func.lower(User.username) == payload.username.lower()).first()
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, "Username already taken")

    user = User(
        username=payload.username,
        password_hash=auth.hash_password(payload.password),
        weight_kg=payload.weight_kg,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Username already taken")
    db.refresh(user)

    return TokenResponse(access_token=auth.create_access_token(user.id))


@app.post("/api/auth/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    """Verify credentials and return a JWT."""
    user = db.query(User).filter(func.lower(User.username) == payload.username.lower()).first()
    if not user or not auth.verify_password(payload.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid username or password")

    return TokenResponse(access_token=auth.create_access_token(user.id))


@app.get("/api/auth/me", response_model=UserOut)
def me(current_user: User = Depends(require_user)):
    return current_user


@app.patch("/api/auth/me", response_model=UserOut)
def update_me(
    payload: WeightUpdate,
    current_user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Update the user's body weight (used for calorie estimation)."""
    current_user.weight_kg = payload.weight_kg
    db.commit()
    db.refresh(current_user)
    return current_user


# ==================== WORKOUTS / STATS ====================

@app.post("/api/workouts", response_model=WorkoutOut, status_code=201)
def save_workout(
    payload: WorkoutCreate,
    current_user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Persist a completed workout session."""
    exercise = db.query(Exercise).filter(Exercise.code == payload.exercise_code).first()
    if exercise is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown exercise '{payload.exercise_code}'")

    key = (current_user.id, str(payload.session_key))
    if payload.session_key and (receipt := db.get(WorkoutReceipt, key)):
        return db.get(Workout, receipt.workout_id)
    workout = Workout(
        user_id=current_user.id,
        exercise_code=exercise.code,
        reps_count=payload.reps_count,
        duration_seconds=payload.duration_seconds,
        calories_burned=round(exercise.met_value * 3.5 * current_user.weight_kg / 200 * payload.duration_seconds / 60, 1),
    )
    db.add(workout)
    try:
        db.flush()
        if payload.session_key:
            db.add(WorkoutReceipt(user_id=key[0], session_key=key[1], workout_id=workout.id))
        db.commit()
    except IntegrityError:
        db.rollback()
        receipt = db.get(WorkoutReceipt, key)
        if receipt is None:
            raise
        return db.get(Workout, receipt.workout_id)
    db.refresh(workout)
    return workout


@app.get("/api/user/stats", response_model=StatsOut)
def user_stats(current_user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Aggregate totals for the current user."""
    row = (
        db.query(
            func.coalesce(func.sum(Workout.reps_count), 0).label("reps"),
            func.coalesce(func.count(Workout.id), 0).label("sessions"),
            func.coalesce(func.sum(Workout.duration_seconds), 0).label("duration"),
            func.coalesce(func.sum(Workout.calories_burned), 0.0).label("calories"),
        )
        .filter(Workout.user_id == current_user.id)
        .one()
    )
    records = db.query(Workout.exercise_code, func.max(Workout.reps_count)).filter(
        Workout.user_id == current_user.id).group_by(Workout.exercise_code).all()
    start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=6)
    day = func.date(Workout.completed_at)
    daily = dict(db.query(day, func.sum(Workout.reps_count)).filter(
        Workout.user_id == current_user.id, Workout.completed_at >= start).group_by(day).all())
    dates = [(start + timedelta(days=i)).date().isoformat() for i in range(7)]
    return StatsOut(
        week=[{"date": date, "reps": daily.get(date, 0)} for date in dates],
        records=dict(records),
        total_reps=int(row.reps),
        total_workouts=int(row.sessions),
        total_duration_seconds=int(row.duration),
        total_calories=float(row.calories),
    )


@app.get("/api/user/history", response_model=HistoryOut)
def user_history(
    offset: int = Query(0, ge=0),
    current_user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Last 10 workouts of the current user."""
    rows = (
        db.query(Workout)
        .filter(Workout.user_id == current_user.id)
        .order_by(Workout.completed_at.desc(), Workout.id.desc())
        .offset(offset).limit(11)
        .all()
    )
    return HistoryOut(items=[WorkoutOut.model_validate(w) for w in rows[:10]], has_more=len(rows) > 10)


@app.get("/api/user/workouts.csv")
def export_workouts(current_user: User = Depends(require_user), db: Session = Depends(get_db)):
    rows = (db.query(Workout).filter(Workout.user_id == current_user.id)
            .order_by(Workout.completed_at.desc(), Workout.id.desc()).yield_per(250))

    def lines():
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["date_utc", "exercise", "reps", "duration_seconds", "estimated_kcal"])
        yield buffer.getvalue()
        for workout in rows:
            buffer.seek(0)
            buffer.truncate()
            writer.writerow([workout.completed_at.isoformat(), workout.exercise_code, workout.reps_count,
                             workout.duration_seconds, workout.calories_burned])
            yield buffer.getvalue()

    return StreamingResponse(lines(), media_type="text/csv",
                             headers={"Content-Disposition": 'attachment; filename="genisport-workouts.csv"'})


@app.get("/api/user/battles")
def recent_battles(current_user: User = Depends(require_user), db: Session = Depends(get_db)):
    uid = current_user.id
    rows = (db.query(Battle).filter(Battle.completed_at.is_not(None),
            (Battle.creator_id == uid) | (Battle.opponent_id == uid))
            .order_by(Battle.completed_at.desc(), Battle.id.desc()).limit(10).all())
    items = []
    for row in rows:
        host = row.creator_id == uid
        other = db.get(User, row.opponent_id if host else row.creator_id)
        items.append(dict(opponent=other.username if other else "Opponent",
                          exercise=row.exercise_code, completed_at=row.completed_at,
                          score=row.creator_reps if host else row.opponent_reps,
                          opponent_score=row.opponent_reps if host else row.creator_reps,
                          result="Draw" if row.winner_id is None else "Win" if row.winner_id == uid else "Loss"))
    return {"items": items}


@app.get("/api/leaderboard", response_model=LeaderboardOut)
def leaderboard(db: Session = Depends(get_db)):
    """Top users by total reps — all-time and daily, with per-exercise badges."""
    EXERCISE_ICONS = {
        "push_ups": "💪",
        "squats": "🦵",
        "pull_ups": "🧗",
    }

    def top(mode: str) -> list[LeaderboardEntry]:
        q = (
            db.query(
                User.id.label("user_id"),
                User.username.label("username"),
                func.coalesce(func.sum(Workout.reps_count), 0).label("reps"),
                func.coalesce(func.sum(Workout.calories_burned), 0.0).label("calories"),
            )
            .join(Workout, Workout.user_id == User.id)
        )
        if mode == "daily":
            start_of_day = datetime.now(timezone.utc).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
            q = q.filter(Workout.completed_at >= start_of_day)
        rows = (
            q.group_by(User.id, User.username)
            .order_by(func.sum(Workout.reps_count).desc(), User.id)
            .limit(10)
            .all()
        )

        entries: list[LeaderboardEntry] = []
        for i, r in enumerate(rows):
            # Per-exercise rep totals for badges (only exercises with reps > 0).
            badge_rows = (
                db.query(Workout.exercise_code, func.sum(Workout.reps_count).label("reps"))
                .filter(Workout.user_id == r.user_id)
                .filter(Workout.completed_at >= start_of_day if mode == "daily" else True)
                .group_by(Workout.exercise_code)
                .all()
            )
            badges = [
                ExerciseBadge(code=code, icon=EXERCISE_ICONS.get(code, "🏋️"), reps=int(reps))
                for code, reps in badge_rows
                if int(reps) > 0
            ]
            badges.sort(key=lambda b: b.reps, reverse=True)

            entries.append(
                LeaderboardEntry(
                    rank=i + 1,
                    username=r.username,
                    total_reps=int(r.reps),
                    total_calories=float(r.calories),
                    exercises=badges,
                )
            )
        return entries

    return LeaderboardOut(all_time=top("all"), daily=top("daily"))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8000")))
