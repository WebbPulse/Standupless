"""Each deployed image imports its own domain and nothing else.

A domain function that imports another domain's endpoints carries that code, its
dependencies and its cold start cost, and would be granted nothing to run it
against. Run in subprocesses because this suite has already imported everything.
"""

from __future__ import annotations

import subprocess
import sys

import pytest

from app.common.composition.domains import DOMAIN_NAMES, ENTRYPOINT_MODULES

PROGRAM = (
    "import sys;"
    "import app.domains.{package}.entrypoint as entrypoint;"
    "entrypoint.build_app();"
    "print(','.join(sorted(m for m in sys.modules if m.startswith('app.domains.'))))"
)


@pytest.mark.parametrize("domain", DOMAIN_NAMES)
def test_a_domain_app_imports_only_its_own_domain(domain: str) -> None:
    """Building one domain's application pulls in no other domain's modules."""
    package = ENTRYPOINT_MODULES[domain]
    result = subprocess.run(
        [sys.executable, "-c", PROGRAM.format(package=package)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr

    imported = {module for module in result.stdout.strip().split(",") if module}
    foreign = {
        module for module in imported if not module.startswith(f"app.domains.{package}") and module != "app.domains"
    }
    assert not foreign, f"the {domain} image also imported {sorted(foreign)}"
