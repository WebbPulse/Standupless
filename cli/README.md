# standupless CLI

Standupless from the terminal: list, view, create and close issues, comment, get a
branch name, and see teams, cycles and projects. It talks to the public REST API
with a per-user API key.

## Install

Needs Python 3.11 or later.

```bash
pip install standupless-cli
```

Or with pipx, to keep it in its own environment:

```bash
pipx install standupless-cli
```

Upgrade with `pip install --upgrade standupless-cli` (or `pipx upgrade standupless-cli`).

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
standupless issue move ENG-12 --team OPS
standupless issue comment ENG-12 -b "Looks good"     # or -F - to read stdin
standupless issue branch ENG-12                       # git switch -c "$(standupless issue branch ENG-12)"
standupless team list
standupless team update -t ENG --no-sync-pr-labels   # stop carrying issue labels onto linked pull requests
standupless status list -t ENG
standupless status create "In Review" -t ENG -c started [--color green] [--icon half]
standupless status edit "In Review" -t ENG [--name ...] [-c ...] [--color default] [--icon paused]
standupless status list --shared
standupless status create Review --shared -c started
standupless status hide|unhide|reset Review -t ENG
standupless status rename Review QA -t ENG
standupless status clear-rename Review -t ENG
standupless status delete Review --shared
standupless label list -t ENG [--include-hidden]
standupless label create Bug --shared --color "#eb5757"
standupless label edit|delete|hide|unhide|rename|clear-rename|reset ...
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

## Who `me` is

`me` works anywhere a person is expected. Filters and writes send `me` to the server,
which resolves it to the key's person. A personal key also reads its person from
`/api/users/me`. A workspace key acts as the workspace rather than as a person, so
`me` names nobody and the server refuses it.

## License

The CLI is licensed under the PolyForm Internal Use License 1.0.0 (see `LICENSE`):
use inside your own business, no redistribution, and no warranty or liability. It is
not open source.
