"""Settings resolve flag, then env, then config file, then the production default."""

from __future__ import annotations

import tomllib

import pytest
from typer.testing import CliRunner

from standupless_cli.config import (
    ENVIRONMENTS,
    ConfigError,
    config_path,
    dump_config,
    forget_host,
    load_config,
    remember_host,
    resolve_settings,
)
from tests.conftest import invoke


def test_defaults_to_production() -> None:
    """With nothing set, the CLI talks to production."""
    settings = resolve_settings()
    assert settings.base_url == ENVIRONMENTS["prod"][0]
    assert settings.web_url == ENVIRONMENTS["prod"][1]
    assert settings.api_key() is None


def test_env_flag_beats_env_var(monkeypatch: pytest.MonkeyPatch) -> None:
    """A flag wins over `STANDUPLESS_ENV`."""
    monkeypatch.setenv("STANDUPLESS_ENV", "prod")
    assert resolve_settings(env="staging").base_url == ENVIRONMENTS["staging"][0]


def test_staging_is_reachable_through_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """`STANDUPLESS_ENV=staging` selects staging without any flag."""
    monkeypatch.setenv("STANDUPLESS_ENV", "staging")
    settings = resolve_settings()
    assert settings.base_url == ENVIRONMENTS["staging"][0]
    assert settings.web_url == ENVIRONMENTS["staging"][1]


def test_help_names_only_production() -> None:
    """The help text hides the environment switch and never mentions staging."""
    result = invoke(CliRunner(), "--help")
    assert result.exit_code == 0, result.output
    assert "--env" not in result.output
    assert "staging" not in result.output.lower()
    assert "--base-url" in result.output


def test_hidden_env_flag_still_works() -> None:
    """The hidden `--env` flag keeps working for existing scripts."""
    result = invoke(CliRunner(), "--env", "staging", "auth", "status")
    assert ENVIRONMENTS["staging"][0] in result.output


def test_base_url_beats_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """An explicit base URL wins over a named environment, and its web URL is guessed."""
    monkeypatch.setenv("STANDUPLESS_BASE_URL", "https://api.example.dev/")
    settings = resolve_settings(env="staging")
    assert settings.base_url == "https://api.example.dev"
    assert settings.web_url == "https://example.dev"


def test_unknown_env_is_an_error() -> None:
    """A typo in the environment name fails loudly."""
    with pytest.raises(ConfigError):
        resolve_settings(env="qa")


def test_config_file_supplies_default_host_and_workspace() -> None:
    """Login's remembered host becomes the default, with its workspace."""
    staging = ENVIRONMENTS["staging"][0]
    remember_host(staging, {"workspace_id": "ws-9", "workspace_slug": "acme"})
    settings = resolve_settings()
    assert settings.base_url == staging
    assert settings.workspace == "ws-9"
    assert config_path().stat().st_mode & 0o777 == 0o600


def test_config_round_trips_through_toml() -> None:
    """The hand-rolled writer produces TOML the standard reader accepts."""
    data = {"base_url": "https://a", "hosts": {"https://a": {"workspace_id": 'w"1', "user_id": "u"}}}
    assert tomllib.loads(dump_config(data)) == data


def test_forget_host_keeps_other_hosts() -> None:
    """Logging out of one environment leaves the other alone."""
    remember_host("https://a", {"workspace_id": "1"})
    remember_host("https://b", {"workspace_id": "2"})
    forget_host("https://a")
    assert list(load_config()["hosts"]) == ["https://b"]


def test_extra_headers_must_be_an_object(monkeypatch: pytest.MonkeyPatch) -> None:
    """Gate headers come from a JSON object and nothing else."""
    monkeypatch.setenv("STANDUPLESS_EXTRA_HEADERS", '{"x-origin-verify": "abc"}')
    assert resolve_settings().extra_headers == {"x-origin-verify": "abc"}
    monkeypatch.setenv("STANDUPLESS_EXTRA_HEADERS", "[1]")
    with pytest.raises(ConfigError):
        resolve_settings()


def test_env_key_beats_keyring(monkeypatch: pytest.MonkeyPatch) -> None:
    """`STANDUPLESS_API_KEY` overrides whatever the keyring holds."""
    from standupless_cli.config import write_keyring

    write_keyring(ENVIRONMENTS["prod"][0], "wpk_stored")
    assert resolve_settings().api_key() == "wpk_stored"
    monkeypatch.setenv("STANDUPLESS_API_KEY", "wpk_env")
    assert resolve_settings().api_key() == "wpk_env"
