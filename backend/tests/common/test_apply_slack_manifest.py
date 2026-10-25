"""The Slack manifest script's configuration token rotation, with Slack and Secrets Manager faked."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "apply_slack_manifest.py"

SECRET_ID = "standupless-production/app"


def load_script() -> ModuleType:
    """Import the repository-root script by path, since it lives outside the backend package."""
    spec = importlib.util.spec_from_file_location("apply_slack_manifest", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


script = load_script()


class FakeSecrets:
    """An in-memory Secrets Manager client holding one JSON secret with version ids."""

    def __init__(self, value: dict[str, Any], *, fail_put: bool = False, races: int = 0) -> None:
        """Seed the secret, optionally failing every write or moving the version under the first reads."""
        self.versions: list[str] = ["v0"]
        self.values: dict[str, str] = {"v0": json.dumps(value)}
        self.fail_put = fail_put
        self.races = races
        self.puts = 0
        self.describes = 0

    @property
    def current(self) -> dict[str, Any]:
        """Return the decoded AWSCURRENT value."""
        return json.loads(self.values[self.versions[-1]])

    def describe_secret(self, SecretId: str) -> dict[str, Any]:
        """Answer the version stages, bumping the version between read and re-check while races remain."""
        assert SecretId == SECRET_ID
        self.describes += 1
        if self.races and self.describes % 2 == 0:
            self.races -= 1
            self._append(self.values[self.versions[-1]])
        return {"VersionIdsToStages": {self.versions[-1]: ["AWSCURRENT"]}}

    def get_secret_value(self, SecretId: str, VersionId: str) -> dict[str, Any]:
        """Return one pinned version's string."""
        return {"SecretString": self.values[VersionId]}

    def put_secret_value(self, SecretId: str, SecretString: str, ClientRequestToken: str) -> dict[str, Any]:
        """Store a new current version, or fail when told to."""
        if self.fail_put:
            raise RuntimeError("AccessDenied")
        self.puts += 1
        return {"VersionId": self._append(SecretString)}

    def _append(self, raw: str) -> str:
        """Add a version and return its id."""
        version = f"v{len(self.versions)}"
        self.versions.append(version)
        self.values[version] = raw
        return version


class FakeSlack:
    """Answers ``tooling.tokens.rotate`` once per stored refresh token, as Slack does."""

    def __init__(self) -> None:
        """Start with the seeded refresh token valid."""
        self.valid = {"xoxe-old"}
        self.calls = 0

    def rotate(self, refresh: str) -> dict[str, Any]:
        """Spend the refresh token and issue a new pair."""
        if refresh not in self.valid:
            raise script.SlackApiError("tooling.tokens.rotate: invalid_refresh_token")
        self.valid.discard(refresh)
        self.calls += 1
        new = f"xoxe-new-{self.calls}"
        self.valid.add(new)
        return {"ok": True, "token": f"xoxe.xoxp-access-{self.calls}", "refresh_token": new, "exp": 43200}


def test_rotation_stores_the_new_refresh_token_and_keeps_other_keys() -> None:
    """The new refresh token replaces the old one and every other key survives."""
    client = FakeSecrets({"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-old", "OTHER": "kept"})
    slack = FakeSlack()

    access = script.rotate_config_token(script.RefreshTokenSecret(client, SECRET_ID), slack.rotate)

    assert access == "xoxe.xoxp-access-1"
    assert client.current == {"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-new-1", "OTHER": "kept"}


def test_two_runs_in_a_row_both_rotate() -> None:
    """The second run uses the token the first stored, which proves the rotation persisted."""
    client = FakeSecrets({"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-old"})
    slack = FakeSlack()

    script.rotate_config_token(script.RefreshTokenSecret(client, SECRET_ID), slack.rotate)
    access = script.rotate_config_token(script.RefreshTokenSecret(client, SECRET_ID), slack.rotate)

    assert access == "xoxe.xoxp-access-2"
    assert client.current["SLACK_CONFIG_REFRESH_TOKEN"] == "xoxe-new-2"


def test_a_failed_write_back_withholds_the_access_token() -> None:
    """When the new refresh token cannot be stored the caller gets an error, not a token."""
    client = FakeSecrets({"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-old"}, fail_put=True)

    with pytest.raises(script.WriteBackError) as raised:
        script.rotate_config_token(script.RefreshTokenSecret(client, SECRET_ID), FakeSlack().rotate)

    assert "xoxe" not in str(raised.value)
    assert client.current == {"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-old"}


def test_a_missing_refresh_token_does_not_call_slack() -> None:
    """With no stored refresh token the script stops before rotating."""
    client = FakeSecrets({"OTHER": "kept"})
    slack = FakeSlack()

    with pytest.raises(script.TokenError):
        script.rotate_config_token(script.RefreshTokenSecret(client, SECRET_ID), slack.rotate)

    assert slack.calls == 0


