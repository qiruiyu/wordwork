# Architecture

## Invariants

1. A version is immutable and addressed by its SHA-256 digest.
2. Every submission names the exact frozen base version it was edited from.
3. The server never infers identity, version, or ordering from a filename.
4. Only a teacher can decide review hunks, resolve conflicts, restore history, or publish a result.
5. Unsupported document structures become explicit manual conflicts; they are never silently lost.

## Collaboration state machine

`draft -> open -> reviewing -> published`

- Creating a round captures an immutable base version.
- Publishing the round makes it visible to project members.
- Each submission is compared with that same base, even if another submission is already reviewed.
- Accepted contributions that touch distinct structural blocks are merged automatically.
- Two accepted contributions touching the same paragraph, table cell, or complex object conflict.
- Publishing creates a new master version and makes the round read-only.

## Document engine contract

The API service calls `wordwork_doc_engine` through five stable functions:

- `validate_docx(path)`
- `compute_diff(base_path, revised_path, author)`
- `apply_decisions(base_path, revised_path, diff_result, decisions, output_path)`
- `merge_contributions(base_path, contributions, output_path)`
- `generate_redline(base_path, revised_path, author, output_path)`

The engine works at OOXML part/block boundaries. It preserves untouched ZIP parts byte-for-byte
where practical and never converts the full document through Markdown.

## Storage

SQLite stores metadata and append-only audit events. File content is stored under
`objects/aa/bb/<sha256>`. Display filenames exist only in metadata and download headers. The worker
uses database-backed jobs so the pilot deployment does not require Redis.

## Desktop synchronization

The desktop app stores the server URL, user session, checked-out base ID, working path and latest
local digest. Local snapshots are queued while offline. A queued submission is rejected if its
round has closed; the local file remains available and may be attached to a new round explicitly.

