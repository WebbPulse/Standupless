# Workspace export

A workspace owner or admin can export the whole workspace as one zip. The
export runs as an async job on the server, the bundle is written to S3, and the
requester gets an inbox notice and an expiring download link when it is ready.
The export is deterministic: it reads stored rows and writes them out, with no
model calls.

## Starting and fetching an export

| Surface | How |
| --- | --- |
| API | `POST /api/workspaces/{workspace_id}/exports`, `GET /api/workspaces/{workspace_id}/exports`, `GET /api/workspaces/{workspace_id}/exports/{export_id}` |
| MCP | `export_workspace`, `list_workspace_exports`, `get_workspace_export` |
| CLI | `standupless workspace export [--mask-emails] [--no-wait] [--id EXPORT_ID] [-o PATH]` |
| UI | Workspace settings, Export tab |

Every route needs the workspace admin capability. Anyone else gets 403.

- `POST` takes `{"include_emails": true}` and answers 202 with the job. Pass
  `false` to mask member emails. A second export while one is queued or running
  answers 409. An environment with no export bucket or queue answers 503.
- `GET .../exports` lists recent jobs, newest first, with no download links.
- `GET .../exports/{export_id}` returns one job. Once the job is `ready`, it
  carries a fresh `download_url` that is valid for 15 minutes. Fetch the job
  again for a new link.

Job statuses are `queued`, `running`, `ready` and `failed`. A ready job carries
`size_bytes`, a `counts` map with the rows per file, and `expires_at`. The
bundle is kept for 7 days.

When the job finishes, the requester gets an inbox notice of kind
`export_ready` or `export_failed`. The notice's `issue_key` field holds the
export id.

## Bundle format

`format_version` is `1`. The version goes up with any change a reader would
need to know about. Adding a field to a row does not count as such a change, so
readers should ignore fields they do not know.

The zip contains `manifest.json` plus one NDJSON file per entity. Each line of
an NDJSON file is one JSON object. Timestamps are ISO 8601 in UTC. Rows within
a file come out in a fixed order: teams in workspace order, issues by number
within each team.

### manifest.json

| Field | Meaning |
| --- | --- |
| `format_version` | The bundle format version, currently `1` |
| `export_id` | The job's id |
| `exported_at` | When the bundle was written |
| `requested_by` | The user id of the requester |
| `emails_masked` | Whether member emails are masked |
| `attachment_links_expire_at` | When the attachment file links in `attachments.ndjson` stop working |
| `workspace` | `{id, name, slug}` |
| `files` | `[{name, rows}]`, one entry per NDJSON file, in the order below |

### Entity files

| File | Rows |
| --- | --- |
| `teams.ndjson` | Every team the requester can find. A private team the requester is not in has `content_included: false`, and none of its content appears in the other files. |
| `members.ndjson` | Workspace members: `user_id`, `role`, `joined_at`, `display_name`, `email` |
| `team_members.ndjson` | Team memberships: `team_id`, `user_id`, `role`, `joined_at` |
| `statuses.ndjson` | Workspace statuses, then each team's own statuses |
| `labels.ndjson` | Workspace labels, then each team's own labels |
| `issues.ndjson` | Every issue. Sub-issues carry `parent_id`. |
| `relations.ndjson` | Issue relations such as blocks and related, one row per link |
| `comments.ndjson` | Every comment on every issue |
| `attachments.ndjson` | Attachment metadata. Files are listed, not inlined. |
| `projects.ndjson` | Projects that include at least one included team |
| `milestones.ndjson` | Milestones of those projects |
| `project_updates.ndjson` | Updates posted on those projects |
| `cycles.ndjson` | Cycles of each included team |
| `views.ndjson` | Team views, plus the requester's personal views |
| `releases.ndjson` | Releases of each included team |
| `documents.ndjson` | Documents of the included projects and of every initiative, each with its Markdown `body`. A guest requester gets no initiative documents. |

### Attachments

An attachment row is the stored attachment without its storage key. An
uploaded file adds three fields:

- `download_url`: a presigned link to the file, valid until
  `attachment_links_expire_at`, about 6 hours after the export finishes.
- `download_url_expires_at`: the same expiry, on the row.
- `download_path`: the API path that mints a new link for a signed-in member
  after the bundle's links expire.

A link attachment has no file and keeps its `url`.

### Email masking

An owner or admin gets real member emails unless they ask for masking. A masked
email keeps its first character and its domain, such as `t***@example.com`.
`manifest.json` records which kind of bundle it is in `emails_masked`.

## Storage and infrastructure

The job and its bundle live in the attachments bucket under
`exports/{workspace_id}/{export_id}/`, as `job.json` and `bundle.zip`. A
lifecycle rule on `exports/` deletes both after 7 days. The API queues the job
on the workspace export SQS queue, and the `workspaces-export-consumer` function
builds it. In local development, where no queue exists, the export builds
inline.
