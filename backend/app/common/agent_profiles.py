"""Private, versioned agent profiles: one person's local agent guidance, kept for another machine.

A profile is a named set of text files, such as `~/.claude/CLAUDE.md`, a project's
untracked `CLAUDE.md` and Claude Code's memory folder for that project, each path
relative to one of three roots so the same profile restores onto a machine whose
home directory or checkout lives elsewhere.

Profiles belong to the person, not to a workspace. Every read and write is keyed
by the caller's own user id, so no member, admin or workspace credential reaches
another person's profiles, and nothing here takes a user id from a request.

Each version is sealed before it is stored: the sorted file manifest is compressed
and encrypted with `SecretMasterKeyCipher` under a key expanded from the
environment's master key with an HKDF info string of its own, and bound to the
person, the profile and the version, so a ciphertext copied onto another row does
not open. Only counts, sizes and a digest are stored in the clear.

A save refuses content shaped like a credential, naming the file, the line and
the kind of credential but never the value, because a profile is the wrong place
for a secret and an agent saving one should be told so before it is stored.

Saves, restores and deletes are recorded on the person's own audit trail, a
partition of the audit table keyed `user-<user id>` that no workspace listing reads.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import zlib
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Optional, Sequence

from webbpulse.audit import AuditActor, AuditCatalogue, AuditEvent, AuditQuery, AuditRecorder, AuditTarget
from webbpulse.dynamodb import ConditionFailed, InvalidStartKey
from webbpulse.identity.crypto import EnvelopeDecryptionFailed, SealedSecret, SecretMasterKeyCipher
from webbpulse.security import expand_key

from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.agent_profiles import (
    AgentProfileActivityRead,
    AgentProfileEventRead,
    AgentProfileFile,
    AgentProfileListRead,
    AgentProfileRead,
    AgentProfileSaveRead,
    AgentProfileSnapshotRead,
    AgentProfileVersionListRead,
    AgentProfileVersionRead,
)
from app.common.core.config import settings
from app.common.db.dynamo.agent_profiles import ProfileHead, ProfileVersion
from app.common.db.dynamo.audit import RETENTION
from app.common.db.dynamo.base import utc_now

_log = logging.getLogger(__name__)

KEY_INFO = b"standupless.agent-profile.v1"

SEAL_PURPOSE = "agent_profile"

ROOTS: dict[str, str] = {
    "home": "The home directory, ~ on this machine. ~/.claude/CLAUDE.md is home:.claude/CLAUDE.md.",
    "project": "The project checkout root, the directory the project's own CLAUDE.md sits in.",
    "memory": "Claude Code's memory folder for the project: ~/.claude/projects/<the project's absolute path with "
    "every character other than a letter, digit or hyphen replaced by a hyphen>/memory.",
}
"""What each root means on a machine, answered with every restore so the files land in the right place."""

MAX_PROFILES = 50
"""The most profiles one person keeps, an abuse limit rather than a plan limit."""

VERSIONS_KEPT = 10
"""How many versions of a profile are kept for rollback; a save past this prunes the oldest."""

MAX_FILES = 500
"""The most files one version holds."""

MAX_FILE_BYTES = 256 * 1024
"""The largest one file may be, in UTF-8 bytes."""

MAX_TOTAL_BYTES = 1_500_000
"""The most one version may hold across its files, in UTF-8 bytes.

Below the Lambda response ceiling with room for the JSON escaping a restore through
MCP adds, so a version that saves can always be read back in one call.
"""

MAX_PATH_LENGTH = 512

MAX_NOTE_LENGTH = 1000

CHUNK_CHARACTERS = 350_000
"""How much sealed ciphertext one row carries, under DynamoDB's 400 KB item limit."""

NAME_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

AUDIT_PREFIX = "user-"

EVENTS: dict[str, str] = {
    "agent_profile.saved": "Agent profile saved",
    "agent_profile.restored": "Agent profile restored",
    "agent_profile.deleted": "Agent profile deleted",
}
"""Every event the agent profile trail records, with the label the settings page shows."""

CATALOGUE = AuditCatalogue(EVENTS)


