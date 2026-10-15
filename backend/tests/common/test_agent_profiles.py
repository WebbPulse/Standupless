"""The agent profile store: secret refusal, path rules, sealing, versions and pruning.

Driven through `app.common.agent_profiles` over the moto tables, so a version that
saves here is one the deployed routes and tools would read back the same way.
"""

from __future__ import annotations

import dataclasses
import os
from typing import Any

import pytest
from webbpulse.audit import AuditActor

from app.common import agent_profiles

USER = "01JB0000000000000000000USR"

OTHER = "01JB0000000000000000000OTH"

ACTOR = AuditActor(id=USER, kind="user", source="mcp")

MASTER = "dGVzdC1zaWduaW5nLWtleS1ub3QtYS1yZWFsLW9uZQ=="


@pytest.fixture(autouse=True)
def master_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """A master key for sealing, as the app secret carries in a deployed function."""
    monkeypatch.setenv("WEBHOOK_SIGNING_KEY", MASTER)


def home(path: str, content: str) -> dict[str, str]:
    """One file under the home root."""
    return {"root": "home", "path": path, "content": content}


def save(repositories: Any, files: list[dict[str, str]], name: str = "laptop", user: str = USER) -> Any:
    """Save files as the next version of one profile."""
    return agent_profiles.save_profile(repositories, user, name, files, "a note", ACTOR)


@pytest.mark.parametrize(
    ("line", "kind"),
    [
        ("token: ghp_" + "a" * 36, "GitHub token"),
        ("key = AKIA" + "ABCDEFGHIJKLMNOP", "AWS access key"),
        ("-----BEGIN OPENSSH " + "PRIVATE KEY-----", "private key"),
        ("export STRIPE=sk_" + "live_" + "a1b2c3d4e5f6g7h8i9", "Stripe key"),
        ("postgres://app:hunter2secret@db.internal/app", "URL with a password"),
        ("password = Tr0ub4dor3xyzabcd", "assigned secret"),
        ("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123", "bearer token"),
        ("wpk_" + "x1" * 16, "Standupless API key"),
    ],
)
def test_the_scanner_names_each_credential_kind(line: str, kind: str) -> None:
    assert agent_profiles.scan_line(line) == kind


@pytest.mark.parametrize(
    "line",
    [
        "Use `{{resolve:secretsmanager:secret-id:SecretString:json-key}}` with asm-exec.",
        "password = ${DB_PASSWORD}",
        "api_key: <your-api-key>",
        "secret_key = CHANGE_ME_BEFORE_DEPLOYING",
        "postgres://user:password@localhost/app",
        "The SSO portal lives at https://d-1234567890.awsapps.com/start.",
        "Never put secrets, tokens or passwords in issues.",
        "client_secret: example-value-1234567",
    ],
)
def test_the_scanner_passes_guidance_that_only_talks_about_secrets(line: str) -> None:
    assert agent_profiles.scan_line(line) is None


def test_a_save_with_a_credential_names_the_file_and_line_but_not_the_value(repositories: Any) -> None:
    value = "ghp_" + "Z" * 36
    files = [home(".claude/CLAUDE.md", "# Rules\nfine\n"), home("notes.md", f"first\nsecond {value}\n")]

    with pytest.raises(agent_profiles.SecretsFound) as refused:
        save(repositories, files)

    assert "home:notes.md line 2 (GitHub token)" in refused.value.message
    assert value not in refused.value.message
    assert repositories.agent_profiles.list_heads(USER) == []


@pytest.mark.parametrize("path", ["/etc/passwd", "~/x", "../x", "a/../b", "a//b", "a\\b", "./a", ""])
def test_a_path_that_could_leave_its_root_is_refused(repositories: Any, path: str) -> None:
    with pytest.raises(agent_profiles.AgentProfileError):
        save(repositories, [home(path, "text")])


def test_duplicate_paths_and_unknown_roots_are_refused(repositories: Any) -> None:
    with pytest.raises(agent_profiles.AgentProfileError, match="more than once"):
        save(repositories, [home("a.md", "1"), home("a.md", "2")])
    with pytest.raises(agent_profiles.AgentProfileError, match="root"):
        save(repositories, [{"root": "etc", "path": "a.md", "content": "1"}])


def test_a_bad_name_is_refused(repositories: Any) -> None:
    with pytest.raises(agent_profiles.AgentProfileError, match="profile name"):
        save(repositories, [home("a.md", "1")], name="has space")


def test_a_saved_version_reads_back_sealed_and_sorted(repositories: Any) -> None:
    files = [
        {"root": "memory", "path": "MEMORY.md", "content": "- [Rule](rule.md)"},
        home(".claude/CLAUDE.md", "# Global rules\nUse ünïcode."),
        {"root": "project", "path": "CLAUDE.md", "content": "project guidance"},
    ]

    saved = save(repositories, files)
    snapshot = agent_profiles.read_profile(repositories, USER, "laptop", None, ACTOR)

    assert saved.version == 1 and saved.unchanged is False
    assert [(item.root, item.path) for item in snapshot.files] == [
        ("home", ".claude/CLAUDE.md"),
        ("memory", "MEMORY.md"),
        ("project", "CLAUDE.md"),
    ]
    assert snapshot.files[0].content == "# Global rules\nUse ünïcode."
    assert set(snapshot.roots) == {"home", "project", "memory"}
    stored = repositories.agent_profiles.read_chunks(USER, "laptop", 1)
    assert "Global rules" not in "".join(stored)


