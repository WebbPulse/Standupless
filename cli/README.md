# standupless CLI

Standupless from the terminal: list, view, create and close issues, comment, get a
branch name, and see teams, cycles and projects. It talks to the public REST API
with a per-user API key.

## Install

```bash
uv tool install "git+https://github.com/WebbPulse/Standupless#subdirectory=cli"
```

Upgrade with `uv tool upgrade standupless-cli`.

## Log in

Create an API key in the web app under Settings, API keys, then:

```bash
standupless auth login            # prompts for the key
echo "$KEY" | standupless auth login --with-token
standupless --env staging auth login
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
| `--env` | `STANDUPLESS_ENV` | `prod` (default) or `staging` |
| `--base-url` | `STANDUPLESS_BASE_URL` | Any API base URL, overriding `--env` |
| `-w`, `--workspace` | `STANDUPLESS_WORKSPACE` | Workspace id, slug or name |
| | `STANDUPLESS_API_KEY` | Use this key instead of the keyring |
| | `STANDUPLESS_WEB_URL` | Web app URL for links and `--web` |
| | `STANDUPLESS_EXTRA_HEADERS` | JSON object of extra request headers |

Flags beat environment variables, which beat the config file.

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
