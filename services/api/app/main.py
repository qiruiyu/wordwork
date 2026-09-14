"""Private, single-instance API for immutable DOCX collaboration versions."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import tempfile
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Generator

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    event,
    select,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

UTC = timezone.utc
DATA = Path(os.getenv("WORDWORK_DATA_DIR", Path(__file__).parents[2] / ".data"))
OBJECTS = DATA / "objects"
OBJECTS.mkdir(parents=True, exist_ok=True)
MAX_DOCX = int(os.getenv("WORDWORK_MAX_UPLOAD_BYTES", str(100 * 1024 * 1024)))
DATABASE_URL = os.getenv("WORDWORK_DATABASE_URL", f"sqlite:///{DATA / 'wordwork.sqlite3'}")
IS_SQLITE = DATABASE_URL.startswith("sqlite")
SESSION_DAYS = int(os.getenv("WORDWORK_SESSION_DAYS", "7"))
DEFAULT_DEMO_PASSWORD = "wordwork-demo-change-me"

# Origins allowed to call the API.  The desktop client is the only supported
# client; browser development servers must be listed explicitly.
TAURI_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]
DEV_ORIGINS = [o.strip() for o in os.getenv("WORDWORK_DEV_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip()]
EXTRA_ORIGINS = [o.strip() for o in os.getenv("WORDWORK_ALLOWED_ORIGINS", "").split(",") if o.strip()]
ALLOWED_ORIGINS = TAURI_ORIGINS + DEV_ORIGINS + EXTRA_ORIGINS

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False} if IS_SQLITE else {})


@event.listens_for(engine, "connect")
def _sqlite_wal(conn, _):
    if IS_SQLITE:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")


DB = sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class Member(Base):
    __tablename__ = "members"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(16))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)


class SessionToken(Base):
    __tablename__ = "sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    member_id: Mapped[int] = mapped_column(ForeignKey("members.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class LoginAttempt(Base):
    __tablename__ = "login_attempts"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), index=True)
    attempted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    succeeded: Mapped[bool] = mapped_column(Boolean, default=False)


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    owner_id: Mapped[int] = mapped_column(ForeignKey("members.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class ProjectMember(Base):
    __tablename__ = "project_members"
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    member_id: Mapped[int] = mapped_column(ForeignKey("members.id"), primary_key=True)


class Document(Base):
    __tablename__ = "documents"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    name: Mapped[str] = mapped_column(String(200))
    current_version_id: Mapped[int | None] = mapped_column(ForeignKey("versions.id"), nullable=True)


class Version(Base):
    __tablename__ = "versions"
    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id"))
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("versions.id"), nullable=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("members.id"))
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    display_name: Mapped[str] = mapped_column(String(255))
    kind: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    immutable: Mapped[bool] = mapped_column(Boolean, default=True)


class Round(Base):
    __tablename__ = "rounds"
    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id"))
    number: Mapped[int] = mapped_column(Integer)
    base_version_id: Mapped[int] = mapped_column(ForeignKey("versions.id"))
    status: Mapped[str] = mapped_column(String(20), default="draft")
    created_by: Mapped[int] = mapped_column(ForeignKey("members.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class Submission(Base):
    __tablename__ = "submissions"
    id: Mapped[int] = mapped_column(primary_key=True)
    round_id: Mapped[int] = mapped_column(ForeignKey("rounds.id"))
    author_id: Mapped[int] = mapped_column(ForeignKey("members.id"))
    base_version_id: Mapped[int] = mapped_column(ForeignKey("versions.id"))
    version_id: Mapped[int] = mapped_column(ForeignKey("versions.id"))
    redline_version_id: Mapped[int | None] = mapped_column(ForeignKey("versions.id"), nullable=True)
    resolved_version_id: Mapped[int | None] = mapped_column(ForeignKey("versions.id"), nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="submitted")
    # JSON list of `generate_redline` warnings. The redline is shown to the teacher as the
    # authoritative "what changed" view, so if it could not express a change (a new table,
    # or a paragraph carrying a drawing) that fact has to travel with the submission.
    redline_warnings: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class ReviewHunk(Base):
    __tablename__ = "review_hunks"
    id: Mapped[int] = mapped_column(primary_key=True)
    submission_id: Mapped[int] = mapped_column(ForeignKey("submissions.id"))
    engine_hunk_id: Mapped[str] = mapped_column(String(64))
    anchor: Mapped[str] = mapped_column(String(255))
    payload: Mapped[str] = mapped_column(Text)
    risk: Mapped[str] = mapped_column(String(32), default="normal")


class ReviewDecision(Base):
    __tablename__ = "review_decisions"
    id: Mapped[int] = mapped_column(primary_key=True)
    hunk_id: Mapped[int] = mapped_column(ForeignKey("review_hunks.id"), unique=True)
    teacher_id: Mapped[int] = mapped_column(ForeignKey("members.id"))
    decision: Mapped[str] = mapped_column(String(16))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class MergeConflict(Base):
    __tablename__ = "merge_conflicts"
    # One row per contested location. Without this, a retry after a partial failure
    # could insert a second row for the same (round, anchor) and the same conflict
    # would show up twice, with two different resolutions.
    __table_args__ = (UniqueConstraint("round_id", "anchor", name="uq_merge_conflicts_round_anchor"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    round_id: Mapped[int] = mapped_column(ForeignKey("rounds.id"))
    anchor: Mapped[str] = mapped_column(String(255))
    payload: Mapped[str] = mapped_column(Text, default="{}")
    resolution: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="open")


class Comment(Base):
    __tablename__ = "comments"
    id: Mapped[int] = mapped_column(primary_key=True)
    submission_id: Mapped[int] = mapped_column(ForeignKey("submissions.id"))
    author_id: Mapped[int] = mapped_column(ForeignKey("members.id"))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    actor_id: Mapped[int] = mapped_column(ForeignKey("members.id"))
    action: Mapped[str] = mapped_column(String(80))
    entity: Mapped[str] = mapped_column(String(80))
    entity_id: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class Event(Base):
    __tablename__ = "events"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int | None] = mapped_column(nullable=True)
    kind: Mapped[str] = mapped_column(String(80))
    payload: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    payload: Mapped[str] = mapped_column(Text, default="{}")


_EXTRA_COLUMNS = {
    "members": {"must_change_password": "must_change_password BOOLEAN DEFAULT 0"},
    "submissions": {"redline_warnings": "redline_warnings TEXT DEFAULT '[]'"},
}


def _migrate() -> None:
    """create_all plus additive column migrations for pre-existing SQLite files."""
    with engine.begin() as conn:
        Base.metadata.create_all(conn)
        if not IS_SQLITE:
            return
        for table, columns in _EXTRA_COLUMNS.items():
            existing = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")}
            for name, ddl in columns.items():
                if name not in existing:
                    conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {ddl}")
        # Older databases have no unique index and may already contain duplicates.
        # Collapse them first — preferring a row that recorded a resolution, then the
        # newest — otherwise CREATE UNIQUE INDEX would fail and the server would not start.
        conn.exec_driver_sql(
            "DELETE FROM merge_conflicts WHERE id NOT IN ("
            " SELECT id FROM ("
            "  SELECT id, ROW_NUMBER() OVER ("
            "   PARTITION BY round_id, anchor ORDER BY (resolution IS NULL), id DESC"
            "  ) AS rn FROM merge_conflicts"
            " ) WHERE rn = 1)"
        )
        conn.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_merge_conflicts_round_anchor"
            " ON merge_conflicts (round_id, anchor)"
        )


def upsert_conflict(s: Session, round_id: int, anchor: str, payload: dict) -> MergeConflict:
    """Insert or refresh the conflict row for one (round, anchor).

    Uses an UPSERT rather than read-then-write so two requests racing on the same
    anchor cannot both insert; the unique index is the backstop.
    """
    encoded = json.dumps(payload, ensure_ascii=False)
    statement = select(MergeConflict).where(MergeConflict.round_id == round_id, MergeConflict.anchor == anchor)
    existing = s.scalar(statement)
    if existing is None and IS_SQLITE:
        from sqlalchemy.dialects.sqlite import insert as sqlite_insert

        s.execute(
            sqlite_insert(MergeConflict.__table__)
            .values(round_id=round_id, anchor=anchor, payload=encoded, status="open", resolution=None)
            .on_conflict_do_update(
                index_elements=["round_id", "anchor"],
                set_={"payload": encoded, "status": "open", "resolution": None},
            )
        )
        existing = s.scalar(statement)
    if existing is None:
        existing = MergeConflict(round_id=round_id, anchor=anchor)
        s.add(existing)
    existing.payload = encoded
    existing.status = "open"
    existing.resolution = None
    s.flush()
    return existing


def now() -> datetime:
    return datetime.now(UTC)


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def db() -> Generator[Session, None, None]:
    s = DB()
    try:
        yield s
    finally:
        s.close()


def password(value: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    value_hash = hashlib.pbkdf2_hmac("sha256", value.encode(), salt.encode(), 310000).hex()
    return f"pbkdf2$310000${salt}${value_hash}"


def verify(value: str, stored: str) -> bool:
    try:
        _, _, salt, digest = stored.split("$", 3)
    except ValueError:
        return False
    return hmac.compare_digest(password(value, salt).split("$")[-1], digest)


def token_fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_token(s: Session, m: Member) -> str:
    token = secrets.token_urlsafe(32)
    s.add(SessionToken(token_hash=token_fingerprint(token), member_id=m.id, expires_at=now() + timedelta(days=SESSION_DAYS)))
    return token


def resolve_token(s: Session, token: str) -> Member | None:
    record = s.scalar(select(SessionToken).where(SessionToken.token_hash == token_fingerprint(token)))
    if not record or record.revoked:
        return None
    expires = record.expires_at if record.expires_at.tzinfo else record.expires_at.replace(tzinfo=UTC)
    if expires < now():
        return None
    m = s.get(Member, record.member_id)
    return m if m and m.active else None


def revoke_member_tokens(s: Session, member_id: int, keep_hash: str | None = None) -> None:
    rows = s.scalars(select(SessionToken).where(SessionToken.member_id == member_id, SessionToken.revoked.is_(False))).all()
    for row in rows:
        if keep_hash and row.token_hash == keep_hash:
            continue
        row.revoked = True


def user(authorization: str | None = Header(default=None), s: Session = Depends(db)) -> Member:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "需要登录后访问")
    m = resolve_token(s, authorization[7:])
    if not m:
        raise HTTPException(401, "登录状态已失效，请重新登录")
    return m


def teacher(m: Member = Depends(user)) -> Member:
    if m.role != "teacher":
        raise HTTPException(403, "该操作仅限老师")
    return m


def member_project(s: Session, project_id: int, m: Member) -> Project:
    p = s.get(Project, project_id)
    if not p:
        raise HTTPException(404, "项目不存在")
    if not s.get(ProjectMember, {"project_id": project_id, "member_id": m.id}):
        raise HTTPException(403, "你不是该项目成员")
    return p


def audit(s: Session, m: Member, action: str, entity: str, eid: int, project_id: int | None = None) -> None:
    s.add(AuditEvent(actor_id=m.id, action=action, entity=entity, entity_id=eid))
    s.add(Event(project_id=project_id, kind=action, payload=json.dumps({"entity": entity, "id": eid}, ensure_ascii=False)))


def clean_name(s: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "_", s).strip()[:120] or "document"


def export_name(project: str, round_no: int, author: str, version_id: int) -> str:
    return f"{clean_name(project)}_{round_no}_{clean_name(author)}_{now():%Y%m%d-%H%M}_{version_id:08x}.docx"


def object_path(digest: str) -> Path:
    return OBJECTS / digest[:2] / digest[2:4] / f"{digest}.docx"


def store_docx(upload: UploadFile) -> tuple[str, Path]:
    if not upload.filename or not upload.filename.lower().endswith(".docx") or upload.filename.lower().endswith(".docm"):
        raise HTTPException(422, "只接受 .docx 文件（不支持 .docm 宏文档）")
    target = DATA / f".upload-{secrets.token_hex(8)}.docx"
    total = 0
    with target.open("wb") as f:
        while chunk := upload.file.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_DOCX:
                target.unlink(missing_ok=True)
                raise HTTPException(413, f"文件超过 {MAX_DOCX // (1024 * 1024)} MB 上限")
            f.write(chunk)
    try:
        with zipfile.ZipFile(target) as z:
            names = z.namelist()
            if "[Content_Types].xml" not in names or "word/document.xml" not in names or any(n.startswith("/") or ".." in Path(n).parts for n in names):
                raise ValueError()
            if any("vbaProject.bin" in n for n in names):
                raise ValueError()
            packed = sum(i.compress_size for i in z.infolist())
            unpacked = sum(i.file_size for i in z.infolist())
            if unpacked > MAX_DOCX * 10 or (packed and unpacked / packed > 200):
                raise ValueError()
    except (zipfile.BadZipFile, ValueError):
        target.unlink(missing_ok=True)
        raise HTTPException(422, "文件不是安全有效的 .docx（可能已损坏或包含宏）")
    try:
        from wordwork_doc_engine import validate_docx
    except ImportError as exc:
        target.unlink(missing_ok=True)
        raise HTTPException(503, "服务器缺少 DOCX 校验引擎，请联系管理员") from exc
    checked = validate_docx(target)
    if not checked.valid:
        target.unlink(missing_ok=True)
        raise HTTPException(422, {"message": "文件未通过安全检查", "errors": checked.errors})
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    obj = object_path(digest)
    obj.parent.mkdir(parents=True, exist_ok=True)
    if obj.exists():
        target.unlink()
    else:
        target.replace(obj)
    return digest, obj


def store_generated(path: Path) -> tuple[str, Path]:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    target = object_path(digest)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        target.write_bytes(path.read_bytes())
    return digest, target


def make_version(s: Session, document: Document, author: Member, digest: str, kind: str, project: Project, round_no: int, parent_id: int | None) -> Version:
    version = Version(document_id=document.id, parent_id=parent_id, author_id=author.id, sha256=digest, display_name="pending.docx", kind=kind)
    s.add(version)
    s.flush()
    version.display_name = export_name(project.name, round_no, author.username, version.id)
    return version


# A submission may only be published once the teacher has put it in one of these states.
# `manual_required` is deliberately absent: it means the engine refused to apply an accepted
# change, so the round must go through a manual merge or the submission must be skipped.
TERMINAL_SUBMISSION_STATUSES = ("reviewed", "skipped", "rejected")

# Version kinds `/versions/{id}/restore` accepts. Everything else the pipeline produces
# (`redline`, `summary_redline`, `draft`, `contribution`) is an intermediate artifact of
# a review, not a document anyone should be able to promote to the official main version
# in one click. The client mirrors this list in `lib/format.ts` to hide the button.
RESTORABLE_VERSION_KINDS = ("main", "submission", "manual_merge")


def record_apply_conflicts(s: Session, round_: Round, conflicts: list) -> list[dict]:
    """Persist engine-level conflicts as round conflicts so the teacher can see and resolve them."""
    recorded: list[dict] = []
    for conflict in conflicts:
        payload = {
            "source": "apply_decisions",
            "kind": conflict.kind,
            "reason": conflict.reason,
            "detail": conflict.detail,
            "match_key": conflict.match_key,
            "part": conflict.part,
            "anchor": conflict.anchor,
        }
        row = upsert_conflict(s, round_.id, conflict.match_key, payload)
        recorded.append({"id": row.id, **payload})
    return recorded


def build_submission_diff(s: Session, sub: Submission, author: Member, document: Document, project: Project, round_: Round) -> None:
    apply_decisions, compute_diff, generate_redline, _ = engine_api()
    base = s.get(Version, sub.base_version_id)
    revised = s.get(Version, sub.version_id)
    if not base or not revised:
        raise HTTPException(500, "提交缺少基础版本或修订版本")
    diff = compute_diff(object_path(base.sha256), object_path(revised.sha256), author.username)
    for old in s.scalars(select(ReviewHunk).where(ReviewHunk.submission_id == sub.id)).all():
        s.delete(old)
    for hunk in diff.hunks:
        payload = json.dumps(
            {
                "operation": hunk.operation,
                "before": hunk.base_text,
                "after": hunk.revised_text,
                "context_before": hunk.before,
                "context_after": hunk.after,
                "author": hunk.author,
                "part": hunk.match_key.split("|", 1)[0],
            },
            ensure_ascii=False,
        )
        risk = "high" if hunk.risks else "normal"
        s.add(ReviewHunk(submission_id=sub.id, engine_hunk_id=hunk.hunk_id, anchor=hunk.match_key, payload=payload, risk=risk))
    with tempfile.TemporaryDirectory() as directory:
        redline_path = Path(directory) / "redline.docx"
        produced = generate_redline(object_path(base.sha256), object_path(revised.sha256), author.username, redline_path)
        sub.redline_warnings = json.dumps(produced.warnings, ensure_ascii=False)
        digest, _ = store_generated(redline_path)
    redline = make_version(s, document, author, digest, "redline", project, round_.number, sub.base_version_id)
    sub.redline_version_id = redline.id
    sub.status = "ready_for_review"


def login_throttle(s: Session, username: str) -> None:
    window = now() - timedelta(minutes=15)
    failures = s.scalars(
        select(LoginAttempt).where(LoginAttempt.username == username, LoginAttempt.succeeded.is_(False), LoginAttempt.attempted_at > window)
    ).all()
    if len(failures) >= 10:
        raise HTTPException(429, "登录失败次数过多，请 15 分钟后再试")


@asynccontextmanager
async def lifespan(_: FastAPI):
    _migrate()
    with DB.begin() as s:
        if not s.scalar(select(Member.id).limit(1)):
            configured_password = os.getenv("WORDWORK_BOOTSTRAP_PASSWORD")
            if configured_password:
                if len(configured_password) < 12:
                    raise RuntimeError("WORDWORK_BOOTSTRAP_PASSWORD must have at least 12 characters")
                name = os.getenv("WORDWORK_BOOTSTRAP_TEACHER", "teacher")
                force = os.getenv("WORDWORK_BOOTSTRAP_FORCE_CHANGE", "1") not in ("0", "false", "False")
                s.add(Member(username=name, password_hash=password(configured_password), role="teacher", must_change_password=force))
            else:
                for name, role in [("teacher", "teacher"), ("student1", "student"), ("student2", "student")]:
                    s.add(Member(username=name, password_hash=password(DEFAULT_DEMO_PASSWORD), role=role, must_change_password=True))
    yield


app = FastAPI(title="wordwork private API", version="0.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["Content-Disposition"],
)


# `/me` is what the client uses to learn that a change is required; login/logout must work
# or the account would be permanently locked out.  Everything else is refused until the
# password has actually been changed, because the bootstrap password is written down.
PASSWORD_CHANGE_EXEMPT_PATHS = {"/healthz", "/auth/login", "/auth/logout", "/auth/change-password", "/me"}


@app.middleware("http")
async def require_password_change(request: Request, call_next):
    if request.method == "OPTIONS" or request.url.path in PASSWORD_CHANGE_EXEMPT_PATHS:
        return await call_next(request)
    header = request.headers.get("authorization")
    if header and header.startswith("Bearer "):
        with DB() as s:
            pending = resolve_token(s, header[7:])
            blocked = bool(pending and pending.must_change_password)
        if blocked:
            return JSONResponse({"detail": "首次登录必须先修改初始密码"}, status_code=428)
    return await call_next(request)


class Login(BaseModel):
    username: str
    password: str


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)


class MemberIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=8, max_length=128)
    role: str


class RoundIn(BaseModel):
    document_id: int


class DecisionIn(BaseModel):
    decision: str | None = None
    status: str | None = None


class RestoreIn(BaseModel):
    document_id: int


class CommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=4000)


class PublishResultIn(BaseModel):
    conflict_choices: dict[str, str] = Field(default_factory=dict)


class SkipIn(BaseModel):
    reason: str = Field(default="", max_length=400)


def member_public(m: Member) -> dict:
    return {"id": m.id, "username": m.username, "role": m.role, "must_change_password": bool(m.must_change_password)}


@app.get("/healthz")
def healthz():
    engine = engine_status()
    return {
        # `degraded` is the honest answer when the engine cannot satisfy this API's
        # contract: most endpoints still answer, but every review endpoint would 503.
        "status": "ok" if engine["compatible"] else "degraded",
        "name": "wordwork",
        "version": app.version,
        "engine_available": engine["available"],
        "engine_compatible": engine["compatible"],
        "engine_version": engine["version"],
        "engine_contract": engine["contract"],
        "engine_contract_required": ENGINE_REQUIRED_CONTRACT,
        # This endpoint is intentionally unauthenticated so clients can test connectivity.
        # Never disclose the server's absolute installation path to the public network.
        "engine_file": Path(engine["file"]).name if engine["file"] else None,
        "engine_problem": engine["problem"],
    }


@app.post("/auth/login")
def login(data: Login, s: Session = Depends(db)):
    username = data.username.strip()
    login_throttle(s, username)
    m = s.scalar(select(Member).where(Member.username == username))
    ok = bool(m and m.active and verify(data.password, m.password_hash))
    s.add(LoginAttempt(username=username, succeeded=ok))
    if not ok:
        s.commit()
        raise HTTPException(401, "用户名或密码不正确")
    token = issue_token(s, m)
    s.commit()
    return {"access_token": token, "token_type": "bearer", "member": member_public(m)}


@app.post("/auth/logout")
def logout(authorization: str | None = Header(default=None), s: Session = Depends(db), m: Member = Depends(user)):
    if authorization and authorization.startswith("Bearer "):
        record = s.scalar(select(SessionToken).where(SessionToken.token_hash == token_fingerprint(authorization[7:])))
        if record:
            record.revoked = True
    s.commit()
    return {"status": "signed_out"}


@app.post("/auth/change-password")
def change_password(data: PasswordChange, authorization: str | None = Header(default=None), s: Session = Depends(db), m: Member = Depends(user)):
    if not verify(data.current_password, m.password_hash):
        raise HTTPException(401, "当前密码不正确")
    if data.new_password == data.current_password:
        raise HTTPException(422, "新密码不能与当前密码相同")
    m.password_hash = password(data.new_password)
    m.must_change_password = False
    keep = token_fingerprint(authorization[7:]) if authorization and authorization.startswith("Bearer ") else None
    revoke_member_tokens(s, m.id, keep_hash=keep)
    audit(s, m, "password.changed", "member", m.id)
    s.commit()
    return {"status": "password_changed", "member": member_public(m)}


@app.get("/me")
def me(m: Member = Depends(user)):
    return member_public(m)


@app.get("/projects")
def list_projects(s: Session = Depends(db), m: Member = Depends(user)):
    ids = select(ProjectMember.project_id).where(ProjectMember.member_id == m.id)
    rows = s.scalars(select(Project).where(Project.id.in_(ids)).order_by(Project.created_at.desc())).all()
    result = []
    for p in rows:
        docs = s.scalars(select(Document).where(Document.project_id == p.id)).all()
        active = None
        if docs:
            active = s.scalar(
                select(Round)
                .where(Round.document_id.in_([d.id for d in docs]), Round.status.in_(["open", "reviewing"]))
                .order_by(Round.created_at.desc())
                .limit(1)
            )
        member_count = len(s.scalars(select(ProjectMember.member_id).where(ProjectMember.project_id == p.id)).all())
        result.append(
            {
                "id": p.id,
                "name": p.name,
                "documents": len(docs),
                "members": member_count,
                "is_owner": p.owner_id == m.id,
                "active_round_id": active.id if active else None,
                "active_round_number": active.number if active else None,
                "created_at": iso(p.created_at),
            }
        )
    return result


@app.post("/projects")
def create_project(data: ProjectIn, s: Session = Depends(db), m: Member = Depends(teacher)):
    p = Project(name=data.name.strip(), owner_id=m.id)
    s.add(p)
    s.flush()
    s.add(ProjectMember(project_id=p.id, member_id=m.id))
    audit(s, m, "project.created", "project", p.id, p.id)
    s.commit()
    return {"id": p.id, "name": p.name}


@app.get("/projects/{project_id}")
def project_detail(project_id: int, s: Session = Depends(db), m: Member = Depends(user)):
    p = member_project(s, project_id, m)
    members = s.execute(select(Member).join(ProjectMember, ProjectMember.member_id == Member.id).where(ProjectMember.project_id == p.id)).scalars().all()
    documents = s.scalars(select(Document).where(Document.project_id == p.id)).all()
    return {
        "id": p.id,
        "name": p.name,
        "owner_id": p.owner_id,
        "is_owner": p.owner_id == m.id,
        "created_at": iso(p.created_at),
        "members": [member_public(x) for x in members],
        "documents": [
            {"id": d.id, "name": d.name, "current_version_id": d.current_version_id} for d in documents
        ],
    }


@app.get("/projects/{project_id}/members")
def list_members(project_id: int, s: Session = Depends(db), m: Member = Depends(user)):
    member_project(s, project_id, m)
    rows = s.execute(select(Member).join(ProjectMember, ProjectMember.member_id == Member.id).where(ProjectMember.project_id == project_id)).scalars().all()
    return [member_public(x) for x in rows]


@app.post("/projects/{project_id}/members")
def add_member(project_id: int, data: MemberIn, s: Session = Depends(db), m: Member = Depends(teacher)):
    member_project(s, project_id, m)
    if data.role not in ("teacher", "student"):
        raise HTTPException(422, "角色只能是 teacher 或 student")
    username = data.username.strip()
    x = s.scalar(select(Member).where(Member.username == username))
    if not x:
        # The teacher reads this password aloud or pastes it into a chat, so the account
        # must not be usable until its owner has replaced it.
        x = Member(username=username, password_hash=password(data.password), role=data.role, must_change_password=True)
        s.add(x)
        s.flush()
    elif x.role != data.role:
        raise HTTPException(409, "同名账号已存在且角色不同")
    if not s.get(ProjectMember, {"project_id": project_id, "member_id": x.id}):
        s.add(ProjectMember(project_id=project_id, member_id=x.id))
        audit(s, m, "member.added", "member", x.id, project_id)
    s.commit()
    return member_public(x)


@app.get("/projects/{project_id}/documents")
def list_documents(project_id: int, s: Session = Depends(db), m: Member = Depends(user)):
    member_project(s, project_id, m)
    rows = s.scalars(select(Document).where(Document.project_id == project_id)).all()
    return [{"id": d.id, "name": d.name, "current_version_id": d.current_version_id} for d in rows]


@app.post("/projects/{project_id}/documents")
def upload_document(project_id: int, file: UploadFile = File(...), s: Session = Depends(db), m: Member = Depends(teacher)):
    p = member_project(s, project_id, m)
    digest, _ = store_docx(file)
    d = Document(project_id=project_id, name=clean_name(file.filename))
    s.add(d)
    s.flush()
    v = make_version(s, d, m, digest, "main", p, 0, None)
    d.current_version_id = v.id
    audit(s, m, "document.uploaded", "document", d.id, project_id)
    s.commit()
    return {"id": d.id, "version_id": v.id, "sha256": digest}


@app.get("/documents/{document_id}")
def document_detail(document_id: int, s: Session = Depends(db), m: Member = Depends(user)):
    d = s.get(Document, document_id)
    if not d:
        raise HTTPException(404, "文档不存在")
    p = member_project(s, d.project_id, m)
    return {"id": d.id, "project_id": d.project_id, "project_name": p.name, "name": d.name, "current_version_id": d.current_version_id}


@app.post("/projects/{project_id}/rounds")
def create_round(project_id: int, data: RoundIn, s: Session = Depends(db), m: Member = Depends(teacher)):
    member_project(s, project_id, m)
    d = s.get(Document, data.document_id)
    if not d or d.project_id != project_id or not d.current_version_id:
        raise HTTPException(422, "请先上传该项目的初始文档")
    n = (s.scalar(select(Round.number).where(Round.document_id == d.id).order_by(Round.number.desc()).limit(1)) or 0) + 1
    r = Round(document_id=d.id, number=n, base_version_id=d.current_version_id, created_by=m.id)
    s.add(r)
    s.flush()
    audit(s, m, "round.created", "round", r.id, project_id)
    s.commit()
    return {"id": r.id, "number": n, "base_version_id": r.base_version_id, "status": r.status}


@app.get("/rounds/{round_id}")
def round_detail(round_id: int, s: Session = Depends(db), m: Member = Depends(user)):
    r = s.get(Round, round_id)
    if not r:
        raise HTTPException(404, "轮次不存在")
    d = s.get(Document, r.document_id)
    p = member_project(s, d.project_id, m)
    base = s.get(Version, r.base_version_id)
    return {
        "id": r.id,
        "number": r.number,
        "status": r.status,
        "document_id": d.id,
        "document_name": d.name,
        "project_id": p.id,
        "project_name": p.name,
        "base_version_id": r.base_version_id,
        "base_version_name": base.display_name if base else None,
        "created_at": iso(r.created_at),
    }


@app.post("/rounds/{round_id}/publish")
def publish_round(round_id: int, s: Session = Depends(db), m: Member = Depends(teacher)):
    r = s.get(Round, round_id)
    if not r:
        raise HTTPException(404, "轮次不存在")
    p = member_project(s, s.get(Document, r.document_id).project_id, m)
    if r.status != "draft":
        raise HTTPException(409, "该轮次已经发布")
    r.status = "open"
    audit(s, m, "round.published", "round", r.id, p.id)
    s.commit()
    return {"id": r.id, "status": r.status}


@app.get("/projects/{project_id}/rounds")
def list_rounds(project_id: int, s: Session = Depends(db), m: Member = Depends(user)):
    member_project(s, project_id, m)
    document_ids = select(Document.id).where(Document.project_id == project_id)
    rows = s.scalars(select(Round).where(Round.document_id.in_(document_ids)).order_by(Round.created_at.desc())).all()
    out = []
    for x in rows:
        count = len(s.scalars(select(Submission.id).where(Submission.round_id == x.id)).all())
        out.append(
            {
                "id": x.id,
                "document_id": x.document_id,
                "number": x.number,
                "base_version_id": x.base_version_id,
                "status": x.status,
                "submission_count": count,
                "created_at": iso(x.created_at),
            }
        )
    return out


@app.post("/rounds/{round_id}/drafts")
def upload_draft(round_id: int, base_version_id: int = Form(...), sha256: str = Form(...), file: UploadFile = File(...), s: Session = Depends(db), m: Member = Depends(user)):
    r = s.get(Round, round_id)
    if not r:
        raise HTTPException(404, "轮次不存在")
    d = s.get(Document, r.document_id)
    p = member_project(s, d.project_id, m)
    if r.status != "open" or base_version_id != r.base_version_id:
        raise HTTPException(409, "轮次已关闭或基础版本已过期")
    digest, _ = store_docx(file)
    if digest.lower() != sha256.lower():
        raise HTTPException(422, "文件内容与本地校验值不一致，可能上传中断")
    version = make_version(s, d, m, digest, "draft", p, r.number, r.base_version_id)
    audit(s, m, "draft.snapshot", "version", version.id, p.id)
    s.commit()
    return {"version_id": version.id, "sha256": digest}


@app.post("/rounds/{round_id}/submissions")
def submit(round_id: int, base_version_id: int = Form(...), sha256: str = Form(...), note: str = Form(""), file: UploadFile = File(...), s: Session = Depends(db), m: Member = Depends(user)):
    r = s.get(Round, round_id)
    if not r:
        raise HTTPException(404, "轮次不存在")
    d = s.get(Document, r.document_id)
    p = member_project(s, d.project_id, m)
    if r.status != "open":
        raise HTTPException(409, "该轮次已停止接收提交")
    if base_version_id != r.base_version_id:
        raise HTTPException(409, "基础版本已过期，请重新下载本轮工作副本")
    digest, _ = store_docx(file)
    if digest.lower() != sha256.lower():
        raise HTTPException(422, "文件内容与本地校验值不一致，可能上传中断")
    if s.scalar(select(Submission).where(Submission.round_id == r.id, Submission.author_id == m.id, Submission.version_id.in_(select(Version.id).where(Version.sha256 == digest)))):
        raise HTTPException(409, "这份提交已经上传过了")
    v = make_version(s, d, m, digest, "submission", p, r.number, r.base_version_id)
    sub = Submission(round_id=r.id, author_id=m.id, base_version_id=base_version_id, version_id=v.id, note=note.strip())
    s.add(sub)
    s.flush()
    job = Job(kind="diff", status="running", payload=json.dumps({"submission_id": sub.id}))
    s.add(job)
    s.flush()
    try:
        build_submission_diff(s, sub, m, d, p, r)
        job.status = "complete"
    except Exception as exc:
        job.status = "failed"
        job.payload = json.dumps({"submission_id": sub.id, "error": type(exc).__name__})
        sub.status = "diff_failed"
    audit(s, m, "submission.created", "submission", sub.id, p.id)
    s.commit()
    return {"id": sub.id, "version_id": v.id, "redline_version_id": sub.redline_version_id, "status": sub.status, "job_id": job.id}


def submission_access(s: Session, sub_id: int, m: Member) -> tuple[Submission, Round, Document, Project]:
    sub = s.get(Submission, sub_id)
    if not sub:
        raise HTTPException(404, "提交不存在")
    r = s.get(Round, sub.round_id)
    d = s.get(Document, r.document_id)
    p = member_project(s, d.project_id, m)
    return sub, r, d, p


@app.get("/rounds/{round_id}/submissions")
def list_submissions(round_id: int, s: Session = Depends(db), m: Member = Depends(user)):
    r = s.get(Round, round_id)
    if not r:
        raise HTTPException(404, "轮次不存在")
    d = s.get(Document, r.document_id)
    member_project(s, d.project_id, m)
    rows = s.scalars(select(Submission).where(Submission.round_id == r.id).order_by(Submission.created_at.desc())).all()
    return [
        {
            "id": x.id,
            "author": s.get(Member, x.author_id).username,
            "author_id": x.author_id,
            "created_at": iso(x.created_at),
            "note": x.note,
            "status": x.status,
            "version_id": x.version_id,
            "redline_version_id": x.redline_version_id,
            "resolved_version_id": x.resolved_version_id,
            "redline_warnings": json.loads(x.redline_warnings or "[]"),
        }
        for x in rows
    ]


@app.get("/submissions/{submission_id}/comments")
def list_comments(submission_id: int, s: Session = Depends(db), m: Member = Depends(user)):
    submission_access(s, submission_id, m)
    rows = s.scalars(select(Comment).where(Comment.submission_id == submission_id).order_by(Comment.created_at)).all()
    return [{"id": x.id, "author": s.get(Member, x.author_id).username, "body": x.body, "created_at": iso(x.created_at)} for x in rows]


@app.post("/submissions/{submission_id}/comments")
def add_comment(submission_id: int, data: CommentIn, s: Session = Depends(db), m: Member = Depends(user)):
    _, _, _, p = submission_access(s, submission_id, m)
    comment = Comment(submission_id=submission_id, author_id=m.id, body=data.body.strip())
    s.add(comment)
    s.flush()
    audit(s, m, "comment.created", "comment", comment.id, p.id)
    s.commit()
    return {"id": comment.id, "author": m.username, "body": comment.body, "created_at": iso(comment.created_at)}


@app.get("/submissions/{submission_id}/diff")
def get_diff(submission_id: int, s: Session = Depends(db), m: Member = Depends(user)):
    sub, _, _, _ = submission_access(s, submission_id, m)
    hunks = s.scalars(select(ReviewHunk).where(ReviewHunk.submission_id == sub.id)).all()
    return {
        "submission_id": sub.id,
        "status": sub.status,
        "note": sub.note,
        "redline_version_id": sub.redline_version_id,
        "resolved_version_id": sub.resolved_version_id,
        "redline_warnings": json.loads(sub.redline_warnings or "[]"),
        "engine_available": bool(_engine()),
        "hunks": [
            {
                "id": h.id,
                "anchor": h.anchor,
                "risk": h.risk,
                "decision": (s.scalar(select(ReviewDecision.decision).where(ReviewDecision.hunk_id == h.id)) or "pending"),
                **json.loads(h.payload),
            }
            for h in hunks
        ],
    }


@app.patch("/reviews/{submission_id}/hunks/{hunk_id}")
def decide_hunk(submission_id: int, hunk_id: int, data: DecisionIn, s: Session = Depends(db), m: Member = Depends(teacher)):
    selected = data.decision or data.status
    if selected not in ("accepted", "rejected", "pending"):
        raise HTTPException(422, "决定只能是 accepted、rejected 或 pending")
    sub, r, _, p = submission_access(s, submission_id, m)
    if r.status not in ("open", "reviewing"):
        raise HTTPException(409, "该轮次已经结束，不能再修改决定")
    h = s.get(ReviewHunk, hunk_id)
    if not h or h.submission_id != sub.id:
        raise HTTPException(404, "修改片段不存在")
    x = s.scalar(select(ReviewDecision).where(ReviewDecision.hunk_id == h.id))
    if x:
        x.decision = selected
        x.teacher_id = m.id
        x.updated_at = now()
    else:
        s.add(ReviewDecision(hunk_id=h.id, teacher_id=m.id, decision=selected))
    audit(s, m, "review.decided", "review_hunk", h.id, p.id)
    s.commit()
    return {"hunk_id": h.id, "decision": selected}


@app.post("/reviews/{submission_id}/finalize")
def finalize_review(submission_id: int, s: Session = Depends(db), m: Member = Depends(teacher)):
    sub, r, _, p = submission_access(s, submission_id, m)
    if r.status != "open":
        raise HTTPException(409, "该轮次已经结束")
    d = s.get(Document, r.document_id)
    author = s.get(Member, sub.author_id)
    hunks = s.scalars(select(ReviewHunk).where(ReviewHunk.submission_id == sub.id)).all()
    decisions = {x.hunk_id: x.decision for x in s.scalars(select(ReviewDecision).where(ReviewDecision.hunk_id.in_([h.id for h in hunks]))).all()} if hunks else {}
    pending = [h.id for h in hunks if decisions.get(h.id, "pending") == "pending"]
    if pending:
        raise HTTPException(409, {"message": "请先处理完所有修改片段", "pending_hunk_ids": pending})
    apply_decisions, compute_diff, _, _ = engine_api()
    base = s.get(Version, sub.base_version_id)
    revised = s.get(Version, sub.version_id)
    diff = compute_diff(object_path(base.sha256), object_path(revised.sha256), author.username)
    by_engine = {h.engine_hunk_id: decisions.get(h.id, "rejected") for h in hunks}
    with tempfile.TemporaryDirectory() as directory:
        resolved_path = Path(directory) / "resolved.docx"
        applied = apply_decisions(object_path(base.sha256), object_path(revised.sha256), diff, by_engine, resolved_path)
        digest, _ = store_generated(resolved_path)
    resolved = make_version(s, d, author, digest, "contribution", p, r.number, sub.base_version_id)
    sub.resolved_version_id = resolved.id
    try:
        needs_manual = applied.needs_manual_review
    except AttributeError as exc:
        # Backstop only. `engine_api()` already refuses to run against an engine that
        # fails the contract probe, so reaching here means the engine changed shape
        # after import. Report it with a code the log can be searched for instead of
        # letting a bare AttributeError look like an internal bug.
        raise HTTPException(500, {
            "code": "engine_contract_mismatch",
            "message": "服务器上的 DOCX 引擎返回了无法识别的结果，审阅无法完成。请联系管理员重新部署。",
            "detail": str(exc),
            "engine": engine_status(),
        }) from exc
    if needs_manual:
        # The engine applied everything it could but refused at least one accepted change.
        # Marking the submission reviewed here is what used to let a paragraph silently
        # disappear from the published version, so surface it as a manual requirement instead.
        conflicts = record_apply_conflicts(s, r, applied.conflicts)
        sub.status = "manual_required"
        audit(s, m, "review.needs_manual_merge", "submission", sub.id, p.id)
        s.commit()
        raise HTTPException(409, {
            "message": "该提交包含无法自动套用的改动（新增/删除段落，或含图片、公式、域、超链接的段落）。已套用能自动处理的部分，请下载结果后人工合并并上传，或将该提交标记为跳过。",
            "submission_id": sub.id,
            "status": sub.status,
            "resolved_version_id": resolved.id,
            "conflicts": conflicts,
        })
    audit(s, m, "review.finalized", "submission", sub.id, p.id)
    sub.status = "reviewed"
    s.commit()
    return {
        "submission_id": sub.id,
        "status": "reviewed",
        "resolved_version_id": resolved.id,
        "warnings": applied.warnings,
    }


@app.post("/submissions/{submission_id}/skip")
def skip_submission(submission_id: int, data: SkipIn = SkipIn(), s: Session = Depends(db), m: Member = Depends(teacher)):
    """Put a submission in a terminal state without reviewing it, so the round can be published."""
    sub, r, _, p = submission_access(s, submission_id, m)
    if r.status not in ("open", "reviewing"):
        raise HTTPException(409, "该轮次已经结束，不能再修改决定")
    if sub.status in ("reviewed", "skipped", "rejected"):
        raise HTTPException(409, "该提交已经处理过了")
    reason = data.reason.strip()
    if reason:
        sub.note = f"{sub.note}\n[老师跳过] {reason}".strip()
    sub.status = "skipped"
    audit(s, m, "submission.skipped", "submission", sub.id, p.id)
    s.commit()
    return {"submission_id": sub.id, "status": sub.status, "note": sub.note}


@app.post("/rounds/{round_id}/publish-result")
def publish_result(round_id: int, data: PublishResultIn = PublishResultIn(), s: Session = Depends(db), m: Member = Depends(teacher)):
    r = s.get(Round, round_id)
    if not r:
        raise HTTPException(404, "轮次不存在")
    d = s.get(Document, r.document_id)
    p = member_project(s, d.project_id, m)
    if r.status != "open":
        raise HTTPException(409, "该轮次不是进行中状态")
    submissions = s.scalars(select(Submission).where(Submission.round_id == r.id)).all()
    outstanding = [x for x in submissions if x.status not in TERMINAL_SUBMISSION_STATUSES]
    if outstanding:
        # Publishing used to filter to `reviewed` and silently drop everyone else, which
        # quietly published a version missing half the contributions.
        raise HTTPException(409, {
            "message": "还有提交没有处理完，不能发布本轮结果。请逐份审阅，或把不参与的提交标记为跳过。",
            "outstanding": [
                {
                    "id": x.id,
                    "author": (s.get(Member, x.author_id).username if s.get(Member, x.author_id) else None),
                    "status": x.status,
                }
                for x in outstanding
            ],
        })
    reviewed = [x for x in submissions if x.status == "reviewed"]
    if not reviewed:
        raise HTTPException(409, "还没有完成审阅的提交")
    _, _, generate_redline, merge_contributions = engine_api()
    base = s.get(Version, r.base_version_id)
    contributions = []
    for sub in reviewed:
        version = s.get(Version, sub.resolved_version_id)
        author = s.get(Member, sub.author_id)
        if version:
            contributions.append((object_path(version.sha256), author.username))
    # Conflicts are upserted by anchor so a retry after resolving keeps the record
    # of what collided and which side the teacher chose, instead of wiping it.
    known = {c.anchor: c for c in s.scalars(select(MergeConflict).where(MergeConflict.round_id == r.id)).all()}
    with tempfile.TemporaryDirectory() as directory:
        merged_path = Path(directory) / "merged.docx"
        result = merge_contributions(object_path(base.sha256), contributions, merged_path, data.conflict_choices)
        if result.conflicts:
            conflicts = []
            reported = set()
            for conflict in result.conflicts:
                payload = conflict.to_dict()
                reported.add(conflict.match_key)
                row = upsert_conflict(s, r.id, conflict.match_key, payload)
                conflicts.append({"id": row.id, **payload})
            # Conflicts that no longer collide are stale; drop them so the teacher is
            # not asked to resolve something that has already gone away.
            for stale in known.values():
                if stale.anchor not in reported:
                    s.delete(stale)
            audit(s, m, "round.conflicts_detected", "round", r.id, p.id)
            s.commit()
            raise HTTPException(409, {"message": "存在多人冲突，需要选择保留哪一方或上传人工合并结果", "conflicts": conflicts})
        digest, _ = store_generated(merged_path)
        final = make_version(s, d, m, digest, "main", p, r.number, d.current_version_id)
        summary_path = Path(directory) / "summary-redline.docx"
        summary_warnings = generate_redline(
            object_path(base.sha256), merged_path, "合并结果", summary_path
        ).warnings
        summary_digest, _ = store_generated(summary_path)
        summary = make_version(s, d, m, summary_digest, "summary_redline", p, r.number, r.base_version_id)
    for conflict in s.scalars(select(MergeConflict).where(MergeConflict.round_id == r.id)).all():
        conflict.status = "resolved"
        conflict.resolution = data.conflict_choices.get(conflict.anchor, "auto")
    d.current_version_id = final.id
    r.status = "published"
    audit(s, m, "round.published_result", "round", r.id, p.id)
    s.commit()
    return {
        "round_id": r.id,
        "status": r.status,
        "version_id": final.id,
        "summary_redline_version_id": summary.id,
        "resolution": "auto",
        "redline_warnings": summary_warnings,
    }


@app.get("/rounds/{round_id}/conflicts")
def list_conflicts(round_id: int, s: Session = Depends(db), m: Member = Depends(user)):
    r = s.get(Round, round_id)
    if not r:
        raise HTTPException(404, "轮次不存在")
    d = s.get(Document, r.document_id)
    member_project(s, d.project_id, m)
    return [
        {"id": x.id, "anchor": x.anchor, "status": x.status, "resolution": x.resolution, **json.loads(x.payload)}
        for x in s.scalars(select(MergeConflict).where(MergeConflict.round_id == r.id)).all()
    ]


@app.post("/rounds/{round_id}/manual-result")
def publish_manual_result(round_id: int, file: UploadFile = File(...), s: Session = Depends(db), m: Member = Depends(teacher)):
    r = s.get(Round, round_id)
    if not r:
        raise HTTPException(404, "轮次不存在")
    d = s.get(Document, r.document_id)
    p = member_project(s, d.project_id, m)
    if r.status != "open":
        raise HTTPException(409, "该轮次不是进行中状态")
    digest, _ = store_docx(file)
    _, _, generate_redline, _ = engine_api()
    base = s.get(Version, r.base_version_id)
    with tempfile.TemporaryDirectory() as directory:
        stored_path = Path(directory) / "manual-result.docx"
        stored_path.write_bytes(object_path(digest).read_bytes())
        version = make_version(s, d, m, digest, "manual_merge", p, r.number, d.current_version_id)
        # Emit the same audit trail as an automatic publish: a teacher comparing two
        # rounds should not have to guess why one of them has no summary redline.
        summary_path = Path(directory) / "summary-redline.docx"
        manual_warnings = generate_redline(
            object_path(base.sha256), stored_path, "人工合并结果", summary_path
        ).warnings
        summary_digest, _ = store_generated(summary_path)
        summary = make_version(s, d, m, summary_digest, "summary_redline", p, r.number, r.base_version_id)
    d.current_version_id = version.id
    r.status = "published"
    for conflict in s.scalars(select(MergeConflict).where(MergeConflict.round_id == r.id)).all():
        conflict.status = "resolved"
        conflict.resolution = "manual"
    audit(s, m, "round.published_manual_result", "round", r.id, p.id)
    s.commit()
    return {
        "round_id": r.id,
        "status": r.status,
        "version_id": version.id,
        "summary_redline_version_id": summary.id,
        "resolution": "manual",
        "redline_warnings": manual_warnings,
    }


@app.post("/documents/{document_id}/versions")
def replace_document_version(document_id: int, file: UploadFile = File(...), s: Session = Depends(db), m: Member = Depends(teacher)):
    """Replace a document's main file without creating a second Document.

    Rounds, submissions and versions all hang off the Document row, so "replace the main
    document" has to add a Version here rather than upload a new Document — otherwise the
    project silently ends up with two unrelated documents and rounds bind to the old one.
    """
    d = s.get(Document, document_id)
    if not d:
        raise HTTPException(404, "文档不存在")
    p = member_project(s, d.project_id, m)
    digest, _ = store_docx(file)
    version = make_version(s, d, m, digest, "main", p, 0, d.current_version_id)
    d.current_version_id = version.id
    audit(s, m, "document.replaced", "document", d.id, p.id)
    s.commit()
    return {
        "document_id": d.id,
        "version_id": version.id,
        "sha256": digest,
        "current_version_id": d.current_version_id,
    }


@app.get("/documents/{document_id}/versions")
def versions(document_id: int, s: Session = Depends(db), m: Member = Depends(user)):
    d = s.get(Document, document_id)
    if not d:
        raise HTTPException(404, "文档不存在")
    member_project(s, d.project_id, m)
    rows = s.scalars(select(Version).where(Version.document_id == d.id).order_by(Version.created_at.desc(), Version.id.desc())).all()
    return [
        {
            "id": v.id,
            "parent_id": v.parent_id,
            "sha256": v.sha256,
            "display_name": v.display_name,
            "kind": v.kind,
            "author": (s.get(Member, v.author_id).username if s.get(Member, v.author_id) else None),
            "created_at": iso(v.created_at),
            "current": v.id == d.current_version_id,
            "size_bytes": (object_path(v.sha256).stat().st_size if object_path(v.sha256).exists() else None),
        }
        for v in rows
    ]


@app.get("/versions/{version_id}")
def version_detail(version_id: int, s: Session = Depends(db), m: Member = Depends(user)):
    v = s.get(Version, version_id)
    if not v:
        raise HTTPException(404, "版本不存在")
    d = s.get(Document, v.document_id)
    p = member_project(s, d.project_id, m)
    author = s.get(Member, v.author_id)
    return {
        "id": v.id,
        "document_id": v.document_id,
        "document_name": d.name,
        "project_id": p.id,
        "project_name": p.name,
        "parent_id": v.parent_id,
        "sha256": v.sha256,
        "display_name": v.display_name,
        "kind": v.kind,
        "author": author.username if author else None,
        "created_at": iso(v.created_at),
        "current": v.id == d.current_version_id,
    }


@app.get("/versions/{version_id}/download")
def download(version_id: int, s: Session = Depends(db), m: Member = Depends(user)):
    v = s.get(Version, version_id)
    if not v:
        raise HTTPException(404, "版本不存在")
    d = s.get(Document, v.document_id)
    member_project(s, d.project_id, m)
    obj = object_path(v.sha256)
    if not obj.exists():
        raise HTTPException(410, "服务器上的该文件已丢失，请联系管理员")
    audit(s, m, "version.downloaded", "version", v.id, d.project_id)
    s.commit()
    return FileResponse(
        obj,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename=v.display_name,
    )


@app.post("/versions/{version_id}/restore")
def restore(version_id: int, data: RestoreIn, s: Session = Depends(db), m: Member = Depends(teacher)):
    v = s.get(Version, version_id)
    d = s.get(Document, data.document_id)
    if not v or not d or v.document_id != d.id:
        raise HTTPException(404, "版本或文档不存在")
    member_project(s, d.project_id, m)
    if v.kind not in RESTORABLE_VERSION_KINDS:
        # A redline is a *view* of a submission and a draft is unfinished work; making
        # either the official main version with one click is invisible afterwards, since
        # versions are immutable. The UI hides the button, and this is the real control.
        raise HTTPException(409, {
            "code": "version_kind_not_restorable",
            "message": "这是审阅用的中间版本，不能直接恢复为主版本。可以恢复的是：正式主版本、成员提交、人工合并结果。",
            "kind": v.kind,
            "restorable_kinds": list(RESTORABLE_VERSION_KINDS),
        })
    d.current_version_id = v.id
    audit(s, m, "version.restored", "version", v.id, d.project_id)
    s.commit()
    return {"document_id": d.id, "current_version_id": v.id}


@app.get("/jobs/{job_id}")
def job_status(job_id: int, s: Session = Depends(db), m: Member = Depends(user)):
    job = s.get(Job, job_id)
    if not job:
        raise HTTPException(404, "任务不存在")
    payload = json.loads(job.payload)
    submission_id = payload.get("submission_id")
    if submission_id:
        submission_access(s, submission_id, m)
    return {"id": job.id, "kind": job.kind, "status": job.status, "payload": payload}


@app.get("/events")
def event_history(after: int = 0, s: Session = Depends(db), m: Member = Depends(user)):
    project_ids = select(ProjectMember.project_id).where(ProjectMember.member_id == m.id)
    rows = s.scalars(select(Event).where(Event.id > after, Event.project_id.in_(project_ids)).order_by(Event.id).limit(500)).all()
    return [{"id": x.id, "project_id": x.project_id, "kind": x.kind, "payload": json.loads(x.payload), "created_at": iso(x.created_at)} for x in rows]


@app.websocket("/events")
async def events(ws: WebSocket):
    token = ws.query_params.get("token")
    after = int(ws.query_params.get("after", "0") or 0)
    if not token:
        await ws.close(code=4401)
        return
    with DB() as s:
        m = resolve_token(s, token)
        if not m or m.must_change_password:
            await ws.close(code=4401)
            return
        project_ids = [row for row in s.scalars(select(ProjectMember.project_id).where(ProjectMember.member_id == m.id)).all()]
    await ws.accept()
    with DB() as s:
        rows = s.scalars(select(Event).where(Event.id > after, Event.project_id.in_(project_ids)).order_by(Event.id)).all()
        for e in rows:
            await ws.send_json({"id": e.id, "kind": e.kind, "payload": json.loads(e.payload), "created_at": iso(e.created_at)})
    try:
        while True:
            await ws.receive_text()
            await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass


# The engine contract this file is written against. Bumped in lockstep with
# `wordwork_doc_engine.ENGINE_CONTRACT_VERSION`; a mismatch means the deployed engine
# and this API disagree about the shape of `apply_decisions()`'s result.
ENGINE_REQUIRED_CONTRACT = 2


def engine_status() -> dict:
    """Import the engine and *prove* it satisfies the contract this API codes against.

    Checking that the package merely imports is not enough: a deployment once served
    `engine_available: true` from a stale 0.1.0 engine whose `apply_decisions()`
    returned a bare `Path`, so every "完成审阅" ended in
    `AttributeError: 'WindowsPath' object has no attribute 'needs_manual_review'`.
    `verify_contract()` probes the real result objects instead of trusting a version.
    """
    try:
        import wordwork_doc_engine as engine
    except ImportError as exc:
        return {
            "available": False,
            "compatible": False,
            "version": None,
            "contract": None,
            "file": None,
            "problem": f"未安装 wordwork-doc-engine：{exc}",
        }
    # A 0.1.0 engine has no `verify_contract` at all, so calling it unconditionally
    # would turn a diagnosable "wrong engine" into an AttributeError inside /healthz.
    probe = getattr(engine, "verify_contract", None)
    problems = list(probe()) if callable(probe) else ["引擎缺少 verify_contract()，无法确认它满足本 API 的契约"]
    contract = getattr(engine, "ENGINE_CONTRACT_VERSION", None)
    if contract != ENGINE_REQUIRED_CONTRACT:
        problems.insert(0, f"契约版本不匹配：服务端需要 {ENGINE_REQUIRED_CONTRACT}，实际 {contract}")
    return {
        "available": True,
        "compatible": not problems,
        "version": getattr(engine, "ENGINE_VERSION", None),
        "contract": contract,
        "file": getattr(engine, "__file__", None),
        "problem": "；".join(problems) or None,
    }


def _engine() -> bool:
    return bool(engine_status()["compatible"])


def engine_api():
    """The engine callables the endpoints use, or a 503 that says exactly why not."""
    status = engine_status()
    if not status["available"]:
        raise HTTPException(503, "服务器缺少 DOCX 差异引擎，请联系管理员")
    if not status["compatible"]:
        # Fail here, with the diagnosis, rather than as an AttributeError halfway
        # through the teacher's review.
        raise HTTPException(503, {
            "code": "engine_contract_mismatch",
            "message": "服务器上的 DOCX 引擎版本与 API 不匹配，审阅无法进行。请联系管理员重新部署。",
            "problem": status["problem"],
            "engine_version": status["version"],
            "engine_contract": status["contract"],
            "required_contract": ENGINE_REQUIRED_CONTRACT,
        })
    from wordwork_doc_engine import apply_decisions, compute_diff, generate_redline, merge_contributions

    return apply_decisions, compute_diff, generate_redline, merge_contributions
