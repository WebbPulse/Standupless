"""The deploy role trusts only jobs running under this environment's GitHub Environment.

A wildcard subject lets any branch push or workflow from a writer assume the deploy
role without passing the Environment's protection rules. `terraform/iam_github_actions.tf`
is parsed as text, the way `test_gateway_routing.py` reads `apigateway.tf`, so nothing
here needs the terraform binary or a plan.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

TERRAFORM = Path(__file__).resolve().parents[2].parent / "terraform" / "iam_github_actions.tf"

DEPLOY_SUBJECT = "repo:WebbPulse@185014056/Standupless@1375434030:environment:${var.environment}"


def _deploy_role_block() -> str:
    """The text of the github_actions_role module block."""
    if not TERRAFORM.exists():
        pytest.skip("terraform/iam_github_actions.tf is not present")
    source = TERRAFORM.read_text()
    match = re.search(r'module "github_actions_role" \{(.*?)\n\}', source, re.DOTALL)
    assert match, "github_actions_role module block not found"
    return match.group(1)


def test_deploy_role_subject_is_pinned_to_the_environment() -> None:
    """The deploy role's only subject is the environment-scoped one."""
    block = _deploy_role_block()
    subjects = re.search(r"subjects\s*=\s*\[(.*?)\]", block, re.DOTALL)
    assert subjects, "deploy role declares no subjects"
    declared = re.findall(r'"([^"]+)"', subjects.group(1))
    assert declared == [DEPLOY_SUBJECT]
    assert not any(subject.endswith(":*") for subject in declared)


def test_no_role_grants_set_repository_policy() -> None:
    """Deploys never rewrite repository policies, so no role carries the action."""
    if not TERRAFORM.exists():
        pytest.skip("terraform/iam_github_actions.tf is not present")
    assert "ecr:SetRepositoryPolicy" not in TERRAFORM.read_text()
