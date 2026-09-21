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