class AgentProfileError(Exception):
    """A request the store refuses, with a stable code and a message safe to show the caller."""

    code = "AGENT_PROFILE_INVALID"
    status = 422

    def __init__(self, message: str) -> None:
        """Keep the message the caller is shown."""
        super().__init__(message)
        self.message = message


class ProfileNotFound(AgentProfileError):
    """No profile or version by that name is kept for the caller."""

    code = "NOT_FOUND"
    status = 404


class ProfileConflict(AgentProfileError):
    """Another save of the same profile landed first."""

    code = "AGENT_PROFILE_CONFLICT"
    status = 409


class ProfileLimit(AgentProfileError):
    """The caller already keeps as many profiles as one person may."""

    code = "AGENT_PROFILE_LIMIT"
    status = 422


class SecretsFound(AgentProfileError):
    """The files hold content shaped like a credential, so nothing was stored."""

    code = "AGENT_PROFILE_SECRETS"
    status = 422

    def __init__(self, findings: Sequence["SecretFinding"]) -> None:
        """Name every finding by file, line and kind, never by value."""
        self.findings = list(findings)
        shown = "; ".join(finding.describe() for finding in self.findings[:20])
        more = f" and {len(self.findings) - 20} more" if len(self.findings) > 20 else ""
        super().__init__(
            f"Nothing was saved: {len(self.findings)} line(s) look like a credential: {shown}{more}. "
            "Remove the value or point at where it is stored instead, then save again."
        )


class ProfileKeyMissing(AgentProfileError):
    """The environment has no master key to seal or open profiles with."""

    code = "AGENT_PROFILES_UNAVAILABLE"
    status = 503


class ProfileUnreadable(AgentProfileError):
    """A kept version would not open, because it is still being saved or is damaged."""

    code = "AGENT_PROFILE_UNREADABLE"
    status = 409


@dataclass(frozen=True)
class SecretFinding:
    """One line that looks like a credential: where it is and what it looks like."""

    root: str
    path: str
    line: int
    kind: str

    def describe(self) -> str:
        """The finding as the refusal names it, with no part of the value."""
        return f"{self.root}:{self.path} line {self.line} ({self.kind})"


_PLACEHOLDER = re.compile(
    r"(?i)(example|placeholder|changeme|change[_-]?me|redacted|dummy|sample|your[_-]|<|>|\*{3}|x{4}|\.\.\.)"
)

SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("Standupless API key", re.compile(r"\b(?:wpk|wps)_[A-Za-z0-9_\-]{20,}")),
    ("Anthropic API key", re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}")),
    ("OpenAI API key", re.compile(r"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{32,}")),
    ("Stripe key", re.compile(r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}")),
    ("webhook signing secret", re.compile(r"\bwhsec_[A-Za-z0-9]{16,}")),
    ("GitHub token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}")),
    ("GitHub token", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{40,}")),
    ("GitLab token", re.compile(r"\bglpat-[A-Za-z0-9_\-]{20,}")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}")),
    ("Slack webhook URL", re.compile(r"https://hooks\.slack\.com/services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/[A-Za-z0-9]+")),
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    (
        "AWS secret access key",
        re.compile(r"(?i)aws_secret_access_key[\"']?\s*[:=]\s*[\"']?[A-Za-z0-9/+]{40}\b"),
    ),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("npm token", re.compile(r"\bnpm_[A-Za-z0-9]{36}\b")),
    ("PyPI token", re.compile(r"\bpypi-[A-Za-z0-9_\-]{50,}")),
    ("JSON web token", re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}")),
    ("bearer token", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/\-]{24,}={0,2}")),
)
"""Values shaped like a known credential, each with the kind a refusal names."""

_URL_PASSWORD = re.compile(r"\b[a-z][a-z0-9+.\-]*://[^\s/:@\"'`]+:([^\s/@\"'`]+)@[^\s/\"'`]+", re.I)

_ASSIGNMENT = re.compile(
    r"(?i)\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|"
    r"private[_-]?key|signing[_-]?key)\b[\"']?\s*[:=]\s*[\"']?([^\s\"'`,;)]{16,})"
)


