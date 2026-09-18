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

/** A role held on one project. */
export type ProjectRole = 'admin' | 'member';

/** A role an invite may carry. The contract never issues an owner invite. */
export type InviteRole = Exclude<WorkspaceRole, 'owner'>;

/** How a project sizes its issues. */
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

/** One project inside a workspace. */
export interface ProjectRead {
  id: string;
  workspace_id: string;
  name: string;
  key_prefix: string;
  description: string | null;
  estimate_scale: EstimateScale;
  created_at: string;
  updated_at: string;
  /** The caller's project role, implied from the workspace role when broader. */
  role?: ProjectRole;
}

/** The body the projects list route answers with. */
export interface ProjectListRead {
  projects: ProjectRead[];
}

/** A new project submission. */
export interface ProjectCreate {
  name: string;
  key_prefix: string;
  estimate_scale?: EstimateScale;
}

/** The editable fields on a project. */
export interface ProjectUpdate {
  name?: string;
  estimate_scale?: EstimateScale;
  description?: string | null;
}

/** One member of a project. */
export interface ProjectMemberRead {
  user_id: string;
  email: string;
  display_name: string | null;
  role: ProjectRole;
  added_at: string;
}

/** The body the project members route answers with. */
export interface ProjectMemberListRead {
  members: ProjectMemberRead[];
}

/** A role grant on one project member. */
export interface ProjectMemberUpdate {
  role: ProjectRole;
}

/** One workflow status on a project. */
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

/** One label on a project. */
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

/** One issue. Workspace scoped, so links and "my issues" can cross projects. */
export interface IssueRead {
  id: string;
  workspace_id: string;
  project_id: string;
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
  project_id: string;
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
}

/** The editable fields on an issue. The contract never moves one project. */
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
}

/**
 * The filters the issue list route reads. `assignee_id` accepts the literal
 * `me`, which the server resolves, so the caller never needs its own user id.
 */
export interface IssueListQuery {
  project_id?: string;
  status_id?: string;
  assignee_id?: string;
  label_id?: string;
  parent_id?: string;
  priority?: IssuePriority;
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
