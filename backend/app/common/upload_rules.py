"""Which files an issue attachment may hold and how large, for every path that stores one.

The upload routes in the discussion domain and the create by email consumer in
the integrations domain both store files on issues, and neither may import the
other, so the allow list and the ceilings live here once.
"""

from __future__ import annotations

from webbpulse.storage import UPLOAD_CONTENT_TYPES

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
"""The ceiling a presigned PUT is signed with, 25 MiB.

A larger declared `size_bytes` is refused rather than silently lowered, because a
client that declares 100 MB and is handed a 25 MiB URL fails at the end of the
upload instead of at the start.
"""

MAX_VIDEO_UPLOAD_BYTES = 200 * 1024 * 1024
"""The ceiling a video upload is signed with, 200 MiB.

A screen recording of a minute or two is the case this exists for, and it runs well
past the document cap, so video gets its own bound rather than raising the cap on
everything else.
"""

VIDEO_CONTENT_TYPES: frozenset[str] = frozenset({"video/mp4", "video/webm", "video/quicktime"})
"""The video types an editor may embed inline and a reader plays with native controls.

Held here rather than upstream because this product is the one consumer that plays
video; the platform list stays the conservative document set.
"""

ATTACHMENT_CONTENT_TYPES: frozenset[str] = (frozenset(UPLOAD_CONTENT_TYPES) - {"image/svg+xml"}) | VIDEO_CONTENT_TYPES
"""What an upload may declare here: the platform allow list minus SVG, plus video.

The shared list admits `image/svg+xml` and leans on `disposition_for` to force it
to download, which is a correct answer for a product that needs SVG. This contract
refuses it outright, so the product narrows the platform list rather than restating
it: a type added upstream arrives here, and the one exclusion says why it is an
exclusion.
"""


def normalized_content_type(value: str) -> str:
    """A declared content type without parameters, lower cased, for set membership."""
    return value.split(";")[0].strip().lower()


def upload_ceiling(content_type: str) -> int:
    """The largest declared size one content type may be presigned for."""
    return MAX_VIDEO_UPLOAD_BYTES if normalized_content_type(content_type) in VIDEO_CONTENT_TYPES else MAX_UPLOAD_BYTES
