# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Project Overview

Standupless is a multi-tenant issue tracker. A workspace is the tenant, projects
are the isolation unit inside it, and every key carries the workspace id, so
authorization fails closed rather than relying on a filter being remembered.

**Stack:** FastAPI (Python 3.13) backend, React 19 (TypeScript) frontend, deployed
on AWS as Lambda container images behind an HTTP API with DynamoDB. Infrastructure
is Terraform (`terraform/`), applied by HCP Terraform.

**Status:** day one skeleton. The identity and `workspaces` domains exist, and the
frontend is the auth shell plus one placeholder page. Do not invent product
features: the surface arrives with the design doc.

---

## Commands

### Backend (`backend/`)

The private `webbpulse` package is published only to org CodeArtifact, so any
shell that installs needs a token:

```bash
export UV_INDEX_CODEARTIFACT_USERNAME=aws
export UV_INDEX_CODEARTIFACT_PASSWORD="$(aws codeartifact get-authorization-token \
  --domain webbpulse --domain-owner 432410731887 --region us-west-2 \
  --query authorizationToken --output text)"
```

```bash
uv sync
docker compose up -d
DYNAMODB_ENDPOINT_URL=http://localhost:8001 uv run python scripts/create_local_tables.py
uv run uvicorn app.common.composition.app:app --reload

uv run pytest
uv run ruff format . && uv run ruff check .
uv run pyright
uv run bandit -r app -ll
```

Tests use moto in memory, so no service has to be running.

Per-domain images: one `backend/Dockerfile`, one image per domain, selected by the
`DOMAIN` build argument. The base image lives in the Artifacts account, so log in
to that ECR first.

```bash
aws ecr get-login-password --region us-west-2 \
  | docker login --username AWS --password-stdin \
    432410731887.dkr.ecr.us-west-2.amazonaws.com
```

### Frontend (`frontend/`)

```bash
npm ci
npm run dev
npm run lint && npm run type-check && npm run test:run && npm run build
```

---

## Architecture

### Two composition roots

- **Root A**, `app/common/composition/app.py`, builds every domain into one
  process. It is what local development and the merged OpenAPI document use.
- **Root B**, `app/domains/<name>/entrypoint.py`, builds one application per
  deployed function.

Both go through `build_domain_app`, so a route cannot be reachable in development
and missing in production. `tests/common/test_composition.py` holds that the union
of the Root B applications is exactly Root A.

Composition is `include_router`, never `mount`.

### The domain registry

`app/common/composition/domains.py` is the only place a domain is declared.
Adding one is a new package under `app/domains/` plus one entry in `DOMAINS`, and
the matching Terraform entry. Loaders are lazy, so importing the registry imports
no endpoint module and each image carries only its own code.

Two tests defend this. `test_entrypoint_isolation` fails if one domain's image
imports another's, and `test_declared_tables_match_the_terraform_grants` fails if
the registry and `terraform/lambda_domains.tf` disagree about a function's tables.

### Repository bundles

Each domain declares the repositories it carries. Asking a bundle for one outside
that set raises `RepositoryNotInBundle` rather than reaching a table the function
has no IAM grant on, so the code and the Terraform policy describe the same
surface. Repositories in a domain's `read_repositories` refuse writes with
`ReadOnlyTable`, and `bind_repositories` narrows any bundle to the application's
declared scope, so a route test against the all-carrying fixture fails the same
way the deployed function's IAM policy would.

### Identity

All of `/api/auth` is served by `webbpulse.identity`, mounted with no prefix.
Product policy lives behind the `IdentityHooks` protocol in
`app/domains/identity/identity_hooks.py`, which owns the `users` row. Credentials,
passkeys and OAuth links are the package's own tables.

---

## Conventions

- No code comments. Docstrings on every module, class and function, saying why
  rather than restating the code.
- Fill gaps in the shared packages upstream, in `webbpulse-python`,
  `webbpulse-typescript` or `terraform-aws-platform-modules`, never with a
  product-local workaround.
- Shared packages float to the newest release at build time. An exact pin is the
  explicit exception and should say why.
- User-facing copy says "software engineer", never "developer". No em dashes and
  no tagline language.
- Route guards: a spinner while `isLoading`, a redirect on `!isAuthenticated`, and
  guest guards also wait on `!isBusy`.

---

## Deploys

Every commit to `staging` or `main` deploys, so treat a commit as a release.
`staging` serves `staging.standupless.dev` and `main` serves `standupless.dev`.
Only the domains a commit affects are rebuilt. `all-checks-passed` is the required
check.
