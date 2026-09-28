# standupless CLI

Standupless from the terminal: list, view, create and close issues, comment, get a
branch name, and see teams, cycles and projects. It talks to the public REST API
with a per-user API key.

## Install

```bash
uv tool install standupless-cli
```

Or with pipx:

```bash
pipx install standupless-cli
```

Upgrade with `uv tool upgrade standupless-cli` (or `pipx upgrade standupless-cli`).

## Log in

Create an API key in the web app under Settings, API keys, then:

```bash
standupless auth login            # prompts for the key
echo "$KEY" | standupless auth login --with-token
standupless auth status
standupless auth logout
```

The key goes in the OS keyring, one entry per API base URL. The workspace the key
belongs to is remembered in `~/.config/standupless/config.toml`, and the environment
you last logged in to becomes the default.

## Commands

```bash
standupless issue list [-t ENG] [-a me|none|EMAIL] [-s "In Progress"|started] [-l Bug]
                       [-c current] [-p Launch] [--priority high] [-q text] [--all] [-L 50]
standupless issue view ENG-12 [--comments] [--web]
standupless issue create --title "Fix login" [-t ENG] [-b TEXT | -F FILE] [-a me] [-s Todo]
                         [-l Bug] [--priority high] [-c current] [-p Launch] [--estimate 3]
                         [--due 2026-10-01] [--parent ENG-1] [--web]
standupless issue edit ENG-12 [--title ...] [-s started] [-a none] [--add-label UI]
                              [--remove-label Bug] [-c none] [-p none] [--due none]
standupless issue close ENG-12 [--reason completed|canceled] [-m "Shipped in #42"]
standupless issue reopen ENG-12
standupless issue comment ENG-12 -b "Looks good"     # or -F - to read stdin
standupless issue branch ENG-12                       # git switch -c "$(standupless issue branch ENG-12)"
standupless team list
standupless cycle list [-t ENG] [--status active]
standupless cycle current [-t ENG]
standupless project list [-t ENG] [--status in_progress]
standupless project view Launch [--web]
```

Every command takes `--json` and prints the API's own JSON, for `jq` and scripts.
Names are matched without regard to case: teams by key prefix or name, statuses by
name or category (`backlog`, `unstarted`, `started`, `completed`, `cancelled`),
labels, projects and cycles by name, people by `me`, email or display name.

## Configuration

| Flag | Environment variable | Meaning |
| --- | --- | --- |
| `--base-url` | `STANDUPLESS_BASE_URL` | API base URL, production by default |
| `-w`, `--workspace` | `STANDUPLESS_WORKSPACE` | Workspace id, slug or name |
| | `STANDUPLESS_API_KEY` | Use this key instead of the keyring |
| | `STANDUPLESS_WEB_URL` | Web app URL for links and `--web` |
| | `STANDUPLESS_EXTRA_HEADERS` | JSON object of extra request headers |

Flags beat environment variables, which beat the config file.

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

## Who `me` is

`me` works anywhere a person is expected. Filters and writes send `me` to the server,
which resolves it to the key's person. A personal key also reads its person from
`/api/users/me`. A workspace key acts as the workspace rather than as a person, so
`me` names nobody and the server refuses it.

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

## License

The CLI is licensed under the PolyForm Internal Use License 1.0.0 (see `LICENSE`):
use inside your own business, no redistribution, and no warranty or liability. It is
not open source.
