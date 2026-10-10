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
  /** The URL of the person's avatar image, or null when they use their initials. */
  avatar_url?: string | null;
  /** The account wide email switch, which turns every kind's email off at once. */
  email_notifications?: boolean;
  /** Every notification kind's inbox and email switches, fully resolved. */
  notification_preferences?: Record<NotificationKind, NotificationChannels>;
  /** Whether this session has a second factor, the claim a workspace auth policy checks. */
  two_factor?: boolean;
}

/** One workspace as the account deletion plan names it. */
export interface WorkspaceSummaryRead {
  id: string;
  name: string;
  slug: string;
  /** Whether the workspace's own deletion is scheduled but could still be cancelled. */
  deletion_scheduled?: boolean;
}

/**
 * What deleting the caller's account would do to each of their workspaces:
 * the ones that stop it, the ones deleted with it, and the ones only left.
 */
export interface AccountDeletionPlanRead {
  blocking: WorkspaceSummaryRead[];
  deleted_with_account: WorkspaceSummaryRead[];
  leaving: WorkspaceSummaryRead[];
}

/** The confirmation an account deletion is asked for with. */
export interface AccountDeletionRequest {
  confirm_email: string;
}

/** The confirmation a workspace deletion is asked for with. */
export interface WorkspaceDeletionRequest {
  confirm_name: string;
}

/** Whether one kind of notification goes to the inbox and to email. */
export interface NotificationChannels {
  in_app: boolean;
  email: boolean;
}

/** A partial preferences change: only the switches sent are applied. */
export interface UserPreferencesUpdate {
  email_notifications?: boolean;
  notification_preferences?: Partial<
    Record<NotificationKind, Partial<NotificationChannels>>
  >;
}

/** A role held at the workspace level. */
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest';

/** A role held on one team. */
export type TeamRole = 'admin' | 'member';

/** A role an invite may carry. The contract never issues an owner invite. */
export type InviteRole = Exclude<WorkspaceRole, 'owner'>;

/** How a team sizes its issues. */
export type EstimateScale =
  'off' | 'exponential' | 'fibonacci' | 'linear' | 'tshirt';

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
  /** When the workspace's deletion was asked for, or null when none is scheduled. */
  deletion_scheduled_at?: string | null;
  /** Who asked for the scheduled deletion, or null when none is scheduled. */
  deletion_scheduled_by?: string | null;
  /** When the workspace is permanently deleted, or null when none is scheduled. */
  purge_after?: string | null;
  /** The URL of the workspace logo, or null when it shows its initials. */
  icon_url?: string | null;
  /** The workspace accent as #rrggbb, or null for the Standupless default. */
  accent_color?: string | null;
  /** Days between the project updates a lead is reminded of, 0 for none. */
  project_update_interval_days?: ProjectUpdateInterval;
  /** Whether the workspace's authentication policy refuses the caller's session. */
  auth_policy_blocked?: boolean;
  /** Why the policy refuses the session, when it does. */
  auth_policy_reason?: AuthPolicyReason | null;
  /** The sign-in methods the workspace allows, when the session used another. */
  auth_policy_allowed_methods?: SignInMethod[] | null;
}

/** A way of signing in a workspace may allow or refuse. */
export type SignInMethod = 'password' | 'google' | 'github' | 'passkey';

/** Why a workspace's authentication policy refuses a session. */
export type AuthPolicyReason = 'two_factor' | 'sign_in_method';

/** A workspace's authentication policy, as `GET .../auth-policy` answers it. */
export interface AuthPolicyRead {
  require_two_factor: boolean;
  /** The sign-in methods a session may have used to reach the workspace. */
  allowed_methods: SignInMethod[];
  updated_at?: string | null;
  updated_by?: string | null;
  /** Whether the workspace's plan includes the authentication policy. */
  available: boolean;
  /** How the caller's own session signed in, which the allowed methods must keep. */
  current_method?: SignInMethod | null;
}

/** One event the audit log can record, as a filter option. */
export interface AuditEventType {
  key: string;
  label: string;
}

/** One audit log entry: what happened, to what, by whom, through which client and from where. */
export interface AuditEventRead {
  audit_id: string;
  event: string;
  event_label: string;
  actor_id: string;
  /** user, api_key, service or system. */
  actor_kind: string;
  actor_name?: string;
  /** The client the change came through: web, api, cli, mcp or system. */
  source: string;
  ip?: string;
  amr?: string[];
  target_type?: string;
  target_id?: string;
  target_label?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  created_at: string;
}

/** One page of the audit log, as `GET .../audit-log` answers it. */
export interface AuditLogRead {
  events: AuditEventRead[];
  next_cursor?: string | null;
  /** Whether the workspace's plan includes the audit log. */
  available: boolean;
  event_types: AuditEventType[];
}

/** The filters the audit log and its CSV download take. */
export interface AuditLogFilters {
  actor_id?: string;
  event?: string;
  since?: string;
  until?: string;
}

/** The body `PUT .../auth-policy` takes; a field left out keeps its stored value. */
export interface AuthPolicyUpdate {
  require_two_factor?: boolean;
  allowed_methods?: SignInMethod[];
}

/** One email domain whose verified addresses may join without an invite. */
export interface ApprovedDomainRead {
  domain: string;
  added_by: string;
  added_at: string;
}

/** The body `GET .../approved-domains` answers with. */
export interface ApprovedDomainListRead {
  domains: ApprovedDomainRead[];
}

/** A workspace the caller may join through their verified email domain. */
export interface JoinableWorkspaceRead {
  id: string;
  name: string;
  slug: string;
  icon_url?: string | null;
  accent_color?: string | null;
  /** The approved domain that lets the caller join. */
  domain: string;
}

/** The body `GET /api/workspaces/joinable` answers with. */
export interface JoinableWorkspaceListRead {
  workspaces: JoinableWorkspaceRead[];
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
  /** The accent as #rrggbb, or null to return to the Standupless default. */
  accent_color?: string | null;
  project_update_interval_days?: ProjectUpdateInterval;
}

/** One member of a workspace. */
export interface MemberRead {
  user_id: string;
  email: string;
  display_name: string | null;
  role: WorkspaceRole;
  joined_at: string;
  /** The URL of the person's avatar image, or null when they use their initials. */
  avatar_url?: string | null;
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
  /** Whether the scale offers its larger values, such as 13 and 21 on Fibonacci. */
  estimate_extended?: boolean;
  /** Whether 0 is offered as an estimate. */
  estimate_allow_zero?: boolean;
  /** Whether cycle and project progress count an unestimated issue as 1 point. */
  estimate_count_unestimated?: boolean;
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
  /** The URL of the team icon, or null when it shows its initials. */
  icon_url?: string | null;
  /** Whether linked pull requests carry the labels of this team's issues. */
  sync_pr_labels?: boolean;
  /** Whether only team members can see the team and its issues. */
  private?: boolean;
}

/** The body the teams list route answers with. */
export interface TeamListRead {
  teams: TeamRead[];
}

/** The caller's own sidebar team order, first to last. */
export interface TeamOrderUpdate {
  team_ids: string[];
}

