"""The standup digest operations the REST routes and the MCP tools share.

Each takes the caller's workspace and the resolved team, so the route and the
tool hold the caller to the capability first and then return the same answer.
"""

from __future__ import annotations

from datetime import date

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.team_config import StandupSettings, default_standup_settings
from app.common.standup import (
    StandupDigest,
    StandupWindowError,
    build_digest,
    local_today,
    next_digest_date,
    resolve_zone,
)
from app.domains.integrations.schemas.standup import (
    StandupNoteRead,
    StandupNoteWrite,
    StandupSettingsRead,
    StandupSettingsUpdate,
)


def parse_day(value: str | None, settings: StandupSettings) -> date:
    """A digest date from `YYYY-MM-DD`, or the team's local today when left out."""
    if not value:
        return local_today(settings.timezone)
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise StandupWindowError(f"Date {value!r} is not YYYY-MM-DD") from exc


def note_day(value: str | None, settings: StandupSettings) -> str:
    """The digest date a note is read or written for, the next digest when left out."""
    if not value:
        return next_digest_date(settings).isoformat()
    return parse_day(value, settings).isoformat()


def settings_of(repositories: Repositories, workspace_id: str, team_id: str) -> StandupSettings:
    """A team's stored standup settings, or the defaults."""
    stored = repositories.team_config.get_standup_settings(workspace_id, team_id)
    return stored or default_standup_settings(workspace_id, team_id)


def settings_read(settings: StandupSettings) -> StandupSettingsRead:
    """The wire form of a team's standup settings."""
    return StandupSettingsRead.model_validate(
        {
            "team_id": settings.team_id,
            "cadence": settings.cadence,
            "send_time": settings.send_time,
            "timezone": settings.timezone,
            "weekday": settings.weekday,
            "next_digest_date": next_digest_date(settings).isoformat(),
            "updated_at": settings.updated_at,
        }
    )


def update_settings(
    repositories: Repositories, workspace_id: str, team_id: str, payload: StandupSettingsUpdate
) -> StandupSettingsRead:
    """Apply a partial settings change, refusing an unknown timezone."""
    current = settings_of(repositories, workspace_id, team_id)
    changes = payload.model_dump(exclude_none=True)
    if "timezone" in changes:
        resolve_zone(changes["timezone"])
    stored = repositories.team_config.put_standup_settings(current.model_copy(update=changes))
    return settings_read(stored)


def digest(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    day: str | None,
    cadence: str | None,
) -> StandupDigest:
    """One team's digest for `day`, in the team's cadence unless `cadence` is given."""
    settings = settings_of(repositories, workspace_id, team_id)
    return build_digest(
        repositories, workspace_id, team_id, parse_day(day, settings), cadence=cadence, settings=settings
    )


def read_note(
    repositories: Repositories, workspace_id: str, team_id: str, user_id: str, day: str | None
) -> StandupNoteRead:
    """The caller's note for `day`, the next digest date when left out."""
    settings = settings_of(repositories, workspace_id, team_id)
    on = note_day(day, settings)
    for note in repositories.team_config.list_standup_notes(workspace_id, team_id, on):
        if note.user_id == user_id:
            return StandupNoteRead(
                team_id=team_id, user_id=user_id, date=on, body=note.body, updated_at=note.updated_at
            )
    return StandupNoteRead(team_id=team_id, user_id=user_id, date=on)


def write_note(
    repositories: Repositories, workspace_id: str, team_id: str, user_id: str, payload: StandupNoteWrite
) -> StandupNoteRead:
    """Store the caller's note for one digest date, replacing an earlier one."""
    settings = settings_of(repositories, workspace_id, team_id)
    on = note_day(payload.date, settings)
    note = repositories.team_config.put_standup_note(workspace_id, team_id, on, user_id, payload.body)
    return StandupNoteRead(team_id=team_id, user_id=user_id, date=on, body=note.body, updated_at=note.updated_at)


def delete_note(repositories: Repositories, workspace_id: str, team_id: str, user_id: str, day: str | None) -> bool:
    """Remove the caller's note for `day`, the next digest date when left out."""
    settings = settings_of(repositories, workspace_id, team_id)
    on = note_day(day, settings)
    return repositories.team_config.delete_standup_note(workspace_id, team_id, on, user_id)