def test_the_boto3_fallback_retries_on_a_concurrent_change(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without webbpulse the merge re-checks the version and retries rather than overwriting a newer value."""
    monkeypatch.setitem(sys.modules, "webbpulse.ops.config", None)
    client = FakeSecrets({"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-old", "OTHER": "kept"}, races=1)

    script.RefreshTokenSecret(client, SECRET_ID).write("xoxe-new")

    assert client.puts == 1
    assert client.current == {"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-new", "OTHER": "kept"}


def test_the_access_token_environment_variable_wins() -> None:
    """A set ``SLACK_CONFIG_TOKEN`` is used as is and the secret is never opened."""

    def refuse() -> Any:
        """Fail if the refresh path is taken."""
        raise AssertionError("the secret was opened")

    assert script.resolve_token({"SLACK_CONFIG_TOKEN": "xoxe.xoxp-env"}, refuse) == "xoxe.xoxp-env"


def test_an_unresolved_reference_is_refused() -> None:
    """A literal asm-exec reference means the wrapper was skipped, so it is not sent to Slack."""
    with pytest.raises(script.TokenError):
        script.resolve_token({"SLACK_CONFIG_TOKEN": "{{resolve:secretsmanager:x}}"}, lambda: None)


def test_main_applies_nothing_when_the_write_back_fails(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A failed write-back exits 4 before any manifest call and prints no token."""
    client = FakeSecrets({"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-old"}, fail_put=True)
    slack = FakeSlack()
    methods: list[str] = []

    def fake_call(method: str, token: str | None, **params: str) -> dict[str, Any]:
        """Route rotation to the fake and record every other method."""
        if method == "tooling.tokens.rotate":
            return slack.rotate(params["refresh_token"])
        methods.append(method)
        return {"ok": True}

    monkeypatch.delenv("SLACK_CONFIG_TOKEN", raising=False)
    monkeypatch.setattr(script, "call", fake_call)
    monkeypatch.setattr(
        script, "open_secret", lambda secret_id, region, role_arn=None: script.RefreshTokenSecret(client, SECRET_ID)
    )
    monkeypatch.setattr(sys, "argv", ["apply_slack_manifest.py", "staging", "--app-id", "A0123456789"])

    assert script.main() == 4
    assert methods == []
    output = capsys.readouterr()
    assert "xoxe" not in output.out + output.err


DEDICATED_ID = "standupless-production/slack-config"


class NotFound(Exception):
    """Stands in for the botocore ``ClientError`` a secret with no value answers."""

    response = {"Error": {"Code": "ResourceNotFoundException"}}


class FakeDedicated:
    """An in-memory dedicated secret that answers only ``GetSecretValue`` and ``PutSecretValue``."""

    def __init__(self, value: dict[str, Any] | None = None, *, fail_put: bool = False) -> None:
        """Seed the secret, or leave it with no value, optionally failing every write."""
        self.raw = None if value is None else json.dumps(value)
        self.fail_put = fail_put

    @property
    def current(self) -> dict[str, Any] | None:
        """Return the decoded value, or ``None`` while there is none."""
        return None if self.raw is None else json.loads(self.raw)

    def get_secret_value(self, SecretId: str) -> dict[str, Any]:
        """Return the current string, or raise the not found error while there is none."""
        assert SecretId == DEDICATED_ID
        if self.raw is None:
            raise NotFound()
        return {"SecretString": self.raw}

    def put_secret_value(self, SecretId: str, SecretString: str, ClientRequestToken: str) -> dict[str, Any]:
        """Store a new value, or fail when told to."""
        assert SecretId == DEDICATED_ID
        if self.fail_put:
            raise RuntimeError("AccessDenied")
        self.raw = SecretString
        return {"VersionId": "v1"}


class RefusingLegacy:
    """A legacy secret the caller has no access to, as the deploy roles see the app secret."""

    secret_id = SECRET_ID
    key = "SLACK_CONFIG_REFRESH_TOKEN"

    def read(self) -> str:
        """Refuse the read."""
        raise RuntimeError("AccessDenied")


def test_the_dedicated_secret_rotates_in_place() -> None:
    """With a token in the dedicated secret the app secret is never opened."""
    dedicated = FakeDedicated({"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-old"})
    slack = FakeSlack()

    def refuse() -> Any:
        """Fail if the migration path is taken."""
        raise AssertionError("the legacy secret was opened")

    access = script.resolve_token({}, lambda: script.TokenSecret(dedicated, DEDICATED_ID), slack.rotate, refuse)

    assert access == "xoxe.xoxp-access-1"
    assert dedicated.current == {"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-new-1"}


def test_an_empty_dedicated_secret_migrates_the_token_out_of_the_app_secret() -> None:
    """The first run rotates the old key, writes the successor only to the dedicated secret and drops the old key."""
    legacy = FakeSecrets({"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-old", "OTHER": "kept"})
    dedicated = FakeDedicated()
    slack = FakeSlack()

    access = script.resolve_token(
        {},
        lambda: script.TokenSecret(dedicated, DEDICATED_ID),
        slack.rotate,
        lambda: script.RefreshTokenSecret(legacy, SECRET_ID),
    )

    assert access == "xoxe.xoxp-access-1"
    assert dedicated.current == {"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-new-1"}
    assert legacy.current == {"OTHER": "kept"}


def test_a_migration_without_app_secret_access_spends_nothing() -> None:
    """A deploy role that cannot read the app secret stops before Slack is called."""
    slack = FakeSlack()

    with pytest.raises(script.TokenError) as raised:
        script.migrate_config_token(RefusingLegacy(), script.TokenSecret(FakeDedicated(), DEDICATED_ID), slack.rotate)

    assert slack.calls == 0
    assert "AdministratorAccess" in str(raised.value)


def test_a_migration_whose_dedicated_write_fails_keeps_the_token_in_the_app_secret() -> None:
    """The successor goes back into the app secret so it is not lost, and the run still stops."""
    legacy = FakeSecrets({"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-old", "OTHER": "kept"})
    dedicated = FakeDedicated(fail_put=True)

    with pytest.raises(script.WriteBackError) as raised:
        script.migrate_config_token(
            script.RefreshTokenSecret(legacy, SECRET_ID),
            script.TokenSecret(dedicated, DEDICATED_ID),
            FakeSlack().rotate,
        )

    assert "xoxe" not in str(raised.value)
    assert dedicated.current is None
    assert legacy.current == {"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-new-1", "OTHER": "kept"}


def test_a_failed_dedicated_write_back_withholds_the_access_token() -> None:
    """Outside the migration a failed write to the dedicated secret is a write-back error."""
    dedicated = FakeDedicated({"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-old"}, fail_put=True)

    with pytest.raises(script.WriteBackError):
        script.rotate_config_token(script.TokenSecret(dedicated, DEDICATED_ID), FakeSlack().rotate)


def test_the_boto3_fallback_removes_only_the_token_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without webbpulse the removal keeps every other key of the app secret."""
    monkeypatch.setitem(sys.modules, "webbpulse.ops.config", None)
    client = FakeSecrets({"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-old", "OTHER": "kept"})

    script.RefreshTokenSecret(client, SECRET_ID).remove()

    assert client.current == {"OTHER": "kept"}


def test_the_app_id_defaults_to_the_committed_file(tmp_path: Path) -> None:
    """``slack/app_ids.json`` supplies the App ID, and an empty entry is refused."""
    (tmp_path / "app_ids.json").write_text(json.dumps({"staging": "A0STAGING", "production": ""}))

    assert script.committed_app_id("staging", tmp_path) == "A0STAGING"
    with pytest.raises(script.TokenError):
        script.committed_app_id("production", tmp_path)


def test_main_passes_the_role_to_the_dedicated_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """``--role-arn`` reaches the opener of the dedicated secret and the legacy secret keeps the ambient profile."""
    seen: dict[str, Any] = {}
    dedicated = FakeDedicated({"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-old"})
    slack = FakeSlack()

    def open_dedicated(secret_id: str, region: str, role_arn: str | None = None) -> Any:
        """Record the arguments and hand back the fake."""
        seen.update(secret_id=secret_id, role_arn=role_arn)
        return script.TokenSecret(dedicated, secret_id)

    def fake_call(method: str, token: str | None, **params: str) -> dict[str, Any]:
        """Answer rotation and the manifest calls with the committed manifest."""
        if method == "tooling.tokens.rotate":
            return slack.rotate(params["refresh_token"])
        if method == "apps.manifest.export":
            return {"ok": True, "manifest": json.loads(params.get("manifest") or MANIFEST.read_text())}
        return {"ok": True}

    monkeypatch.delenv("SLACK_CONFIG_TOKEN", raising=False)
    monkeypatch.setattr(script, "call", fake_call)
    monkeypatch.setattr(script, "open_secret", open_dedicated)
    monkeypatch.setattr(
        sys,
        "argv",
        ["apply_slack_manifest.py", "staging", "--app-id", "A0123456789", "--role-arn", "arn:aws:iam::1:role/x"],
    )

    assert script.main() == 0
    assert seen == {"secret_id": DEDICATED_ID, "role_arn": "arn:aws:iam::1:role/x"}
    assert dedicated.current == {"SLACK_CONFIG_REFRESH_TOKEN": "xoxe-new-1"}


MANIFEST = SCRIPT.parent.parent / "slack" / "manifest.staging.json"
