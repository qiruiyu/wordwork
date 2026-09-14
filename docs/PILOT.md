# Three-person pilot checklist

## Preparation

- Use a fully anonymized copy of a real grant document.
- Create one teacher account and two student accounts.
- Verify backup creation and restoration on an empty test data directory.

## Round 1

1. Teacher uploads the master and publishes a round.
2. Both students download the same base and edit different paragraphs plus one shared paragraph.
3. Both students submit with a short change note.
4. Confirm both students can view, but cannot decide, the other's submitted diff.
5. Teacher accepts some hunks, rejects others, and sees one deterministic shared-paragraph conflict.
6. Teacher resolves the conflict and publishes the result.
7. Open the result in Windows Word, macOS Word and the available WPS clients.

## Round 2

- Restore Round 1's base as a new master, verify its digest, then restore the published result.
- Repeat with tables, an image, an equation, header/footer text and footnotes.
- Confirm complex changes are marked risky or manual instead of disappearing.

The pilot passes only if there is no repair prompt, version loss, unauthorized access, or silent
overwrite across two consecutive rounds.

