"""Custom workspace emoji: the name rules, the image pass and the reaction check.

A custom emoji is written as its `:name:` shortcode everywhere text or a
reaction holds it, so markdown round trips and a deleted emoji still reads as
its name. The name is held to lowercase letters, digits, dashes and underscores,
and may not be a built-in shortcode, so `:tada:` always means the Unicode party
popper rather than whatever a workspace uploaded under that name.

Images are icon objects under the workspace's emoji prefix. The commit reads
the whole upload back, decodes it with Pillow, and rewrites it no larger than
`EMOJI_SIZE` on its long side, keeping every frame of an animated GIF or WebP.
"""

from __future__ import annotations

import io
import re
from typing import TYPE_CHECKING, Any, Optional

import emoji as emoji_data

from app.common.icons import IconOwner, delete_icon_objects, icons_bucket, icons_client, normalized_type, unprocessable

if TYPE_CHECKING:
    from app.common.api.dependencies.repositories import Repositories

EMOJI_CONTENT_TYPES: dict[str, str] = {
    "image/png": "PNG",
    "image/gif": "GIF",
    "image/webp": "WEBP",
}
"""The image types a custom emoji may be, with the Pillow format each one decodes as."""

MAX_EMOJI_BYTES = 1024 * 1024
"""The largest custom emoji upload accepted, before it is resized."""

EMOJI_SIZE = 128
"""The long side, in pixels, a stored custom emoji image is resized down to."""

MAX_SOURCE_PIXELS = 4096 * 4096
"""The largest source image decoded, so a small file cannot unpack into a huge bitmap."""

MAX_FRAMES = 500
"""The most frames an animated custom emoji may carry."""

NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{1,31}$")
"""A custom emoji name: two to thirty two lowercase letters, digits, dashes or underscores."""

SHORTCODE_PATTERN = re.compile(r"^:([a-z0-9][a-z0-9_-]{1,31}):$")
"""A custom emoji as a reaction or text holds it, the name between colons."""

_ALIAS_PATTERN = re.compile(r"^:([A-Za-z0-9_+-]{1,64}):$")


def is_builtin_shortcode(name: str) -> bool:
    """Whether a name is already a built-in emoji shortcode, in any of its spellings."""
    for spelling in {name, name.replace("-", "_")}:
        code = f":{spelling}:"
        if emoji_data.emojize(code, language="alias") != code:
            return True
        if emoji_data.emojize(code) != code:
            return True
    return False


def check_name(value: str) -> str:
    """Hold a new custom emoji name to the shape rule and keep it off the built-in shortcodes."""
    name = value.strip().strip(":").lower()
    if not NAME_PATTERN.match(name):
        raise ValueError("Use 2 to 32 lowercase letters, digits, dashes or underscores")
    if is_builtin_shortcode(name):
        raise ValueError(f":{name}: is already a built-in emoji")
    return name


def custom_name(value: str) -> Optional[str]:
    """The custom emoji name a `:name:` reaction value carries, or `None` for a Unicode emoji."""
    match = SHORTCODE_PATTERN.match(value)
    return match.group(1) if match else None


def builtin_from_shortcode(value: str) -> Optional[str]:
    """The Unicode emoji a built-in `:shortcode:` names, or `None` when it names none."""
    if not _ALIAS_PATTERN.match(value):
        return None
    for language in ("alias", "en"):
        resolved = emoji_data.emojize(value, language=language)
        if resolved != value:
            return resolved
    return None


def require_custom_emoji(repositories: "Repositories", workspace_id: str, value: str) -> None:
    """Refuse a reaction naming a custom emoji the workspace does not have.

    Only adding is checked: taking back a reaction to a since deleted emoji must
    still work, and a Unicode emoji passes straight through.
    """
    name = custom_name(value)
    if name is None:
        return
    if repositories.custom_emoji.get(workspace_id, name) is None:
        raise unprocessable(f":{name}: is not an emoji in this workspace", "UNKNOWN_EMOJI")


def _invalid(owner: IconOwner, key: str, message: str, error_code: str = "INVALID_IMAGE") -> Exception:
    """Remove a refused upload and answer the 422 that says why."""
    delete_icon_objects(owner.prefix, only=key)
    return unprocessable(message, error_code)


def _resized(image: Any, image_format: str) -> bytes:
    """Every frame of an image scaled to fit `EMOJI_SIZE`, encoded in its own format."""
    from PIL import ImageSequence

    frames = []
    durations = []
    for frame in ImageSequence.Iterator(image):
        copy = frame.convert("RGBA")
        copy.thumbnail((EMOJI_SIZE, EMOJI_SIZE))
        frames.append(copy)
        durations.append(int(frame.info.get("duration", image.info.get("duration", 100)) or 100))
    buffer = io.BytesIO()
    options: dict[str, Any] = {"format": image_format}
    if len(frames) > 1:
        options.update(save_all=True, append_images=frames[1:], duration=durations, loop=image.info.get("loop", 0))
        if image_format == "GIF":
            options["disposal"] = 2
    frames[0].save(buffer, **options)
    return buffer.getvalue()


def process_emoji_image(owner: IconOwner, key: str) -> None:
    """Decode one committed emoji upload, refuse a bad one, and shrink a large one in place.

    The type is checked against what Pillow actually decodes, the pixel count and
    frame count are bounded before any frame is decoded, and an image already
    within `EMOJI_SIZE` is left byte for byte as uploaded.
    """
    from PIL import Image, UnidentifiedImageError

    bucket = icons_bucket()
    client = icons_client()
    response = client.get_object(Bucket=bucket, Key=key)
    content_type = normalized_type(str(response.get("ContentType") or ""))
    expected = EMOJI_CONTENT_TYPES.get(content_type)
    if expected is None:
        raise _invalid(owner, key, "Custom emoji must be PNG, GIF or WebP images", "UNSUPPORTED_MEDIA_TYPE")
    body = response["Body"].read()
    if len(body) > MAX_EMOJI_BYTES:
        raise _invalid(owner, key, f"Custom emoji are limited to {MAX_EMOJI_BYTES} bytes", "UPLOAD_TOO_LARGE")
    try:
        with Image.open(io.BytesIO(body)) as image:
            if image.format != expected:
                raise _invalid(owner, key, "The file is not the image type it claims to be")
            width, height = image.size
            if width * height > MAX_SOURCE_PIXELS or getattr(image, "n_frames", 1) > MAX_FRAMES:
                raise _invalid(owner, key, "The image is too large to use as an emoji")
            if max(width, height) <= EMOJI_SIZE:
                image.load()
                return
            resized = _resized(image, expected)
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, SyntaxError):
        raise _invalid(owner, key, "The file is not a valid image") from None
    client.put_object(Bucket=bucket, Key=key, Body=resized, ContentType=content_type)
