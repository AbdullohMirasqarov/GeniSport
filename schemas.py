"""Pydantic request/response schemas for GeniSport API."""
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


# ---------- Auth ----------
class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9_.-]+$")
    password: str = Field(min_length=6, max_length=128)
    weight_kg: float = Field(default=70.0, gt=20, le=300)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    weight_kg: float
    created_at: datetime


class WeightUpdate(BaseModel):
    weight_kg: float = Field(gt=20, le=300)


# ---------- Workouts / Stats ----------
class WorkoutCreate(BaseModel):
    session_key: UUID | None = None
    exercise_code: str = Field(default="push_ups", max_length=64)
    reps_count: int = Field(ge=0, le=100000)
    duration_seconds: int = Field(ge=0, le=60 * 60 * 24)
    calories_burned: float = Field(ge=0, le=100000)


class WorkoutOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    exercise_code: str
    reps_count: int
    duration_seconds: int
    calories_burned: float
    completed_at: datetime


class ActivityDay(BaseModel):
    date: str
    reps: int


class StatsOut(BaseModel):
    week: list[ActivityDay]
    records: dict[str, int]
    total_reps: int
    total_workouts: int
    total_duration_seconds: int
    total_calories: float


class HistoryOut(BaseModel):
    items: list[WorkoutOut]
    has_more: bool = False


class ExerciseBadge(BaseModel):
    """Per-exercise rep total shown as an icon badge on the leaderboard."""
    code: str
    icon: str
    reps: int


class LeaderboardEntry(BaseModel):
    rank: int
    username: str
    total_reps: int
    total_calories: float
    exercises: list[ExerciseBadge] = []


class LeaderboardOut(BaseModel):
    all_time: list[LeaderboardEntry]
    daily: list[LeaderboardEntry]


# ---------- Battles (1v1 PVP) ----------
class BattleCreate(BaseModel):
    """Payload for creating a battle room."""
    exercise_code: str = Field(default="push_ups", max_length=64)
    mode: str = Field(pattern=r"^(time_attack|first_to_target)$")
    target: int = Field(gt=0, le=1000)


class BattleRoomOut(BaseModel):
    """Response after room creation — the code is what the host shares."""
    room_code: str
    exercise_code: str
    mode: str
    target_value: int


class BattleOut(BaseModel):
    """A persisted battle row (result view)."""
    model_config = ConfigDict(from_attributes=True)

    id: int
    room_code: str
    creator_id: int
    opponent_id: int | None
    exercise_code: str
    mode: str
    target_value: int
    creator_reps: int
    opponent_reps: int
    winner_id: int | None
    created_at: datetime
    completed_at: datetime | None
