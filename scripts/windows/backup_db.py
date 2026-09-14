"""数据库备份助手。

直接复制 .sqlite3 文件在 WAL 模式下可能拿到半截数据，所以一律走 SQLite
自己的 backup API；它是原子的，数据库正在被服务端读写时也能安全复制。

用法:
    backup_db.py backup <源库> <目标库>   复制并打印目标库的 sha256
    backup_db.py hash   <文件>            打印 sha256
    backup_db.py verify <库文件>          跑 PRAGMA integrity_check
"""
from __future__ import annotations

import hashlib
import sqlite3
import sys
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cmd_backup(src: Path, dst: Path) -> int:
    if not src.exists():
        print(f"数据库不存在：{src}", file=sys.stderr)
        return 1
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    with sqlite3.connect(str(src)) as source, sqlite3.connect(str(dst)) as target:
        source.backup(target)
    print(sha256(dst))
    return 0


def cmd_hash(path: Path) -> int:
    if not path.exists():
        print(f"文件不存在：{path}", file=sys.stderr)
        return 1
    print(sha256(path))
    return 0


def cmd_verify(path: Path) -> int:
    if not path.exists():
        print(f"文件不存在：{path}", file=sys.stderr)
        return 1
    try:
        with sqlite3.connect(str(path)) as conn:
            result = conn.execute("PRAGMA integrity_check").fetchone()
    except sqlite3.DatabaseError as exc:
        print(f"不是有效的 SQLite 数据库：{exc}", file=sys.stderr)
        return 1
    verdict = result[0] if result else "unknown"
    print(verdict)
    return 0 if verdict == "ok" else 1


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    mode, rest = argv[0], argv[1:]
    if mode == "backup" and len(rest) == 2:
        return cmd_backup(Path(rest[0]), Path(rest[1]))
    if mode == "hash" and len(rest) == 1:
        return cmd_hash(Path(rest[0]))
    if mode == "verify" and len(rest) == 1:
        return cmd_verify(Path(rest[0]))
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
