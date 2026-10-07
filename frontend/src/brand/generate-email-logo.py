"""Render the email header logo.

Email clients drop SVG, so the header of every Standupless email loads this PNG
from `public/email-logo.png` at an absolute URL. The tile is the brand orange
with the mark in white, which reads on a light inbox and on a dark one without
relying on a client honouring `prefers-color-scheme`. It is drawn at three times
the 32 pixel display size so it stays sharp on high density screens.

Run from the `frontend` directory:

    python3 src/brand/generate-email-logo.py

The bars are the same rectangles and radii as `Logo.tsx` on the same 32 unit
grid, so the two cannot drift apart silently.
"""

from __future__ import annotations

import pathlib

from PIL import Image, ImageDraw

SIZE = 96
SUPERSAMPLE = 4
TILE = (184, 69, 26, 255)
MARK = (255, 255, 255, 255)
TILE_RADIUS = 7.0

MARK_BARS = (
    (4.0, 21.5, 12.0, 5.0, 2.5),
    (10.0, 13.5, 12.0, 5.0, 2.5),
    (23.0, 5.5, 5.0, 5.0, 2.5),
)


def render() -> Image.Image:
    """Draw the tile and the mark supersampled, then scale down for smooth edges."""
    full = SIZE * SUPERSAMPLE
    unit = full / 32
    image = Image.new("RGBA", (full, full), (0, 0, 0, 0))
    canvas = ImageDraw.Draw(image)
    canvas.rounded_rectangle((0, 0, full - 1, full - 1), radius=TILE_RADIUS * unit, fill=TILE)
    for left, top, width, height, radius in MARK_BARS:
        box = (left * unit, top * unit, (left + width) * unit, (top + height) * unit)
        canvas.rounded_rectangle(box, radius=radius * unit, fill=MARK)
    return image.resize((SIZE, SIZE), Image.LANCZOS)


def main() -> None:
    """Write `public/email-logo.png`."""
    target = pathlib.Path("public/email-logo.png")
    render().save(target, optimize=True)
    print(f"Wrote {target}")


if __name__ == "__main__":
    main()
