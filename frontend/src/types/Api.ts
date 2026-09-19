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
  project_id: string;
  body: string;
  parent_comment_id: string | null;
  author_id: string;
  author: AuthorRead;
  mentions: string[];
  reactions: ReactionGroup[];
  reply_count: number;
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
  project_id: string;
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
  project_id: string;
  columns: BoardColumnRead[];
}

/** The filters the board read varies on, beyond the project itself. */
export interface BoardQuery {
  assignee_id?: string;
  label_id?: string;
  priority?: IssuePriority;
  cycle_id?: string;
  milestone_id?: string;
  column_limit?: number;
}

/** Whether a saved view renders as a list or a board. */
export type ViewKind = 'list' | 'board';

/** Whether a saved view belongs to one person or to a project. */
export type ViewScope = 'personal' | 'project';

/** How a saved view groups its rows. */
export type ViewGroupBy = 'status' | 'assignee' | 'priority' | 'label';

/** Which saved views a list read asks for. */
export type ViewListScope = 'mine' | 'project' | 'all';

/**
 * A saved view's stored filter. Each value is a scalar or a list of scalars,
 * where a list means "any of". An unknown key is refused on write with
 * `INVALID_FILTER`, so a view cannot silently widen when a field is renamed.
 */
export interface ViewFilter {
  project_id?: string | string[];
  status_id?: string | string[];
  status_category?: StatusCategory | StatusCategory[];
  assignee_id?: string | string[];
  label_id?: string | string[];
  priority?: IssuePriority | IssuePriority[];
  parent_id?: string | string[];
  cycle_id?: string | string[];
  milestone_id?: string | string[];
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
  project_id: string | null;
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
  project_id?: string | null;
}

/** The editable fields on a saved view. Neither kind nor project may move. */
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
  project_id: string;
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
  project_id: string;
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
