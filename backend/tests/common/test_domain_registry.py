"""The registry is the one place a domain is declared.

These hold the property the backend is built around: adding a domain is a new
package under `app/domains/` plus one entry in `DOMAINS`. If a later change makes
some other file enumerate domains, one of these fails.
"""

from __future__ import annotations

import importlib
import pkgutil

import pytest

from app.common.composition.consumers import CONSUMERS
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
    source = _terraform_source()
    for name in DOMAIN_NAMES:
        body = _function_block(source, name)
        written = _listed(body, "tables")
        read = _listed(body, "read_tables")

        assert written - {"rate-limits"} == set(DOMAINS[name].tables), (
            f"the {name} function is granted write on {sorted(written)} "
            f"but the registry declares {list(DOMAINS[name].tables)}"
        )
        assert read == set(DOMAINS[name].read_tables), (
            f"the {name} function is granted read on {sorted(read)} "
            f"but the registry declares {list(DOMAINS[name].read_tables)}"
        )
        assert not (written & read), f"the {name} function lists {sorted(written & read)} as both written and read only"


def _terraform_source() -> str:
    """The text of `terraform/lambda_domains.tf`, skipping when it is not checked out."""
    from pathlib import Path

    terraform = Path(__file__).resolve().parents[2].parent / "terraform" / "lambda_domains.tf"
    if not terraform.exists():
        pytest.skip("terraform/lambda_domains.tf is not present")
    return terraform.read_text()


def _local_map(source: str, local: str) -> str:
    """The body of one top-level map in the `locals` block."""
    import re

    match = re.search(rf"^  {re.escape(local)} = \{{\n(.*?)^  \}}", source, re.S | re.M)
    assert match, f"terraform declares no {local}"
    return match.group(1)


def _function_block(source: str, name: str) -> str:
    """The body of one function's block in `lambda_domains_declared`."""
    import re

    functions = _local_map(source, "lambda_domains_declared")
    block = re.search(rf"^    {re.escape(name)} = \{{(.*?)^    \}}", functions, re.S | re.M)
    assert block, f"terraform declares no function named {name}"
    return block.group(1)


def test_every_terraform_function_is_declared_in_python() -> None:
    """Each hand-written function block is either a domain or a declared consumer.

    A consumer Terraform grants without a `CONSUMERS` entry would have nothing
    holding its code to its policy, which is how a write it needs goes unnoticed
    until IAM refuses it in a deployed environment.
    """
    import re

    functions = _local_map(_terraform_source(), "lambda_domains_declared")
    declared = set(re.findall(r"^    ([a-z][a-z-]*) = \{", functions, re.M))
    assert declared == set(DOMAIN_NAMES) | set(CONSUMERS), (
        f"terraform functions {sorted(declared - set(DOMAIN_NAMES) - set(CONSUMERS))} are not declared, "
        f"and declared ones {sorted(set(DOMAIN_NAMES) | set(CONSUMERS) - declared)} have no terraform block"
    )


@pytest.mark.parametrize("name", sorted(CONSUMERS))
def test_consumer_grants_match_the_terraform_grants(name: str) -> None:
    """Each consumer function is granted exactly the tables its declaration names.

    Compared per function rather than per domain, because a consumer runs in its
    domain's image under its own, narrower policy. `rate-limits` is excluded for
    the reason the domain check gives.
    """
    scope = CONSUMERS[name]
    body = _function_block(_terraform_source(), name)
    written = _listed(body, "tables")
    read = _listed(body, "read_tables")

    assert written - {"rate-limits"} == set(scope.tables), (
        f"the {name} function is granted write on {sorted(written)} but its declaration names {list(scope.tables)}"
    )
    assert read == set(scope.read_tables), (
        f"the {name} function is granted read on {sorted(read)} but its declaration names {list(scope.read_tables)}"
    )
    assert not (written & read), f"the {name} function lists {sorted(written & read)} as both written and read only"


@pytest.mark.parametrize("name", sorted(CONSUMERS))
def test_consumers_run_in_their_domains_image(name: str) -> None:
    """A consumer's grant stays inside the bundle its image's domain carries, and its entrypoint serves it."""
    import re

    scope = CONSUMERS[name]
    source = _terraform_source()
    image = re.search(rf'^    {re.escape(name)}\s*=\s*"([^"]+)"', _local_map(source, "lambda_domain_images"), re.M)
    assert image and image.group(1) == scope.domain, f"terraform runs {name} in another image than {scope.domain}"

    outside = set(scope.all_repositories) - set(DOMAINS[scope.domain].all_repositories)
    assert not outside, f"{name} declares {sorted(outside)}, which the {scope.domain} image does not carry"

    commands = _local_map(source, "lambda_domain_commands")
    command = re.search(rf'^    {re.escape(name)}\s*=\s*\[[^\]]*"-m", "([^"]+)"\]', commands, re.M)
    assert command, f"terraform gives {name} no entrypoint module"
    entrypoint = importlib.import_module(command.group(1))
    assert entrypoint.DOMAIN.repositories == scope.repositories
    assert entrypoint.DOMAIN.read_repositories == scope.read_repositories


def test_a_consumer_bundle_refuses_what_its_function_is_not_granted() -> None:
    """Narrowing the all-carrying bundle is what makes a test fail the way IAM would."""
    from app.common.api.dependencies.repositories import RepositoryNotInBundle, build_bundle
    from app.common.db.dynamo.registry import ALL_REPOSITORY_NAMES

    scope = CONSUMERS["integrations-dispatch-consumer"]
    narrowed = scope.narrow(build_bundle(ALL_REPOSITORY_NAMES))

    assert narrowed.bundle_name == scope.name
    assert scope.narrow(narrowed) is narrowed
    assert not narrowed.is_read_only("inbox")
    assert narrowed.is_read_only("issues")
    with pytest.raises(RepositoryNotInBundle):
        _ = narrowed.views


def _listed(block: str, attribute: str) -> "set[str]":
    """The table names one Terraform list attribute holds."""
    import re

    match = re.search(rf"{attribute}\s*=\s*\[([^\]]*)\]", block)
    assert match, f"the block declares no {attribute}"
    return set(re.findall(r'"([^"]+)"', match.group(1)))