/** A new team submission. */
export interface TeamCreate {
  name: string;
  key_prefix: string;
  description?: string | null;
  estimate_scale?: EstimateScale;
  estimate_extended?: boolean;
  estimate_allow_zero?: boolean;
  estimate_count_unestimated?: boolean;
  /** Make the team private from the start. Needs the Business plan. */
  private?: boolean;
}

/** The editable fields on a team. */
export interface TeamUpdate {
  name?: string;
  /** A new key. The old one is retired and keeps resolving issue keys. */
  key_prefix?: string;
  estimate_scale?: EstimateScale;
  estimate_extended?: boolean;
  estimate_allow_zero?: boolean;
  estimate_count_unestimated?: boolean;
  description?: string | null;
  /** Whether linked pull requests carry the labels of this team's issues. */
  sync_pr_labels?: boolean;
  /** Turning this on needs the Business plan; turning it off never does. */
  private?: boolean;
}

/** One member of a team. */
export interface TeamMemberRead {
  user_id: string;
  email: string;
  display_name: string | null;
  role: TeamRole;
  added_at: string;
  /** The URL of the person's avatar image, or null when they use their initials. */
  avatar_url?: string | null;
}

/** The body the team members route answers with. */
export interface TeamMemberListRead {
  members: TeamMemberRead[];
}

/** A role grant on one team member. */
export interface TeamMemberUpdate {
  role: TeamRole;
}

/** Whether a status or label belongs to one team or is inherited from the workspace. */
export type WorkflowScope = 'team' | 'workspace';

/** One workflow status on a team or the workspace. */
export interface StatusRead {
  id: string;
  name: string;
  category: StatusCategory;
  position: number;
  /** A palette color name, or null for the category default. */
  color?: string | null;
  /** An icon variant from the category's set, or null for its default. */
  icon?: string | null;
  /** Where the status is defined. Absent on older rows, which are team rows. */
  scope?: WorkflowScope;
  /** Whether the team hid this inherited status. Only answered with `include_hidden`. */
  hidden?: boolean;
  /** The workspace name of an inherited status the team renamed, or null. */
  inherited_name?: string | null;
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
  color?: string | null;
  icon?: string | null;
}

/** The editable fields on a status. */
export interface StatusUpdate {
  name?: string;
  category?: StatusCategory;
  position?: number;
  /** A palette color name, or null to go back to the category default. */
  color?: string | null;
  /** An icon variant, or null to go back to the category default. */
  icon?: string | null;
}

/** One label on a team or the workspace. */
export interface LabelRead {
  id: string;
  name: string;
  color: string;
  /** Where the label is defined. Absent on older rows, which are team rows. */
  scope?: WorkflowScope;
  /** Whether the team hid this inherited label. Only answered with `include_hidden`. */
  hidden?: boolean;
  /** The workspace name of an inherited label the team renamed, or null. */
  inherited_name?: string | null;
  /** Whether this is a label group, which holds labels and never sits on an issue. */
  is_group?: boolean;
  /** The group this label sits in, or null outside one. */
  parent_id?: string | null;
}

/** The body the labels route answers with. */
export interface LabelListRead {
  labels: LabelRead[];
}

/** A new label submission. */
export interface LabelCreate {
  name: string;
  color: string;
  /** Makes a label group. Set only at creation. */
  is_group?: boolean;
  /** The group to put the label in, of the same scope. */
  parent_id?: string | null;
}

/** The editable fields on a label. */
export interface LabelUpdate {
  name?: string;
  color?: string;
  /** Moves the label into this group, or out of its group with null. */
  parent_id?: string | null;
}

/**
 * A team's override of an inherited status or label. A field left out keeps
 * its value, and a null `name` clears the local rename.
 */
