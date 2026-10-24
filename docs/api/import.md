# Issue import from CSV

A workspace owner or admin can import issues into one team from a CSV file.
Presets map exports from Jira and Linear without any setup, and the generic
preset maps any file that uses common column names. A dry run shows what every
row would become before anything is written. The import itself runs as an async
job a page at a time. Parsing and mapping are deterministic, with no model calls.

## Surfaces

| Surface | How |
| --- | --- |
| API | `POST /api/workspaces/{workspace_id}/imports/preview`, `POST /api/workspaces/{workspace_id}/imports`, `GET /api/workspaces/{workspace_id}/imports`, `GET /api/workspaces/{workspace_id}/imports/{import_id}` |
| UI | Workspace settings, Import tab |

Every route needs the workspace admin capability. Anyone else gets 403. The
caller must also be able to write in the target team, so a private team the
admin is not in answers 404.

Both `POST` routes take the same body:

```json
{
  "team_id": "01J...",
  "preset": "jira",
  "csv": "Summary,Issue key,Status\nFix login,PROJ-1,In Progress\n",
  "file_name": "jira.csv",
  "mapping": {"estimate": "Story Points", "due_date": null}
}
```

- `preset` is `generic`, `jira` or `linear`.
- `csv` is the whole file as text, header row first, at most 4 MB and 5000 data
  rows.
- `mapping` is optional. It overrides the preset's mapping per field. A value is
  a header name from the file, and `null` unmaps the field.

A file that cannot be imported answers 422 from either route. That covers an
empty file, no header row, too many rows, a mapping that names a missing column
or an unknown field, and no column mapped to the title.

### Dry run

`POST .../imports/preview` reads the whole file against the team and writes
nothing. It answers:

| Field | Meaning |
| --- | --- |
| `headers` | The file's column names, in order |
| `mapping` | The mapping used, field to header or `null` |
| `total_rows`, `importable_rows` | Data rows, and how many would become issues |
| `problems` | Up to 200 row problems: `{row, field, severity, message}` |
| `problems_truncated` | Whether there were more than 200 |
| `rows` | The first 10 rows as the issues they would become |
| `new_labels` | Label names the import would create on the team |
| `statuses` | `{source, status_name, count}` for each source status and where it lands |
| `parent_links` | How many rows would become sub-issues of another row |

Each entry in `rows` also carries `parent_row`, the row it would become a
sub-issue of, or `null`.

`row` is the spreadsheet row number, counting the header as row 1. An `error`
skips the row. A `warning` drops or replaces one value and the row still
imports.

### Starting and fetching an import

- `POST .../imports` answers 202 with the job. A second import while one is
  queued or running in the workspace answers 409. A job that has not moved for
  15 minutes no longer blocks a new one. An environment with no bucket, or a
  deployed environment with no queue, answers 503.
- `GET .../imports` lists recent jobs, newest first, without their problems.
- `GET .../imports/{import_id}` returns one job with up to 500 row problems.

Job statuses are `queued`, `running`, `completed` and `failed`. A job carries
`total_rows`, `processed_rows`, `created_count`, `skipped_count`,
`labels_created`, `linked_count`, `problem_count` and, when it failed, `error`.

When the job finishes, the requester gets one inbox notice of kind
`import_ready` or `import_failed`. The notice's `issue_key` field holds the
import id.

## Fields and presets

| Field | Generic headers | Jira | Linear |
| --- | --- | --- | --- |
| `title` | Title, Summary, Name | Summary | Title |
| `description` | Description, Body, Details | Description | Description |
| `status` | Status, State | Status | Status |
| `priority` | Priority | Priority | Priority |
| `assignee` | Assignee Email, Assignee, Owner | Assignee | Assignee |
| `labels` | Labels, Label, Tags | Labels | Labels |
| `estimate` | Estimate, Points, Story Points | Custom field (Story Points) | Estimate |
| `due_date` | Due Date, Due | Due date | Due Date |
| `source_key` | ID, Key, Issue Key, Identifier | Issue key | ID |
| `created_at` | Created, Created At | Created | Created |
| `parent` | Parent, Parent Key, Parent Issue, Parent ID | Parent, Parent id | Parent issue |

