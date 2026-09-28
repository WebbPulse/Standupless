# Working on the standupless CLI

This file stays in the repository; the README is the public PyPI page.

## Development

```bash
cd cli
uv sync
uv run pytest
uv run ruff format . && uv run ruff check .
uv run pyright
uv run python scripts/generate_models.py   # after backend/openapi.json changes
```

The request and response types in `src/standupless_cli/_generated/models.py` are
generated from `backend/openapi.json`, and CI fails when they are stale. A contract
test holds every request the client sends to an operation in that document.

## Staging

The CLI targets production. For internal work against staging, set
`STANDUPLESS_ENV=staging`, or point `STANDUPLESS_BASE_URL` and `STANDUPLESS_WEB_URL`
at any other deployment; `--base-url` works too.

The staging API sits behind the staging access gate, which admits a request only
when it carries the gate's `x-origin-verify` header or the signed cookies the gate
sets after a browser login. An API key alone does not pass the gate: the key is
checked after the gate, not instead of it. Send the header on every request:

```bash
export STANDUPLESS_EXTRA_HEADERS="{\"x-origin-verify\": \"$(aws ssm get-parameter \
  --name /standupless-staging/access-gate/origin-verify --with-decryption \
  --query Parameter.Value --output text)\"}"
export STANDUPLESS_ENV=staging
standupless auth login
```

The parameter lives in the staging account and is also the
`staging_access_gate_ssm_parameter_name` Terraform output. Treat the value like a
password. Production has no gate and needs no extra header.

