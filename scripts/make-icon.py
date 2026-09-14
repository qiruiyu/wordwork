"""Generate the wordwork app icon as a PNG without third-party imaging libraries.

Run once to regenerate the source image, then `pnpm tauri icon` derives the
Windows/macOS/Linux icon set from it:

    python scripts/make-icon.py apps/desktop/src-tauri/icons/source.png
"""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

SIZE = 1024
BACKGROUND = (79, 70, 229)
FOREGROUND = (255, 255, 255)
CORNER = int(SIZE * 0.22)
STROKE = int(SIZE * 0.075)


def rounded_rect_alpha(x: float, y: float) -> float:
    """Signed-distance style coverage for an anti-aliased rounded square."""
    cx = min(max(x, CORNER), SIZE - CORNER)
    cy = min(max(y, CORNER), SIZE - CORNER)
    dx = x - cx
    dy = y - cy
    distance = (dx * dx + dy * dy) ** 0.5
    coverage = CORNER + 1.0 - distance
    return max(0.0, min(1.0, coverage))


def distance_to_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    length_sq = vx * vx + vy * vy
    t = 0.0 if length_sq == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / length_sq))
    dx, dy = px - (ax + t * vx), py - (ay + t * vy)
    return (dx * dx + dy * dy) ** 0.5


def letter_w_strokes() -> list[tuple[float, float, float, float]]:
    left, right = SIZE * 0.24, SIZE * 0.76
    top, bottom = SIZE * 0.32, SIZE * 0.70
    mid = SIZE * 0.56
    return [
        (left, top, left + (right - left) * 0.20, bottom),
        (left + (right - left) * 0.20, bottom, (left + right) / 2, mid),
        ((left + right) / 2, mid, right - (right - left) * 0.20, bottom),
        (right - (right - left) * 0.20, bottom, right, top),
    ]


def build_pixels() -> bytes:
    strokes = letter_w_strokes()
    half = STROKE / 2
    rows = bytearray()
    for y in range(SIZE):
        rows.append(0)  # PNG filter type: none
        for x in range(SIZE):
            px, py = x + 0.5, y + 0.5
            alpha = rounded_rect_alpha(px, py)
            ink = 0.0
            for ax, ay, bx, by in strokes:
                ink = max(ink, half + 1.0 - distance_to_segment(px, py, ax, ay, bx, by))
            ink = max(0.0, min(1.0, ink))
            r = round(BACKGROUND[0] * (1 - ink) + FOREGROUND[0] * ink)
            g = round(BACKGROUND[1] * (1 - ink) + FOREGROUND[1] * ink)
            b = round(BACKGROUND[2] * (1 - ink) + FOREGROUND[2] * ink)
            rows.extend((r, g, b, round(alpha * 255)))
    return bytes(rows)


def chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def write_png(target: Path) -> None:
    header = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    body = zlib.compress(build_pixels(), 9)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", body)
        + chunk(b"IEND", b"")
    )


if __name__ == "__main__":
    destination = Path(sys.argv[1] if len(sys.argv) > 1 else "source.png")
    write_png(destination)
    print(f"wrote {destination} ({destination.stat().st_size} bytes)")