Headers match without case. A preset falls back to the generic names for any
field its own names miss. A field mapped to a header that appears more than
once, such as Jira's repeated `Labels` columns, reads every column of that name.

## How values map

- **Keys.** Every imported issue gets a new key in the target team. The source
  key is kept in the issue's `external_ref`.
- **Status.** Matched to a team status by name, without case. Failing that, a
  common workflow name such as `To Do`, `In Review`, `Resolved` or `Won't Do`
  maps to the first team status of its category. Anything else lands in the
  team's default status with a warning.
- **Priority.** Jira words (`Highest` to `Lowest`, `Blocker`, `Critical`),
  Linear's numbers 0 to 4, and `P0` to `P4` map to the five priorities. An
  unknown word is `none` with a warning.
- **Assignee.** Matched to a workspace member by email, then by display name
  when exactly one member has it. A member who cannot be assigned in the team,
  or no match, leaves the issue unassigned with a warning.
- **Labels.** Split on commas. A name the team lacks is created on the team.
- **Estimate.** Must be on the team's estimate scale, or it is dropped with a
  warning. `3.0` reads as `3`.
- **Dates.** ISO 8601, Jira's `12/Oct/26 3:45 PM`, US `MM/DD/YYYY` and
  JavaScript date strings are read, in UTC. A created date in the future is
  capped at the import time.
- **Description.** Cut to the issue body limit with a warning when longer.
- **Parent.** Names another row of the same file by its source key, by a
  tracker id column such as Jira's `Issue id`, or by its title when exactly one
  row has it. Keys and titles match without case, and the order of rows does
  not matter. Sub-issues are one level deep, so a row whose parent is itself a
  sub-issue in the file, a loop, or a row naming itself is left without a
  parent. A parent that is missing from the file, ambiguous or skipped is a
  warning on the child, which still imports at the top level.

## Paging, retries and the bulk guard

The job writes 100 rows per page and moves a cursor after each one. Each row's
issue id is derived from the import id and the row number, so a page that runs
twice finds the issues it already wrote and writes nothing new. A message for a
page the cursor has passed is dropped. A page that fails is retried by the
queue, and after 3 attempts the job is marked failed.

When a parent column is mapped, a link pass follows the last write page. Its
cursor carries on past the last row and walks the rows again, 100 per page,
so `processed_rows` reads `total_rows` while it runs. The link write only lands
on an issue of this import that still carries the bulk marker and has no parent,
so a link page that runs twice links nothing twice, and an issue someone edited
in between is left alone with a warning. The link keeps the marker, so it sends
no notifications either, while the parent's progress still counts the child.

Every imported issue carries `import_batch_id`. The notify consumer, the GitHub
issue sync and the outbound webhook fan-out skip rows that carry it, so an
import of thousands of issues sends no per-issue notifications, syncs and
webhook deliveries. Only the assignee is subscribed. The first edit of an
imported issue clears the marker, and from then on it behaves like any other
issue.

## Storage and infrastructure

The job and its source file live in the attachments bucket under
`imports/{workspace_id}/{import_id}/`, as `job.json` and `source.csv`. A
lifecycle rule on `imports/` deletes both after 7 days. The API queues pages on
the issue import SQS queue, and the `integrations-import-consumer` function
runs them. The queue and consumer exist when the `issue_import_enabled`
Terraform variable is true. In local development, where no queue exists, the
import runs inline.

## Import from Linear's API

A workspace owner or admin can also import straight from a Linear workspace,
with no export file. They paste a Linear personal API key with read access,
pick the Linear teams to bring over and map each one to a new or existing
Standupless team. The UI creates a new team before it starts the import.

