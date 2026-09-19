# Standupless MVP technical design

Scope is fixed by `ISSUE-TRACKER-MVP.md`. Shape follows CarModPicker: `app/common/` plus `app/domains/<name>/`, one OCI image per domain selected by the `DOMAIN` build arg, routers registered once in `composition/domains.py`, tables declared as `TableSpec`s and exported to `terraform/dynamodb_tables.json`, GSIs auto-named `<hash>-<range>-index` by `gsi()`. Domain names kebab-case, packages snake_case, services `standupless-{domain}`. Terraform points straight at `app.domains.<x>.consumers.<y>_entrypoint`, skipping CarModPicker's `app/entrypoints/` shims, which exist there only for historical pinning.

## 1. Domain decomposition

Eight domain Lambdas plus four stream consumers that reuse their domain's image.

| Domain | Route prefixes | Notes |
|---|---|---|
| `identity` | `/api/auth`, `/api/users` | `build_identity_router` included with **no prefix**: it derives its own from the issuer path. Its one router of its own serves `GET /api/users/me`, the profile the frontend's auth shell loads. Gains the OAuth authorization-server router for MCP. |
| `workspaces` | `/api/workspaces`, `/api/memberships`, `/api/invites`, `/api/api-keys` | Tenant root, roles, invites, API key issue and revoke. |
| `projects` | `/api/projects`, `/api/project-members`, `/api/statuses`, `/api/labels`, `/api/webhooks` | Per-project config: key prefix, estimate scale, transition rules, outbound webhook registration. |
| `issues` | `/api/issues`, `/api/issue-links`, `/api/activity` | Issues, sub-issue parenting, links, key allocation, activity read. |
| `discussion` | `/api/comments`, `/api/reactions`, `/api/attachments` | Comments, reactions, URL and S3 attachments with presigned PUT. |
| `planning` | `/api/cycles`, `/api/milestones`, `/api/roadmap` | Time boxes, milestones, cross-project roadmap read. |
| `views` | `/api/views`, `/api/search`, `/api/inbox`, `/api/share-links`, `/api/shared` | Saved views, search, inbox, share-link mint and public read. |
| `integrations` | `/api/github`, `/api/mcp` | GitHub App webhooks and installs, MCP HTTP transport. |

