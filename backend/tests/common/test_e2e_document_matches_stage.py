"""The document the e2e suite builds must describe only what the stage serves.

The post-deploy suite asks the live gateway for every operation the locally built
OpenAPI document declares, so a value in `e2e/conftest.py` that does not match the
deployed function's environment turns into a reported defect against working code.
That is what happened on the first full staging run: the conftest injected a
placeholder OAuth client id, the document declared `/api/auth/oauth/callback`, and
the stage, whose `oauth_google_client_id` and `oauth_github_client_id` are empty,
correctly mounted no such route and answered 404.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

E2E_DIRECTORY = Path(__file__).resolve().parents[2] / "e2e"

OAUTH_CALLBACK_PATH = "/api/auth/oauth/callback"

PROVIDER_ID_VARIABLES = ("E2E_GOOGLE_CLIENT_ID", "E2E_GITHUB_CLIENT_ID")


@pytest.fixture(autouse=True)
def _restore_environment() -> Any:
    """Put `os.environ` back after each test in this module.

    `e2e_openapi_document` deliberately calls `os.environ.update`, because the suite
    it belongs to runs in its own process and wants those settings to stick. Under
    the unit run it shares a process with every other test, and leaving
    `IDENTITY_SIGNER=local` and the rest behind reconfigures the identity settings
    the OAuth server tests build their app from. Snapshotting and restoring keeps
    this module from deciding another one's environment.
    """
    snapshot = dict(os.environ)
    yield
    os.environ.clear()
    os.environ.update(snapshot)


@pytest.fixture
def identity_environment(monkeypatch: pytest.MonkeyPatch) -> Any:
    """`_identity_environment` with a stage base url and no inherited provider ids."""
    monkeypatch.setenv("E2E_API_BASE_URL", "https://api.staging.standupless.dev")
    monkeypatch.setenv("E2E_ENVIRONMENT", "staging")
    for variable in PROVIDER_ID_VARIABLES:
        monkeypatch.delenv(variable, raising=False)
    if str(E2E_DIRECTORY) not in sys.path:
        sys.path.insert(0, str(E2E_DIRECTORY))
    from conftest import _identity_environment

    return _identity_environment


def test_no_provider_id_is_invented(identity_environment: Any) -> None:
    """A client id absent from the environment must stay absent in the build.

    A placeholder here is what made the document claim an OAuth callback the stage
    does not mount, so the empty string is the assertion rather than an accident.
    """
    environment = identity_environment()
    assert environment["IDENTITY_GOOGLE_CLIENT_ID"] == ""
    assert environment["IDENTITY_GITHUB_CLIENT_ID"] == ""


def test_a_configured_provider_id_is_carried(identity_environment: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """A stage that does configure a provider still gets its routes described.

    The fix must not be a blanket removal: the suite should cover the OAuth routes
    wherever they really mount.
    """
    monkeypatch.setenv("E2E_GOOGLE_CLIENT_ID", "a-configured-client-id")
    environment = identity_environment()
    assert environment["IDENTITY_GOOGLE_CLIENT_ID"] == "a-configured-client-id"
    assert environment["IDENTITY_GITHUB_CLIENT_ID"] == ""


def test_the_document_declares_no_oauth_callback_without_a_provider() -> None:
    """End to end: the built document matches a stage with no provider configured.

    Asserting on the document rather than only the environment is what ties this to
    the failure, since the package decides route mounting from those variables and a
    future change to how it reads them would otherwise slip past.

    Built in a subprocess because `e2e_openapi_document` updates `os.environ` and
    the identity settings and composed app are module level singletons. In the real
    suite that is a fresh process; here it would reconfigure the identity tests
    sharing this one, and re-importing to avoid that pollutes them just as badly.
    """
    script = (
        "import json, os, sys\n"
        f"sys.path.insert(0, {str(E2E_DIRECTORY)!r})\n"
        "os.environ['E2E_API_BASE_URL'] = 'https://api.staging.standupless.dev'\n"
        "os.environ['E2E_ENVIRONMENT'] = 'staging'\n"
        "os.environ.pop('E2E_GOOGLE_CLIENT_ID', None)\n"
        "os.environ.pop('E2E_GITHUB_CLIENT_ID', None)\n"
        "from conftest import e2e_openapi_document\n"
        "print(json.dumps(sorted(e2e_openapi_document()['paths'])))\n"
    )
    completed = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        cwd=str(E2E_DIRECTORY.parent),
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    paths = json.loads(completed.stdout.splitlines()[-1])
    assert OAUTH_CALLBACK_PATH not in paths
    assert "/api/auth/oauth/providers" in paths