export interface OverrideUpdate {
  hidden?: boolean;
  name?: string | null;
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
  | 'child_removed'
  | 'archived'
  | 'unarchived';

/**
 * Direct sub-issue counts, maintained by the rollup consumer rather than the
 * request handler, so it can lag a write by a moment.
 */
export interface IssueProgress {
  total: number;
  completed: number;
}

/**
 * Where an issue stands against its team's SLA: no SLA, on track, inside the
 * at risk window before the deadline, or past it.
 */
export type SlaStatus = 'none' | 'on_track' | 'at_risk' | 'breached';

/** One linked pull request as an issue row's chip shows it. */
export interface PullRequestSummaryEntryRead {
  repository_full_name: string;
  number: number;
  title: string;
  url: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  review_state: PullRequestReviewState;
  ci_state: PullRequestCiState;
}

/**
 * The pull requests linked to an issue: the full count, and up to ten of
 * them with the most advanced first.
 */
export interface PullRequestSummaryRead {
  count: number;
  pull_requests: PullRequestSummaryEntryRead[];
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
  /**
   * The project milestone the issue sits under, always one of its own
   * project's. Optional so a row read before milestones existed reads as none.
   */
  project_milestone_id?: string | null;
  progress: IssueProgress;
  /**
   * How many open issues block this one, recounted by the server on every link
   * write and blocker status move. Optional so older fixtures still type.
   */
  blocked_by_open_count?: number;
  /**
   * The pull requests linked to the issue, most advanced first, kept by the
   * server from GitHub deliveries. Absent when the issue links none.
   */
  pull_request_summary?: PullRequestSummaryRead | null;
  /**
   * When the issue was archived, by hand or by the team's auto-archive
   * period. Null or absent for a live issue.
   */
  archived_at?: string | null;
  /**
   * True while the issue waits in its team's triage inbox, filed from outside
   * the team. Optional so a row read before triage existed reads as accepted.
   */
  in_triage?: boolean;
  /** When a snoozed triage issue comes back to the inbox, or null. */
  snoozed_until?: string | null;
  /**
   * When the issue's SLA timer started: its creation, or its acceptance from
   * triage. Null when the team's SLA rules did not cover it.
   */
  sla_started_at?: string | null;
  /** When the issue breaches its SLA, or null when it has none. */
  sla_breaches_at?: string | null;
  /**
   * Where the issue stands against its SLA, derived by the server at read
   * time. Optional so a row read before SLAs existed reads as none.
   */
  sla_status?: SlaStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * One page of a CSV export. The first page starts with the header row, so the
 * pages joined in order are the whole file; it is finished when `next_cursor` is null.
 */
export interface IssueExportRead {
  csv: string;
  rows: number;
  next_cursor?: string | null;
}

/** The body the issue list and children routes answer with. */
export interface IssueListRead {
  issues: IssueRead[];
  next_cursor: string | null;
  /** The cursor to send back as `updated_since` for a delta read. */
  synced_at?: string | null;
  /** On a delta read, the issues that left the list: filtered out, archived or deleted. */
  removed_ids?: string[];
  /** On a delta read, true when the list must be read in full instead. */
  resync_required?: boolean;
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
  project_milestone_id?: string | null;
}

/** The body that moves an issue to another team, which gives it a new key. */
export interface IssueMove {
  team_id: string;
}

/** The editable fields on an issue. Moving team is its own route. */
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
  /** A milestone of the issue's project; changing the project clears it. */
  project_milestone_id?: string | null;
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
  project_milestone_id?: string;
  q?: string;
  sort?: IssueSort;
  cursor?: string;
  limit?: number;
}

/** The status of a link's far side, from that issue's own team. */
export interface LinkStatusRead {
  id: string;
  name: string;
  category: StatusCategory;
  color?: string | null;
  icon?: string | null;
}

/** One link between two issues, denormalised with the target's key and title. */
export interface LinkRead {
  link_id: string;
  issue_id: string;
  type: LinkTypeRead;
  target_issue_id: string;
  target_key: string;
  target_title: string;
  target_status?: LinkStatusRead | null;
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

/**
 * Which client a change came through, read off the credential that made it.
 * The web app, GitHub and jobs render unlabelled; the rest show "via MCP" and
 * the like.
 */
export type ChangeSource = 'web' | 'mcp' | 'cli' | 'api' | 'github' | 'system';

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
  /** Which client made the change; absent on rows written before sources were recorded. */
  source?: ChangeSource | null;
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
  /** The URL of the person's avatar image, or null when they use their initials. */
  avatar_url?: string | null;
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
  /** Which client made the change; absent on rows written before sources were recorded. */
  source?: ChangeSource | null;
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

/**
 * The body a reaction write takes, which is the row's own key. `issue_id` is
 * required for a comment target, whose partition is its issue, and the API
 * answers 404 without it.
 */
export interface ReactionWrite {
  target_id: string;
  target_kind: ReactionTarget;
  emoji: string;
  issue_id?: string;
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
  /** The signed ticket the commit call must hand back. */
  ticket: string;
  url: string;
  headers: Record<string, string>;
  s3_key: string;
  max_bytes: number;
  expires_at: string;
}

/** A request to sign one icon upload: the image type and its exact size in bytes. */
export interface IconUploadCreate {
  content_type: string;
  size_bytes: number;
}

/** The signed PUT for one icon and the headers it must be sent with. */
export interface IconUploadRead {
  upload_id: string;
  url: string;
  headers: Record<string, string>;
  max_bytes: number;
  expires_at: string;
}

/** The commit call that makes an uploaded icon current. */
export interface IconCommit {
  upload_id: string;
}

/** The commit call, which is what makes an upload visible on the issue. */
export interface FileAttachmentCreate {
  issue_id: string;
  upload_id: string;
  ticket: string;
  title?: string;
}

/**
 * Media tokens for one issue's files, keyed by attachment id. Each is appended
 * to that attachment's stable content path when an embed renders.
 */
export interface MediaTokensRead {
  tokens: Record<string, string>;
  expires_at: string;
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
  color?: string | null;
  icon?: string | null;
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
export type ViewGroupBy =
  'status' | 'assignee' | 'priority' | 'label' | 'milestone';

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
  project_milestone_id?: string | string[];
  estimate?: string | string[];
  due_before?: string;
  due_after?: string;
  sla_status?: SlaStatus | SlaStatus[];
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

/**
 * One possible duplicate of a draft title. `score` is how many of the title's
 * terms the issue is posted under; the status fields style its glyph.
 */
export interface SimilarIssueRead {
  issue_id: string;
  key: string;
  title: string;
  team_id: string;
  status_id: string;
  status_name: string | null;
  status_category: StatusCategory | null;
  status_color: string | null;
  status_icon: string | null;
  score: number;
}

/** The body the similar issues route answers with, best match first. */
export interface SimilarListRead {
  results: SimilarIssueRead[];
}

/** What put a notification in the inbox. */
export type NotificationKind =
  | 'assigned'
  | 'mentioned'
  | 'commented'
  | 'status_changed'
  | 'project_update'
  | 'project_update_due'
  | 'due_soon'
  | 'overdue'
  | 'standup_digest'
  | 'sla_at_risk'
  | 'sla_breached';

/**
 * Every kind an inbox row can carry: the ones a member can tune, the notice a
 * team admin gets when a Slack or Discord channel was turned off, and the
 * notices an admin gets when a workspace export or an issue import finishes or
 * fails.
 */
export type InboxKind =
  | NotificationKind
  | 'channel_disabled'
  | 'export_ready'
  | 'export_failed'
  | 'import_ready'
  | 'import_failed';

/**
 * One inbox row. The issue key and title are denormalised at write, so a
 * notification whose issue has since been deleted still renders rather than
 * making the list 404.
 */
export interface NotificationRead {
  notification_id: string;
  workspace_id: string;
  kind: InboxKind;
  issue_id: string;
  issue_key: string;
  issue_title: string;
  team_id: string;
  comment_id: string | null;
  /** The project a `project_update` row is about; null on issue rows. */
  project_id?: string | null;
  project_name?: string | null;
  project_update_id?: string | null;
  /** The digest date a `standup_digest` row is about; null on every other row. */
  standup_date?: string | null;
  actor_id: string;
  actor_name: string;
  unread: boolean;
  snoozed_until?: string | null;
  /** Which client made the change; absent on rows written before sources were recorded. */
  source?: ChangeSource | null;
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

/** What a mark-unread call takes: the rows to bring back as unread. */
export interface InboxUnreadWrite {
  notification_ids: string[];
}

/** What a snooze call takes: the rows to hide and the timezone aware moment they return. */
export interface InboxSnoozeWrite {
  notification_ids: string[];
  until: string;
}

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
  /** The sequence number of a cycle the schedule created, named "Cycle N"; null for one made by hand. */
  number?: number | null;
  start_date: string;
  end_date: string;
  goal: string | null;
  cancelled: boolean;
  status: CycleStatus;
  counts: RollupCounts;
  /**
   * The same buckets weighted by estimate points; an unestimated issue adds
   * one point when its team counts unestimated issues.
   */
  points?: RollupCounts;
  /** How many issues in each bucket carry no estimate. */
  unestimated?: RollupCounts;
  /** What the cycle close rolled in from the cycle before and out to the next. */
  carry?: CarryOver;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * Unfinished work a cycle close moved between cycles, in issues and in
 * estimate points. `carried_in` came from the previous cycle and
 * `carried_out` rolled on to the next; the id lists name those issues.
 */
export interface CarryOver {
  carried_in: number;
  carried_in_points: number;
  carried_out: number;
  carried_out_points: number;
  carried_in_unestimated?: number;
  carried_out_unestimated?: number;
  carried_in_issue_ids?: string[];
  carried_out_issue_ids?: string[];
}

/**
 * One day of a cycle's burn-up. Scope leaves cancelled work out, started
 * includes finished work, and each measure comes in issues and in points.
 */
export interface CycleHistoryPoint {
  date: string;
  scope: number;
  started: number;
  completed: number;
  scope_points: number;
  started_points: number;
  completed_points: number;
}

/**
 * A cycle's daily history from its first day to today or its end. Recorded
 * by the rollup as the cycle's issues move, so every past day reads as it
 * stood then rather than being rebuilt from the issues as they are now.
 */
export interface CycleHistoryRead {
  cycle_id: string;
  team_id: string;
  start_date: string;
  end_date: string;
  status: CycleStatus;
  today: string;
  days: CycleHistoryPoint[];
}

/** One closed cycle's delivered work, read as it stood on its last day. */
export interface VelocityCycleRead {
  cycle_id: string;
  name: string;
  start_date: string;
  end_date: string;
  completed_issues: number;
  completed_points: number;
  scope_issues: number;
  scope_points: number;
  carried_out: number;
  carried_out_points: number;
}

/** The cycle capacity guidance speaks to: the active one, else the next. */
export interface CycleCapacityRead {
  cycle_id: string;
  name: string;
  status: CycleStatus;
  start_date: string;
  end_date: string;
  scope_issues: number;
  scope_points: number;
  carried_in: number;
  carried_in_points: number;
}

/**
 * A team's velocity: the last closed cycles oldest first, their averages,
 * and the cycle being planned. `estimate_scale` says whether points mean
 * anything for this team; `off` means read the issue counts instead.
 */
export interface VelocityRead {
  team_id: string;
  estimate_scale: string;
  cycles: VelocityCycleRead[];
  average_points: number;
  average_issues: number;
  upcoming: CycleCapacityRead | null;
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

/**
 * A team's automatic cycle schedule. `start_weekday` counts from 0 for Monday
 * to 6 for Sunday, and `updated_at` is null until the schedule is first saved.
 */
export interface CycleSettingsRead {
  team_id: string;
  enabled: boolean;
  duration_weeks: number;
  cooldown_weeks: number;
  start_weekday: number;
  upcoming_count: number;
  auto_add_started: boolean;
  move_unfinished: boolean;
  updated_at: string | null;
}

/** The editable fields of a team's cycle schedule, each optional. */
export interface CycleSettingsUpdate {
  enabled?: boolean;
  duration_weeks?: number;
  cooldown_weeks?: number;
  start_weekday?: number;
  upcoming_count?: number;
  auto_add_started?: boolean;
  move_unfinished?: boolean;
}

/** The months without an update after which a team's stale issues close. */
export type AutoClosePeriodMonths = 1 | 3 | 6 | 9 | 12;

/**
 * A team's auto-close setting. Backlog and triage issues not updated for
 * `period_months` move to `status_id`, or the first cancelled status when it
 * is null. A null period means auto-close is off, the default.
 */
export interface AutoCloseSettingsRead {
  team_id: string;
  enabled: boolean;
  period_months: AutoClosePeriodMonths | null;
  status_id: string | null;
  updated_at: string | null;
}

/** The editable fields of a team's auto-close setting; null clears either. */
export interface AutoCloseSettingsUpdate {
  period_months?: AutoClosePeriodMonths | null;
  status_id?: string | null;
}

/** The months after which a team's finished issues are archived. */
export type ArchivePeriodMonths = 1 | 3 | 6 | 9 | 12;

/**
 * A team's auto-archive period. Issues completed or canceled longer ago than
 * this leave the team's lists. `updated_at` is null until first saved.
 */
export interface ArchiveSettingsRead {
  team_id: string;
  period_months: ArchivePeriodMonths;
  updated_at: string | null;
}

/** The editable field of a team's auto-archive period. */
export interface ArchiveSettingsUpdate {
  period_months?: ArchivePeriodMonths;
}

/**
 * A team's SLA rules: whether they are on, and the hours an issue of each
 * priority may stay open before it breaches, null for no rule at that
 * priority. `updated_at` is null until first saved.
 */
export interface SlaSettingsRead {
  team_id: string;
  enabled: boolean;
  urgent_hours: number | null;
  high_hours: number | null;
  medium_hours: number | null;
  low_hours: number | null;
  updated_at: string | null;
}

/** The editable fields of a team's SLA rules. Hours are whole, 1 to 2160. */
export interface SlaSettingsUpdate {
  enabled?: boolean;
  urgent_hours?: number | null;
  high_hours?: number | null;
  medium_hours?: number | null;
  low_hours?: number | null;
}

/**
 * A team's triage switch. While on, issues filed by guests, integrations and
 * people outside the team wait in its triage inbox until someone works them.
 */
export interface TriageSettingsRead {
  team_id: string;
  enabled: boolean;
  updated_at: string | null;
}

/** The editable field of a team's triage switch. */
export interface TriageSettingsUpdate {
  enabled?: boolean;
}

/** One triage-enabled team and how many issues wait in it, snoozed ones aside. */
export interface TriageTeamCount {
  team_id: string;
  count: number;
}

/** Every visible team with triage on, for the sidebar badges. */
export interface TriageSummaryRead {
  teams: TriageTeamCount[];
}

/** Accepts a triage issue, into the named status or the team's first unstarted one. */
export interface TriageAccept {
  status_id?: string | null;
}

/** Declines a triage issue, with an optional reason kept in its history. */
export interface TriageDecline {
  reason?: string | null;
}

/** Closes a triage issue as a duplicate of another. */
export interface TriageDuplicate {
  duplicate_of_id: string;
}

/** Hides a triage issue until a moment, or brings it back with null. */
export interface TriageSnooze {
  until: string | null;
}

/** The filters the cycle list reads. The team is required. */
export interface CycleListQuery {
  team_id: string;
  status?: CycleStatus;
  cursor?: string;
  limit?: number;
}

/** How a project is tracking against its plan, as its lead last judged it. */
export type ProjectHealth = 'on_track' | 'at_risk' | 'off_track';

/** The glyphs a project can pick for its icon. */
export type ProjectIconName =
  | 'box'
  | 'rocket'
  | 'target'
  | 'flag'
  | 'zap'
  | 'star'
  | 'bug'
  | 'book'
  | 'code'
  | 'globe'
  | 'heart'
  | 'layers'
  | 'shield'
  | 'sparkles'
  | 'users'
  | 'wrench';

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
  icon: ProjectIconName | null;
  color: string | null;
  health: ProjectHealth | null;
  priority: IssuePriority;
  member_ids: string[];
  counts: RollupCounts;
  /** The same buckets weighted by estimate points. */
  points?: RollupCounts;
  /** Issues per status id, beside the category totals; empty until the project's first recount. */
  status_counts?: Record<string, number>;
  /** When the newest project update was posted, or null before the first. */
  last_update_at?: string | null;
  /** The cadence the project follows, its own or the workspace default. */
  update_interval_days?: ProjectUpdateInterval;
  /** Whether the cadence is the workspace default rather than the project's own. */
  update_interval_inherited?: boolean;
  /** When the next update is due, or null when the project never comes due. */
  next_update_due_at?: string | null;
  update_due_state?: ProjectUpdateDueState | null;
  /** The initiative the project belongs to, or null outside any. */
  initiative_id?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Days between project updates: off, weekly, every two weeks or monthly. */
export type ProjectUpdateInterval = 0 | 7 | 14 | 30;

/** Where a project stands against its update cadence. */
export type ProjectUpdateDueState = 'upcoming' | 'due' | 'overdue';

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
  icon?: ProjectIconName | null;
  color?: string | null;
  health?: ProjectHealth | null;
  priority?: IssuePriority;
  member_ids?: string[];
  update_interval_days?: ProjectUpdateInterval | null;
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
  icon?: ProjectIconName | null;
  color?: string | null;
  health?: ProjectHealth | null;
  priority?: IssuePriority;
  member_ids?: string[];
  /** A null returns the project to the workspace's cadence. */
  update_interval_days?: ProjectUpdateInterval | null;
  /** Moves the project into an initiative; a null takes it out of one. */
  initiative_id?: string | null;
}

/**
 * One stage of a project, in the project's manual order. `sort_order` is a
 * base 62 fractional key, so a drag rewrites only the row that moved, and
 * `counts` rolls up the issues filed under it the way a project's do.
 */
export interface MilestoneRead {
  milestone_id: string;
  project_id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  target_date: string | null;
  sort_order: string;
  counts: RollupCounts;
  /** The same buckets weighted by estimate points. */
  points?: RollupCounts;
  /** Issues per status id, beside the category totals. */
  status_counts?: Record<string, number>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** The body the milestone list answers with: the whole set, never paged. */
export interface MilestoneListRead {
  milestones: MilestoneRead[];
  next_cursor: string | null;
}

/** A new milestone. Without a `sort_order` it lands after the last one. */
export interface MilestoneCreate {
  name: string;
  description?: string | null;
  target_date?: string | null;
  sort_order?: string;
}

/** The editable fields on a milestone. A null clears the date or description. */
export interface MilestoneUpdate {
  name?: string;
  description?: string | null;
  target_date?: string | null;
  sort_order?: string;
}

/**
 * One written status update on a project or an initiative: a Markdown body and
 * the health it judged the subject at. Posting one sets the subject's health.
 * `can_edit` says whether the caller may edit or delete it.
 */
export interface StatusUpdateRead {
  update_id: string;
  workspace_id: string;
  body: string;
  health: ProjectHealth;
  author_id: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
  can_edit: boolean;
  /** Which client made the change; absent on rows written before sources were recorded. */
  source?: ChangeSource | null;
}

/** One written update on a project. */
export interface ProjectUpdateRead extends StatusUpdateRead {
  project_id: string;
}

/** One page of a project's updates, newest first. */
export interface ProjectUpdateListRead {
  updates: ProjectUpdateRead[];
  next_cursor: string | null;
}

/** A new project update. */
export interface ProjectUpdateCreate {
  body: string;
  health: ProjectHealth;
}

/** The editable fields of a project update. */
export interface ProjectUpdateEdit {
  body?: string;
  health?: ProjectHealth;
}

/** The paging a project's update list reads. */
export interface ProjectUpdateListQuery {
  cursor?: string;
  limit?: number;
}

/** Where an initiative stands: not begun, under way, or finished. */
export type InitiativeStatus = 'planned' | 'active' | 'completed';

/** How many of an initiative's projects report each health. */
export interface HealthBreakdownRead {
  on_track: number;
  at_risk: number;
  off_track: number;
  none: number;
}

/**
 * A workspace level initiative grouping projects across teams. The rollup
 * fields count only the projects the caller can see.
 */
export interface InitiativeRead {
  initiative_id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  owner_id: string | null;
  status: InitiativeStatus;
  health: ProjectHealth | null;
  target_date: string | null;
  project_ids: string[];
  project_count: number;
  counts: RollupCounts;
  points: RollupCounts;
  /** Issues per status id across the visible projects. */
  status_counts?: Record<string, number>;
  project_health: HealthBreakdownRead;
  last_update_at: string | null;
  update_interval_days: ProjectUpdateInterval;
  update_interval_inherited: boolean;
  next_update_due_at: string | null;
  update_due_state: ProjectUpdateDueState | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** One page of the workspace's initiatives, by target date. */
export interface InitiativeListRead {
  initiatives: InitiativeRead[];
  next_cursor: string | null;
}

/** The filters and paging the initiative list reads. */
export interface InitiativeListQuery {
  status?: InitiativeStatus;
  cursor?: string;
  limit?: number;
}

/** A new initiative. The status defaults to planned. */
export interface InitiativeCreate {
  name: string;
  description?: string | null;
  owner_id?: string | null;
  status?: InitiativeStatus;
  health?: ProjectHealth | null;
  target_date?: string | null;
  update_interval_days?: ProjectUpdateInterval | null;
}

/** The editable fields on an initiative. A null clears an owner or a date. */
export interface InitiativeUpdate {
  name?: string;
  description?: string | null;
  owner_id?: string | null;
  status?: InitiativeStatus;
  health?: ProjectHealth | null;
  target_date?: string | null;
  update_interval_days?: ProjectUpdateInterval | null;
}

/** One written update on an initiative. */
export interface InitiativeUpdateRead extends StatusUpdateRead {
  initiative_id: string;
}

/** One page of an initiative's updates, newest first. */
export interface InitiativeUpdateListRead {
  updates: InitiativeUpdateRead[];
  next_cursor: string | null;
}

/** The filters the project list reads. Without a team it is workspace wide. */
export interface ProjectListQuery {
  team_id?: string;
  status?: ProjectStatus;
  /** Only the projects in this initiative. */
  initiative_id?: string;
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
  icon?: ProjectIconName | null;
  color?: string | null;
  health?: ProjectHealth | null;
  priority?: IssuePriority | null;
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

/** A linked pull request's review decision. */
export type PullRequestReviewState =
  'none' | 'pending' | 'approved' | 'changes_requested';

/** The combined result of a linked pull request's checks on its head commit. */
export type PullRequestCiState = 'none' | 'pending' | 'success' | 'failure';

/**
 * Where a pull request sits in a stack of an issue's pull requests, counted
 * from the one based on the trunk. The state fields describe the whole stack.
 */
export interface PullRequestStackRead {
  stack_id: string;
  position: number;
  size: number;
  pr_state: 'open' | 'draft' | 'merged' | 'closed';
  review_state: PullRequestReviewState;
  ci_state: PullRequestCiState;
}

/**
 * One pull request linked to an issue. The pull request's own fields are
 * denormalised at write, so a link still renders without calling GitHub. The
 * branch, review, check and stack fields are absent from an older server.
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
  head_ref?: string;
  base_ref?: string;
  review_state?: PullRequestReviewState;
  ci_state?: PullRequestCiState;
  stack?: PullRequestStackRead | null;
  linked_at: string;
  updated_at: string;
}

/** Which way a team's issues sync with its linked repository. */
export type GithubSyncDirection = 'two_way' | 'github_to_standupless';

/**
 * A team's link to one repository whose issues it mirrors. A repository syncs
 * with at most one team, so a second team linking it is refused with a 409.
 */
export interface TeamSyncRead {
  team_id: string;
  repository_id: string;
  full_name: string;
  direction: GithubSyncDirection;
  enabled: boolean;
  sync_labels: boolean;
  /** Whether two way sync may hold on a public repository, publishing the team's issues there. */
  allow_public_two_way?: boolean;
  /** Whether the repository is private. A public one syncs one way unless two way is allowed. */
  repository_private?: boolean;
  /** When two way sync dropped to one way because the repository turned public. */
  public_demoted_at?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** What a team admin sets when linking a team to a repository. */
export interface TeamSyncWrite {
  repository_id: string;
  direction?: GithubSyncDirection;
  enabled?: boolean;
  sync_labels?: boolean;
  allow_public_two_way?: boolean;
}

/** The GitHub issue one Standupless issue mirrors. */
export interface IssueSyncRead {
  issue_id: string;
  repository_full_name: string;
  number: number;
  url: string;
  origin: 'github' | 'standupless';
  synced_at: string;
}

/** The resource types a webhook may subscribe to, in the order the form lists them. */
export const WEBHOOK_RESOURCE_TYPES = [
  'issues',
  'comments',
  'projects',
  'project_updates',
  'cycles',
  'labels',
] as const;

/** One resource type a webhook may subscribe to. */
export type WebhookResourceType = (typeof WEBHOOK_RESOURCE_TYPES)[number];

/**
 * One outbound webhook. `team_id` null means every team in the workspace.
 * `secret` is present only on the create and rotate responses, because it is
 * never stored in a readable form and so can never be shown again.
 * `disabled_reason` is set when delivery was switched off after repeated
 * failures rather than by a person.
 */
export interface WebhookEndpointRead {
  webhook_id: string;
  url: string;
  label: string;
  team_id: string | null;
  resource_types: WebhookResourceType[];
  enabled: boolean;
  secret_hint: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_status: number | null;
  last_delivery_at: string | null;
  consecutive_failures: number;
  disabled_reason: string | null;
  disabled_at: string | null;
  secret?: string | null;
}

/**
 * What registering a webhook takes. `team_id` is accepted only on the
 * workspace route; the team route forces its own team.
 */
export interface WebhookEndpointCreate {
  url: string;
  label: string;
  resource_types: WebhookResourceType[];
  enabled?: boolean;
  team_id?: string | null;
}

/**
 * What editing a webhook takes, every field optional. Enabling one that was
 * switched off after repeated failures clears its failure count server side.
 */
export interface WebhookEndpointUpdate {
  url?: string;
  label?: string;
  resource_types?: WebhookResourceType[];
  enabled?: boolean;
  team_id?: string | null;
}

/** Where one delivery stands. */
export type WebhookDeliveryState =
  'pending' | 'retrying' | 'delivered' | 'failed';

/** The change a delivery reports. `ping` is a test sent by hand. */
export type WebhookDeliveryAction = 'create' | 'update' | 'remove' | 'ping';

/**
 * One attempt at sending a delivery. `status_code` 0 means no response came
 * back: a timeout, a refused connection or a blocked address.
 */
export interface WebhookDeliveryAttempt {
  attempt: number;
  at: string;
  status_code: number;
  latency_ms: number;
  error: string | null;
  response_body: string;
}

/** One delivery in a webhook's log, with every attempt at sending it. */
export interface WebhookDeliveryRead {
  delivery_id: string;
  webhook_id: string;
  event_type: string;
  action: WebhookDeliveryAction;
  state: WebhookDeliveryState;
  is_test: boolean;
  redelivery_of: string | null;
  created_at: string;
  updated_at: string;
  next_attempt_at: string | null;
  attempts: WebhookDeliveryAttempt[];
  request_body: string;
  request_truncated: boolean;
}

/**
 * One transition rule. `is_default` marks a rule the team never configured,
 * which is the design section 4 fallback rather than a stored row. A
 * `branch_pattern` limits the rule to pull requests into a matching branch.
 */
export interface TransitionRead {
  transition_id: string;
  team_id: string;
  trigger: string;
  status_id: string | null;
  is_default: boolean;
  branch_pattern?: string | null;
}

/** What creating a transition rule takes. */
export interface TransitionCreate {
  trigger: string;
  status_id?: string | null;
  branch_pattern?: string | null;
}

/** What editing a transition rule takes; an empty pattern means any branch. */
export interface TransitionUpdate {
  status_id?: string | null;
  branch_pattern?: string | null;
}

/** A team's whole rule set, replaced at once; empty restores the defaults. */
export interface TransitionSet {
  rules: TransitionCreate[];
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
  'teams:write',
  'members:read',
  'members:write',
  'statuses:read',
  'statuses:write',
  'labels:read',
  'labels:write',
  'projects:read',
  'projects:write',
  'milestones:read',
  'milestones:write',
  'cycles:read',
  'cycles:write',
  'releases:read',
  'releases:write',
  'views:read',
  'views:write',
  'notifications:read',
  'notifications:write',
  'settings:read',
  'settings:write',
  'admin',
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
  /** A palette color name, or null for the category default. */
  color?: string | null;
  icon?: string | null;
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
  /** Media tokens for the attachments the body and comments embed. */
  media?: Record<string, string>;
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

/** Why one person follows an issue. */
export type SubscriptionReason =
  'creator' | 'assignee' | 'commenter' | 'mentioned' | 'manual';

/** One person following an issue. */
export interface SubscriberRead {
  user_id: string;
  display_name: string;
  reason: SubscriptionReason;
  created_at: string;
  /** The URL of the person's avatar image, or null when they use their initials. */
  avatar_url?: string | null;
}

/** An issue's subscribers, and whether the caller is one of them. */
export interface SubscribersRead {
  subscribers: SubscriberRead[];
  subscribed: boolean;
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

/** One workspace an OAuth client was authorized in, and what it may do there. */
export interface ConnectedAppWorkspaceRead {
  id: string;
  name: string;
  scopes: string[];
  authorized_at: string | null;
  last_used_at: string | null;
}

/** One OAuth client the caller authorized, across every workspace they granted it. */
export interface ConnectedAppRead {
  client_id: string;
  client_name: string;
  scopes: string[];
  first_authorized_at: string | null;
  last_used_at: string | null;
  workspaces: ConnectedAppWorkspaceRead[];
}

/** The person behind a grant, as a workspace admin sees them. */
export interface ConnectedAppMemberRead {
  id: string;
  display_name: string;
  email: string;
}

/** One member's grant to one OAuth client in a workspace. */
export interface WorkspaceConnectedAppRead {
  client_id: string;
  client_name: string;
  user: ConnectedAppMemberRead;
  scopes: string[];
  authorized_at: string | null;
  last_used_at: string | null;
}

/** A paid plan a workspace can check out on. */
export type PaidPlan = 'standard' | 'business';

/** How often a paid plan is billed. */
export type BillingInterval = 'month' | 'year';

/** The body `GET /api/workspaces/{id}/billing` answers with. */
export interface BillingRead {
  plan: string;
  billing_interval: BillingInterval | null;
  subscription_status: string | null;
  /** The seats the subscription bills for, or null on the free plan. */
  billed_seats: number | null;
  /** The owners, admins and members counted as seats today. */
  seats_in_use: number;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  /** Whether the workspace has a Stripe customer, which the portal needs. */
  has_billing_account: boolean;
  /** Whether paid plans are on sale at all. */
  billing_enabled: boolean;
  business_available: boolean;
  features: string[];
  limits: Record<string, number>;
  storage_bytes: number;
  guests_per_seat: number;
}

/** A Checkout Session request. */
export interface CheckoutCreate {
  plan: PaidPlan;
  interval: BillingInterval;
}

/** A hosted Stripe page the browser is sent to. */
export interface BillingSessionRead {
  url: string;
}

/** The body `GET /api/workspaces/{id}/attachments/usage` answers with. */
export interface StorageUsageRead {
  plan: string;
  used_bytes: number;
  limit_bytes: number;
}

/** What an insights breakdown can group issues by. */
export type InsightDimension =
  | 'status'
  | 'status_category'
  | 'assignee'
  | 'creator'
  | 'priority'
  | 'label'
  | 'project'
  | 'cycle'
  | 'estimate'
  | 'team';

/** What each insights bar measures: issues, or the sum of their estimate points. */
export type InsightMeasure = 'count' | 'points';

/**
 * One bar or bar segment. `key` is the raw value and null for the unset
 * bucket; `label` is resolved on the server. `color` is a status palette name
 * for statuses and a hex value for labels and projects.
 */
export interface InsightBucket {
  key: string | null;
  label: string;
  color: string | null;
  value: number;
  issue_count: number;
}

/** One bar, split by the segment dimension when one was asked for. */
export interface InsightGroup extends InsightBucket {
  segments: InsightBucket[];
}

/**
 * A breakdown of the issues a scope and filter select. Label bars can sum past
 * `total`, which counts each issue once. `truncated` means the figures cover
 * only the first `row_cap` issues read.
 */
export interface InsightsRead {
  team_ids: string[];
  view_id: string | null;
  group_by: InsightDimension;
  segment_by: InsightDimension | null;
  measure: InsightMeasure;
  total: number;
  issue_count: number;
  groups: InsightGroup[];
  truncated: boolean;
  row_cap: number;
}

/** The events a team channel may post, in the order the settings page lists them. */
export const CHANNEL_EVENTS = [
  'issue_created',
  'issue_status_changed',
  'issue_completed',
  'issue_assigned',
  'comment_created',
  'project_update_posted',
  'project_update_due',
] as const;

/** One event a team channel may post. */
export type ChannelEvent = (typeof CHANNEL_EVENTS)[number];

/** The chat services a team channel can post to. */
export type ChannelProvider = 'slack' | 'discord';

/** How a team channel posts: through its incoming webhook, or as the installed Slack App's bot. */
export type ChannelTransport = 'webhook' | 'slack_app';

/**
 * One Slack or Discord channel a team posts its notifications to. The webhook
 * URL is never returned; `url_hint` names the host and its last characters.
 * `disabled_reason` is set when the channel answered 404 or 410 and was
 * turned off rather than by a person.
 */
export interface ChannelRead {
  channel_id: string;
  team_id: string;
  provider: ChannelProvider;
  /** Absent from an older backend, which only had webhooks. */
  transport?: ChannelTransport;
  /** The Slack channel id a `slack_app` channel posts to, empty for a webhook. */
  slack_channel_id?: string;
  label: string;
  events: ChannelEvent[];
  enabled: boolean;
  url_hint: string;
  last_status: number | null;
  last_delivery_at: string | null;
  disabled_reason: string | null;
  disabled_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** One stage of a team's release pipeline. */
export interface PipelineStageRead {
  stage_id: string;
  name: string;
  /** The GitHub environments whose successful deployments mark this stage reached. */
  github_environments: string[];
  /** The status a release's issues move forward to when it reaches this stage, or null to leave them. */
  status_id?: string | null;
  /** Whether reaching this stage publishes a GitHub Release with the release notes. */
  publish_github_release?: boolean;
}

/** A team's ordered release stages. `configured` is false while it runs on the default. */
export interface ReleasePipelineRead {
  team_id: string;
  configured: boolean;
  stages: PipelineStageRead[];
}

/** One stage in a pipeline replacement. An existing stage keeps its id. */
export interface PipelineStageWrite {
  stage_id?: string | null;
  name: string;
  github_environments: string[];
  status_id?: string | null;
  publish_github_release?: boolean;
}

/** The body `PUT .../teams/{team_id}/release-pipeline` takes: every stage, in order. */
export interface ReleasePipelineUpdate {
  stages: PipelineStageWrite[];
}

/** What reported a release or a stage reached. */
export type ReleaseSource = 'manual' | 'api' | 'github_deployment';

/** One stage a release reached, when, and what reported it. */
export interface ReleaseStageRead {
  stage_id: string;
  name: string;
  reached_at: string;
  source: ReleaseSource;
  environment?: string | null;
  url?: string | null;
  actor_id?: string | null;
}

/** One release as a listing shows it. */
export interface ReleaseRead {
  release_id: string;
  team_id: string;
  workspace_id: string;
  name: string;
  version?: string | null;
  description?: string | null;
  source: ReleaseSource;
  repository_id?: string | null;
  /** The repository as `owner/name`, when the release came from one. */
  repository?: string | null;
  sha?: string | null;
  previous_sha?: string | null;
  url?: string | null;
  /** The pull request whose merge deployed this release, when there was one. */
  pr_number?: number | null;
  pr_url?: string | null;
  /** The GitHub Release published for this release, when a stage publishes one. */
  github_release_url?: string | null;
  issue_count: number;
  /** The issues the caller can see, counted by status category. */
  status_counts?: Partial<Record<StatusCategory, number>>;
  stages: ReleaseStageRead[];
  /** The furthest pipeline stage the release reached. */
  current_stage?: ReleaseStageRead | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * What adding a team channel takes: either an incoming webhook `url`, or the
 * `slack_channel_id` the installed Slack App's bot posts to, never both.
 */
export interface ChannelCreate {
  url?: string;
  slack_channel_id?: string;
  slack_channel_name?: string;
  label?: string;
  events: ChannelEvent[];
  enabled?: boolean;
}

/** What editing a team channel takes; unset fields are left alone. */
export interface ChannelUpdate {
  url?: string;
  label?: string;
  events?: ChannelEvent[];
  enabled?: boolean;
}

/** Whether this environment has a Slack App and whether this workspace installed it. */
export interface SlackConnectionRead {
  configured: boolean;
  installed: boolean;
  slack_team_id?: string | null;
  slack_team_name?: string | null;
  installed_by?: string | null;
  installed_at?: string | null;
}

/** One Slack channel the installed bot can post to. */
export interface SlackChannelRead {
  id: string;
  name: string;
  is_private: boolean;
}

/** What a test message got back. */
export interface ChannelTestRead {
  delivered: boolean;
  status_code: number;
  error: string | null;
}

/** One issue a release carried. */
export interface ReleaseIssueRead {
  issue_id: string;
  key: string;
  title: string;
  status_id: string;
  status_category?: StatusCategory | null;
}

/** One release with its issues and the notes built from them. */
export interface ReleaseDetailRead extends ReleaseRead {
  issues: ReleaseIssueRead[];
  /** One `KEY title` line per issue, in key order. */
  notes: string;
  /** The references a write named that matched no issue of the team. */
  skipped_issues?: string[];
}

/** One cursor page of a team's releases, newest first. */
export interface ReleaseListRead {
  releases: ReleaseRead[];
  next_cursor?: string | null;
}

/** The paging a release list takes. */
export interface ReleaseListQuery {
  cursor?: string;
  limit?: number;
}

/** The body `POST .../teams/{team_id}/releases` takes. Every field is optional. */
export interface ReleaseCreate {
  name?: string | null;
  version?: string | null;
  description?: string | null;
  /** A stage id or name; the pipeline's first stage when unset. */
  stage?: string | null;
  sha?: string | null;
  previous_sha?: string | null;
  repository?: string | null;
  url?: string | null;
  environment?: string | null;
  /** Issue keys or ids of the team. */
  issues?: string[];
  commit_messages?: string[];
}

/** A release patch. Only the fields named are written; null clears an optional one. */
export interface ReleaseUpdate {
  name?: string | null;
  version?: string | null;
  description?: string | null;
  url?: string | null;
}

/** The body that marks a release reached a stage, by id or name. */
export interface ReleaseStageAdvance {
  stage: string;
  environment?: string | null;
  url?: string | null;
}

/** The body that adds issues to a release, by key or id. */
export interface ReleaseIssuesAdd {
  issues: string[];
}

/** One release an issue shipped in, as the issue page names it. */
export interface IssueReleaseRead {
  release_id: string;
  team_id: string;
  name: string;
  current_stage?: ReleaseStageRead | null;
  created_at: string;
}

/** The releases one issue shipped in, newest first. */
export interface IssueReleaseListRead {
  releases: IssueReleaseRead[];
}

/** How often a team's standup digest is cut, or `off` for never. */
export type StandupCadence = 'off' | 'daily' | 'weekly';

/** The window shape one digest read covers. */
export type DigestCadence = 'daily' | 'weekly';

/** One issue line in a standup digest. */
export interface StandupItem {
  issue_id: string;
  key: string;
  title: string;
  status_id: string;
  project_id: string | null;
  project_name: string | null;
  due_date: string | null;
  at: string | null;
  /** How many comments the person left, on comment lines. */
  count: number;
}

/** A project update a person posted inside the digest window. */
export interface StandupProjectUpdate {
  update_id: string;
  project_id: string;
  project_name: string;
  health: ProjectHealth;
  body: string;
  created_at: string;
}

/** Everything one person did, and has open, for one digest. */
export interface StandupPerson {
  user_id: string;
  display_name: string;
  note: string | null;
  completed: StandupItem[];
  started: StandupItem[];
  commented: StandupItem[];
  blocked: StandupItem[];
  overdue: StandupItem[];
  due_soon: StandupItem[];
  project_updates: StandupProjectUpdate[];
}

/** The body `GET /api/workspaces/{id}/teams/{team}/standup` answers with. */
export interface StandupDigest {
  team_id: string;
  team_key: string;
  team_name: string;
  date: string;
  cadence: DigestCadence;
  timezone: string;
  send_time: string;
  window_start: string;
  window_end: string;
  generated_at: string;
  people: StandupPerson[];
}

/** A team's standup digest settings. */
export interface StandupSettingsRead {
  team_id: string;
  cadence: StandupCadence;
  /** The local send time, as HH:MM. */
  send_time: string;
  timezone: string;
  /** The weekly send day, 0 for Monday through 6 for Sunday. */
  weekday: number;
  next_digest_date: string;
  updated_at: string | null;
}

/** A partial change to a team's standup digest settings. */
export interface StandupSettingsUpdate {
  cadence?: StandupCadence;
  send_time?: string;
  timezone?: string;
  weekday?: number;
}

/** The caller's note for one digest date. */
export interface StandupNoteRead {
  team_id: string;
  user_id: string;
  date: string;
  body: string | null;
  updated_at: string | null;
}

/** The caller's note, written for the next digest when `date` is left out. */
export interface StandupNoteWrite {
  body: string;
  date?: string;
}

/** Where a workspace export job is: waiting, building, downloadable or failed. */
export type WorkspaceExportStatus = 'queued' | 'running' | 'ready' | 'failed';

/** The body that starts a workspace export. */
export interface WorkspaceExportCreate {
  include_emails?: boolean;
}

/**
 * One workspace export job. `download_url` is a short lived presigned link,
 * present only while the job is ready, and minted fresh on every read.
 */
export interface WorkspaceExportRead {
  export_id: string;
  workspace_id: string;
  status: WorkspaceExportStatus;
  format_version: number;
  requested_by: string;
  emails_masked: boolean;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  expires_at?: string | null;
  size_bytes?: number | null;
  counts: Record<string, number>;
  error?: string | null;
  download_url?: string | null;
  download_expires_at?: string | null;
}

/** The body the workspace export list answers with, newest first. */
export interface WorkspaceExportListRead {
  items: WorkspaceExportRead[];
}

/** The tracker an import file came from, which picks the default column mapping. */
export type ImportPreset = 'generic' | 'jira' | 'linear';

/** The issue fields a CSV column can map to. */
export type ImportField =
  | 'title'
  | 'description'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'labels'
  | 'estimate'
  | 'due_date'
  | 'source_key'
  | 'created_at';

/** The body both the dry run and the import take. A null mapping value unmaps that field. */
export interface IssueImportRequest {
  team_id: string;
  preset: ImportPreset;
  csv: string;
  file_name?: string;
  mapping?: Partial<Record<ImportField, string | null>> | null;
}

/** One problem with one row: an error skips the row, a warning drops one value. */
export interface RowProblemRead {
  row: number;
  field?: string | null;
  severity: 'error' | 'warning';
  message: string;
}

/** One dry run row as the issue it would become. */
export interface ImportRowRead {
  row: number;
  title: string;
  status_name: string;
  priority: string;
  assignee_id?: string | null;
  labels: string[];
  estimate?: string | null;
  due_date?: string | null;
  source_key?: string | null;
  created_at?: string | null;
  importable: boolean;
}

/** How many rows carry one source status, and the team status they land in. */
export interface StatusMappingRead {
  source: string;
  status_name: string;
  count: number;
}

/** What an import would do, computed without writing anything. */
export interface IssueImportPreviewRead {
  headers: string[];
  mapping: Partial<Record<ImportField, string | null>>;
  total_rows: number;
  importable_rows: number;
  problems: RowProblemRead[];
  problems_truncated: boolean;
  rows: ImportRowRead[];
  new_labels: string[];
  statuses: StatusMappingRead[];
}

/** Where an issue import job is. */
export type ImportStatus = 'queued' | 'running' | 'completed' | 'failed';

/** One issue import job and how far it has got. */
export interface IssueImportRead {
  import_id: string;
  workspace_id: string;
  team_id: string;
  preset: string;
  file_name: string;
  status: ImportStatus;
  requested_by: string;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  total_rows: number;
  processed_rows: number;
  created_count: number;
  skipped_count: number;
  labels_created: number;
  problem_count: number;
  problems: RowProblemRead[];
  problems_truncated: boolean;
  error?: string | null;
}

/** The body the import list answers with, newest first. */
export interface IssueImportListRead {
  items: IssueImportRead[];
}