def test_identical_files_add_no_version(repositories: Any) -> None:
    save(repositories, [home("a.md", "same")])

    again = save(repositories, [home("a.md", "same")])

    assert again.unchanged is True
    assert again.version == 1
    assert len(agent_profiles.list_versions(repositories, USER, "laptop").versions) == 1


def test_versions_past_the_kept_count_are_pruned_oldest_first(repositories: Any) -> None:
    for number in range(agent_profiles.VERSIONS_KEPT + 2):
        result = save(repositories, [home("a.md", f"version {number}")])

    listed = agent_profiles.list_versions(repositories, USER, "laptop")

    assert result.pruned_versions == [2]
    assert [row.version for row in listed.versions] == list(range(agent_profiles.VERSIONS_KEPT + 2, 2, -1))
    assert listed.versions[0].latest is True
    assert repositories.agent_profiles.read_chunks(USER, "laptop", 1) == []
    with pytest.raises(agent_profiles.ProfileNotFound):
        agent_profiles.read_profile(repositories, USER, "laptop", 1, ACTOR)


def test_an_older_version_restores_by_number(repositories: Any) -> None:
    save(repositories, [home("a.md", "first")])
    save(repositories, [home("a.md", "second")])

    older = agent_profiles.read_profile(repositories, USER, "laptop", "1", ACTOR)

    assert older.version == 1 and older.latest_version == 2
    assert older.files[0].content == "first"


def test_another_person_sees_none_of_the_profiles(repositories: Any) -> None:
    save(repositories, [home("a.md", "mine")])

    assert agent_profiles.list_profiles(repositories, OTHER).profiles == []
    with pytest.raises(agent_profiles.ProfileNotFound):
        agent_profiles.read_profile(repositories, OTHER, "laptop", None, ACTOR)


def test_a_version_copied_to_another_person_does_not_open(repositories: Any) -> None:
    save(repositories, [home("a.md", "mine")])
    save(repositories, [home("a.md", "theirs")], user=OTHER)
    mine = repositories.agent_profiles.get_version(USER, "laptop", 1)
    chunks = repositories.agent_profiles.read_chunks(USER, "laptop", 1)
    repositories.agent_profiles.delete_version(OTHER, "laptop", 1)
    repositories.agent_profiles.create_version(dataclasses.replace(mine, user_id=OTHER), chunks)

    with pytest.raises(agent_profiles.ProfileUnreadable):
        agent_profiles.read_profile(repositories, OTHER, "laptop", None, ACTOR)


def test_no_master_key_refuses_rather_than_storing_in_the_clear(
    repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("WEBHOOK_SIGNING_KEY", "")

    with pytest.raises(agent_profiles.ProfileKeyMissing):
        save(repositories, [home("a.md", "text")])


def test_delete_removes_every_row_and_records_the_trail(repositories: Any) -> None:
    save(repositories, [home("a.md", "one")])
    save(repositories, [home("a.md", "two")])
    agent_profiles.read_profile(repositories, USER, "laptop", None, ACTOR)

    removed = agent_profiles.delete_profile(repositories, USER, "laptop", ACTOR)
    activity = agent_profiles.list_activity(repositories, USER)

    assert removed == 2
    assert repositories.agent_profiles.list_heads(USER) == []
    assert repositories.agent_profiles.read_chunks(USER, "laptop", 2) == []
    assert repositories.agent_profiles.list_versions(USER, "laptop") == []
    assert {row.event for row in activity.events} == {
        "agent_profile.saved",
        "agent_profile.restored",
        "agent_profile.deleted",
    }


def test_a_large_profile_spans_several_chunks(repositories: Any) -> None:
    files = [home(f"skills/{index}.md", os.urandom(90_000).hex()) for index in range(8)]

    save(repositories, files)
    snapshot = agent_profiles.read_profile(repositories, USER, "laptop", None, ACTOR)
    version = repositories.agent_profiles.get_version(USER, "laptop", 1)

    assert version.chunk_count > 1
    assert len(repositories.agent_profiles.read_chunks(USER, "laptop", 1)) == version.chunk_count
    assert [item.content for item in snapshot.files] == [item["content"] for item in files]


def test_a_version_over_the_size_limit_is_refused(repositories: Any) -> None:
    files = [home(f"{index}.md", "a" * agent_profiles.MAX_FILE_BYTES) for index in range(6)]

    with pytest.raises(agent_profiles.AgentProfileError, match="at most"):
        save(repositories, files)


def test_account_deletion_removes_every_profile(repositories: Any) -> None:
    save(repositories, [home("a.md", "one")], name="one")
    save(repositories, [home("a.md", "two")], name="two")

    agent_profiles.delete_for_user(repositories, USER)

    assert repositories.agent_profiles.list_heads(USER) == []
    assert agent_profiles.list_activity(repositories, USER).events == []
