/**
 * Shapes the Standupless API returns, hand written against `docs/api/m1.md`
 * until a generated client exists. Every list body is an object with one plural
 * key, never a bare array.
 */

/** The signed in user, as the identity service reports it. */
export interface UserRead {
  id: string;
  email: string;
  display_name: string | null;
  email_verified: boolean;
}

/** A role held at the workspace level. */
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest';

/** A role held on one team. */
export type TeamRole = 'admin' | 'member';

/** A role an invite may carry. The contract never issues an owner invite. */
export type InviteRole = Exclude<WorkspaceRole, 'owner'>;

/** How a team sizes its issues. */
export type EstimateScale = 'off' | 'fibonacci' | 'linear' | 'tshirt';

/** The workflow bucket a status belongs to. */
export type StatusCategory =
  'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';

/** One workspace the signed in user belongs to. */
export interface WorkspaceRead {
  id: string;
  name: string;
  slug: string;
  plan: string;
  created_at: string;
  /** The caller's role. Present only on a response to a member. */
  role?: WorkspaceRole;
}

/** The body `GET /api/workspaces` answers with. */
export interface WorkspaceListRead {
  workspaces: WorkspaceRead[];
}

/** A new workspace submission. */
export interface WorkspaceCreate {
  name: string;
  slug: string;
}

/** The editable fields on a workspace. */
export interface WorkspaceUpdate {
  name?: string;
}

/** One member of a workspace. */
export interface MemberRead {
  user_id: string;
  email: string;
  display_name: string | null;
  role: WorkspaceRole;
  joined_at: string;
}

/** The body the workspace members route answers with. */
export interface MemberListRead {
  members: MemberRead[];
}

/** A role change on one workspace member. */
export interface MemberUpdate {
  role: WorkspaceRole;
}

/** One outstanding invite to a workspace. */
export interface InviteRead {
  invite_id: string;
  email: string;
  role: InviteRole;
  invited_by: string;
  expires_at: string;
  created_at: string;
}

/** The body the invites list route answers with. */
export interface InviteListRead {
  invites: InviteRead[];
}

/** A new invite submission. The contract refuses `owner`. */
export interface InviteCreate {
  email: string;
  role: InviteRole;
}

/**
 * The create-invite response. The token is returned once, on creation only, so
 * it is carried apart from the fields the list route repeats.
 */
export interface InviteCreatedRead extends InviteRead {
  token: string;
}

/** One team inside a workspace. */
export interface TeamRead {
  id: string;
  workspace_id: string;
  name: string;
  key_prefix: string;
  description: string | null;
  estimate_scale: EstimateScale;
  created_at: string;
  updated_at: string;
  /** The caller's team role, implied from the workspace role when broader. */
  role?: TeamRole;
  /** How many people hold an explicit membership of this team. */
  member_count?: number;
  /** Whether the caller holds an explicit membership of this team. */
  is_member?: boolean;
  /** Prefixes this team used before, which still resolve issue keys. */
  retired_key_prefixes?: string[];
}

/** The body the teams list route answers with. */
export interface TeamListRead {
  teams: TeamRead[];
}

/** A new team submission. */
export interface TeamCreate {
  name: string;
  key_prefix: string;
  description?: string | null;
  estimate_scale?: EstimateScale;
}

/** The editable fields on a team. */
export interface TeamUpdate {
  name?: string;
  /** A new key. The old one is retired and keeps resolving issue keys. */
  key_prefix?: string;
  estimate_scale?: EstimateScale;
  description?: string | null;
}

/** One member of a team. */
export interface TeamMemberRead {
  user_id: string;
  email: string;
  display_name: string | null;
  role: TeamRole;
  added_at: string;
}

/** The body the team members route answers with. */
export interface TeamMemberListRead {
  members: TeamMemberRead[];
}

/** A role grant on one team member. */
export interface TeamMemberUpdate {
  role: TeamRole;
}

/** One workflow status on a team. */
export interface StatusRead {
  id: string;
  name: string;
  category: StatusCategory;
  position: number;
}

/** The body the statuses route answers with, ordered by position. */
export interface StatusListRead {
  statuses: StatusRead[];
}

/** A new status submission. */
export interface StatusCreate {
  name: string;
  category: StatusCategory;
  position?: number;
}