| Surface | How |
| --- | --- |
| API | `POST /api/workspaces/{workspace_id}/imports/linear/teams`, `POST /api/workspaces/{workspace_id}/imports/linear`, `POST /api/workspaces/{workspace_id}/imports/{import_id}/cancel`, and the `GET` routes above |
| MCP | `list_linear_teams`, `import_linear_workspace`, `get_workspace_import`, `cancel_workspace_import` |
| UI | Workspace settings, Import tab, source Linear |

`POST .../imports/linear/teams` takes `{"api_key": "..."}` and answers the
teams the key can read. A key Linear refuses answers 400 with code
`LINEAR_KEY_REFUSED`, and Linear not answering is 502. `POST .../imports/linear`
takes the key and `teams`, a list of `{"linear_team_id", "team_id"}`, and
answers 202 with the job, which has `kind` `linear`. A Linear team the key
cannot read, or one chosen twice, answers 422, and a second import while one
runs answers 409. Cancel stops a queued or running job and answers a finished
one as it is.

### What is read

Per mapped team, in order: cycles, projects with their milestones and updates,
issues with their comments, then a second pass over the issues for sub-issue
links and relations. Initiatives and then project dependencies come last, once
for the workspace. Every
connection is paged 50 at a time. Linear's rate limit, a 429 or a `RATELIMITED`
error, is waited out until the reset time it gives, at most 60 seconds per wait
and 5 attempts per request. The job's `phase`, `phase_index` and `phase_count`
say where it is, and `counts` holds the tallies the summary shows.

### How values map

- Workflow states map to the team status with the same name, else the first
  status in the category of the state's type, else the team default.
- Priority 1 to 4 is urgent, high, medium and low. Estimates keep their points,
  or the matching size on a t-shirt team; a value off the team's scale is left
  empty with a warning.
- Labels are created in the team when missing, and a Linear label group
  becomes a label group.
- Assignee, creator, project lead and initiative owner are matched to members
  by email. A comment or project update by someone who is not a member keeps a
  `linear:<name>` placeholder author. No account or invite is created.
- Relations `blocks`, `related` and `duplicate` become blocks, relates to and
  duplicate of. Linear's `similar` has no counterpart and is skipped. Attachment
  links are added to the end of the description; only http and https links are
  kept.
- An unnamed Linear cycle is named after its number, such as `Cycle 7`.
- A Linear project dependency becomes a blocks link between the two imported
  projects: the project whose start waits on the other's end is the blocked
  one. A dependency on a project that was not imported is skipped, and one that
  would make projects wait on each other is left out with a warning.

Every row gets an id derived from the workspace and the Linear id, and each
issue keeps its Linear identifier and URL in `external_ref`, so running the
import again updates what the earlier run wrote instead of duplicating it.

### The key

The key is sealed with the environment master key, bound to the workspace and
the import, and stored beside the job as `key.json`. It is opened in memory for
each step and deleted when the job completes, fails or is cancelled. It never
appears in the job, an answer, a log, an audit event or imported data. A key
left behind by a lost job goes with the 7 day lifecycle rule on `imports/`.


## Import from GitHub Issues

A workspace owner or admin can import one repository's Issues through the
workspace's installed GitHub App, with no key. They pick a repository the
installation covers and the team its issues go into.

| Surface | How |
| --- | --- |
| API | `GET /api/workspaces/{workspace_id}/imports/github/repositories`, `POST /api/workspaces/{workspace_id}/imports/github`, `POST /api/workspaces/{workspace_id}/imports/{import_id}/cancel`, and the `GET` routes above |
| MCP | `list_github_import_repositories`, `import_github_issues`, `get_workspace_import`, `cancel_workspace_import` |

`POST .../imports/github` takes `{"repository_id", "team_id"}` and answers 202
with the job, which has `kind` `github`. A repository the installation does not
cover, or an App that is suspended or not installed, answers 422, and a second
import while one runs answers 409. Pull requests are skipped, and running the
import again updates what an earlier run wrote. How each field maps is in the
`app/domains/integrations/github_import.py` docstring.
