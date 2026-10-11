# standupless CLI

Standupless from the terminal: list, view, create and close issues, comment, get a
branch name, see teams, cycles and projects, and record releases. It talks to the public REST API
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
standupless issue export [-t ENG | --view "Urgent bugs"] [the issue list filters] [--open]
                         [--archived] [-o issues.csv]
standupless issue view ENG-12 [--comments] [--web]
standupless issue activity ENG-12 [--source mcp]      # history, with the client each change came through
standupless issue create --title "Fix login" [-t ENG] [-b TEXT | -F FILE] [-a me] [-s Todo]
                         [-l Bug] [--priority high] [-c current] [-p Launch] [--estimate 3]
                         [--due 2026-10-01] [--parent ENG-1] [--web]
standupless issue edit ENG-12 [--title ...] [-s started] [-a none] [--add-label UI]
                              [--remove-label Bug] [-c none] [-p none] [--due none]
standupless issue close ENG-12 [--reason completed|canceled] [-m "Shipped in #42"]
standupless issue reopen ENG-12
standupless issue move ENG-12 --team OPS
standupless issue comment ENG-12 -b "Looks good"     # or -F - to read stdin
standupless issue subscribe ENG-12 [-u ada]           # follow it, or subscribe a teammate
standupless issue unsubscribe ENG-12 [-u ada]
standupless issue branch ENG-12                       # git switch -c "$(standupless issue branch ENG-12)"
standupless workspace export [-o backup.zip] [--mask-emails]   # whole workspace as NDJSON in a zip; needs admin
standupless workspace export --no-wait                          # print the export id, then: --id ID to download
standupless team create Platform --key PLT --parent ENG   # a sub-team of ENG in one call, inheriting its statuses, labels and settings
standupless team list [--parent ENG]                 # each team's parent; --parent keeps only ENG's sub-teams
standupless team update -t ENG --no-sync-pr-labels   # stop carrying issue labels onto linked pull requests
standupless team sync -t ENG [-r 123456] [-d two_way] [--pause] [--no-sync-labels] [--allow-public-two-way]
standupless team update -t ENG --private             # only team members see the team and its issues
standupless team update -t ENG --estimate-scale exponential --extended --count-unestimated   # 1 to 64, unestimated count as 1 point
standupless team update -t PLT --parent ENG           # make PLT a sub-team of ENG; --parent none makes it top level
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
standupless label create Area -t ENG --color "#5e6ad2" --is-group   # a label group
standupless label create Frontend -t ENG --color "#5e6ad2" --group Area
standupless label edit Area/Frontend -t ENG --no-group               # or --group <name> to move it
standupless label edit|delete|hide|unhide|rename|clear-rename|reset ...
standupless channel list -t ENG
standupless channel add -t ENG --label "#eng" -e issue_created -e issue_completed   # prompts for the webhook URL
standupless channel edit "#eng" -t ENG [-e comment_created] [--off] [--new-url]
standupless channel test|delete "#eng" -t ENG
standupless cycle list [-t ENG] [--status active]
standupless cycle current [-t ENG]
standupless cycle settings -t ENG [--move-unfinished/--no-move-unfinished] [--enabled/--disabled]
standupless project list [-t ENG] [--status in_progress] [--initiative Grow]
standupless project view Launch [--web]
standupless project cadence Launch biweekly   # off, weekly, biweekly, monthly, inherit
standupless initiative list [--status active]
standupless initiative view Grow [--web]
standupless initiative create Grow [--owner me] [--target 2026-12-01] [-d "Why it matters"]
standupless initiative edit Grow [--status active] [--owner none] [--target none]
standupless initiative add Grow Launch        # moves Launch out of any other initiative
standupless initiative remove Grow Launch
standupless initiative updates Grow
standupless initiative post-update Grow "Two projects slipped" --health at_risk
standupless initiative delete Grow            # its projects stay
standupless document list --project Launch      # or --initiative Grow
standupless document view DOC_ID [--web]
standupless document create "Launch plan" --project Launch [-b "Markdown" | -F plan.md]
standupless document edit DOC_ID [--title "New title"] [-F plan.md]
standupless document delete DOC_ID
standupless insights [-t ENG | --view VIEW_ID] [-g status|assignee|priority|label|project|cycle|estimate]
                     [--segment-by priority] [-m count|points] [--open] [-c current] [-a me]
standupless release list -t ENG
standupless release view 2026.10.07-1a2b3c4 -t ENG [--web]
standupless release create -t ENG --sha "$(git rev-parse HEAD)" --git-range v1.2.0..HEAD [--stage Staging]
standupless release create -t ENG --name 1.3.0 -i ENG-12 -i ENG-14
standupless release advance 1.3.0 Production -t ENG
standupless release pipeline -t ENG [--stage Staging=staging --stage Production=production]
standupless release pipeline -t ENG --status "Production=Done" --publish Production   # Stage= clears, --no-publish
standupless release backfill -t ENG [--repository owner/name] [--environment production] [--cursor CURSOR]
standupless standup -t ENG [-d 2026-10-06] [--weekly] [--web]
standupless standup note -t ENG "On ENG-12, blocked by the review" [-d 2026-10-07] [--clear]
standupless standup settings -t ENG [--cadence off|daily|weekly] [--send-time 09:00]
                                    [--timezone America/New_York] [--weekday monday]
```

A release records what shipped where. Recording a `--sha` that already has a release
advances that release, so a deploy script can call `release create` for every stage.
`--git-range` reads the commit messages in the range and adds every issue key they
mention.

Every command takes `--json` and prints the API's own JSON, for `jq` and scripts.
Names are matched without regard to case: teams by key prefix or name, statuses by
name or category (`backlog`, `unstarted`, `started`, `completed`, `cancelled`),
labels, projects, initiatives and cycles by name, people by `me`, email or display name.

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
