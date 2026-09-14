#!/bin/sh
set -eu

data_dir="${WORDWORK_DATA_DIR:-/data}"
backup_dir="${WORDWORK_BACKUP_DIR:-/backups}"
retention_days="${WORDWORK_BACKUP_RETENTION_DAYS:-30}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$backup_dir/wordwork-$timestamp.tar.gz"

mkdir -p "$backup_dir"
test -f "$data_dir/wordwork.db"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
python - "$data_dir/wordwork.db" "$tmp_dir/wordwork.db" <<'PY'
import sqlite3, sys
source, target = sys.argv[1:]
with sqlite3.connect(source) as src, sqlite3.connect(target) as dst:
    src.backup(dst)
PY
cp -R "$data_dir/objects" "$tmp_dir/objects"
tar -C "$tmp_dir" -czf "$archive" wordwork.db objects

if [ -n "${WORDWORK_BACKUP_PASSPHRASE:-}" ]; then
  openssl enc -aes-256-cbc -salt -pbkdf2 -in "$archive" -out "$archive.enc" -pass env:WORDWORK_BACKUP_PASSPHRASE
  rm "$archive"
  archive="$archive.enc"
fi

find "$backup_dir" -type f -name 'wordwork-*' -mtime "+$retention_days" -delete
echo "$archive"