def _looks_assigned(value: str) -> bool:
    """Whether a value assigned to a secret-named key reads as a real credential rather than a reference."""
    if value.startswith(("$", "{", "%", "<", "(", "[")) or _PLACEHOLDER.search(value):
        return False
    if re.fullmatch(r"[A-Z0-9_]+", value) or re.fullmatch(r"[a-z_.\-]+", value):
        return False
    return bool(re.search(r"[A-Za-z]", value) and re.search(r"[0-9]", value))


def _url_password(value: str) -> bool:
    """Whether the password part of a URL is a real one rather than a placeholder."""
    if value.startswith(("$", "{", "%", "<")) or _PLACEHOLDER.search(value):
        return False
    return value.lower() not in {"password", "pass", "passwd", "secret", "pw", "pwd", "token"}


def scan_line(line: str) -> Optional[str]:
    """The kind of credential one line holds, or None when it holds none that the scanner knows."""
    for kind, pattern in SECRET_PATTERNS:
        if pattern.search(line):
            return kind
    for match in _URL_PASSWORD.finditer(line):
        if _url_password(match.group(1)):
            return "URL with a password"
    for match in _ASSIGNMENT.finditer(line):
        if _looks_assigned(match.group(1)):
            return "assigned secret"
    return None


def scan_files(files: Iterable[AgentProfileFile]) -> list[SecretFinding]:
    """Every line across the files that looks like a credential, in file then line order."""
    findings: list[SecretFinding] = []
    for item in files:
        for number, line in enumerate(item.content.splitlines(), start=1):
            kind = scan_line(line)
            if kind is not None:
                findings.append(SecretFinding(item.root, item.path, number, kind))
    return findings


def validate_name(raw: Any) -> str:
    """A profile name, or a refusal saying what a name may hold."""
    name = str(raw or "").strip()
    if not NAME_PATTERN.match(name) or name in (".", ".."):
        raise AgentProfileError(
            "A profile name is 1 to 128 letters, digits, dots, hyphens or underscores, such as work-laptop."
        )
    return name


def _validate_path(raw: Any) -> str:
    """A relative POSIX path under a root, refusing anything that could step outside it."""
    path = str(raw or "")
    if not path or len(path) > MAX_PATH_LENGTH:
        raise AgentProfileError(f"Each file path is 1 to {MAX_PATH_LENGTH} characters.")
    if path.startswith(("/", "~")) or "\\" in path or any(ord(char) < 32 for char in path):
        raise AgentProfileError(
            f"{path!r} must be relative to its root, with forward slashes, such as .claude/CLAUDE.md."
        )
    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise AgentProfileError(f"{path!r} may not hold empty, '.' or '..' segments.")
    return path


def validate_files(raw: Any) -> list[AgentProfileFile]:
    """The files of a save, checked and sorted by root then path, or a refusal naming the problem."""
    if not isinstance(raw, (list, tuple)) or not raw:
        raise AgentProfileError("files is a non-empty list of {root, path, content} objects.")
    if len(raw) > MAX_FILES:
        raise AgentProfileError(f"A profile holds at most {MAX_FILES} files.")
    files: list[AgentProfileFile] = []
    seen: set[tuple[str, str]] = set()
    total = 0
    for entry in raw:
        if isinstance(entry, AgentProfileFile):
            entry = entry.model_dump()
        if not isinstance(entry, Mapping):
            raise AgentProfileError("Each file is an object with root, path and content.")
        root = str(entry.get("root") or "")
        if root not in ROOTS:
            raise AgentProfileError(f"Each file's root is one of {', '.join(ROOTS)}.")
        path = _validate_path(entry.get("path"))
        content = entry.get("content")
        if not isinstance(content, str):
            raise AgentProfileError(f"{root}:{path} needs its content as text.")
        if "\x00" in content:
            raise AgentProfileError(f"{root}:{path} is not a text file.")
        if (root, path) in seen:
            raise AgentProfileError(f"{root}:{path} appears more than once.")
        size = len(content.encode("utf-8"))
        if size > MAX_FILE_BYTES:
            raise AgentProfileError(f"{root}:{path} is {size} bytes; one file holds at most {MAX_FILE_BYTES}.")
        total += size
        seen.add((root, path))
        files.append(AgentProfileFile.model_validate({"root": root, "path": path, "content": content}))
    if total > MAX_TOTAL_BYTES:
        raise AgentProfileError(f"These files hold {total} bytes; one version holds at most {MAX_TOTAL_BYTES}.")
    files.sort(key=lambda item: (item.root, item.path))
    return files


