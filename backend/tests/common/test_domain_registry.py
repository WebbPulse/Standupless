"""The registry is the one place a domain is declared.

These hold the property the backend is built around: adding a domain is a new
package under `app/domains/` plus one entry in `DOMAINS`. If a later change makes
some other file enumerate domains, one of these fails.
"""

from __future__ import annotations

import importlib
import pkgutil

import pytest

from app.common.composition.domains import DOMAIN_NAMES, DOMAINS, ENTRYPOINT_MODULES
from app.common.db.dynamo.registry import REPOSITORY_SPECS


def test_every_domain_package_is_registered() -> None:
    """A package under `app/domains/` that nothing registers would never be served."""
    import app.domains

    packages = {
        module.name
        for module in pkgutil.iter_modules(app.domains.__path__)
        if module.ispkg and not module.name.startswith("_")
    }
    assert packages == set(ENTRYPOINT_MODULES.values())


def test_every_domain_has_an_entrypoint_module() -> None:
    """Each registered domain ships the Root B module its Lambda image runs."""
    for name in DOMAIN_NAMES:
        module = importlib.import_module(f"app.domains.{ENTRYPOINT_MODULES[name]}.entrypoint")
        assert hasattr(module, "build_app")
        assert hasattr(module, "main")


def test_declared_repositories_exist() -> None:
    """A domain cannot claim a repository the data layer does not define.

    The claim is what the function's Terraform IAM grant is written from, so a
    name that resolves to no table would grant nothing and fail at request time.
    """
    for domain in DOMAINS.values():
        unknown = set(domain.repositories) - set(REPOSITORY_SPECS)
        assert not unknown, f"{domain.name} declares unknown repositories: {sorted(unknown)}"


def test_tables_follow_from_the_declared_repositories() -> None:
    """A domain's data surface is derived, never written down twice."""
    for domain in DOMAINS.values():
        expected = sorted({REPOSITORY_SPECS[name].table for name in domain.repositories})
        assert list(domain.tables) == expected


def test_importing_the_registry_imports_no_endpoint_module() -> None:
    """Reading the registry must not drag every domain's routes into the process.

    Run in a fresh interpreter because this process has already imported the
    endpoint modules through the app fixtures, which would make the check pass
    for the wrong reason. Laziness here is what keeps a domain image free of the
    other domains' code.
    """
    import subprocess
    import sys

    program = (
        "import sys;"
        "import app.common.composition.domains as registry;"
        "leaked = sorted(m for m in sys.modules if '.endpoints' in m);"
        "print(','.join(leaked))"
    )
    result = subprocess.run(
        [sys.executable, "-c", program],
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == "", f"importing the registry pulled in {result.stdout.strip()}"


def test_declared_tables_match_the_terraform_grants() -> None:
    """A domain's declared tables are what Terraform grants its function.

    The registry and `terraform/lambda_domains.tf` are written by hand in two
    places, so they can disagree, and the failure is invisible until a deployed
    request is denied by IAM. `rate-limits` is excluded because the middleware
    reaches it through the shared package rather than through a bundle.
    """
    import re
    from pathlib import Path

    terraform = Path(__file__).resolve().parents[2].parent / "terraform" / "lambda_domains.tf"
    if not terraform.exists():
        pytest.skip("terraform/lambda_domains.tf is not present")

    source = terraform.read_text()
    for name in DOMAIN_NAMES:
        block = re.search(rf"^    {re.escape(name)} = \{{(.*?)^    \}}", source, re.S | re.M)
        assert block, f"terraform declares no function for the {name} domain"
        granted = set(re.findall(r'"([^"]+)"', re.search(r"tables\s*=\s*\[([^\]]*)\]", block.group(1)).group(1)))
        assert granted - {"rate-limits"} == set(DOMAINS[name].tables), (
            f"the {name} function is granted {sorted(granted)} but the registry declares {list(DOMAINS[name].tables)}"
        )
