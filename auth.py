"""JWT token creation/verification and password hashing helpers."""
import os
import secrets
from pathlib import Path
from database import DB_PATH
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from models import User

# --- Configuration ---
def signing_key():
    configured = os.environ.get("GENISPORT_SECRET_KEY")
    if configured:
        return configured
    path = Path(DB_PATH).with_suffix(".key")
    if not path.exists():
        import tempfile
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
            tmp.write(secrets.token_hex(48).encode())
        try:
            os.link(tmp.name, path)
        except FileExistsError:
            pass
        finally:
            os.unlink(tmp.name)
    return path.read_text().strip()


SECRET_KEY = signing_key()
ALGORITHM = "HS256"
TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days

pwd_context = CryptContext(schemes=["bcrypt_sha256", "bcrypt"], deprecated=["bcrypt"])


def hash_password(password: str) -> str:
    """Hash a plaintext password with bcrypt."""
    return pwd_context.hash(password)


def verify_password(plain_password: str, password_hash: str) -> bool:
    """Verify a plaintext password against a stored bcrypt hash."""
    return pwd_context.verify(plain_password, password_hash)


def create_access_token(user_id: int) -> str:
    """Create a signed JWT access token for the given user id."""
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=TOKEN_EXPIRE_MINUTES)).timestamp()),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> int | None:
    """Decode a JWT and return the user id, or None if invalid/expired."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        sub = payload.get("sub")
        return int(sub) if sub is not None else None
    except (jwt.PyJWTError, TypeError, ValueError):
        return None


def get_current_user(token: str, db: Session) -> User | None:
    """Resolve a user from a raw bearer token (helper used by main.py)."""
    user_id = decode_access_token(token)
    if user_id is None:
        return None
    return db.get(User, user_id)