/** The editable fields on a status. */
export interface StatusUpdate {
  name?: string;
  category?: StatusCategory;
  position?: number;
}

/** One label on a team. */
export interface LabelRead {
  id: string;
  name: string;
  color: string;
}

/** The body the labels route answers with. */
export interface LabelListRead {
  labels: LabelRead[];
}

/** A new label submission. */
export interface LabelCreate {
  name: string;
  color: string;
}

/** The editable fields on a label. */
export interface LabelUpdate {
  name?: string;
  color?: string;
}

/** The body `POST /api/invites/accept` takes. */
export interface InviteAccept {
  token: string;
}

/** How urgent an issue is. The contract fixes these five and defaults to none. */
export type IssuePriority = 'none' | 'urgent' | 'high' | 'medium' | 'low';

/** The sort orders the issue list route accepts. */
export type IssueSort =
  'updated_desc' | 'created_desc' | 'key_asc' | 'priority_desc' | 'due_asc';

/** The kinds of link a pair of issues may hold. */
export type LinkType = 'blocks' | 'blocked_by' | 'relates_to' | 'duplicate_of';

/**
 * The link types a read can return. The contract enumerates `type` as the four
 * writable values, but also says `duplicate_of` on A is `duplicated_by` on B,
 * so a read of B returns a fifth value the enumeration leaves out.
 */
export type LinkTypeRead = LinkType | 'duplicated_by';

/** Who performed an activity entry. */
export type ActorKind = 'user' | 'system' | 'github';

/** What an activity entry records. */
export type ActivityKind =
  | 'created'
  | 'field_changed'
  | 'link_added'
  | 'link_removed'
  | 'child_added'
  | 'child_removed';

/**
 * Direct sub-issue counts, maintained by the rollup consumer rather than the
 * request handler, so it can lag a write by a moment.
 */
export interface IssueProgress {
  total: number;
  completed: number;
}

