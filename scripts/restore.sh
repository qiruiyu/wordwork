#!/bin/sh
set -eu

archive="${1:?usage: restore.sh BACKUP_ARCHIVE TARGET_DATA_DIR}"
target="${2:?usage: restore.sh BACKUP_ARCHIVE TARGET_DATA_DIR}"
test ! -e "$target/wordwork.db" || { echo "target already contains wordwork.db" >&2; exit 2; }

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
case "$archive" in
  *.enc)
    test -n "${WORDWORK_BACKUP_PASSPHRASE:-}" || { echo "WORDWORK_BACKUP_PASSPHRASE is required" >&2; exit 2; }
    openssl enc -d -aes-256-cbc -pbkdf2 -in "$archive" -out "$tmp_dir/backup.tar.gz" -pass env:WORDWORK_BACKUP_PASSPHRASE
    archive="$tmp_dir/backup.tar.gz"
    ;;
esac
mkdir -p "$target"
tar -C "$target" -xzf "$archive"
python - "$target/wordwork.db" <<'PY'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    result = db.execute("PRAGMA integrity_check").fetchone()[0]
    if result != "ok":
        raise SystemExit(f"restored database failed integrity check: {result}")
PY
echo "restored to $target"

