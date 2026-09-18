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
