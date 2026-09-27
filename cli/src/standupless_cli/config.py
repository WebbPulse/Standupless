"""Where the CLI talks to and who it talks as.

Every setting resolves in the same order: a command line flag, then an environment
variable, then the config file, then the production default. The API key is the one
exception to the file: it lives in the OS keyring, keyed by API base URL, so staging
and production keys sit side by side and never land in a plain text file.
"""

from __future__ import annotations

import json
import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import keyring
import keyring.errors

KEYRING_SERVICE = "standupless"

ENVIRONMENTS: dict[str, tuple[str, str]] = {
    "prod": ("https://api.standupless.dev", "https://standupless.dev"),
    "staging": ("https://api.staging.standupless.dev", "https://staging.standupless.dev"),
}
"""API base URL and web app URL for each named environment."""

DEFAULT_ENV = "prod"


class ConfigError(Exception):
    """A setting is missing or malformed in a way the user has to fix."""


def config_path() -> Path:
    """The config file, under `$XDG_CONFIG_HOME` when set so tests and CI can isolate it."""
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "standupless" / "config.toml"


def load_config() -> dict[str, Any]:
    """Read the config file, treating a missing file as empty."""
    path = config_path()
    if not path.exists():
        return {}
    try:
        return tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"{path} is not valid TOML: {exc}") from exc


def _toml_value(value: Any) -> str:
    """Render one scalar as TOML; JSON string escaping is a valid TOML basic string."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    return json.dumps(str(value))


def dump_config(data: dict[str, Any]) -> str:
    """Serialise the config's two levels, top level scalars and one table per host.

    The file only ever holds strings and one nesting level, so a small writer beats a
    dependency.
    """
    lines = [f"{key} = {_toml_value(value)}" for key, value in data.items() if not isinstance(value, dict)]
    hosts = data.get("hosts") or {}
    for host, values in hosts.items():
        if lines:
            lines.append("")
        lines.append(f"[hosts.{json.dumps(host)}]")
        lines.extend(f"{key} = {_toml_value(value)}" for key, value in values.items() if value is not None)
    return "\n".join(lines) + "\n"


def save_config(data: dict[str, Any]) -> Path:
    """Write the config file with owner-only permissions and return its path."""
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dump_config(data))
    path.chmod(0o600)
    return path


@dataclass
class Settings:
    """The resolved connection settings for one invocation."""

    base_url: str
    web_url: str
    workspace: str | None = None
    extra_headers: dict[str, str] = field(default_factory=dict)
    host: dict[str, Any] = field(default_factory=dict)
    api_key_env: str | None = None

    def api_key(self) -> str | None:
        """The key from `STANDUPLESS_API_KEY`, else the keyring entry for this base URL."""
        if self.api_key_env:
            return self.api_key_env
        return read_keyring(self.base_url)


def read_keyring(base_url: str) -> str | None:
    """The stored key for a base URL, or None when there is none or no keyring backend."""
    try:
        return keyring.get_password(KEYRING_SERVICE, base_url)
    except keyring.errors.KeyringError:
        return None


def write_keyring(base_url: str, api_key: str) -> None:
    """Store a key for a base URL, explaining the env var fallback when no backend exists."""
    try:
        keyring.set_password(KEYRING_SERVICE, base_url, api_key)
    except keyring.errors.KeyringError as exc:
        raise ConfigError(
            f"Could not store the key in the OS keyring ({exc}). Set STANDUPLESS_API_KEY instead."
        ) from exc


def delete_keyring(base_url: str) -> bool:
    """Remove the stored key for a base URL, returning whether one was there."""
    try:
        keyring.delete_password(KEYRING_SERVICE, base_url)
    except keyring.errors.PasswordDeleteError:
        return False
    except keyring.errors.KeyringError:
        return False
    return True


def _extra_headers() -> dict[str, str]:
    """Headers from `STANDUPLESS_EXTRA_HEADERS`, a JSON object, for gated environments."""
    raw = os.environ.get("STANDUPLESS_EXTRA_HEADERS")
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigError("STANDUPLESS_EXTRA_HEADERS must be a JSON object of header names to values.") from exc
    if not isinstance(parsed, dict):
        raise ConfigError("STANDUPLESS_EXTRA_HEADERS must be a JSON object of header names to values.")
    return {str(key): str(value) for key, value in parsed.items()}


def _web_url_for(base_url: str) -> str:
    """The web app URL that pairs with an API base URL, guessed by dropping `api.`."""
    for api, web in ENVIRONMENTS.values():
        if base_url == api:
            return web
    return base_url.replace("://api.", "://", 1)


def resolve_settings(
    env: str | None = None,
    base_url: str | None = None,
    workspace: str | None = None,
    config: dict[str, Any] | None = None,
) -> Settings:
    """Resolve flags, environment variables and the config file into one `Settings`."""
    data = load_config() if config is None else config
    chosen_base = base_url or os.environ.get("STANDUPLESS_BASE_URL")
    if not chosen_base:
        env_name = env or os.environ.get("STANDUPLESS_ENV")
        if env_name:
            if env_name not in ENVIRONMENTS:
                raise ConfigError(f"Unknown environment {env_name!r}; choose one of {', '.join(ENVIRONMENTS)}.")
            chosen_base = ENVIRONMENTS[env_name][0]
        else:
            chosen_base = data.get("base_url") or ENVIRONMENTS[data.get("env") or DEFAULT_ENV][0]
    chosen_base = chosen_base.rstrip("/")
    host = dict((data.get("hosts") or {}).get(chosen_base) or {})
    web_url = os.environ.get("STANDUPLESS_WEB_URL") or host.get("web_url") or _web_url_for(chosen_base)
    return Settings(
        base_url=chosen_base,
        web_url=web_url.rstrip("/"),
        workspace=workspace or os.environ.get("STANDUPLESS_WORKSPACE") or host.get("workspace_id"),
        extra_headers=_extra_headers(),
        host=host,
        api_key_env=os.environ.get("STANDUPLESS_API_KEY") or None,
    )


def remember_host(base_url: str, values: dict[str, Any], make_default: bool = True) -> Path:
    """Merge values into a host's config table, optionally making it the default target."""
    data = load_config()
    hosts = data.setdefault("hosts", {})
    hosts[base_url] = {**hosts.get(base_url, {}), **values}
    if make_default:
        data.pop("env", None)
        data["base_url"] = base_url
    return save_config(data)


def forget_host(base_url: str) -> None:
    """Drop a host's config table, keeping the rest of the file."""
    data = load_config()
    hosts = data.get("hosts") or {}
    if base_url in hosts:
        del hosts[base_url]
        save_config(data)
