"""The bulk import marker: how a stream consumer tells an imported issue row from a person's write.

An importer writes hundreds or thousands of issues in one go. Each lands on the
issues stream like any other insert, and without a marker every one of them would
notify its assignee, post to the team's channels, fire the workspace's webhooks
and push to a linked GitHub repository. The importer stamps `import_batch_id` on
every row it writes, and the consumers that announce a change skip a record whose
new image carries it. Rollup and search still read the record, because an imported
issue must count towards its parent and be findable.

Any later edit through `IssueRepository.replace` drops the marker, so the first
change a person makes to an imported issue is announced as usual.
"""

from __future__ import annotations

from typing import Any, Mapping

from webbpulse.events import deserialize_image

IMPORT_BATCH_ATTRIBUTE = "import_batch_id"
"""The issue attribute an importer stamps on every row it writes."""


def from_bulk_import(record: Mapping[str, Any]) -> bool:
    """Whether a stream record's new image was written by a bulk import."""
    image = deserialize_image(record, "NewImage")
    return bool(image) and bool(image.get(IMPORT_BATCH_ATTRIBUTE))
