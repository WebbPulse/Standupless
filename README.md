# Standupless

A multi-tenant issue tracker. Workspaces hold projects, projects hold issues, and
every key carries the workspace id so no read can cross a tenant boundary.

**Stack:** FastAPI (Python 3.13) · React 19 (TypeScript) · DynamoDB · AWS (Lambda
container images behind an HTTP API), with Terraform for infrastructure.

**Status:** day one skeleton. The auth shell and one `workspaces` domain are in
place. The product surface arrives with the design doc.

---

## Structure

```
backend/      FastAPI app, one Lambda image per domain, DynamoDB table definitions
frontend/     React + Vite, on the shared @webbpulse packages
terraform/    AWS infrastructure, applied by HCP Terraform
```

---

## Quickstart

**Prerequisites:** Python 3.13, Node 22+, Docker for DynamoDB Local, and an AWS
login that can mint a CodeArtifact token. Both halves depend on private
`webbpulse` packages, so read the CodeArtifact steps in [CLAUDE.md](CLAUDE.md)
before installing.

### Shared package versions

The shared `webbpulse` and `@webbpulse/*` packages float to the newest release at
build time rather than sitting on an exact pin. The version recorded here is a
floor, the minimum the code needs, and the range admits every later release below
the next major. An exact pin is the explicit exception, used when a specific
release has to be held, and it should say why.

### Backend

```bash
cd backend
export UV_INDEX_CODEARTIFACT_USERNAME=aws
export UV_INDEX_CODEARTIFACT_PASSWORD="$(aws codeartifact get-authorization-token \
  --domain webbpulse --domain-owner 432410731887 --region us-west-2 \
  --query authorizationToken --output text)"
uv sync
docker compose up -d
DYNAMODB_ENDPOINT_URL=http://localhost:8001 uv run python scripts/create_local_tables.py
uv run uvicorn app.common.composition.app:app --reload
```

Checks:

```bash
uv run ruff format --check . && uv run ruff check .
uv run pyright
uv run bandit -r app -ll
uv run pytest
```

### Frontend

```bash
cd frontend
npm ci
npm run dev
```

Checks: `npm run lint`, `npm run type-check`, `npm run test:run`, `npm run build`.

---

## Adding a backend domain

A domain is one deployed Lambda serving one slice of the API. Adding one is three
edits:

1. A new package under `backend/app/domains/<name>/` with an `entrypoint.py`.
2. One entry in `DOMAINS` in `backend/app/common/composition/domains.py`.
3. One entry in `local.lambda_domains_declared` in `terraform/lambda_domains.tf`,
   plus its path prefix in `terraform/apigateway.tf`.

Nothing else enumerates domains. The Dockerfile, both composition roots and the
CI test sharding all read the registry, and a test holds the registry against the
Terraform grants so the two cannot drift apart.

---

## Deploys

Every commit to `staging` or `main` deploys. `staging` serves
`staging.standupless.dev`, `main` serves `standupless.dev`, and the API is at
`api.staging.standupless.dev` and `api.standupless.dev`. Only the domains a commit
affects are rebuilt.

**License:** MIT