Consumers (own entrypoints, parent domain's image):

| Consumer | Source | Effect |
|---|---|---|
| `issues-rollup-consumer` | `issues` stream | Sub-issue progress rollup, milestone and cycle counters. |
| `views-notify-consumer` | `issues` + `comments` streams | Inbox rows for assignment, mention, change. |
| `integrations-dispatch-consumer` | SQS `webhook-dispatch` | Outbound signed webhooks, GitHub write-back. |
| `views-search-consumer` | `issues` stream | Maintains the search projection table. |

Route classes:

- **Optional auth**: `GET /api/shared/{token}` and its issue and view reads, `/.well-known/jwks.json`, `/.well-known/openid-configuration`, `/health`, `/ready`. These carry `authorization_type = "NONE"`, so no claims arrive; the signed-in case resolves through the in-process `JwksVerifier` fallback, exactly as `identity_claims.verify_bearer_subject` does in CarModPicker.
- **Machine facing**: `POST /api/github/webhooks` (HMAC, no JWT), `POST /api/github/installs/callback`, `/api/mcp` (OAuth bearer), every route reachable with an API key, and the consumers' `/events` route, which is stream and queue only and 404s a gateway request.
- Everything else is `require_identity_jwt = true` on its route key, enumerated in terraform rather than swept up by a catch-all.

## 2. Tenancy and authorization

Workspace is the tenant. Every item's partition key begins with the workspace id, so a query cannot span workspaces by construction, not by filter.

Roles, workspace level: `owner`, `admin`, `member`, `guest`. Project level membership carries its own role, and a guest is visible only in projects it is explicitly a member of.

| Capability | owner | admin | member | guest |
|---|---|---|---|---|
| Delete workspace, transfer ownership | yes | no | no | no |
| Manage members, API keys, GitHub install | yes | yes | no | no |
| Create project | yes | yes | yes | no |
| Read or write issues | all projects | all projects | all projects | invited projects only |
| Project config, transition rules, webhooks | yes | yes | project admin only | no |

The dependency lives at `app/common/api/dependencies/authz.py` and is the only place any of this is decided. It fails closed at each step:

1. `workspace_id` comes from the path, never a body or header.
2. Claims come from `webbpulse.identity.claims.identity_claims`, which reads the native JWT authorizer and the staging access gate alike; `None` is a 401, never a fallthrough to anonymous. Read through `AuthorizerClaims`, never `.raw`, since every authorizer claim arrives as a string.
3. The membership item `ws#<workspace_id>` / `user#<user_id>` is read. Absent is 404 on the workspace, not 403, so a non-member cannot probe for existence.
4. On a project-scoped route the project membership is read when the workspace role is `guest`; a missing row is 404.
5. The route declares the capability it needs; the dependency returns an `AuthzContext` carrying `workspace_id`, `user_id`, `role`, a guest's `project_ids`, and the actor kind.

API keys and MCP map onto the same `AuthzContext`, not a parallel path. An API key is stored by SHA-256 hash; presenting it resolves to a synthetic claims object with `sub` set to the key's user plus a workspace claim and a `scope` string, which `coerce_claims` already splits into a `scopes` list. A key is never broader than its minter: the effective role is the intersection of the key's scopes with that user's live membership, re-read per request, so revoking the member revokes the key. MCP issues ordinary identity access tokens carrying the same `scope`, read by the same dependency.

Invariants a reviewer should check:

- No repository method takes a bare entity id. Every signature starts with `workspace_id`.
- No `scan` anywhere outside an admin path.
- Every GSI's hash key is a workspace-scoped composite, never a bare `issue_id` or `user_id`.
- `RepositoryBundle` for each domain excludes every table the domain does not own for write.
- Guest reads go through the project membership check; a test asserts a guest 404s on a project it is not in.
- Share-link reads never widen: the public path resolves the token to exactly one issue or one saved view and reads with a service-role context carrying no user.
- The route-contract fixture and the per-domain route counts are regenerated with every route change, so the diff on that fixture is the review artifact for "did a route just become public".

## 3. DynamoDB table design

Named attribute keys per CarModPicker, not generic `PK`/`SK`. Similar entities share one table, distinguished by a sort-key prefix.

| Table | PK | SK | GSIs | TTL / stream |
|---|---|---|---|---|
| `workspaces` | `id` | none | `slug-index` | none |
| `memberships` | `workspace_id` | `member_key` (`user#<id>` or `project#<pid>#user#<uid>`) | `user_id-workspace_id-index` for "my workspaces" | none |
| `invites` | `workspace_id` | `invite_id` | `token_hash-index` | TTL `expires_at` |
| `projects` | `workspace_id` | `project_id` | `workspace_key_prefix-index` for prefix uniqueness | none |
| `project_config` | `workspace_id` | `config_key` (`project#<pid>#status#<sid>`, `#label#<lid>`, `#transition#<n>`) | none | none |
| `counters` | `workspace_id` | `counter_key` (`project#<pid>#issue`) | none | none |
| `issues` | `workspace_id` | `issue_id` | `ws_project-status_updated-index`, `ws_project-key_number-index`, `ws_assignee-updated_at-index`, `ws_project-cycle_id-index`, `ws_project-milestone_id-index`, `ws_parent-created_at-index` | stream `NEW_AND_OLD_IMAGES` |
| `relations` | `workspace_id` | `relation_key` (`issue#<id>#blocks#<other>`) | `ws_target-relation_type-index` for the inverse | none |
| `comments` | `ws_issue` (`<ws>#<issue_id>`) | `comment_id` (ULID) | `ws_author-created_at-index` | stream |
| `reactions` | `ws_target` (`<ws>#<target_id>`) | `reaction_key` (`<emoji>#<user_id>`) | none | none |
| `attachments` | `ws_issue` | `attachment_id` | none | none |
| `activity` | `ws_issue` | `activity_id` (ULID, descending reads) | `ws_project-created_at-index` for a project feed | none |
| `planning` | `workspace_id` | `planning_key` (`project#<pid>#cycle#<cid>`, `#milestone#<mid>`) | `ws_project-target_date-index` for the roadmap | none |
| `views` | `workspace_id` | `view_key` (`user#<uid>#view#<vid>` or `project#<pid>#view#<vid>`) | none | none |
| `inbox` | `ws_user` (`<ws>#<user_id>`) | `notification_id` (ULID) | `ws_user-unread-index` sparse, set only while unread | TTL `expires_at` at 90 days |
| `api_keys` | `workspace_id` | `key_id` | `key_hash-index` | TTL on expiring keys |
| `github` | `workspace_id` | `github_key` (`install#<iid>`, `repo#<rid>`, `link#<pr_node_id>`) | `installation_id-index`, `ws_issue-link-index` | none |
| `webhooks` | `workspace_id` | `webhook_key` (`project#<pid>#hook#<hid>`) | none | none |
| `share_links` | `token_hash` | none | `ws_target-index` for revoke-by-target | TTL `expires_at` |
| `search_index` | `ws_project` | `term_doc` (`<term>#<issue_id>`) | none | stream-maintained |
| `idempotency` | `scope_key` | none | none | TTL, 24h |
| `rate-limits` | per `webbpulse.ratelimit` | per `webbpulse.ratelimit` | none | TTL |

**Issue keys.** `counters` holds one item per project. Allocation is a single `update` with `ADD next_number :one` and `return_values="UPDATED_NEW"`: atomic, no transaction. A crash between allocation and the issue write leaves a gap; gaps are accepted and nothing ever renumbers to close one. The human key `ABC-123` is denormalised onto the issue and indexed by `ws_project-key_number-index`.

**Access patterns per index.** `ws_project-status_updated-index` serves the board column and the list view by recency. `ws_assignee-updated_at-index` serves "my issues" across projects. `ws_parent-created_at-index` serves sub-issue listing and the rollup consumer. `ws_target-relation_type-index` serves "what blocks this" without a second write path. `ws_user-unread-index` is sparse, so the inbox badge counts a short index rather than filtering a scan.

**Hot partition and size risks.**

- A busy project's board would concentrate on one `ws_project` partition. The composite hash is `<ws>#<project_id>#<status_id>`, spreading across statuses while keeping a column query one partition read.
- `activity` on a long-lived issue grows without bound. The partition is per issue rather than per project, and the MVP exposes only the newest page, no full-history endpoint.
- `search_index` is the real risk: a common term in a large project is one hot partition. The MVP indexes key, title and a truncated body, skips terms of three characters or fewer, and caps postings per term per project. Anything beyond that is a post-MVP OpenSearch decision, not a bigger table.
- Markdown bodies cap at 64 KB and attachments live in S3, so no item nears the 400 KB limit.
- `share_links` partitions by token hash, uniform by construction.

## 4. GitHub App flow

One GitHub App per environment. Install is per workspace on chosen repos.

1. **Install.** An admin hits `GET /api/github/install-url`, returning the App's install URL with a signed, expiring `state` bound to the workspace. The callback verifies `state`, exchanges the installation, and writes `install#<iid>` plus one `repo#<rid>` row per repository. `installation_id-index` maps an inbound webhook back to its workspace.
2. **Webhook receipt.** `POST /api/github/webhooks` is `authorization_type = "NONE"`, authenticated only by `X-Hub-Signature-256` verified with `hmac.compare_digest` before the body is parsed. An unverified body is never logged.
3. **Idempotency.** `X-GitHub-Delivery` is written to `idempotency` conditional on absence; a duplicate short-circuits to 200. The handler replies 202 once the row lands and enqueues to SQS. Nothing calling the GitHub API happens in the request.
4. **Key extraction.** Keys match case-insensitively against the project's own prefix from `projects`, never a global regex, over branch name, PR title, PR body and commit messages. A key naming a project the installation is not linked to is dropped.
5. **Magic words.** `Fixes`, `Closes`, `Resolves` plus a key, in the PR title or body only, not commit messages, so a rebase cannot reclose an issue.
6. **Transitions.** Per-project rules in `project_config`. Default: PR opened to In Progress, merged to Done, merged with a magic word closes. A transition never overrides a manual status change made after the PR event, which the consumer checks by comparing `updated_at`.
7. **Write-back.** The dispatch consumer posts the PR comment listing linked issues and sets a check run. Both async, both retried through the queue, both skipped when the link already carries that state.

Everything after signature verification runs async: link records, transitions, activity rows, PR comments, and check runs.

## 5. MCP server

A remote HTTP MCP server at `/api/mcp` on `integrations`, authorized by the identity package rather than beside it.

The identity package is an OAuth *client* today, with PKCE helpers for Google and GitHub, and its discovery document carries no `authorization_endpoint` or `token_endpoint`. MCP needs the server side, so `identity` gains an authorization-server router publishing `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`, with `/authorize`, `/token` and `/register`. Authorization code plus PKCE S256 only, no implicit grant, no client secret for a public client. Dynamic client registration is open to public PKCE clients under a short-lived registration token, which lets a fresh Claude or editor client connect without pre-registration; a pre-registered client stays available for first-party use. Tokens are the same RS256 access tokens the rest of the product verifies, carrying granted scopes in `scope`, read by the same fail-closed dependency.

Scopes: `issues:read`, `issues:write`, `comments:write`, `projects:read`, `views:read`. Consent names the workspace, and a token is bound to exactly one workspace.

MVP tools: `search_issues`, `get_issue`, `create_issue`, `update_issue`, `add_comment`, `list_projects`, `list_statuses`, `assign_issue`. Deliberately no delete tool and no workspace administration.

## 6. Platform gaps to fill upstream

Verified against `webbpulse` 0.40.2. The package is consume-only for events, an OAuth *client* not an authorization server, and has no API key or webhook surface at all.

| Gap | Proposed surface |
|---|---|
| OAuth authorization server for MCP | `webbpulse.identity.oauth_server.register_authorization_server(router, settings, store)` adding `/authorize`, `/token`, `/register` and the `authorization_endpoint` and `token_endpoint` the current discovery document omits. |
| API keys as a first-class credential | `webbpulse.identity.api_keys`: `mint`, `verify`, `revoke`, an `ApiKeyStore` protocol, and an adapter producing the same `AuthorizerClaims`. |
| Scope-aware authorization dependency | `webbpulse.identity.scopes.require_scopes("issues:write")`, reading the `scopes` list `coerce_claims` already splits out of `scope`. |
| Inbound webhook signature verification | `webbpulse.http.verify_hmac_signature(body, header, secret, algorithm)`, constant-time, with a GitHub `sha256=` variant. |
| Outbound signed webhook dispatch | `webbpulse.events.webhooks`: signed envelope, timestamped signature, retry and dead-letter policy. |
| Event emission | `webbpulse.events.enqueue(queue_url, payload, group_id=None)` plus an event envelope type; the module is consume-only today. |
| Idempotency keys | `webbpulse.dynamodb.IdempotencyStore.claim(key, ttl)` returning whether this caller won. |
| Atomic counter helper | `webbpulse.dynamodb.Repository.increment(key, attribute, by=1)` returning the new value, so key allocation is one call. |
| Stream image deserialization | `webbpulse.events.deserialize_image(record, "NewImage")`; records are raw `Mapping`s today and every consumer hand-rolls the unmarshalling. |
| HTTP pagination model | `webbpulse.http.CursorPage` plus cursor encode and decode; `dynamodb.Page` is data-layer only. |
| ULID ids | `webbpulse.dynamodb.new_ulid()` for time-sortable sort keys. |
| Presigned upload helper | `webbpulse.storage.presigned_put(bucket, key, content_type, max_bytes)` with the content-length guard. |
| Markdown mention parsing | `webbpulse.messages.extract_mentions(markdown)` shared by comments and notifications. |
| `UnprocessedItems` HTTP mapping | Add it to the DynamoDB error handlers; it renders as an opaque 500 today. |
| SQS event source in terraform | `platform-modules` `lambda-function` gains an SQS event source mapping block with batch window and partial-batch response. |
| Frontend polling client | `@webbpulse/api-client` gains `usePolledQuery` with refetch-on-focus and backoff, so no product hand-rolls the freshness loop. |
| MCP client helpers | `@webbpulse/auth` gains the OAuth PKCE browser flow against the new authorization server. |
| Org workflow for OpenAPI publish | `.github` gains `openapi-publish.yml@v1` to emit and publish the spec on deploy. |

## 7. Build order

| Milestone | Contents | Proves |
|---|---|---|
| M0 | Repo, accounts, terraform baseline, ECR, identity Lambda, CI and deploy workflows | The platform shape reproduces for a second product with no per-product terraform invention |
| M1 | `workspaces`, `projects`, membership, roles, authz dependency, invariant tests | Tenancy fails closed before any content exists to leak |
| M2 | `issues`: key counters, statuses, labels, sub-issues, links, rollup consumer | Atomic gap-tolerant keys and the first cross-domain async effect |
| M3 | `discussion` and `views`: comments, reactions, attachments, board, saved views, search, inbox | Usable by a human end to end |
| M4 | `planning`: cycles, milestones, roadmap | Rollups without a second write path into issues |
| M5 | `integrations`: GitHub App, webhooks, transitions, write-back, outbound webhooks | Machine-facing auth and idempotency hold under replay |
| M6 | API keys, OAuth authorization server, MCP, published OpenAPI, share links | Three credential kinds resolve to one authorization context |

## Judgement calls for the owner

1. Eight domains against the 6 to 9 target: `discussion` could fold into `issues`, which trades a Lambda for a larger blast radius on the busiest table.
2. Search as a stream-maintained DynamoDB projection versus accepting OpenSearch cost now. The projection is cheap and will not do relevance ranking.
3. Dynamic client registration open for public PKCE clients versus a pre-registered client only. Open is what makes MCP connect without owner involvement, and it is a registration endpoint exposed to the internet.
4. Guests as a workspace role with project grants, versus project-only principals with no workspace row. The second is stricter and a larger change to every read.
5. Whether `activity` keeps full history with no retention, given it grows fastest and has no MVP reader beyond the newest page.
6. Whether API key scopes may exceed the minting user's role at issue time, or always intersect live as designed here.
7. `webbpulse.ratelimit` fails open by design. API key and MCP traffic is the case where a quota arguably must deny on failure, which would mean a limiter the platform does not have.
