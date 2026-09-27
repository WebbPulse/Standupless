"""Render the Open Graph social card.

The card is checked in as `public/og.png` rather than generated at build time,
because a social crawler fetches it as a flat image and nothing in the app reads
it. This script exists so the card can be rebuilt from the brand source rather
than redrawn by hand, and so the lettering comes from the same Inter files the
interface loads. An earlier card was rendered in whatever sans the machine had
installed, which left the social preview set in a different face from the
wordmark it was meant to mirror.

Run from the `frontend` directory:

    python3 src/brand/generate-og.py

The mark is drawn from the same rectangles and radii as `Logo.tsx` on the same
32 unit grid, so the two cannot drift apart silently.
"""

from __future__ import annotations

import pathlib

from PIL import Image, ImageDraw, ImageFont

WIDTH = 1200
HEIGHT = 630

BACKGROUND = (20, 21, 24)
ACCENT = (242, 112, 58)
HEADING = (231, 231, 235)
SUBTITLE = (155, 157, 167)

RULE_HEIGHT = 7
MARGIN_LEFT = 96
SUPERSAMPLE = 4

MARK_BARS = (
    (4.0, 21.5, 12.0, 5.0, 2.5),
    (10.0, 13.5, 12.0, 5.0, 2.5),
    (23.0, 5.5, 5.0, 5.0, 2.5),
)
MARK_INK_LEFT = 4.0
MARK_INK_TOP = 5.5
MARK_UNIT = 4.04
MARK_LEFT = 113
MARK_TOP = 173

HEADING_TEXT = "Standupless"
HEADING_SIZE = 104
HEADING_BASELINE = 408

SUBTITLE_TEXT = "An issue tracker for small software teams."
SUBTITLE_SIZE = 34
SUBTITLE_BASELINE = 471

BRAND_DIR = pathlib.Path(__file__).resolve().parent
FONT_DIR = BRAND_DIR / "fonts"
OUTPUT = BRAND_DIR.parent.parent / "public" / "og.png"


def load_font(filename: str, size: int) -> ImageFont.FreeTypeFont:
    """Load a vendored Inter cut, so the card cannot fall back to a system face.

    Pillow silently substitutes a default bitmap font when a path is missing,
    which would reintroduce the mismatch this script exists to fix, so a missing
    file is an error rather than a quiet downgrade.
    """
    path = FONT_DIR / filename
    if not path.is_file():
        raise FileNotFoundError(f"vendored font missing: {path}")
    return ImageFont.truetype(str(path), size)


def draw_mark(canvas: ImageDraw.ImageDraw, left: float, top: float, unit: float) -> None:
    """Paint the Standupless mark, positioned by its ink rather than its grid.

    The bars are expressed on the 32 unit grid `Logo.tsx` uses, so the card and
    the component describe one shape rather than two drawings that happen to
    look alike. The grid carries empty margins on every side, so `left` and
    `top` place the first painted pixel instead of the notional box, which is
    what keeps the mark optically aligned with the text below it.
    """
    for x, y, width, height, radius in MARK_BARS:
        box = (
            left + (x - MARK_INK_LEFT) * unit,
            top + (y - MARK_INK_TOP) * unit,
            left + (x + width - MARK_INK_LEFT) * unit,
            top + (y + height - MARK_INK_TOP) * unit,
        )
        canvas.rounded_rectangle(box, radius=radius * unit, fill=ACCENT)


def render() -> Image.Image:
    """Compose the card at multiples of its final size and downsample once.

    The mark is rounded geometry rather than a glyph, so drawing it at the final
    size leaves visibly stepped edges. Supersampling the whole canvas keeps the
    bars and the lettering consistently smooth.
    """
    scale = SUPERSAMPLE
    image = Image.new("RGB", (WIDTH * scale, HEIGHT * scale), BACKGROUND)
    canvas = ImageDraw.Draw(image)

    canvas.rectangle((0, 0, WIDTH * scale, RULE_HEIGHT * scale - 1), fill=ACCENT)

    draw_mark(canvas, MARK_LEFT * scale, MARK_TOP * scale, MARK_UNIT * scale)

    heading_font = load_font("Inter-SemiBold.woff2", HEADING_SIZE * scale)
    subtitle_font = load_font("Inter-Regular.woff2", SUBTITLE_SIZE * scale)

    canvas.text(
        (MARGIN_LEFT * scale, HEADING_BASELINE * scale),
        HEADING_TEXT,
        font=heading_font,
        fill=HEADING,
        anchor="ls",
    )
    canvas.text(
        (MARGIN_LEFT * scale, SUBTITLE_BASELINE * scale),
        SUBTITLE_TEXT,
        font=subtitle_font,
        fill=SUBTITLE,
        anchor="ls",
    )

    return image.resize((WIDTH, HEIGHT), Image.LANCZOS)


def main() -> None:
    """Write the card, reporting where it landed so a run is self evidencing."""
    image = render()
    image.save(OUTPUT, "PNG", optimize=True)
    print(f"wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
