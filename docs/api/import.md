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
`labels_created`, `problem_count` and, when it failed, `error`.

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

## Paging, retries and the bulk guard

The job writes 100 rows per page and moves a cursor after each one. Each row's
issue id is derived from the import id and the row number, so a page that runs
twice finds the issues it already wrote and writes nothing new. A message for a
page the cursor has passed is dropped. A page that fails is retried by the
queue, and after 3 attempts the job is marked failed.

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
