"""SQLite database engine and session management for GeniSport."""
import os

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DB_PATH = os.environ.get("GENISPORT_DB", os.path.join(os.path.dirname(__file__), "genisport.db"))
engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


def get_db():
    """FastAPI dependency yielding a database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Create all tables and seed default exercise data."""
    # Import models so they are registered on Base.metadata before create_all.
    from models import Battle, Exercise, User, Workout  # noqa: F401

    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        for code, name, met in (("push_ups", "Push-ups", 8.0), ("squats", "Squats", 5.5), ("pull_ups", "Pull-ups", 8.0)):
            if not db.query(Exercise).filter(Exercise.code == code).first():
                db.add(Exercise(code=code, name=name, met_value=met))
        db.commit()
    finally:
        db.close()
