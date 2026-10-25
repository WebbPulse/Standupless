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
    monkeypatch.setattr(script, "open_secret", lambda secret_id, region: script.RefreshTokenSecret(client, secret_id))
    monkeypatch.setattr(sys, "argv", ["apply_slack_manifest.py", "staging", "--app-id", "A0123456789"])

    assert script.main() == 4
    assert methods == []
    output = capsys.readouterr()
    assert "xoxe" not in output.out + output.err