def _note(raw: Any) -> str:
    """A version note, refused past its length."""
    note = str(raw or "").strip()
    if len(note) > MAX_NOTE_LENGTH:
        raise AgentProfileError(f"A note is at most {MAX_NOTE_LENGTH} characters.")
    return note


def _canonical(files: Sequence[AgentProfileFile]) -> bytes:
    """The one byte form of a manifest, so equal files always digest and seal alike."""
    manifest = [{"root": item.root, "path": item.path, "content": item.content} for item in files]
    return json.dumps({"files": manifest}, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def _cipher() -> SecretMasterKeyCipher:
    """The cipher for profiles, keyed from the environment master key under this feature's own info string."""
    master = settings.WEBHOOK_SIGNING_KEY
    if not master:
        raise ProfileKeyMissing("Agent profiles are not available in this environment.")
    return SecretMasterKeyCipher(expand_key(hashlib.sha256(master.encode()).digest(), KEY_INFO, 32))


def _context(user_id: str, name: str, version: int) -> str:
    """What one sealed version is bound to."""
    return f"{user_id}:{name}:{version}"


def _seal(user_id: str, name: str, version: int, canonical: bytes) -> tuple[SealedSecret, list[str]]:
    """A version's manifest sealed, and its ciphertext cut into row-sized chunks."""
    sealed = _cipher().seal(
        zlib.compress(canonical, 9), user_id=_context(user_id, name, version), purpose=SEAL_PURPOSE
    )
    text = sealed.ciphertext
    chunks = [text[start : start + CHUNK_CHARACTERS] for start in range(0, len(text), CHUNK_CHARACTERS)] or [""]
    return sealed, chunks


def _open(user_id: str, row: ProfileVersion, chunks: list[str]) -> list[AgentProfileFile]:
    """A kept version's files, or a refusal when its rows do not open."""
    if len(chunks) != row.chunk_count:
        raise ProfileUnreadable(f"Version {row.version} of {row.name} is still being saved; try again shortly.")
    sealed = SealedSecret(ciphertext="".join(chunks), nonce=row.nonce, wrapped_key=row.wrapped_key, scheme=row.scheme)
    try:
        plaintext = _cipher().open(sealed, user_id=_context(user_id, row.name, row.version), purpose=SEAL_PURPOSE)
        manifest = json.loads(zlib.decompress(plaintext))
    except (EnvelopeDecryptionFailed, zlib.error, ValueError) as exc:
        _log.warning("agent_profile_unreadable", extra={"profile_version": row.version, "reason": type(exc).__name__})
        raise ProfileUnreadable(f"Version {row.version} of {row.name} could not be read.") from exc
    return [AgentProfileFile(**entry) for entry in manifest["files"]]


def _profile_read(head: ProfileHead) -> AgentProfileRead:
    """A stored head as the caller reads it."""
    return AgentProfileRead(
        name=head.name,
        latest_version=head.latest_version,
        file_count=head.file_count,
        total_bytes=head.total_bytes,
        note=head.note,
        created_at=head.created_at,
        updated_at=head.updated_at,
    )


def _version_read(row: ProfileVersion, latest: int) -> AgentProfileVersionRead:
    """A stored version as the caller reads it."""
    return AgentProfileVersionRead(
        version=row.version,
        note=row.note,
        file_count=row.file_count,
        total_bytes=row.total_bytes,
        sha256=row.digest,
        source=row.source,
        created_at=row.created_at,
        latest=row.version == latest,
    )


def audit_tenant(user_id: str) -> str:
    """The audit partition holding one person's agent profile trail."""
    return f"{AUDIT_PREFIX}{user_id}"


def _record(
    repositories: Repositories, user_id: str, action: str, actor: AuditActor, name: str, after: Mapping[str, Any]
) -> Optional[AuditEvent]:
    """Store one event on the person's own trail, never failing the change it describes."""
    if "audit" not in repositories.repository_names or repositories.is_read_only("audit"):
        return None
    recorder = AuditRecorder(repositories.audit, CATALOGUE, retention=RETENTION)
    return recorder.record(
        audit_tenant(user_id),
        action,
        actor=actor,
        target=AuditTarget("agent_profile", name, name),
        after=dict(after),
    )


def _require_head(repositories: Repositories, user_id: str, name: str) -> ProfileHead:
    """The caller's profile by name, or a not found refusal."""
    head = repositories.agent_profiles.get_head(user_id, name)
    if head is None:
        raise ProfileNotFound(f"You keep no agent profile named {name}.")
    return head


def list_profiles(repositories: Repositories, user_id: str) -> AgentProfileListRead:
    """Every profile the caller keeps, in name order."""
    heads = repositories.agent_profiles.list_heads(user_id)
    return AgentProfileListRead(
        profiles=[_profile_read(head) for head in heads], max_profiles=MAX_PROFILES, versions_kept=VERSIONS_KEPT
    )


def list_versions(repositories: Repositories, user_id: str, raw_name: Any) -> AgentProfileVersionListRead:
    """A profile's kept versions, newest first."""
    name = validate_name(raw_name)
    head = _require_head(repositories, user_id, name)
    rows = repositories.agent_profiles.list_versions(user_id, name)
    return AgentProfileVersionListRead(
        name=name,
        latest_version=head.latest_version,
        versions=[_version_read(row, head.latest_version) for row in reversed(rows)],
        versions_kept=VERSIONS_KEPT,
    )


def save_profile(
    repositories: Repositories,
    user_id: str,
    raw_name: Any,
    raw_files: Any,
    raw_note: Any,
    actor: AuditActor,
) -> AgentProfileSaveRead:
    """Store a new version of a profile, or nothing when the files match the latest.

    Refuses before storing anything when a file holds a credential, a path could
    step outside its root, or a limit is passed, so a refused save leaves the kept
    versions exactly as they were.
    """
    name = validate_name(raw_name)
    files = validate_files(raw_files)
    note = _note(raw_note)
    findings = scan_files(files)
    if findings:
        raise SecretsFound(findings)
    store = repositories.agent_profiles
    head = store.get_head(user_id, name)
    if head is None and len(store.list_heads(user_id)) >= MAX_PROFILES:
        raise ProfileLimit(f"You keep {MAX_PROFILES} agent profiles already; delete one to save another.")
    canonical = _canonical(files)
    digest = hashlib.sha256(canonical).hexdigest()
    if head is not None:
        latest = store.get_version(user_id, name, head.latest_version)
        if latest is not None and latest.digest == digest:
            return AgentProfileSaveRead(profile=_profile_read(head), version=head.latest_version, unchanged=True)
    number = head.latest_version + 1 if head is not None else 1
    sealed, chunks = _seal(user_id, name, number, canonical)
    now = utc_now()
    total = sum(len(item.content.encode("utf-8")) for item in files)
    row = ProfileVersion(
        user_id=user_id,
        name=name,
        version=number,
        note=note,
        file_count=len(files),
        total_bytes=total,
        digest=digest,
        source=actor.source,
        created_at=now,
        chunk_count=len(chunks),
        nonce=sealed.nonce,
        wrapped_key=sealed.wrapped_key,
        scheme=sealed.scheme,
    )
    try:
        store.create_version(row, chunks)
    except ConditionFailed as exc:
        raise ProfileConflict(f"Another save of {name} landed first; read it and save again.") from exc
    updated = ProfileHead(
        user_id=user_id,
        name=name,
        latest_version=number,
        file_count=len(files),
        total_bytes=total,
        note=note,
        created_at=head.created_at if head is not None else now,
        updated_at=now,
    )
    try:
        store.put_head(updated, expected_version=head.latest_version if head is not None else None)
    except ConditionFailed as exc:
        store.delete_version(user_id, name, number)
        raise ProfileConflict(f"Another save of {name} landed first; read it and save again.") from exc
    pruned = _prune(repositories, user_id, name)
    _record(
        repositories,
        user_id,
        "agent_profile.saved",
        actor,
        name,
        {"version": number, "file_count": len(files), "total_bytes": total},
    )
    return AgentProfileSaveRead(profile=_profile_read(updated), version=number, unchanged=False, pruned_versions=pruned)


def _prune(repositories: Repositories, user_id: str, name: str) -> list[int]:
    """Remove the oldest versions past `VERSIONS_KEPT`, answering which went."""
    rows = repositories.agent_profiles.list_versions(user_id, name)
    doomed = [row.version for row in rows[: max(0, len(rows) - VERSIONS_KEPT)]]
    for number in doomed:
        repositories.agent_profiles.delete_version(user_id, name, number)
    return doomed


def read_profile(
    repositories: Repositories,
    user_id: str,
    raw_name: Any,
    raw_version: Any,
    actor: AuditActor,
) -> AgentProfileSnapshotRead:
    """One version's files, the latest when no version is named, recorded as a restore."""
    name = validate_name(raw_name)
    head = _require_head(repositories, user_id, name)
    number = head.latest_version
    if raw_version is not None and str(raw_version).strip() not in ("", "latest"):
        try:
            number = int(raw_version)
        except (TypeError, ValueError) as exc:
            raise AgentProfileError("version is a version number, or latest.") from exc
    row = repositories.agent_profiles.get_version(user_id, name, number)
    if row is None:
        raise ProfileNotFound(f"Version {number} of {name} is not kept.")
    files = _open(user_id, row, repositories.agent_profiles.read_chunks(user_id, name, number))
    _record(repositories, user_id, "agent_profile.restored", actor, name, {"version": number})
    return AgentProfileSnapshotRead(
        name=name,
        version=number,
        latest_version=head.latest_version,
        note=row.note,
        sha256=row.digest,
        created_at=row.created_at,
        files=files,
        roots=dict(ROOTS),
    )


def delete_profile(repositories: Repositories, user_id: str, raw_name: Any, actor: AuditActor) -> int:
    """Remove a profile and every kept version of it, answering how many versions went."""
    name = validate_name(raw_name)
    head = _require_head(repositories, user_id, name)
    versions = len(repositories.agent_profiles.list_versions(user_id, name))
    repositories.agent_profiles.delete_profile(user_id, name)
    _record(
        repositories,
        user_id,
        "agent_profile.deleted",
        actor,
        name,
        {"latest_version": head.latest_version, "versions": versions},
    )
    return versions


def list_activity(
    repositories: Repositories, user_id: str, *, limit: int = 50, cursor: Optional[str] = None
) -> AgentProfileActivityRead:
    """One page of the caller's own agent profile trail, newest first."""
    size = max(1, min(limit, 100))
    tenant = audit_tenant(user_id)
    try:
        page = repositories.audit.list_events(tenant, AuditQuery(), limit=size, cursor=cursor)
    except InvalidStartKey:
        page = repositories.audit.list_events(tenant, AuditQuery(), limit=size)
    events = []
    for event in page.events:
        after = dict(event.after or {})
        version = after.get("version", after.get("latest_version"))
        events.append(
            AgentProfileEventRead(
                audit_id=event.event_id,
                event=event.action,
                event_label=EVENTS.get(event.action, event.action),
                profile=event.target.id,
                version=int(version) if version is not None else None,
                source=event.actor.source,
                ip=event.actor.ip,
                created_at=event.occurred_at,
            )
        )
    return AgentProfileActivityRead(events=events, next_cursor=page.next_cursor)


def delete_for_user(repositories: Repositories, user_id: str) -> None:
    """Remove every profile and the trail of one person, best effort, for account deletion."""
    try:
        repositories.agent_profiles.delete_for_user(user_id)
    except Exception:
        _log.exception("agent_profiles_delete_failed")
    if "audit" in repositories.repository_names and not repositories.is_read_only("audit"):
        try:
            repositories.audit.purge_tenant(audit_tenant(user_id))
        except Exception:
            _log.exception("agent_profile_trail_delete_failed")

