"""State shared by the API test modules.

Every module drives the same imported FastAPI app, so they also share one database for
the whole pytest run.  The bootstrap demo accounts are forced to change their password on
first login; whichever module logs in first performs that change, and the new password is
cached here so the other module does not keep sending a stale one (repeated wrong
passwords would trip the login throttle and turn a passing suite into a 429).
"""

DEMO_PASSWORD = "wordwork-demo-change-me"
CURRENT_PASSWORDS: dict[str, str] = {}


def changed_password(username: str) -> str:
    return f"{username}-changed-password-2026"
