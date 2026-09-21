# Naming

One vocabulary across the database, the API, the frontend and the docs. Where a
name appears in more than one layer it is spelled the same way in all of them.

## The two renames

Our first names were one step off Linear's, and our "project" meant what Linear
calls a team while colliding with Linear's own "project".

| Concept | Was | Is |
| --- | --- | --- |
| Isolation unit: owns the issue key prefix, statuses, labels, members, cycles and repo links | project | **team** |
| Dated container of work, spans teams, appears on the roadmap | milestone | **project** |

Cycles are unchanged. They belong to a team, as they do in Linear.

Because both renames touch the word "project", the order matters in any
mechanical pass: rename `project` to `team` first, then `milestone` to `project`.
Doing it the other way collapses the two concepts into one.

## What each layer spells

- **Tables:** `teams`, `team_config`. The `planning` table keeps its name and
  holds both kinds, discriminated by `kind` (`cycle`, `project`).
- **Keys and attributes:** `team_id`, `workspace_key_prefix` on the team row,
  `ws_team` on any index that partitions by team, `planning_key`.
- **Routes:** `/api/workspaces/{workspace_id}/teams/{team_id}/...`, and
  `/projects` for the dated containers.
- **Domain and image:** the `teams` domain, the `standupless-teams` image.
- **Frontend:** `/w/:slug/team/:key`, `/w/:slug/projects`. No vocabulary
  translation layer, because the API already says what the UI says.

## Scope keys

API key scopes follow the route nouns: a scope that named projects now names
teams, and the scope for the dated containers is the new `projects`.

## Existing data

A rename of this kind strands data in three ways, and only the first is obvious.

The replaced tables, `projects` and `project_config`, become `teams` and
`team_config`, so their rows are dropped by design rather than migrated.

The surviving tables keep every row they hold, and a row written under the old
vocabulary is stranded in either of two further ways. Its key **values** may carry
an old prefix, as `memberships` rows keyed `project#<id>#user#<id>` and `planning`
rows keyed `project#<wsid>#cycle#<id>` do, which the new code never matches because
it queries `team#`. Its **attribute names** may be the old nouns, `project_id`,
`milestone_id`, `ws_project` or `ws_project_status`, which is the worse case when
the attribute is a GSI key: the renamed index is defined on `ws_team`, and an item
lacking that attribute is not indexed at all, so the row is present, unreachable
and missing from the index meant to find it.

A stage holding real data therefore needs those rows rewritten or purged before the
new code reads them. A green test suite is not evidence that a stage is clean,
because tests write new rows in the new shape and never see the old one.