/** One issue. Workspace scoped, so links and "my issues" can cross teams. */
export interface IssueRead {
  id: string;
  workspace_id: string;
  team_id: string;
  key: string;
  number: number;
  title: string;
  body: string | null;
  status_id: string;
  priority: IssuePriority;
  assignee_id: string | null;
  label_ids: string[];
  estimate: string | null;
  start_date: string | null;
  due_date: string | null;
  parent_id: string | null;
  cycle_id: string | null;
  project_id: string | null;
  progress: IssueProgress;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** The body the issue list and children routes answer with. */
export interface IssueListRead {
  issues: IssueRead[];
  next_cursor: string | null;
}

/** A new issue submission. The key is allocated by the server. */
export interface IssueCreate {
  team_id: string;
  title: string;
  body?: string | null;
  status_id?: string;
  priority?: IssuePriority;
  assignee_id?: string | null;
  label_ids?: string[];
  estimate?: string | null;
  start_date?: string | null;
  due_date?: string | null;
  parent_id?: string | null;
  cycle_id?: string | null;
  project_id?: string | null;
}

/** The editable fields on an issue. The contract never moves one team. */
export interface IssueUpdate {
  title?: string;
  body?: string | null;
  status_id?: string;
  priority?: IssuePriority;
  assignee_id?: string | null;
  label_ids?: string[];
  estimate?: string | null;
  start_date?: string | null;
  due_date?: string | null;
  parent_id?: string | null;
  cycle_id?: string | null;
  project_id?: string | null;
}

/**
 * The filters the issue list route reads. `assignee_id` accepts the literal
 * `me`, which the server resolves, so the caller never needs its own user id.
 */
export interface IssueListQuery {
  team_id?: string;
  status_id?: string;
  assignee_id?: string;
  label_id?: string;
  parent_id?: string;
  priority?: IssuePriority;
  cycle_id?: string;
  project_id?: string;
  q?: string;
  sort?: IssueSort;
  cursor?: string;
  limit?: number;
}

/** One link between two issues, denormalised with the target's key and title. */
export interface LinkRead {
  link_id: string;
  issue_id: string;
  type: LinkTypeRead;
  target_issue_id: string;
  target_key: string;
  target_title: string;
  created_by: string;
  created_at: string;
}

/** The body the links route answers with, carrying both directions. */
export interface LinkListRead {
  links: LinkRead[];
}

/** A new link submission. The contract accepts only the canonical direction. */
export interface LinkCreate {
  type: LinkType;
  target_issue_id: string;
}

/** One entry in an issue's history. */
export interface ActivityRead {
  activity_id: string;
  issue_id: string;
  actor_id: string;
  actor_kind: ActorKind;
  kind: ActivityKind;
  field: string | null;
  from: unknown;
  to: unknown;
  created_at: string;
}

/** The body the activity route answers with, newest first. */
export interface ActivityListRead {
  activity: ActivityRead[];
  next_cursor: string | null;
}

/**
 * A person as a comment, attachment or notification denormalises them, so a
 * thread renders a name without a second read of the membership list.
 */
export interface AuthorRead {
  user_id: string;
  display_name: string | null;
  email: string;
}

/** What a reaction may be attached to. */
export type ReactionTarget = 'issue' | 'comment';

/**
 * One emoji's reactions on a target. `count` is the whole group while
 * `user_ids` is capped at the first 20, so the two disagree on a busy target
 * by design and the count is the one to render.
 */
export interface ReactionGroup {
  emoji: string;
  count: number;
  user_ids: string[];
  reacted: boolean;
}

/**
 * One comment. `parent_comment_id` is one level deep: the contract refuses a
 * reply to a reply with a 409, so the thread renders as roots and their
 * replies rather than an arbitrary tree.
 */
export interface CommentRead {
  comment_id: string;
  issue_id: string;
  workspace_id: string;
  team_id: string;
  body: string;
  parent_comment_id: string | null;
  author_id: string;
  author: AuthorRead;
  mentions: string[];
  reactions: ReactionGroup[];
  reply_count: number;
  /** The attachments the comment named on create, in that order. */
  attachments?: AttachmentRead[];
  created_at: string;
  edited_at: string | null;
}

/** The body the comment list answers with, oldest first. */
export interface CommentListRead {
  comments: CommentRead[];
  next_cursor: string | null;
}

/** A new comment submission. */
export interface CommentCreate {
  body: string;
  parent_comment_id?: string | null;
  /** Attachments on the same issue to show inline, at most ten. */
  attachment_ids?: string[];
}

/** The editable field on a comment. Only the author may send it. */
export interface CommentUpdate {
  issue_id: string;
  body: string;
}

/** The body the reactions list answers with. It carries no cursor. */
export interface ReactionListRead {
  reactions: ReactionGroup[];
}

/** The body a reaction write takes, which is the row's own key. */
export interface ReactionWrite {
  target_id: string;
  target_kind: ReactionTarget;
  emoji: string;
}

/** Whether an attachment is a link or bytes in the bucket. */
export type AttachmentKind = 'url' | 'file';

/**
 * One attachment. A file attachment never carries a URL of its own: the only
 * route to a byte is the download route, which mints a presigned GET per call.
 */
export interface AttachmentRead {
  attachment_id: string;
  issue_id: string;
  workspace_id: string;
  team_id: string;
  kind: AttachmentKind;
  title: string;
  url?: string | null;
  favicon_url?: string | null;
  s3_key?: string | null;
  content_type?: string | null;
  size_bytes?: number | null;
  uploaded_by: string;
  created_at: string;
}

/** The body the attachment list answers with, oldest first. */
export interface AttachmentListRead {
  attachments: AttachmentRead[];
  next_cursor: string | null;
}

/** A new URL attachment submission. */
export interface UrlAttachmentCreate {
  issue_id: string;
  url: string;
  title?: string;
}

/** What the presign call takes, declaring the bytes before they are sent. */
export interface UploadTicketCreate {
  issue_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

/**
 * A minted presigned PUT. Every header is required rather than advisory: the
 * ticket signs the content type and the length into the URL, so S3 refuses a
 * PUT that sends anything else.
 */
export interface UploadTicketRead {
  upload_id: string;
  url: string;
  headers: Record<string, string>;
  s3_key: string;
  max_bytes: number;
  expires_at: string;
}

/** The commit call, which is what makes an upload visible on the issue. */
export interface FileAttachmentCreate {
  issue_id: string;
  upload_id: string;
  title?: string;
}

/** A presigned GET, minted per request and never stored. */
export interface AttachmentDownloadRead {
  url: string;
  expires_at: string;
}

/** One board column: a status and the head of its issue list. */
export interface BoardColumnRead {
  status_id: string;
  name: string;
  category: StatusCategory;
  position: number;
  issues: IssueRead[];
  total: number;
  next_cursor: string | null;
}

/** The body the board route answers with, columns in position order. */
export interface BoardRead {
  team_id: string;
  columns: BoardColumnRead[];
}

/** The filters the board read varies on, beyond the team itself. */
export interface BoardQuery {
  assignee_id?: string;
  label_id?: string;
  priority?: IssuePriority;
  cycle_id?: string;
  project_id?: string;
  column_limit?: number;
}

/** Whether a saved view renders as a list or a board. */
export type ViewKind = 'list' | 'board';

/** Whether a saved view belongs to one person or to a team. */
export type ViewScope = 'personal' | 'team';

/** How a saved view groups its rows. */
export type ViewGroupBy = 'status' | 'assignee' | 'priority' | 'label';

/** Which saved views a list read asks for. */
export type ViewListScope = 'mine' | 'team' | 'all';

/**
 * A saved view's stored filter. Each value is a scalar or a list of scalars,
 * where a list means "any of". An unknown key is refused on write with
 * `INVALID_FILTER`, so a view cannot silently widen when a field is renamed.
 */
export interface ViewFilter {
  team_id?: string | string[];
  status_id?: string | string[];
  status_category?: StatusCategory | StatusCategory[];
  assignee_id?: string | string[];
  label_id?: string | string[];
  priority?: IssuePriority | IssuePriority[];
  parent_id?: string | string[];
  cycle_id?: string | string[];
  project_id?: string | string[];
  due_before?: string;
  due_after?: string;
  q?: string;
}

/** One saved view. It stores a filter, never a result set. */
export interface SavedViewRead {
  view_id: string;
  workspace_id: string;
  name: string;
  kind: ViewKind;
  scope: ViewScope;
  team_id: string | null;
  filter: ViewFilter;
  sort: IssueSort;
  group_by: ViewGroupBy | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

/** The body the saved view list answers with. It carries no cursor. */
export interface SavedViewListRead {
  views: SavedViewRead[];
}

/** A new saved view submission. `scope` is derived, so it is never sent. */
export interface SavedViewCreate {
  name: string;
  kind: ViewKind;
  filter: ViewFilter;
  sort?: IssueSort;
  group_by?: ViewGroupBy | null;
  team_id?: string | null;
}

/** The editable fields on a saved view. Neither kind nor team may move. */
export interface SavedViewUpdate {
  name?: string;
  filter?: ViewFilter;
  sort?: IssueSort;
  group_by?: ViewGroupBy | null;
}

/** One search hit. `score` is the matched term count, not a relevance score. */
export interface SearchResultRead {
  issue_id: string;
  key: string;
  title: string;
  team_id: string;
  status_id: string;
  assignee_id: string | null;
  updated_at: string;
  score: number;
}

/** The body the search route answers with. It is capped rather than paged. */
export interface SearchListRead {
  results: SearchResultRead[];
}

/** What put a notification in the inbox. */
export type NotificationKind =
  'assigned' | 'mentioned' | 'commented' | 'status_changed';

/**
 * One inbox row. The issue key and title are denormalised at write, so a
 * notification whose issue has since been deleted still renders rather than
 * making the list 404.
 */
export interface NotificationRead {
  notification_id: string;
  workspace_id: string;
  kind: NotificationKind;
  issue_id: string;
  issue_key: string;
  issue_title: string;
  team_id: string;
  comment_id: string | null;
  actor_id: string;
  actor_name: string;
  unread: boolean;
  created_at: string;
  expires_at: string;
}

/** The body the inbox list answers with, newest first. */
export interface NotificationListRead {
  notifications: NotificationRead[];
  next_cursor: string | null;
}

/** The unread count, capped and reported as 100 above 100. */
export interface InboxCountRead {
  unread: number;
}

/** What a mark-read call takes: named rows, or every row. */
export type InboxReadWrite = { notification_ids: string[] } | { all: true };

/** How many rows a mark-read call changed. */
export interface InboxReadResult {
  updated: number;
}

/**
 * A cycle's status, derived by the server from its dates and its cancellation
 * flag. Nothing writes it, so it is absent from every request shape.
 */
export type CycleStatus = 'upcoming' | 'active' | 'completed' | 'cancelled';

/**
 * A project's status, which is stored because its dates cannot imply it. The
 * server still accepts `done` on input and reads it as `completed`.
 */
export type ProjectStatus =
  'backlog' | 'planned' | 'in_progress' | 'paused' | 'completed' | 'canceled';

/** Which of the two things a roadmap entry is. */
export type RoadmapKind = 'cycle' | 'project';

/**
 * How many issues sit in each bucket of a cycle or a project. Maintained by a
 * stream consumer rather than the request path, so it can lag a write by a
 * moment. `total` is rendered by the server from the four buckets.
 */
export interface RollupCounts {
  todo: number;
  in_progress: number;
  done: number;
  cancelled: number;
  total: number;
}

/** One time box of a team. */
export interface CycleRead {
  cycle_id: string;
  workspace_id: string;
  team_id: string;
  name: string;
  start_date: string;
  end_date: string;
  goal: string | null;
  cancelled: boolean;
  status: CycleStatus;
  counts: RollupCounts;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** The body the cycle list answers with, by start date ascending. */
export interface CycleListRead {
  cycles: CycleRead[];
  next_cursor: string | null;
}

/** A new cycle. Both dates are required and the end may not precede the start. */
export interface CycleCreate {
  team_id: string;
  name: string;
  start_date: string;
  end_date: string;
  goal?: string | null;
}

/** The editable fields on a cycle. The team names the row and cannot move. */
export interface CycleUpdate {
  team_id: string;
  name?: string;
  start_date?: string;
  end_date?: string;
  goal?: string | null;
  cancelled?: boolean;
}

/** The filters the cycle list reads. The team is required. */
export interface CycleListQuery {
  team_id: string;
  status?: CycleStatus;
  cursor?: string;
  limit?: number;
}

/**
 * One workspace level project shared by one or more teams. `team_ids` lists
 * only the teams the caller can see, and `team_id` is the first of them.
 */
export interface ProjectRead {
  project_id: string;
  workspace_id: string;
  team_id: string;
  team_ids: string[];
  name: string;
  description: string | null;
  lead_id: string | null;
  start_date: string | null;
  target_date: string | null;
  status: ProjectStatus;
  counts: RollupCounts;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** The body the project list answers with, undated rows last. */
export interface ProjectListRead {
  projects: ProjectRead[];
  next_cursor: string | null;
}

/**
 * A new project. `team_ids` names its teams; the older single `team_id` is
 * still accepted and read as a one-team list. The dates are optional.
 */
export interface ProjectCreate {
  team_ids?: string[];
  team_id?: string;
  name: string;
  description?: string | null;
  lead_id?: string | null;
  start_date?: string | null;
  target_date?: string | null;
  status?: ProjectStatus;
}

/**
 * The editable fields on a project. `team_ids` replaces the teams the caller
 * can see and keeps the rest. `team_id` is optional and only checked. A null
 * clears a lead or a date.
 */
export interface ProjectUpdate {
  team_id?: string;
  team_ids?: string[];
  name?: string;
  description?: string | null;
  lead_id?: string | null;
  start_date?: string | null;
  target_date?: string | null;
  status?: ProjectStatus;
}

/** The filters the project list reads. Without a team it is workspace wide. */
export interface ProjectListQuery {
  team_id?: string;
  status?: ProjectStatus;
  cursor?: string;
  limit?: number;
}

/**
 * One cycle or project as the roadmap draws it. A projection rather than the
 * whole row: the timeline renders a bar and a count, and a reader wanting the
 * rest has the entity's own route.
 */
export interface RoadmapEntryRead {
  kind: RoadmapKind;
  id: string;
  team_id: string;
  team_ids: string[];
  name: string;
  target_date: string | null;
  start_date: string | null;
  status: string;
  counts: RollupCounts;
}

/** The body the roadmap answers with, by date ascending and undated last. */
export interface RoadmapListRead {
  entries: RoadmapEntryRead[];
  next_cursor: string | null;
}

/** The filters the roadmap reads. Both narrow an otherwise workspace wide read. */
export interface RoadmapQuery {
  team_id?: string;
  kind?: RoadmapKind;
  cursor?: string;
  limit?: number;
}

/** The events a workspace webhook endpoint may subscribe to. */
export const OUTBOUND_EVENTS = [
  'issue.created',
  'issue.updated',
  'issue.status_changed',
  'comment.created',
] as const;

/** One event a workspace webhook endpoint may subscribe to. */
export type OutboundEvent = (typeof OUTBOUND_EVENTS)[number];

/** The pull request events a transition rule may fire on. */
export const TRANSITION_TRIGGERS = [
  'pr_opened',
  'pr_ready_for_review',
  'pr_merged',
  'pr_closed',
] as const;

/** One pull request event a transition rule may fire on. */
export type TransitionTrigger = (typeof TRANSITION_TRIGGERS)[number];

/** Where to send a workspace admin to install the GitHub App. */
export interface InstallUrlRead {
  url: string;
  expires_at: string;
}

/**
 * One repository the installation can see. `team_id` pins it to a single
 * team, which narrows which issue keys a branch in it may name.
 */
export interface GithubRepositoryRead {
  repository_id: string;
  full_name: string;
  name: string;
  private: boolean;
  default_branch: string;
  team_id: string | null;
  linked_at: string;
}

/** The GitHub App installation backing a workspace, when there is one. */
export interface GithubInstallationRead {
  installation_id: string;
  account_login: string;
  account_type: string;
  repository_selection: string;
  html_url: string;
  manage_url: string;
  avatar_url: string;
  suspended: boolean;
  installed_by: string;
  installed_at: string;
  repository_count: number;
}

/**
 * One pull request linked to an issue. The pull request's own fields are
 * denormalised at write, so a link still renders without calling GitHub.
 */
export interface GithubIssueLinkRead {
  link_id: string;
  issue_id: string;
  issue_key: string;
  repository_full_name: string;
  pr_number: number;
  pr_title: string;
  pr_url: string;
  pr_state: 'open' | 'draft' | 'merged' | 'closed';
  author_login: string;
  closes_issue: boolean;
  applied_status_id: string | null;
  linked_at: string;
  updated_at: string;
}

/**
 * One outbound webhook endpoint. `secret` is present only on the create and
 * rotate responses, because it is never stored in a readable form and so can
 * never be shown again.
 */
export interface WebhookEndpointRead {
  webhook_id: string;
  url: string;
  events: string[];
  description: string | null;
  active: boolean;
  secret_hint: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_status: number | null;
  last_delivery_at: string | null;
  secret?: string | null;
}

/** What registering an endpoint takes. `events` defaults to all of them. */
export interface WebhookEndpointCreate {
  url: string;
  events?: string[];
  description?: string | null;
  active?: boolean;
}

/** What editing an endpoint takes, every field optional. */
export interface WebhookEndpointUpdate {
  url?: string;
  events?: string[];
  description?: string | null;
  active?: boolean;
}

/**
 * One transition rule. `is_default` marks a rule the team never configured,
 * which is the design section 4 fallback rather than a stored row.
 */
export interface TransitionRead {
  transition_id: string;
  team_id: string;
  trigger: string;
  status_id: string | null;
  is_default: boolean;
}

/** What creating a transition rule takes. */
export interface TransitionCreate {
  trigger: string;
  status_id?: string | null;
}

/** What editing a transition rule takes. */
export interface TransitionUpdate {
  status_id?: string | null;
}

/**
 * The scopes an API key or an MCP token may carry. Exported as a tuple so the
 * create form renders its checkboxes from the same list the server validates
 * against, rather than from a copy that can drift out of step with it.
 */
export const API_KEY_SCOPES = [
  'issues:read',
  'issues:write',
  'comments:write',
  'teams:read',
  'views:read',
] as const;

/** One scope an API key may carry. */
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * Whether a key acts as the person who minted it or as the workspace itself.
 * A workspace key outlives whoever set it up, which is why only an admin may
 * mint one.
 */
export type ApiKeyKind = 'user' | 'workspace';

/** Which keys a listing asks for: the caller's own, or every key in the workspace. */
export type ApiKeyListScope = 'mine' | 'workspace';

/**
 * One API key as a listing answers it. `prefix` is the only clear-text
 * fragment that survives the mint, so it is what a person recognises a key by;
 * the secret itself is stored as a hash and can never be read back.
 */
export interface ApiKeyRead {
  key_id: string;
  name: string;
  kind: ApiKeyKind;
  prefix: string;
  scopes: string[];
  created_by: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

/**
 * The create response, which is the one and only place `secret` is ever
 * present. There is no route that shows it again and no support path that can
 * recover it, so a page that drops it has lost it.
 */
export interface ApiKeyCreatedRead extends ApiKeyRead {
  secret: string;
}

/** What minting a key takes. `kind` defaults to `user` when it is left out. */
export interface ApiKeyCreate {
  name: string;
  scopes: string[];
  kind?: ApiKeyKind;
  expires_in_days?: number;
}

/**
 * What a share link may point at. A `filter` link publishes an unsaved team
 * filter: its `target_id` is the team, and the filter and sort are snapshotted
 * onto the link when it is minted.
 */
export type ShareTargetType = 'issue' | 'view' | 'filter';

/** What a share token reads as on the public page: one issue or a listing. */
export type SharedTargetType = 'issue' | 'view';

/**
 * One share link as a listing answers it. `title` is denormalised onto the row
 * so a settings list renders without a second read per link, and `url` carries
 * the path with no token, because a list that carried live tokens would make
 * the list itself a credential.
 */
export interface ShareLinkRead {
  token_hash: string;
  target_type: ShareTargetType;
  target_id: string;
  team_id: string;
  title: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at?: string | null;
  url: string;
}

/**
 * The create response, the one place `token` is present. `url` on this one
 * response carries the token, so it is the only value worth copying.
 */
export interface ShareLinkCreatedRead extends ShareLinkRead {
  token: string;
}

/**
 * What minting a share link takes. `filter`, `sort` and `title` are read only
 * for a `filter` link, which snapshots them.
 */
export interface ShareLinkCreate {
  target_type: ShareTargetType;
  target_id: string;
  expires_in_days?: number;
  filter?: Record<string, unknown>;
  sort?: string;
  title?: string;
}

/** The filters a share link listing narrows on. */
export interface ShareLinkListQuery {
  target_type?: ShareTargetType;
  target_id?: string;
}

/**
 * What a share token resolves to, read first by the anonymous page so it knows
 * which of the two follow-up reads to make. It carries no ids that are useful
 * anywhere else and no creator identity.
 */
export interface SharedTargetRead {
  target_type: SharedTargetType;
  title: string;
  workspace_name: string;
  team_name: string;
  shared_at: string;
}

/** The status of a shared issue, reduced to what renders a badge. */
export interface SharedStatusRead {
  name: string;
  category: string;
  color: string;
}

/** One label on a shared issue, reduced to what renders a chip. */
export interface SharedLabelRead {
  name: string;
  color: string;
}

/**
 * One comment on a shared issue. Names rather than ids, and no reactions or
 * edit history, because a reader holding a token is not a member.
 */
export interface SharedCommentRead {
  author_name: string;
  body: string;
  created_at: string;
}

/**
 * A shared issue in full. Sub-issues, linked issues, activity and attachment
 * URLs are deliberately absent: the token resolves one row and the read never
 * follows a link out of it.
 */
export interface SharedIssueRead {
  issue_key: string;
  title: string;
  body: string | null;
  status: SharedStatusRead;
  priority: string | null;
  labels: SharedLabelRead[];
  estimate: number | null;
  start_date: string | null;
  due_date: string | null;
  assignee_name: string | null;
  created_at: string;
  updated_at: string;
  comments: SharedCommentRead[];
}

/** One row of a shared view listing, with no ids a reader could spend. */
export interface SharedIssueSummaryRead {
  issue_key: string;
  title: string;
  status: SharedStatusRead;
  priority: string | null;
  assignee_name: string | null;
  updated_at: string;
}

/** One cursor page of a shared view's issues. */
export interface SharedViewPageRead {
  issues: SharedIssueSummaryRead[];
  next_cursor: string | null;
}

/** Whether this environment has a GitHub App, as a platform admin sees it. */
export interface GithubAppStatusRead {
  configured: boolean;
  secret_available: boolean;
  organization: string;
  app_name: string;
}

/** The manifest the browser posts to GitHub, and the url carrying its state. */
export interface GithubAppManifestRead {
  manifest: Record<string, unknown>;
  post_url: string;
  expires_at: string;
}

/** The `code` and `state` GitHub sent the browser back with. */
export interface GithubAppConversionCreate {
  code: string;
  state: string;
}

/** The App GitHub created, with nothing but its id and slug. */
export interface GithubAppCreatedRead {
  id: number;
  slug: string;
  settings_url: string;
  logo_path: string;
  badge_color: string;
}
