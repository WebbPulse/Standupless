/**
 * Shapes the Standupless API returns, hand written against `docs/api/m1.md`
 * until a generated client exists. Every list body is an object with one plural
 * key, never a bare array.
 */

/** The signed in user, as the identity service reports it. */
export interface UserRead {
  id: string;
  email: string;
  /** The handle the person is mentioned by and the name shown beside their work. */
  display_name: string | null;
  /** The person's written name, or an empty string when none is set. */
  full_name?: string;
  email_verified: boolean;
  /** The URL of the person's avatar image, or null when they use their initials. */
  avatar_url?: string | null;
  /** The account wide email switch, which turns every kind's email off at once. */
  email_notifications?: boolean;
  /** Every notification kind's inbox and email switches, fully resolved. */
  notification_preferences?: Record<NotificationKind, NotificationChannels>;
  /** Whether the inbox splits into Priority and Other tabs. */
  priority_inbox?: boolean;
  /** Every kind the Priority tab holds, fully resolved. */
  priority_kinds?: InboxKind[];
  /** Whether notification emails are batched into a digest or sent one at a time. */
  email_format?: EmailFormat;
  /** Whether this session has a second factor, the claim a workspace auth policy checks. */
  two_factor?: boolean;
  /** The IANA zone due dates are judged in, or null when none is stored yet. */
  timezone?: string | null;
  /** How often the Pulse email digest goes out, or `off`. */
  pulse_digest?: PulseDigest;
  /** The page a workspace opens on. */
  home_view?: HomeView;
  /** The day the person's week starts on. */
  week_start?: WeekStart;
  /** Whether teammates read by username or full name. */
  name_display?: NameDisplay;
  /** The interface text size. */
  font_size?: FontSize;
  /** The interface theme, null until the person first saves one. */
  theme?: Theme | null;
  /** Whether interactive elements show the pointer cursor. */
  pointer_cursors?: boolean;
  /** Whether links in rich text and inline text links are underlined at rest. */
  underline_links?: boolean;
  /** The syntax highlighting theme of code blocks. */
  code_theme?: CodeTheme;
  /** Whether the editor turns typed emoticons such as `:)` into emoji. */
  convert_emoticons?: boolean;
  /** Whether issue activity shows every change or only comments. */
  activity_filter?: ActivityFilter;
  /** Where every sidebar item sits: shown, in the More menu, or hidden. */
  sidebar_items?: Record<SidebarItem, SidebarVisibility>;
  /** Whether the sidebar's unread badges show a count or a dot. */
  sidebar_badge_style?: SidebarBadgeStyle;
  /** How the projects page is laid out, grouped, ordered and windowed. */
  projects_display?: ProjectsDisplayPreference;
  /** Whether the person arranged the projects page, so their own arrangement wins over the defaults. */
  projects_display_saved?: boolean;
  /** How the initiatives page is ordered and which of its properties show. */
  initiatives_display?: InitiativesDisplayPreference;
  /** Whether the person arranged the initiatives page, so their own arrangement wins over the default. */
  initiatives_display_saved?: boolean;
  /** Whether issues the person creates start assigned to them. */
  auto_assign_to_self?: boolean;
  /** Whether copying a git branch name moves a backlog or unstarted issue to the team's first started status. */
  branch_copy_starts?: boolean;
  /** Whether copying a git branch name assigns an unassigned, not yet started issue to the person. */
  branch_copy_assigns?: boolean;
  /** Whether a connected app that took every scope gets scopes added later at its next refresh. */
  auto_grant_new_scopes?: boolean;
}

/** The initiatives page arrangement an account saves, every field filled. */
export interface InitiativesDisplayPreference {
  /** Whether the page draws the list or bars on a timeline from start to target date. */
  layout: 'list' | 'timeline';
  /** The timeline's scale, the same scales the projects timeline offers. */
  zoom: 'week' | 'month' | 'quarter' | 'year';
  /** What the list groups rows by: status, lead team, owner, health or the target date's period. */
  grouping: 'status' | 'team' | 'owner' | 'health' | 'target_date';
  /** How rows run inside each group; `manual` follows the shared manual position. */
  order: 'manual' | 'target' | 'name' | 'progress' | 'created' | 'updated';
  completed: 'show' | 'hide';
  /** The shown properties, comma separated in the list's own order. */
  columns: string;
}

/** The projects page arrangement an account saves, every field filled. */
export interface ProjectsDisplayPreference {
  layout: 'list' | 'board' | 'timeline';
  group:
    | 'status'
    | 'health'
    | 'priority'
    | 'initiative'
    | 'lead'
    | 'member'
    | 'team'
    | 'start_date'
    | 'target_date'
    | 'none';
  order:
    | 'target'
    | 'start'
    | 'name'
    | 'priority'
    | 'progress'
    | 'created'
    | 'updated'
    | 'customers'
    | 'important'
    | 'manual';
  closed: 'all' | 'fortnight' | 'month' | 'none';
  /** Whether groups run in their own order or reversed. */
  direction?: 'asc' | 'desc';
  /** The grouping inside each group. */
  rows?:
    | 'status'
    | 'health'
    | 'priority'
    | 'initiative'
    | 'lead'
    | 'member'
    | 'team'
    | 'start_date'
    | 'target_date'
    | 'none';
  /** Whether a team page keeps only the projects that team leads. */
  lead_team?: 'all' | 'lead';
  /** Whether the board shows columns that hold no project. */
  empty?: 'show' | 'hide';
  zoom: 'week' | 'month' | 'quarter' | 'year';
  /** Whether the timeline draws the lines between blocking and blocked projects. */
  dependencies?: 'show' | 'hide';
  /** The shown list columns, comma separated, absent on a row saved before columns could be chosen. */
  columns?: string;
}

/** The page a workspace opens on when the person enters it. */
export type HomeView =
  'home' | 'inbox' | 'my_issues' | 'projects' | 'pulse' | 'views';

/** The day a person's week starts on. */
export type WeekStart = 'monday' | 'sunday' | 'saturday';

/** Whether people read by their username or their full name. */
export type NameDisplay = 'username' | 'full_name';

/** The interface text size a person picked. */
export type FontSize = 'small' | 'default' | 'large';

/** The interface themes a person may pick. */
export type Theme = 'system' | 'light' | 'dark';

/** The syntax highlighting theme of code blocks, `app` following the interface theme. */
export type CodeTheme =
  'app' | 'light' | 'dark' | 'light_high_contrast' | 'dark_high_contrast';

/** Whether an issue's activity shows every change or only its comments. */
export type ActivityFilter = 'all' | 'comments';

/** A top-level workspace sidebar item a person may move or hide. */
export type SidebarItem =
  | 'home'
  | 'inbox'
  | 'my_issues'
  | 'reviews'
  | 'pulse'
  | 'projects'
  | 'initiatives'
  | 'customers'
  | 'views'
  | 'roadmap'
  | 'teams';

/** Where a sidebar item sits: in the sidebar, in its More menu, or nowhere. */
export type SidebarVisibility = 'show' | 'more' | 'hide';

/** Whether the sidebar's unread badges show a number or a dot. */
export type SidebarBadgeStyle = 'count' | 'dot';

/** How often a person's Pulse email digest goes out. */
export type PulseDigest = 'off' | 'daily' | 'weekly';

/** How notification emails arrive: batched into a short digest, or one per notification. */
export type EmailFormat = 'digest' | 'immediate';

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
  /** Whether the kind also reaches a linked Slack or Discord account as a direct message. */
  chat?: boolean;
}

/** A partial preferences change: only the switches sent are applied. */
export interface UserPreferencesUpdate {
  email_notifications?: boolean;
  notification_preferences?: Partial<
    Record<NotificationKind, Partial<NotificationChannels>>
  >;
  priority_inbox?: boolean;
  /** Replaces the whole set of kinds the Priority tab holds. */
  priority_kinds?: InboxKind[];
  email_format?: EmailFormat;
  timezone?: string;
  pulse_digest?: PulseDigest;
  home_view?: HomeView;
  week_start?: WeekStart;
  name_display?: NameDisplay;
  font_size?: FontSize;
  theme?: Theme;
  pointer_cursors?: boolean;
  underline_links?: boolean;
  code_theme?: CodeTheme;
  convert_emoticons?: boolean;
  activity_filter?: ActivityFilter;
  /** Moves the named sidebar items, leaving the others where they are. */
  sidebar_items?: Partial<Record<SidebarItem, SidebarVisibility>>;
  sidebar_badge_style?: SidebarBadgeStyle;
  /** Replaces the saved projects page arrangement whole, null forgets it. */
  projects_display?: ProjectsDisplayPreference | null;
  /** Replaces the saved initiatives page arrangement whole, null forgets it. */
  initiatives_display?: InitiativesDisplayPreference | null;
  auto_assign_to_self?: boolean;
  branch_copy_starts?: boolean;
  branch_copy_assigns?: boolean;
  auto_grant_new_scopes?: boolean;
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

/** How a workspace builds the git branch names its members copy. */
export type BranchFormat = 'key_title' | 'user_key_title' | 'key';

/** Who a workspace permission setting lets act: admins only, or every member. */
export type PermissionLevel = 'admins' | 'members';

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
  /** How every member's copied git branch names are built. */
  branch_format?: BranchFormat;
  /** Who may invite people, admins only by default. */
  invite_permission?: PermissionLevel;
  /** Who may create teams, every member by default. */
  team_creation_permission?: PermissionLevel;
  /** Whether members need an admin's approval before connecting a third-party app. */
  third_party_app_approvals?: boolean;
  /** The sign-in methods the workspace allows, when the session used another. */
  auth_policy_allowed_methods?: SignInMethod[] | null;
}

/** A way of signing in a workspace may allow or refuse. */
export type SignInMethod = 'password' | 'google' | 'github' | 'passkey';

/** Why a workspace's authentication policy refuses a session. */
export type AuthPolicyReason = 'two_factor' | 'sign_in_method' | 'sso';

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

/** The protocol a workspace's single sign-on connection speaks. */
export type SsoProtocol = 'oidc' | 'saml';

/** One single sign-on domain and the DNS TXT record that proves it. */
export interface SsoDomainRead {
  domain: string;
  verified: boolean;
  verified_at?: string | null;
  /** Whether the domain was verified and lost it because its TXT record went missing. */
  lapsed?: boolean;
  /** When the recheck found the record gone. */
  lapsed_at?: string | null;
  added_at: string;
  /** Where the TXT record goes. */
  record_name: string;
  /** Always TXT. */
  record_type: string;
  /** Exactly what the TXT record says. */
  record_value: string;
}

/** A workspace's stored single sign-on connection, never carrying its secret. */
export interface SsoConnectionRead {
  protocol: SsoProtocol;
  display_name: string;
  oidc_issuer: string;
  oidc_client_id: string;
  oidc_scopes: string[];
  has_client_secret: boolean;
  saml_idp_entity_id: string;
  saml_idp_sso_url: string;
  saml_certificate_count: number;
  /** Whether someone has finished a test sign-in since the connection was saved. */
  tested: boolean;
  tested_at?: string | null;
  updated_at: string;
}

/** What a workspace registers with its identity provider. */
export interface SsoServiceProviderRead {
  oidc_redirect_uri: string;
  saml_acs_url: string;
  saml_metadata_url: string;
  saml_entity_id: string;
}

/** Everything the single sign-on settings show, as `GET .../sso` answers it. */
export interface SsoSettingsRead {
  /** Whether the workspace's plan includes single sign-on. */
  available: boolean;
  domains: SsoDomainRead[];
  connection: SsoConnectionRead | null;
  require_sso: boolean;
  service_provider: SsoServiceProviderRead;
  /** Whether the caller's own session came through this workspace's connection. */
  current_session_sso: boolean;
  /** Whether single sign-on can be required now. */
  can_require: boolean;
}

/** One SCIM token, as the provisioning settings list it. The secret is never here. */
export interface ScimTokenRead {
  key_id: string;
  name: string;
  /** The first characters of the token, so a person can tell tokens apart. */
  prefix: string;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** A SCIM token just minted: the only response that carries its secret. */
export interface ScimTokenCreated extends ScimTokenRead {
  secret: string;
}

/** What `GET .../sso/scim` answers: where the directory connects and its tokens. */
export interface ScimSettingsRead {
  /** The SCIM 2.0 base URL to give the identity provider. */
  base_url: string;
  tokens: ScimTokenRead[];
}

/**
 * The body `PUT .../sso/connection` takes. A blank OIDC client secret keeps the
 * stored one; SAML takes either the metadata XML or the three provider values.
 */
export interface SsoConnectionUpdate {
  protocol: SsoProtocol;
  display_name?: string;
  oidc_issuer?: string;
  oidc_client_id?: string;
  oidc_client_secret?: string;
  oidc_scopes?: string[] | null;
  saml_metadata_xml?: string;
  saml_idp_entity_id?: string;
  saml_idp_sso_url?: string;
  saml_idp_certificate?: string;
}

/** The connection fields a `SSO_CONNECTION_INVALID` refusal can name. */
export type SsoConnectionField =
  | 'oidc_issuer'
  | 'oidc_client_id'
  | 'oidc_client_secret'
  | 'saml_metadata_xml'
  | 'saml_idp_entity_id'
  | 'saml_idp_sso_url'
  | 'saml_idp_certificate';

/** The workspace a single sign-on session belongs to, after joining it if needed. */
export interface SsoJoinRead {
  workspace_id: string;
  slug: string;
  name: string;
  /** Whether this call made the caller a member. */
  created: boolean;
}

/** The body `POST /api/auth/sso/start` takes: one of the ways to find the connection. */
export interface SsoStartRequest {
  email?: string;
  tenant?: string;
  connection_id?: string;
  return_to?: string;
}

/** Where the browser goes to sign in with the identity provider. */
export interface SsoStartRead {
  authorization_url: string;
  connection_id: string;
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
  branch_format?: BranchFormat;
  invite_permission?: PermissionLevel;
  team_creation_permission?: PermissionLevel;
  third_party_app_approvals?: boolean;
}

/** Where a member stands: active, suspended by an admin, or invited and not yet joined. */
export type MemberStatus = 'active' | 'suspended' | 'invited';

/** One member of a workspace. */
export interface MemberRead {
  user_id: string;
  email: string;
  display_name: string | null;
  role: WorkspaceRole;
  joined_at: string;
  /** The URL of the person's avatar image, or null when they use their initials. */
  avatar_url?: string | null;
  /** The person's written name, or an empty string when none is set. */
  full_name?: string;
  /** Handles the person gave up in a rename, which old mentions still use. */
  previous_handles?: string[];
  /** Whether the member is active, suspended or only invited. */
  status?: MemberStatus;
  /** When the member was suspended, or null while active. */
  suspended_at?: string | null;
  /** Who suspended the member, or null while active. */
  suspended_by?: string | null;
  /** The invite behind an invited row, or null for a member. */
  invite_id?: string | null;
}

/** A change to the caller's own name or handle. Fields left out keep their value. */
export interface UserProfileUpdate {
  full_name?: string;
  display_name?: string;
}

/** The body the workspace members route answers with. */
export interface MemberListRead {
  members: MemberRead[];
}

/** A role change on one workspace member. */
export interface MemberUpdate {
  role: WorkspaceRole;
}

/** The action a bulk member change applies to every member named. */
export type MemberBulkAction =
  'change_role' | 'suspend' | 'reactivate' | 'remove' | 'add_to_team';

/** One action on several workspace members: a role for a role change, a team to add them to. */
export interface MemberBulkUpdate {
  action: MemberBulkAction;
  user_ids: string[];
  role?: WorkspaceRole;
  team_id?: string;
}

/** What a bulk member change did to one member, with the reason when it was skipped. */
export interface MemberBulkResult {
  user_id: string;
  outcome: 'changed' | 'unchanged' | 'skipped';
  error_code?: string | null;
  message?: string | null;
  member?: MemberRead | null;
}

/** The answer to a bulk member change: a result per member and the tallies. */
export interface MemberBulkRead {
  results: MemberBulkResult[];
  changed: number;
  unchanged: number;
  skipped: number;
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
  /** The IANA timezone cycles start, end and roll over at midnight in. */
  timezone?: string;
  /** Whether only team members can see the team and its issues. */
  private?: boolean;
  /** The parent team this one sits under, or null for a top-level team. */
  parent_team_id?: string | null;
  /** When the team was retired, or null while it is active. A retired team is read-only. */
  retired_at?: string | null;
  /** The user who retired the team, or null while it is active. */
  retired_by?: string | null;
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
  /** The IANA timezone the team's cycles run in, UTC when left out. */
  timezone?: string | null;
  /** Make the team private from the start. Needs the Business plan. */
  private?: boolean;
  /** A top-level team to sit under, inheriting its statuses and labels. */
  parent_team_id?: string | null;
  /**
   * A team whose statuses, labels, templates, estimates and workflow settings
   * the new team starts with. Exclusive with `parent_team_id`.
   */
  copy_settings_from_team_id?: string | null;
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
  /** The IANA timezone the team's cycles run in. A sub-team takes its parent's. */
  timezone?: string | null;
  /** Whether linked pull requests carry the labels of this team's issues. */
  sync_pr_labels?: boolean;
  /** Turning this on needs the Business plan; turning it off never does. */
  private?: boolean;
  /** A top-level team to sit under, or null to make the team top-level. */
  parent_team_id?: string | null;
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
  /** The person's written name, or an empty string when none is set. */
  full_name?: string;
}

/** The body the team members route answers with. */
export interface TeamMemberListRead {
  members: TeamMemberRead[];
}

/** A role grant on one team member. */
export interface TeamMemberUpdate {
  role: TeamRole;
}

/** Whether a status or label is a team's own or inherited from the workspace or parent team. */
export type WorkflowScope = 'team' | 'workspace' | 'parent';

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
  /** Whether an issue may carry several labels of this group rather than one. */
  allow_multiple?: boolean;
  /** The group this label sits in, or null outside one. */
  parent_id?: string | null;
  /** A short description, carried to linked GitHub repositories. */
  description?: string | null;
}

/** The body the labels route answers with. */
export interface LabelListRead {
  labels: LabelRead[];
}

/**
 * What a label merge did. `complete` is false when a large merge ran out of
 * time for one request; calling the merge again with the same target resumes
 * it, and a merge already finished answers its result again.
 */
export interface LabelMergeRead {
  source_label_id: string;
  source_name: string;
  target: LabelRead;
  issues_updated: number;
  views_updated: number;
  templates_updated: number;
  complete: boolean;
}

/** A new label submission. */
export interface LabelCreate {
  name: string;
  color: string;
  /** Makes a label group. Set only at creation. */
  is_group?: boolean;
  /** For a group, lets an issue carry several of its labels. */
  allow_multiple?: boolean;
  /** The group to put the label in, of the same scope. */
  parent_id?: string | null;
  /** A short description, up to 100 characters. */
  description?: string | null;
}

/** The editable fields on a label. */
export interface LabelUpdate {
  name?: string;
  color?: string;
  /** Moves the label into this group, or out of its group with null. */
  parent_id?: string | null;
  /** A short description, or null to clear it. */
  description?: string | null;
  /** For a group, whether an issue may carry several of its labels. */
  allow_multiple?: boolean;
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
  | 'updated_desc'
  | 'created_desc'
  | 'key_asc'
  | 'priority_desc'
  | 'due_asc'
  | 'sla_asc'
  | 'status_asc'
  | 'start_asc'
  | 'estimate_desc'
  | 'customer_requests_desc'
  | 'customer_important_desc'
  | 'customer_revenue_desc'
  | 'completed_desc'
  | 'links_desc';

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
  | 'unarchived'
  | 'deleted'
  | 'restored'
  | 'subscriber_added'
  | 'subscriber_removed'
  | 'mentioned'
  | 'thread_resolved'
  | 'thread_unresolved';

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
  /**
   * The parent's key and title, which the list route fills on a sub-issue so a
   * row shown apart from its parent can still name it. Absent elsewhere.
   */
  parent_key?: string | null;
  parent_title?: string | null;
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
   * How many open issues this one blocks while its own status is open, zero
   * once it is completed or cancelled. Optional so older fixtures still type.
   */
  blocking_count?: number;
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
   * When the issue was moved to its team's trash, where it stays restorable
   * for 30 days. Null or absent for a live issue.
   */
  deleted_at?: string | null;
  /** Who moved the issue to the trash, set alongside `deleted_at`. */
  deleted_by?: string | null;
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
   * When the issue's SLA timer paused because it entered one of its team's
   * paused statuses, or null while the timer runs.
   */
  sla_paused_at?: string | null;
  /**
   * Where the issue stands against its SLA, derived by the server at read
   * time. Optional so a row read before SLAs existed reads as none.
   */
  sla_status?: SlaStatus;
  /**
   * The key or URL the issue carried in the tool it was imported from, such as
   * a Linear or Jira key. Null for issues created in Standupless.
   */
  external_ref?: string | null;
  /**
   * When the issue first landed in a started status, kept after it moves on.
   * Optional so a row read before it was stamped reads as none.
   */
  started_at?: string | null;
  /**
   * When the issue last landed in a completed status, null while it is open
   * or cancelled. Optional so a row read before it was stamped reads as none.
   */
  completed_at?: string | null;
  /**
   * When the issue landed in a cancelled status, null while it is anywhere
   * else. Optional so a row read before it was stamped reads as none.
   */
  cancelled_at?: string | null;
  /**
   * When the issue entered its current status, for time in status. Optional
   * so a row built on the client before the server stamps it reads its
   * creation instead.
   */
  status_changed_at?: string | null;
  /**
   * How many relations the issue carries, every kind counted. Optional so a
   * row read before it was counted reads as none.
   */
  relation_count?: number;
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

/** One team's recently deleted issues, the most recently deleted first. */
export interface DeletedIssueListRead {
  issues: IssueRead[];
  /** How many days a deleted issue stays restorable before it is purged. */
  retention_days: number;
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
  status_id?: string | null;
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
  /** A template that fills the fields left out; the create dialog sends it for a form or a template with sub-issues. */
  template_id?: string | null;
  /** A form template's answers by field key: text, or true and false for a checkbox. */
  form_answers?: Record<string, string | boolean> | null;
  /** The template sub-issues to create, by key; absent creates every one and an empty list none. */
  template_sub_issue_keys?: string[] | null;
}

/** What a template fills: a new issue, a new project, or a new document or update. */
export type TemplateKind = 'issue' | 'project' | 'document';

/** One milestone a project template adds, its target counted from the creation day. */
export interface ProjectTemplateMilestone {
  key?: string | null;
  name: string;
  description?: string | null;
  target_offset_days?: number | null;
}

/**
 * One issue a project template adds. `parent_key` names an issue listed
 * before it, making this a sub-issue, and `milestone_key` one of the
 * template's milestones.
 */
export interface ProjectTemplateIssue {
  key?: string | null;
  title: string;
  body?: string | null;
  status_id?: string | null;
  priority?: IssuePriority | null;
  assignee_id?: string | null;
  label_ids?: string[];
  estimate?: string | null;
  milestone_key?: string | null;
  parent_key?: string | null;
}

/**
 * What a project template fills, every field optional. The offsets are days
 * from the creation day to the start and target dates. Milestones and issues
 * sent without a key are given one, `m1` and `i1` onwards.
 */
export interface ProjectTemplateFields {
  description?: string | null;
  lead_id?: string | null;
  member_ids?: string[];
  status?: ProjectStatus | null;
  priority?: IssuePriority | null;
  icon?: ProjectIconName | null;
  color?: string | null;
  start_offset_days?: number | null;
  target_offset_days?: number | null;
  milestones?: ProjectTemplateMilestone[];
  issues?: ProjectTemplateIssue[];
}

/** A saved template milestone, which always has its key. */
export interface ProjectBlueprintMilestone extends ProjectTemplateMilestone {
  key: string;
}

/** A saved template issue, which always has its key. */
export interface ProjectBlueprintIssue extends ProjectTemplateIssue {
  key: string;
}

/** A saved project template's fields, milestones and issues. */
export interface ProjectBlueprint extends ProjectTemplateFields {
  member_ids: string[];
  milestones: ProjectBlueprintMilestone[];
  issues: ProjectBlueprintIssue[];
}

/** One sub-issue an issue template adds under every issue made from it; a key is given when left out, `s1` onwards. */
export type TemplateSubIssue = Omit<
  ProjectTemplateIssue,
  'milestone_key' | 'parent_key'
>;

/** A saved template sub-issue, which always has its key. */
export interface TemplateSubIssueRead extends TemplateSubIssue {
  key: string;
  label_ids: string[];
}

/** The answer a form field takes. */
export type FormFieldType = 'short_text' | 'long_text' | 'select' | 'checkbox';

/** One choice of a select field; choosing it puts its label and priority on the issue. */
export interface FormOption {
  value: string;
  label_id?: string | null;
  priority?: IssuePriority | null;
}

/** One question a form template asks. A field sent without a key is given one, `f1` onwards. */
export interface FormField {
  key?: string | null;
  label: string;
  type?: FormFieldType;
  required?: boolean;
  description?: string | null;
  options?: FormOption[];
}

/** A saved form field, which always has its key, type and options. */
export interface FormFieldRead extends FormField {
  key: string;
  type: FormFieldType;
  required: boolean;
  options: FormOption[];
}

/** The issue fields a template fills, every one optional. */
export interface TemplateFields {
  title?: string | null;
  body?: string | null;
  status_id?: string | null;
  priority?: IssuePriority | null;
  assignee_id?: string | null;
  estimate?: string | null;
  project_id?: string | null;
  project_milestone_id?: string | null;
  cycle_id?: string | null;
  /** Zero-based place in the picker; a create without one goes to the end. */
  position?: number | null;
}

/** A new template: a name and any of the issue fields. */
export interface TemplateCreate extends TemplateFields {
  name: string;
  label_ids?: string[];
  /** A project template sends `project` and none of the issue fields. */
  kind?: TemplateKind;
  project?: ProjectTemplateFields | null;
  /** The questions that make an issue template a form. */
  form_fields?: FormField[];
  /** The sub-issues an issue template creates under each issue made from it. */
  sub_issues?: TemplateSubIssue[];
}

/** A template patch: only the fields sent change, and null clears one. */
export interface TemplateUpdate extends TemplateFields {
  name?: string;
  label_ids?: string[] | null;
  /** Replaces a project template's whole blueprint. */
  project?: ProjectTemplateFields | null;
  /** Replaces a form's questions; null or an empty list turns the form off. */
  form_fields?: FormField[] | null;
  /** Replaces an issue template's sub-issues; null or an empty list removes them. */
  sub_issues?: TemplateSubIssue[] | null;
}

/**
 * One issue template. `scope` says where it comes from as the team asked
 * about sees it: its own, its parent team's or the workspace's.
 */
export interface TemplateRead {
  id: string;
  name: string;
  team_id: string | null;
  scope: WorkflowScope;
  title: string | null;
  body: string | null;
  status_id: string | null;
  priority: IssuePriority | null;
  assignee_id: string | null;
  label_ids: string[];
  estimate: string | null;
  project_id: string | null;
  project_milestone_id: string | null;
  cycle_id: string | null;
  /** Absent on an older answer, which is an issue template. */
  kind?: TemplateKind;
  /** A project template's blueprint; null on an issue template. */
  project?: ProjectBlueprint | null;
  /** A form template's questions; empty, or absent on an older answer, on any other template. */
  form_fields?: FormFieldRead[];
  /** An issue template's sub-issues, in order; empty, or absent on an older answer, on any other template. */
  sub_issues?: TemplateSubIssueRead[];
  position: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** The templates a team offers, and the one its create dialog opens with. */
export interface TemplateListRead {
  templates: TemplateRead[];
  default_template_id: string | null;
}

/** A team's saved default template and the one it falls back to from its parent. */
export interface TemplateSettingsRead {
  team_id: string;
  default_template_id: string | null;
  effective_default_template_id: string | null;
  default_project_template_id?: string | null;
  effective_default_project_template_id?: string | null;
  default_document_template_id?: string | null;
  effective_default_document_template_id?: string | null;
  default_update_template_id?: string | null;
  effective_default_update_template_id?: string | null;
}

/** The body that sets or clears a team's defaults; only the fields sent change. */
export interface TemplateSettingsUpdate {
  default_template_id?: string | null;
  default_project_template_id?: string | null;
  default_document_template_id?: string | null;
  default_update_template_id?: string | null;
}

/**
 * The document templates a project or initiative offers: its teams' and the
 * workspace's, or the workspace's alone for an initiative, with the ones its
 * new document flow and update composer open with.
 */
export interface DocumentTemplateListRead {
  templates: TemplateRead[];
  default_document_template_id: string | null;
  default_update_template_id: string | null;
}

/** How often a recurring issue repeats. */
export type RecurringFrequency = 'daily' | 'weekly' | 'monthly';

/** Why the system paused a recurring issue, or null when a person did. */
export type RecurringPausedReason =
  'template_deleted' | 'creator_cannot_write' | 'create_failed';

/** The rule fields a recurring issue create and patch share. */
export interface RecurringIssueFields {
  interval?: number;
  /** Weekly days to run, 0 (Monday) to 6 (Sunday). */
  weekdays?: number[];
  /** Monthly day to run; past a short month's end it runs on the last day. */
  day_of_month?: number | null;
  /** Local time of day as HH:MM. */
  time?: string;
  /** IANA timezone; a create without one takes the team's standup timezone. */
  timezone?: string;
  /** First local date as YYYY-MM-DD. */
  starts_on?: string;
}

/** A new recurring issue: a template, a rule, and whether it starts paused. */
export interface RecurringIssueCreate extends RecurringIssueFields {
  template_id: string;
  frequency: RecurringFrequency;
  paused?: boolean;
}

/** A recurring issue patch: only the fields sent change; `paused` pauses or resumes. */
export interface RecurringIssueUpdate extends RecurringIssueFields {
  template_id?: string;
  frequency?: RecurringFrequency;
  paused?: boolean;
}

/**
 * One recurring issue. `next_run_at` is when the next issue is due, null while
 * paused; the hourly sweep creates it within the hour after.
 */
export interface RecurringIssueRead {
  id: string;
  team_id: string;
  template_id: string;
  /** The template's name, null once it is deleted. */
  template_name: string | null;
  frequency: RecurringFrequency;
  interval: number;
  weekdays: number[];
  day_of_month: number | null;
  time: string;
  timezone: string;
  starts_on: string;
  paused: boolean;
  paused_reason: RecurringPausedReason | null;
  next_run_at: string | null;
  upcoming_runs: string[];
  last_run_at: string | null;
  last_issue_id: string | null;
  last_issue_key: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** A team's recurring issues and the timezone new ones default to. */
export interface RecurringIssueListRead {
  recurring_issues: RecurringIssueRead[];
  default_timezone: string;
}

/** The optional body a duplicate takes: whether the sub-issue tree is copied too. */
export interface IssueDuplicate {
  include_sub_issues?: boolean;
}

/** The body that moves an issue to another team, which gives it a new key. */
export interface IssueMove {
  team_id: string;
}

/**
 * What converting an issue into a project answers: the new project, the
 * issue as it was closed into it, and the sub-issues moved into the project.
 */
export interface IssueConversionRead {
  project: ProjectRead;
  issue: IssueRead;
  moved_issue_ids: string[];
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
 * The web app, GitHub and jobs render unlabelled; the rest show "via MCP",
 * "via email" and the like.
 */
export type ChangeSource =
  'web' | 'mcp' | 'cli' | 'api' | 'github' | 'system' | 'email';

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

/** One kept version of an issue's description: the text, who wrote it and when. */
export interface IssueDescriptionVersionRead {
  version_id: string;
  issue_id: string;
  body: string;
  edited_by: string;
  edited_at: string;
  source?: ChangeSource | null;
}

/** An issue's description versions, newest first; the newest is the current text. */
export interface IssueDescriptionVersionListRead {
  versions: IssueDescriptionVersionRead[];
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
 * The passage of the issue description a root comment is pinned to: the
 * quoted text and a little of the text either side, which finds it again
 * among repeats. The description itself is never rewritten.
 */
export interface CommentAnchor {
  quote: string;
  prefix?: string;
  suffix?: string;
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
  /** Where a root comment's thread is mirrored on GitHub, when it is. */
  github_thread?: GithubThread | null;
  /** Who resolved a root comment's thread and when, while it is resolved. */
  resolution?: ThreadResolution | null;
  /** The description passage a root comment is pinned to, when it is. */
  anchor?: CommentAnchor | null;
  /** The document the comment was written on; null on an issue's comment. */
  document_id?: string | null;
  created_at: string;
  edited_at: string | null;
}

/**
 * A resolved thread's mark, held on its root comment. Any team member may set
 * or clear it, and a reply to the thread clears it.
 */
export interface ThreadResolution {
  resolved_by: string;
  resolved_at: string;
}

/**
 * Where a root comment's thread is mirrored on GitHub. `private` is the
 * repository's visibility when it was synced, and `comment_url` is the App's
 * opening comment there, empty until that post lands.
 */
export interface GithubThread {
  kind: 'pull_request' | 'issue';
  repository_id: string;
  full_name: string;
  number: number;
  target_url: string;
  private: boolean;
  synced_by: string;
  synced_at: string;
  comment_url: string;
}

/** A linked pull request or GitHub issue a thread may be synced to. */
export interface GithubThreadTargetRead {
  kind: 'pull_request' | 'issue';
  repository_id: string;
  full_name: string;
  number: number;
  title: string;
  url: string;
  private: boolean;
  ref: string;
}

/** Which linked pull request or GitHub issue to sync a thread to. */
export interface GithubThreadWrite {
  repository_id: string;
  number: number;
}

/** One root comment's thread sync, with no thread once it is unsynced. */
export interface GithubThreadRead {
  comment_id: string;
  issue_id: string;
  github_thread?: GithubThread | null;
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
  /** Pins a new thread to a passage of the description; never on a reply. */
  anchor?: CommentAnchor | null;
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
  /** The document a comment target was written on, in place of `issue_id`. */
  document_id?: string;
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

/** One custom workspace emoji: its shortcode, image and who uploaded it. */
export interface CustomEmojiRead {
  name: string;
  shortcode: string;
  url: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
}

/** Every custom emoji of a workspace, by name. */
export interface CustomEmojiListRead {
  emoji: CustomEmojiRead[];
}

/** Names an uploaded image as a custom emoji. */
export interface CustomEmojiCreate {
  name: string;
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
export type ViewScope = 'personal' | 'team' | 'workspace';

/** How a saved view groups its rows: a property, or one label group as `label_group:<id>`. */
export type ViewGroupBy =
  | 'status'
  | 'assignee'
  | 'priority'
  | 'label'
  | 'milestone'
  | 'project'
  | 'cycle'
  | 'parent'
  | 'team'
  | 'sla'
  | 'customer'
  | 'release'
  | `label_group:${string}`;

/** Which saved views a list read asks for. */
export type ViewListScope = 'mine' | 'team' | 'workspace' | 'all';

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
  created_after?: string;
  created_before?: string;
  updated_after?: string;
  updated_before?: string;
  team_id_in?: string | string[];
  creator_id?: string | string[];
  sla_status?: SlaStatus | SlaStatus[];
  is_blocked?: 'true' | 'false';
  is_blocking?: 'true' | 'false';
  has_relation?: string | string[];
  customer_id?: string | string[];
  release_id?: string | string[];
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
  /** Whether the caller follows the view and hears when issues enter it. */
  subscribed?: boolean;
  /** How many members follow the view. */
  subscriber_count?: number;
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

/**
 * One search hit. `score` is the matched term count, not a relevance score.
 * The status fields style its glyph, and an issue waiting in triage reads as
 * the Triage status.
 */
export interface SearchResultRead {
  issue_id: string;
  key: string;
  title: string;
  team_id: string;
  status_id: string;
  status_name?: string | null;
  status_category?: StatusCategory | null;
  status_color?: string | null;
  status_icon?: string | null;
  assignee_id: string | null;
  priority?: string | null;
  updated_at: string;
  score: number;
}

/** One project whose name or description holds every searched term. */
export interface SearchProjectRead {
  project_id: string;
  name: string;
  status: ProjectStatus;
  status_id?: string;
  health: ProjectHealth | null;
  icon: string | null;
  color: string | null;
  lead_id: string | null;
  team_ids: string[];
  target_date: string | null;
  target_date_resolution?: DateResolution | null;
  updated_at: string;
}

/** One initiative whose name or description holds every searched term. */
export interface SearchInitiativeRead {
  initiative_id: string;
  name: string;
  status: InitiativeStatus;
  health: ProjectHealth | null;
  owner_id: string | null;
  target_date: string | null;
  target_date_resolution?: DateResolution | null;
  updated_at: string;
}

/** One comment holding every searched term, with an excerpt around the match. */
export interface SearchCommentRead {
  comment_id: string;
  issue_id: string;
  issue_key: string;
  issue_title: string;
  team_id: string;
  author_id: string;
  snippet: string;
  created_at: string;
  /** The document a hit was written on; issue fields are empty when set. */
  document_id?: string | null;
  document_title?: string | null;
}

/** The kinds of record a search can be narrowed to. */
export type SearchType =
  'issues' | 'projects' | 'initiatives' | 'documents' | 'comments';

/** The body the search route answers with. It is capped rather than paged. */
export interface SearchListRead {
  results: SearchResultRead[];
  /** Documents whose title or body matches, for a workspace wide search. */
  documents?: DocumentSummaryRead[];
  /** Projects on a visible team, or on the one team a search is narrowed to. */
  projects?: SearchProjectRead[];
  /** Initiatives, for a workspace wide search by a member. */
  initiatives?: SearchInitiativeRead[];
  /** Comments on issues in a visible team, newest first. */
  comments?: SearchCommentRead[];
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
  | 'subscribed'
  | 'project_update'
  | 'project_update_comment'
  | 'project_update_due'
  | 'initiative_update_due'
  | 'due_soon'
  | 'overdue'
  | 'reminder'
  | 'standup_digest'
  | 'sla_at_risk'
  | 'sla_breached'
  | 'review_requested'
  | 'triage_new'
  | 'view_issue_added'
  | 'view_project_added'
  | 'reaction'
  | 'issue_completed'
  | 'issue_cancelled'
  | 'priority_urgent'
  | 'blocking_changed'
  | 'document_comment'
  | 'team_issue_created';

/** Which of one team's issue events reach the caller's inbox, every one off by default. */
export interface TeamNotificationSubscriptionRead {
  team_id: string;
  issue_created: boolean;
  triage: boolean;
  completed: boolean;
  cancelled: boolean;
}

/** One team issue event a person can subscribe to. */
export type TeamSubscriptionEvent = Exclude<
  keyof TeamNotificationSubscriptionRead,
  'team_id'
>;

/** The team events to turn on or off; any left out keep their current value. */
export type TeamNotificationSubscriptionUpdate = Partial<
  Record<TeamSubscriptionEvent, boolean>
>;

/**
 * Every kind an inbox row can carry: the ones a member can tune, the notice a
 * team admin gets when a Slack or Discord channel was turned off, and the
 * notices an admin gets when a workspace export or an issue import finishes or
 * fails, and the notices a third-party app approval sends to admins and to the
 * member who asked.
 */
export type InboxKind =
  | NotificationKind
  | 'channel_disabled'
  | 'export_ready'
  | 'export_failed'
  | 'import_ready'
  | 'import_failed'
  | 'app_approval_requested'
  | 'app_approval_decided';

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
  /** The initiative an `initiative_update_due` row is about; null on every other row. */
  initiative_id?: string | null;
  initiative_name?: string | null;
  /** Whether an `initiative_update_due` row's update is due or overdue. */
  due_state?: 'due' | 'overdue' | null;
  /** The digest date a `standup_digest` row is about; null on every other row. */
  standup_date?: string | null;
  /** The document a `document_comment` row is about; null on every other row. */
  document_id?: string | null;
  document_title?: string | null;
  actor_id: string;
  actor_name: string;
  unread: boolean;
  snoozed_until?: string | null;
  /** Which client made the change; absent on rows written before sources were recorded. */
  source?: ChangeSource | null;
  /** The pull request a `review_requested` row points at; null on every other row. */
  url?: string | null;
  /** The status a `status_changed` row moved to, a reaction's emoji, or a blocking row's change and other issue; absent on older rows. */
  new_value?: string | null;
  /** The line the row reads, such as "Olive moved to Done"; absent on older clients' fixtures. */
  summary?: string;
  created_at: string;
  expires_at: string;
}

/** The body the inbox list answers with, newest first. */
export interface NotificationListRead {
  notifications: NotificationRead[];
  next_cursor: string | null;
}

/** One tab of the split inbox, or both. */
export type InboxBucket = 'all' | 'priority' | 'other';

/**
 * The unread counts, each capped and reported as 100 above 100: everything,
 * each tab of the split inbox, and the sidebar badge, which counts Priority
 * alone while the split is on.
 */
export interface InboxCountRead {
  unread: number;
  priority_unread?: number;
  other_unread?: number;
  priority_inbox?: boolean;
  badge?: number;
}

/** What a mark-read call takes: named rows, or every row. */
export type InboxReadWrite =
  | { notification_ids: string[] }
  | { all: true; kinds?: string[]; bucket?: InboxBucket };

/** What a mark-unread call takes: the rows to bring back as unread. */
export interface InboxUnreadWrite {
  notification_ids: string[];
}

/** What a snooze call takes: the rows to hide and the timezone aware moment they return. */
export interface InboxSnoozeWrite {
  notification_ids: string[];
  until: string;
}

/** What setting a reminder takes: the timezone aware moment it comes due. */
export interface IssueReminderWrite {
  remind_at: string;
}

/**
 * One pending reminder the caller set on an issue. It is the caller's own, so
 * nobody else sees it, and at `remind_at` it becomes a `reminder` inbox row.
 */
export interface IssueReminderRead {
  issue_id: string;
  issue_key: string;
  issue_title: string;
  team_id: string;
  remind_at: string;
  created_at: string;
}

/** The caller's pending reminders, soonest first. */
export interface IssueReminderListRead {
  reminders: IssueReminderRead[];
}

/** How many rows a mark-read call changed. */
export interface InboxReadResult {
  updated: number;
}

/**
 * Which of the caller's rows a bulk delete removes: read rows only, rows about
 * completed or cancelled issues, or every row, with snoozed rows only when asked,
 * optionally narrowed to some kinds.
 */
export interface InboxClearWrite {
  read_only?: boolean;
  include_snoozed?: boolean;
  completed_only?: boolean;
  kinds?: string[];
  bucket?: InboxBucket;
}

/** How many rows a bulk delete removed. */
export interface InboxClearResult {
  deleted: number;
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
  /**
   * On the cycle list, the days with no live cycle before this one, drawn as
   * "Cycles paused"; null on the first live cycle, a cancelled one and other reads.
   */
  gap_before_days?: number | null;
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

/**
 * Where the recent completion rate takes a project's remaining scope.
 * `rate_per_day` is in the project's measure. `expected_date` is null when
 * nothing was completed recently or the finish is out of sight, and
 * `days_past_target` is negative when the finish lands before the target.
 */
export interface ProjectProjectionRead {
  rate_per_day: number;
  expected_date: string | null;
  days_past_target: number | null;
}

/**
 * A project's daily history from the day its series opens to today, recorded
 * by the rollup as the project's issues move. `recorded_since` is null while
 * nothing has been recorded, and `days` then holds today alone.
 */
export interface ProjectHistoryRead {
  project_id: string;
  start_date: string | null;
  target_date: string | null;
  target_date_resolution?: DateResolution | null;
  today: string;
  measure: 'points' | 'issues';
  recorded_since: string | null;
  days: CycleHistoryPoint[];
  projection: ProjectProjectionRead | null;
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

/** Starting a team's next upcoming cycle today. The team names the row. */
export interface CycleStartToday {
  team_id: string;
}

/** Ending a team's current cycle at the close of today. The team names the row. */
export interface CycleEndToday {
  team_id: string;
}

/**
 * What starting a cycle today changed: the started cycle, the current one it
 * ended, which is null in a cooldown, and how many open issues moved across.
 */
export interface CycleStartTodayRead {
  cycle: CycleRead;
  ended: CycleRead | null;
  moved_issues: number;
}

/**
 * The caller's cycle calendar feed for one team. `url` is present only on the
 * answer to minting, the one time the secret URL is shown; a read says only
 * whether a feed is active.
 */
export interface CycleCalendarFeedRead {
  team_id: string;
  active: boolean;
  created_at?: string | null;
  url?: string | null;
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
  auto_add_completed?: boolean;
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
  auto_add_completed?: boolean;
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

/** Whether a team closes a parent with its last sub-issue and open sub-issues with their parent. */
export interface ParentAutoCloseSettingsRead {
  team_id: string;
  close_parent: boolean;
  close_sub_issues: boolean;
  updated_at: string | null;
}

/** The switches of a team's parent and sub-issue auto-close; a field left out keeps its value. */
export interface ParentAutoCloseSettingsUpdate {
  close_parent?: boolean;
  close_sub_issues?: boolean;
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
 * A team's SLA rules: whether they are on, the hours an issue of each
 * priority may stay open before it breaches, null for no rule at that
 * priority, and the open statuses whose time does not count toward a breach.
 * `updated_at` is null until first saved.
 */
/** When a team's SLA timers start: once an issue leaves triage, or from when it was created. */
export type SlaStartMode = 'on_triage_exit' | 'on_creation';

export interface SlaSettingsRead {
  team_id: string;
  enabled: boolean;
  urgent_hours: number | null;
  high_hours: number | null;
  medium_hours: number | null;
  low_hours: number | null;
  /** Open statuses that pause the timer. Optional so an older answer reads as none. */
  paused_status_ids?: string[];
  /** When timers start. Optional so an older answer reads as on_triage_exit. */
  start_mode?: SlaStartMode;
  updated_at: string | null;
}

/**
 * The editable fields of a team's SLA rules. Hours are whole, 1 to 2160.
 * `paused_status_ids` replaces the paused set, at most 50 open statuses.
 * `start_mode` applies from each issue's next move, leaving running timers alone.
 */
export interface SlaSettingsUpdate {
  enabled?: boolean;
  urgent_hours?: number | null;
  high_hours?: number | null;
  medium_hours?: number | null;
  low_hours?: number | null;
  paused_status_ids?: string[] | null;
  start_mode?: SlaStartMode;
}

/** What triage duty does as an issue enters the inbox: tell everyone on duty, or assign one of them. */
export type TriageResponsibilityAction = 'notify' | 'assign';

/**
 * A team's triage settings. While on, issues filed by guests, integrations and
 * people outside the team wait in its triage inbox until someone works them.
 * The members on duty are notified of each issue that enters, or one of them,
 * round robin, is assigned it; `require_priority` holds an accept until the
 * issue has a priority.
 */
export interface TriageSettingsRead {
  team_id: string;
  enabled: boolean;
  responsible_user_ids: string[];
  responsibility_action: TriageResponsibilityAction;
  require_priority: boolean;
  /** The team's triage rules, in the order they run. */
  rules?: TriageRuleRead[];
  updated_at: string | null;
}

/** The editable fields of a team's triage settings; an omitted field keeps its value. */
export interface TriageSettingsUpdate {
  enabled?: boolean;
  responsible_user_ids?: string[];
  responsibility_action?: TriageResponsibilityAction;
  require_priority?: boolean;
  /** The whole ordered rule list, replacing the saved one. */
  rules?: TriageRuleBody[];
}

/** Where an issue came from, as a triage rule filters on it. */
export type TriageRuleSource =
  'web' | 'form' | 'mcp' | 'cli' | 'api' | 'github' | 'system';

/**
 * What an issue entering triage must match. Every field given must hold, a
 * list matches any of its values, and an empty filter matches every issue.
 */
export interface TriageRuleFilter {
  label_ids?: string[];
  priorities?: IssuePriority[];
  creator_ids?: string[];
  sources?: TriageRuleSource[];
  /** A case-insensitive substring of the title or description. */
  text?: string | null;
}

/** What a matching rule does; `team_id` moves the issue to that team. */
export interface TriageRuleActions {
  add_label_ids?: string[];
  priority?: Exclude<IssuePriority, 'none'> | null;
  assignee_id?: string | null;
  project_id?: string | null;
  team_id?: string | null;
}

/** One triage rule as the API returns it. */
export interface TriageRuleRead {
  rule_id: string;
  name: string;
  /** False when switched off, or when a target was deleted. */
  enabled: boolean;
  /** Whether later rules still run after this one applies. */
  continue_after: boolean;
  filter: TriageRuleFilter;
  actions: TriageRuleActions;
  /** Why the rule is off because a label, project, user or team it names was deleted. */
  warning?: string | null;
}

/** One triage rule as a settings patch sends it; a rule without `rule_id` is new. */
export interface TriageRuleBody {
  rule_id?: string | null;
  name: string;
  enabled?: boolean;
  continue_after?: boolean;
  filter?: TriageRuleFilter;
  actions: TriageRuleActions;
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

/**
 * Accepts a triage issue, into the named status or the team's first unstarted
 * one. A non-blank `comment` is posted on the issue as the person accepting,
 * and `priority` is set in the same write.
 */
export interface TriageAccept {
  status_id?: string | null;
  comment?: string | null;
  priority?: IssuePriority | null;
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
  /** Also list the cycles of the team's sub-teams the caller can see. */
  include_sub_teams?: boolean;
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

/** How precise a planning date is: an exact day, or a whole month, quarter, half or year. */
export type DateResolution = 'day' | 'month' | 'quarter' | 'half' | 'year';

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
  start_date_resolution?: DateResolution | null;
  target_date: string | null;
  target_date_resolution?: DateResolution | null;
  status: ProjectStatus;
  /** The workspace project status the project sits in, within `status`. */
  status_id?: string;
  icon: ProjectIconName | null;
  color: string | null;
  health: ProjectHealth | null;
  priority: IssuePriority;
  member_ids: string[];
  counts: RollupCounts;
  /** The same buckets weighted by estimate points. */
  points?: RollupCounts;
  /** The unit `progress` reads in: points when a team on it estimates, otherwise issues. */
  measure?: 'points' | 'issues';
  /** The buckets scope and completion are measured by, in `measure`. */
  progress?: RollupCounts;
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
  /** The manual position, a base 62 fractional key; null on a project never placed. */
  sort_order?: string | null;
  /** Issues still open in the project, answered by a patch that leaves it completed or canceled. */
  open_issue_count?: number | null;
  /** When the project last became completed or canceled, null while it is open. */
  completed_at?: string | null;
  /** Template issues left out, answered by a create from a project template, empty when none were. */
  skipped_template_issues?: SkippedTemplateIssueRead[] | null;
  /** The visible projects that block this one, oldest link first. */
  blocked_by_project_ids?: string[];
  /** The visible projects this one blocks, oldest link first. */
  blocking_project_ids?: string[];
  /** The project's dated milestones, earliest first, filled on the project list. */
  milestone_markers?: ProjectMilestoneMarkerRead[];
  /** The project's Resources links in their manual order, filled on a single project read. */
  links?: ProjectLinkRead[] | null;
  /** How many customer requests name the project, set when the list was filtered or sorted by customer. */
  customer_request_count?: number | null;
  /** How many of those requests are marked important, set alongside the request count. */
  customer_important_count?: number | null;
  /** The summed revenue of the customers asking, set when the list was sorted by revenue. */
  customer_revenue?: number | null;
  /** The project labels it carries, in the order they were set. */
  label_ids?: string[];
  /** The short project id: the lowercased tail of `project_id`. */
  slug_id?: string;
  /** When the project was archived, null while it is live. */
  archived_at?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** One project label: the workspace's one set of labels for projects. */
export interface ProjectLabelRead {
  id: string;
  name: string;
  color: string;
  description: string | null;
  /** How many projects the caller can see carry the label. */
  project_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * One workspace project status: a named stage inside one of the six fixed
 * categories, which every rule reads. The six seeded defaults have the
 * category as their id.
 */
export interface ProjectStatusRead {
  id: string;
  name: string;
  category: ProjectStatus;
  color: string | null;
  description: string | null;
  position: number;
  /** The first status of its category, where a bare category lands. */
  is_default: boolean;
  /** How many projects the caller can see sit in the status. */
  project_count: number;
  created_at: string;
  updated_at: string;
}

/** The body the project status list answers with, by category then position. */
export interface ProjectStatusListRead {
  statuses: ProjectStatusRead[];
}

/** A new project status; names are unique ignoring case. */
export interface ProjectStatusCreate {
  name: string;
  category: ProjectStatus;
  color?: string | null;
  description?: string | null;
  position?: number;
}

/** The editable fields on a project status; a null color clears it. */
export interface ProjectStatusUpdate {
  name?: string;
  color?: string | null;
  description?: string | null;
  position?: number;
}

/** The body the project label list answers with, in name order. */
export interface ProjectLabelListRead {
  labels: ProjectLabelRead[];
}

/** A new project label; names are unique ignoring case. */
export interface ProjectLabelCreate {
  name: string;
  color: string;
  description?: string | null;
}

/** The editable fields on a project label; an empty description clears it. */
export interface ProjectLabelUpdate {
  name?: string;
  color?: string;
  description?: string | null;
}

/** One dated milestone of a project, as the timeline marks it on the lane. */
export interface ProjectMilestoneMarkerRead {
  milestone_id: string;
  name: string;
  target_date: string;
  /** Every issue in the milestone is finished, and it holds at least one. */
  completed: boolean;
  /** The milestone's issue counts. */
  counts?: RollupCounts;
  /** The unit `progress` reads in: points when a team on it estimates, otherwise issues. */
  measure?: 'points' | 'issues';
  /** The buckets scope and completion are measured by, in `measure`. */
  progress?: RollupCounts;
}

/** One template issue a project created from a template left out, and why. */
export interface SkippedTemplateIssueRead {
  /** The issue's key within the template. */
  key: string;
  title: string;
  /** Why the issue rules refused it. */
  reason: string;
}

/** How a project dependency reads from the project it is listed on. */
export type ProjectRelationType = 'blocks' | 'blocked_by';

/** One dependency between two projects, read from the side of `project_id`. */
export interface ProjectRelationRead {
  relation_id: string;
  type: ProjectRelationType;
  project_id: string;
  target_project_id: string;
  created_by: string;
  created_at: string;
}

/** A dependency to add between a project and another one. */
export interface ProjectRelationCreate {
  type: ProjectRelationType;
  target_project_id: string;
}

/** The body the project relation list answers with, whole and never paged. */
export interface ProjectRelationListRead {
  relations: ProjectRelationRead[];
  next_cursor: string | null;
}

/** What a project close does with the issues still open in it. */
export type ProjectOpenIssuesAction = 'keep' | 'move' | 'cancel';

/** The open issue choice on a close; `project_id` names the move target and only a move. */
export interface ProjectOpenIssues {
  action: ProjectOpenIssuesAction;
  project_id?: string;
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
  /** A project template one of the teams offers, filling the fields left out. */
  template_id?: string | null;
  name: string;
  description?: string | null;
  lead_id?: string | null;
  start_date?: string | null;
  start_date_resolution?: DateResolution | null;
  target_date?: string | null;
  target_date_resolution?: DateResolution | null;
  status?: ProjectStatus;
  /** A workspace project status by id; `status` then may only name its category. */
  status_id?: string;
  icon?: ProjectIconName | null;
  color?: string | null;
  health?: ProjectHealth | null;
  priority?: IssuePriority;
  member_ids?: string[];
  label_ids?: string[];
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
  start_date_resolution?: DateResolution | null;
  target_date?: string | null;
  target_date_resolution?: DateResolution | null;
  status?: ProjectStatus;
  /** A workspace project status by id; a bare category keeps a status already in it. */
  status_id?: string;
  icon?: ProjectIconName | null;
  color?: string | null;
  health?: ProjectHealth | null;
  priority?: IssuePriority;
  member_ids?: string[];
  /** Replaces the project labels; an empty list clears them. */
  label_ids?: string[];
  /** A null returns the project to the workspace's cadence. */
  update_interval_days?: ProjectUpdateInterval | null;
  /** Moves the project into an initiative; a null takes it out of one. */
  initiative_id?: string | null;
  /** The manual position, a base 62 fractional key shared by every viewer. */
  sort_order?: string;
  /** What to do with the open issues, taken only by a patch that completes or cancels the project. */
  open_issues?: ProjectOpenIssues;
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
  /** The unit `progress` reads in: points when a team on it estimates, otherwise issues. */
  measure?: 'points' | 'issues';
  /** The buckets scope and completion are measured by, in `measure`. */
  progress?: RollupCounts;
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

/** A milestone turned into its own project: the new project and the issues moved into it. */
export interface MilestoneConversionRead {
  project: ProjectRead;
  moved_issue_ids: string[];
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
 * One external link in a project's Resources: a web URL and an optional title.
 * Readers show the hostname when there is no title.
 */
export interface ProjectLinkRead {
  link_id: string;
  project_id: string;
  workspace_id: string;
  url: string;
  title: string | null;
  sort_order: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** The body the link list answers with: the whole set, never paged. */
export interface ProjectLinkListRead {
  links: ProjectLinkRead[];
  next_cursor: string | null;
}

/** A new link. Without a `sort_order` it lands after the last one. */
export interface ProjectLinkCreate {
  url: string;
  title?: string | null;
  sort_order?: string;
}

/** The editable fields on a link. A null title clears it. */
export interface ProjectLinkUpdate {
  url?: string;
  title?: string | null;
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

/**
 * One written update on a project. `reactions` and `comment_count` summarise
 * its thread, so the feed shows the reaction bar and reply toggle without a
 * read per card.
 */
export interface ProjectUpdateRead extends StatusUpdateRead {
  project_id: string;
  reactions?: ReactionGroup[];
  comment_count?: number;
  /** Where the project stood when the update was posted; absent on updates from before snapshots. */
  snapshot?: ProjectUpdateSnapshot | null;
  /** The snapshot the update before this one recorded, or null for a first update. */
  previous_snapshot?: ProjectUpdateSnapshot | null;
  /** Whether the author hid the progress report for everyone. */
  hide_details?: boolean;
}

/** One milestone's progress when a project update was posted. */
export interface MilestoneSnapshot {
  milestone_id: string;
  name: string;
  completed: number;
  total: number;
}

/**
 * Where a project stood when an update was posted. `total` is the scope with
 * cancelled work left out, and `percent` is a whole number.
 */
export interface ProjectUpdateSnapshot {
  measure: 'points' | 'issues';
  completed: number;
  total: number;
  percent: number;
  target_date: string | null;
  target_date_resolution: DateResolution | null;
  lead_id: string | null;
  lead_name: string | null;
  status: ProjectStatus | null;
  status_id: string | null;
  status_name: string | null;
  milestones: MilestoneSnapshot[];
}

/**
 * One reply on a project update. `can_edit` says whether the caller may edit
 * or delete it: its author, a workspace admin or an admin of a project team.
 */
export interface ProjectUpdateCommentRead {
  comment_id: string;
  update_id: string;
  project_id: string;
  workspace_id: string;
  body: string;
  author_id: string;
  author: AuthorRead;
  mentions: string[];
  reactions: ReactionGroup[];
  source?: ChangeSource | null;
  created_at: string;
  edited_at: string | null;
  can_edit: boolean;
}

/** An update's whole thread, oldest reply first. */
export interface ProjectUpdateCommentListRead {
  comments: ProjectUpdateCommentRead[];
}

/** A reaction on a project update, or on one of its replies when `comment_id` is set. */
export interface ProjectUpdateReactionWrite {
  emoji: string;
  comment_id?: string;
}

/** One page of a project's updates, newest first. */
export interface ProjectUpdateListRead {
  updates: ProjectUpdateRead[];
  next_cursor: string | null;
}

/** What one project activity row records. */
export type ProjectActivityKind =
  | 'created'
  | 'field_changed'
  | 'milestone_added'
  | 'milestone_removed'
  | 'milestone_changed'
  | 'milestone_converted'
  | 'converted_from_milestone'
  | 'link_added'
  | 'link_removed'
  | 'link_changed'
  | 'archived'
  | 'unarchived';

/**
 * One recorded change to a project: a property a patch moved, with its old and
 * new value, or a milestone or Resources link added, changed or removed, named
 * in `to` or, once removed, in `from`.
 */
export interface ProjectActivityRead {
  activity_id: string;
  project_id: string;
  actor_id: string;
  kind: ProjectActivityKind;
  field: string | null;
  from: unknown;
  to: unknown;
  milestone_id: string | null;
  /** The Resources link a link row is about, null on every other row. */
  link_id?: string | null;
  source?: ChangeSource | null;
  created_at: string;
}

/** One page of a project's activity, newest first. */
export interface ProjectActivityListRead {
  activity: ProjectActivityRead[];
  next_cursor: string | null;
}

/** A new project update. */
export interface ProjectUpdateCreate {
  body: string;
  health: ProjectHealth;
  /** Hides the progress report for everyone; project updates only. */
  hide_details?: boolean;
}

/** The editable fields of a project update. */
export interface ProjectUpdateEdit {
  body?: string;
  health?: ProjectHealth;
  /** Hides or shows the progress report; project updates only. */
  hide_details?: boolean;
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

/** An initiative named by id and name, as a breadcrumb draws it. */
export interface InitiativeRef {
  initiative_id: string;
  name: string;
}

/**
 * A workspace level initiative grouping projects across teams. It may sit
 * under a parent as a sub-initiative, and the rollup fields take in every
 * sub-initiative below it, counting only the projects the caller can see.
 */
export interface InitiativeRead {
  initiative_id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  owner_id: string | null;
  /** The lead team, or null for a workspace level initiative. A private lead team hides it from everyone outside. */
  team_id?: string | null;
  status: InitiativeStatus;
  health: ProjectHealth | null;
  /** When the initiative opens; a coarse start is its period's first day. */
  start_date?: string | null;
  start_date_resolution?: DateResolution | null;
  target_date: string | null;
  target_date_resolution?: DateResolution | null;
  /** The initiative this one sits under, or null at the top level. */
  parent_initiative_id?: string | null;
  /** The chain of parents, root first. */
  ancestors?: InitiativeRef[];
  /** The initiatives directly below this one. */
  sub_initiative_ids?: string[];
  /** The visible projects held directly. */
  project_ids: string[];
  /** The visible projects of this initiative and every sub-initiative below it. */
  rollup_project_ids?: string[];
  /** How many projects the rollup covers. */
  project_count: number;
  counts: RollupCounts;
  points: RollupCounts;
  /** The unit `progress` reads in: points when a team on it estimates, otherwise issues. */
  measure?: 'points' | 'issues';
  /** The buckets scope and completion are measured by, in `measure`. */
  progress?: RollupCounts;
  /** Issues per status id across the visible projects. */
  status_counts?: Record<string, number>;
  project_health: HealthBreakdownRead;
  last_update_at: string | null;
  update_interval_days: ProjectUpdateInterval;
  update_interval_inherited: boolean;
  next_update_due_at: string | null;
  update_due_state: ProjectUpdateDueState | null;
  /** The shared manual position, a base 62 fractional key, or null when never placed. */
  sort_order?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** One day of an initiative's progress graph, in the series' measure. */
export interface InitiativeProgressPoint {
  date: string;
  scope: number;
  started: number;
  completed: number;
}

/**
 * An initiative's scope, started and completed work per day across its
 * subtree. `days` runs through today and `end_date` is where the axis ends.
 */
export interface InitiativeProgressRead {
  initiative_id: string;
  measure: 'points' | 'issues';
  start_date: string;
  end_date: string;
  days: InitiativeProgressPoint[];
}

/** One page of the workspace's initiatives, by target date. */
export interface InitiativeListRead {
  initiatives: InitiativeRead[];
  next_cursor: string | null;
}

/** The filters and paging the initiative list reads. */
export interface InitiativeListQuery {
  status?: InitiativeStatus;
  /** One lead team's initiatives, or `none` for the workspace level ones. */
  team_id?: string;
  cursor?: string;
  limit?: number;
}

/** A new initiative. The status defaults to planned. */
export interface InitiativeCreate {
  name: string;
  description?: string | null;
  owner_id?: string | null;
  team_id?: string | null;
  status?: InitiativeStatus;
  health?: ProjectHealth | null;
  start_date?: string | null;
  start_date_resolution?: DateResolution | null;
  target_date?: string | null;
  target_date_resolution?: DateResolution | null;
  update_interval_days?: ProjectUpdateInterval | null;
  parent_initiative_id?: string | null;
}

/** The editable fields on an initiative. A null clears an owner, the team, a date or the parent. */
export interface InitiativeUpdate {
  name?: string;
  description?: string | null;
  owner_id?: string | null;
  team_id?: string | null;
  status?: InitiativeStatus;
  health?: ProjectHealth | null;
  start_date?: string | null;
  start_date_resolution?: DateResolution | null;
  target_date?: string | null;
  target_date_resolution?: DateResolution | null;
  update_interval_days?: ProjectUpdateInterval | null;
  parent_initiative_id?: string | null;
  /** The shared manual position, a base 62 fractional key. */
  sort_order?: string;
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

/** Which Pulse feed a page reads: what the caller follows, the last two weeks' updates by engagement, or everything they may read. */
export type PulseScope = 'for_me' | 'popular' | 'recent';

/** What one Pulse entry reports. */
export type PulseEventType =
  | 'project_update'
  | 'initiative_update'
  | 'project_health'
  | 'initiative_health'
  | 'milestone_completed';

/** One Pulse entry, with the project or initiative it is about. */
export interface PulseItemRead {
  event_id: string;
  workspace_id: string;
  event_type: PulseEventType;
  subject_type: 'project' | 'initiative';
  project_id: string | null;
  project_name: string | null;
  project_icon: ProjectIconName | null;
  project_color: string | null;
  initiative_id: string | null;
  initiative_name: string | null;
  milestone_id: string | null;
  milestone_name: string | null;
  update_id: string | null;
  body: string | null;
  health: ProjectHealth | null;
  previous_health: ProjectHealth | null;
  /** Who made it, or null for what no person did, such as a milestone its last issue completed. */
  actor_id: string | null;
  /** Who made it, as a name to show; empty when no person did. */
  actor_name: string;
  source: ChangeSource | null;
  created_at: string;
  edited_at: string | null;
  unread: boolean;
}

/** One page of the caller's Pulse, newest first. */
export interface PulseListRead {
  items: PulseItemRead[];
  next_cursor: string | null;
}

/** How many entries of the caller's Pulse are unread. */
export interface PulseCountRead {
  unread: number;
}

/** When the caller last marked their Pulse read. */
export interface PulseReadMarker {
  read_at: string;
}

/** Whether the caller follows a project or initiative, and whether that is their own choice. */
export interface PulseFollowRead {
  following: boolean;
  explicit: boolean;
}

/** The filters the project list reads. Without a team it is workspace wide. */
export interface ProjectListQuery {
  team_id?: string;
  /** A category, or one workspace project status by id. */
  status?: string;
  /** Only the projects in this initiative. */
  initiative_id?: string;
  /** With `team_id`, also list the projects of its sub-teams the caller can see. */
  include_sub_teams?: boolean;
  /** Only the projects these customers asked for, `none` for projects no customer asked for. */
  customer_id?: string[];
  /** Leaves out the projects these customers asked for, `none` for projects no customer asked for. */
  customer_id_not?: string[];
  sort?: ProjectSortField;
  /** Lists archived projects too, which the list leaves out by default. */
  include_archived?: boolean;
  cursor?: string;
  limit?: number;
}

/** How the projects route orders its rows, target date first by default. */
export type ProjectSortField =
  | 'target_asc'
  | 'customer_requests_desc'
  | 'customer_important_desc'
  | 'customer_revenue_desc';

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
  target_date_resolution?: DateResolution | null;
  start_date: string | null;
  start_date_resolution?: DateResolution | null;
  status: string;
  /** A project entry's workspace project status. */
  status_id?: string | null;
  icon?: ProjectIconName | null;
  color?: string | null;
  health?: ProjectHealth | null;
  priority?: IssuePriority | null;
  counts: RollupCounts;
  /** The unit `progress` reads in: points when a team on it estimates, otherwise issues. */
  measure?: 'points' | 'issues';
  /** The buckets scope and completion are measured by, in `measure`. */
  progress?: RollupCounts;
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
  /** What records the pinned team's releases from this repository. */
  release_source?: RepositoryReleaseSource;
}

/** What records a repository's releases: its deployments, its tags, or its published GitHub Releases. */
export interface RepositoryReleaseSource {
  kind: 'deployments' | 'tags' | 'github_releases';
  /** A glob the tags must match, such as `v*`, or null for every tag. */
  tag_pattern: string | null;
  /** The status a tag release moves the issues it closes to, or null for the team's Done. */
  status_id: string | null;
  move_issues: boolean;
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
  /** Whether the workspace labels are pushed to every repository the App sees. */
  label_set: GithubLabelSetRead;
}

/** The workspace label set push: on or off, and whether public repositories get it. */
export interface GithubLabelSetRead {
  enabled: boolean;
  include_public: boolean;
  /** True on a write that turned the push on and queued the first run. */
  queued: boolean;
}

/** Turns the workspace label set push on or off. */
export interface GithubLabelSetWrite {
  enabled: boolean;
  include_public: boolean;
}

/** A linked pull request's review decision. */
export type PullRequestReviewState =
  'none' | 'pending' | 'approved' | 'changes_requested';

/** The combined result of a linked pull request's checks on its head commit. */
export type PullRequestCiState = 'none' | 'pending' | 'success' | 'failure';

/** Where a pull request sits on the caller's Reviews list. */
export type ReviewGroup = 'needs_review' | 'changes_requested' | 'approved';

/** One issue a pull request on the Reviews list links, among those the caller can see. */
export interface ReviewIssueRead {
  issue_id: string;
  key: string;
  title: string;
  team_id: string;
}

/** One pull request waiting on the caller as a reviewer. */
export interface ReviewItemRead {
  repository_id: string;
  repository_full_name: string;
  number: number;
  title: string;
  url: string;
  author_login: string;
  state: 'open' | 'draft';
  group: ReviewGroup;
  review_state: PullRequestReviewState;
  ci_state: PullRequestCiState;
  created_at: string | null;
  updated_at: string | null;
  issues: ReviewIssueRead[];
}

/** How many pull requests sit in each Reviews group. */
export type ReviewCountsRead = Record<ReviewGroup, number>;

/**
 * The caller's Reviews list, in the order the page draws it. `github_linked`
 * is false when the caller has linked no GitHub account.
 */
export interface ReviewsRead {
  github_linked: boolean;
  counts: ReviewCountsRead;
  items: ReviewItemRead[];
}

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

/**
 * One pull request a linked issue the caller can see points at, as the `#`
 * reference picker and a pull request chip read it. `issue_keys` names only
 * the linked issues the caller can see.
 */
export interface PullRequestHitRead {
  repository_full_name: string;
  number: number;
  title: string;
  url: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  author_login: string;
  issue_keys: string[];
  updated_at: string;
}

/** The pull requests matching a picker query, exact references first. */
export interface PullRequestSearchRead {
  pull_requests: PullRequestHitRead[];
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

/** One live create by email address of a team, or of one of its templates. */
export interface EmailIntakeRead {
  team_id: string;
  /** The template the address files with, or null for the team's own address. */
  template_id: string | null;
  /** Where mail is sent: `<team key>-<token>@<intake domain>`. */
  address: string;
  /** Who turned the address on; the issues it files are created as them. */
  enabled_by: string;
  created_at: string;
  updated_at: string;
}

/** A team's live create by email addresses, its own first. */
export interface EmailIntakeList {
  team_id: string;
  /** Whether this deployment takes intake mail at all. */
  available: boolean;
  addresses: EmailIntakeRead[];
}

/** Which address a change names: a template's, or the team's when absent. */
export interface EmailIntakeWrite {
  template_id?: string | null;
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
  /** Scopes offered since this grant was made that it does not cover yet. */
  new_scopes?: string[];
  authorized_at: string | null;
  last_used_at: string | null;
}

/** One OAuth client the caller authorized, across every workspace they granted it. */
export interface ConnectedAppRead {
  client_id: string;
  client_name: string;
  scopes: string[];
  /** Scopes some grant to this client does not cover yet, offered as new permissions. */
  new_scopes?: string[];
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

/** Where a third-party app stands with a workspace's admins. */
export type AppApprovalStatus = 'pending' | 'approved' | 'denied';

/** Who requested or decided an app approval. */
export interface AppApprovalPersonRead {
  id: string;
  display_name: string;
}

/** One third-party app's approval record in a workspace. */
export interface AppApprovalRead {
  client_id: string;
  client_name: string;
  status: AppApprovalStatus;
  requested_by?: AppApprovalPersonRead | null;
  request_reason?: string;
  requested_at?: string | null;
  decided_by?: AppApprovalPersonRead | null;
  decision_reason?: string;
  decided_at?: string | null;
  updated_at: string;
}

/** Every approval record in a workspace, and whether approvals are required. */
export interface AppApprovalListRead {
  enabled: boolean;
  approvals: AppApprovalRead[];
}

/** What the request access page shows for the app a member was stopped on. */
export interface AppAccessRequestRead {
  workspace_id: string;
  workspace_name: string;
  client_id: string;
  client_name: string;
  return_to: string;
  enabled: boolean;
  approval?: AppApprovalRead | null;
}

/** Which local folder an agent profile file belongs under. */
export type AgentProfileRoot = 'home' | 'project' | 'memory';

/** One of the caller's private agent profiles, with its latest version's size. */
export interface AgentProfileRead {
  name: string;
  latest_version: number;
  file_count: number;
  total_bytes: number;
  note?: string;
  created_at: string;
  updated_at: string;
}

/** The caller's agent profiles and the limits they are kept under. */
export interface AgentProfileListRead {
  profiles: AgentProfileRead[];
  versions_kept: number;
  max_profiles: number;
}

/** One kept version of an agent profile, without its files. */
export interface AgentProfileVersionRead {
  version: number;
  created_at: string;
  file_count: number;
  total_bytes: number;
  sha256: string;
  source: string;
  note?: string;
  latest: boolean;
}

/** One agent profile's kept versions, newest first. */
export interface AgentProfileVersionListRead {
  name: string;
  latest_version: number;
  versions_kept: number;
  versions: AgentProfileVersionRead[];
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
  /** The plan an internal comp grant holds the workspace on, set only while it is live. */
  comp_plan?: string | null;
  /** When the live comp grant ends, or null when it has no expiry. */
  comp_expires_at?: string | null;
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

/**
 * What an insights breakdown measures: issues, the sum of their estimate
 * points, or how long each issue took. Cycle time runs from started to
 * completed, lead time from created to completed, triage time from entering
 * triage to leaving it, and issue age from created to now.
 */
export type InsightMeasure =
  'count' | 'points' | 'cycle_time' | 'lead_time' | 'triage_time' | 'issue_age';

/** The time measures, which answer durations and points rather than sums. */
export type InsightTimeMeasure = Exclude<InsightMeasure, 'count' | 'points'>;

/** Summary statistics of a set of durations, in hours; null when the set is empty. */
export interface InsightDurations {
  count: number;
  average: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p95: number | null;
  minimum: number | null;
  maximum: number | null;
}

/**
 * One issue's duration under a time measure. `group` is the bucket key it
 * falls in and `segment` its first segment value, both null when unset.
 */
export interface InsightPoint {
  issue_id: string;
  key: string;
  title: string;
  group: string | null;
  segment: string | null;
  hours: number;
}

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
  /** Duration statistics under a time measure, null otherwise. */
  durations?: InsightDurations | null;
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
  /** Duration statistics over the whole set under a time measure, null otherwise. */
  durations?: InsightDurations | null;
  /** One point per measured issue under a time measure, empty otherwise. */
  points?: InsightPoint[];
}

/** Where a dashboard is filed: its owner alone, one team, or the whole workspace. */
export type DashboardScope = 'personal' | 'team' | 'workspace';

/** How a widget draws its breakdown: bars, a table of the bars, or one figure. */
export type DashboardWidgetKind = 'chart' | 'table' | 'metric';

/** What a widget reads: every team the caller sees, one team, or a saved view. */
export type DashboardWidgetSource = 'workspace' | 'team' | 'view';

/** How much of a dashboard row a widget takes. */
export type DashboardWidgetSize = 'half' | 'full';

/** The fields a widget is created with, each defaulted on the server when left out. */
export interface DashboardWidgetCreate {
  kind?: DashboardWidgetKind;
  title?: string | null;
  source?: DashboardWidgetSource;
  team_id?: string | null;
  view_id?: string | null;
  include_sub_teams?: boolean;
  filter?: Record<string, unknown>;
  group_by?: InsightDimension;
  segment_by?: InsightDimension | null;
  measure?: InsightMeasure;
  size?: DashboardWidgetSize;
}

/** One widget of a dashboard, in the order the dashboard draws it. */
export interface DashboardWidgetRead {
  widget_id: string;
  kind: DashboardWidgetKind;
  title: string | null;
  source: DashboardWidgetSource;
  team_id: string | null;
  view_id: string | null;
  include_sub_teams: boolean;
  filter: Record<string, unknown>;
  group_by: InsightDimension;
  segment_by: InsightDimension | null;
  measure: InsightMeasure;
  size: DashboardWidgetSize;
}

/**
 * A page of widgets over several teams and views. `filter` applies to every
 * widget on top of its own, and `can_edit` says whether the caller may change it.
 */
export interface DashboardRead {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  scope: DashboardScope;
  team_id: string | null;
  owner_id: string;
  filter: Record<string, unknown>;
  widgets: DashboardWidgetRead[];
  can_edit: boolean;
  created_at: string;
  updated_at: string;
}

/** The body that creates a dashboard; the caller owns it. */
export interface DashboardCreate {
  name: string;
  description?: string | null;
  icon?: string | null;
  scope?: DashboardScope;
  team_id?: string | null;
  filter?: Record<string, unknown>;
  widgets?: DashboardWidgetCreate[];
}

/** The dashboard fields a patch may change. */
export interface DashboardUpdate {
  name?: string;
  description?: string | null;
  icon?: string | null;
  filter?: Record<string, unknown> | null;
  owner_id?: string;
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
  'standup_digest',
] as const;

/** One event a team channel may post. */
export type ChannelEvent = (typeof CHANNEL_EVENTS)[number];

/** The chat services a team channel can post to. */
export type ChannelProvider = 'slack' | 'discord';

/** How a team channel posts: through its incoming webhook, or as the installed Slack or Discord App's bot. */
export type ChannelTransport = 'webhook' | 'slack_app' | 'discord_app';

/** Who owns a channel: one team, or the workspace, which follows several teams. */
export type ChannelScope = 'team' | 'workspace';

/**
 * One Slack or Discord channel a team posts its notifications to. The webhook
 * URL is never returned; `url_hint` names the host and its last characters.
 * `disabled_reason` is set when the channel answered 404 or 410 and was
 * turned off rather than by a person.
 */
export interface ChannelRead {
  channel_id: string;
  /** The team a team channel belongs to, empty for a workspace channel. */
  team_id: string;
  /** Whether one team or the whole workspace owns the channel. Absent from an older backend. */
  scope?: ChannelScope;
  /** The teams a workspace channel follows, empty for every open team. */
  team_ids?: string[];
  provider: ChannelProvider;
  /** Absent from an older backend, which only had webhooks. */
  transport?: ChannelTransport;
  /** The Slack channel id a `slack_app` channel posts to, empty for a webhook. */
  slack_channel_id?: string;
  /** The Discord channel id a `discord_app` channel posts to, empty otherwise. */
  discord_channel_id?: string;
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
export type ReleaseSource =
  'manual' | 'api' | 'github_deployment' | 'github_tag' | 'github_release';

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
  /** The promotion release that carried this one to a later stage, when one did. */
  included_in?: string | null;
  /** How many earlier releases this promotion carried. */
  included_count?: number;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * What adding a team channel takes: exactly one of an incoming webhook `url`,
 * the `slack_channel_id` the installed Slack App's bot posts to, or the
 * `discord_channel_id` the installed Discord App's bot posts to.
 */
export interface ChannelCreate {
  url?: string;
  slack_channel_id?: string;
  slack_channel_name?: string;
  discord_channel_id?: string;
  discord_channel_name?: string;
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

/**
 * What adding a workspace channel takes: the Slack or Discord channel an
 * installed App posts to, and the teams it follows, empty for every open team.
 */
export interface WorkspaceChannelCreate extends Omit<ChannelCreate, 'url'> {
  team_ids?: string[];
}

/** What editing a workspace channel takes; unset fields are left alone. */
export interface WorkspaceChannelUpdate {
  label?: string;
  events?: ChannelEvent[];
  enabled?: boolean;
  team_ids?: string[];
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

/** Whether the caller's personal notifications reach their own Slack direct messages. */
export interface SlackLinkRead {
  /** Whether this environment has a Slack App at all. */
  configured: boolean;
  /** Whether this workspace installed the Slack App, so a link can be made. */
  available: boolean;
  linked: boolean;
  slack_user_id?: string | null;
  slack_team_name?: string | null;
  linked_at?: string | null;
  /** Why a linked account stopped receiving messages, or null while it works. */
  problem?: string | null;
}

/** One Slack channel the installed bot can post to. */
export interface SlackChannelRead {
  id: string;
  name: string;
  is_private: boolean;
}

/** Whether this environment has a Discord App and whether this workspace added it to a server. */
export interface DiscordConnectionRead {
  configured: boolean;
  installed: boolean;
  guild_id?: string | null;
  guild_name?: string | null;
  installed_by?: string | null;
  installed_at?: string | null;
}

/** One Discord text or announcement channel the installed bot can post to. */
export interface DiscordChannelRead {
  id: string;
  name: string;
}

/** Whether the caller's personal notifications reach their Discord direct messages. */
export interface DiscordLinkRead {
  /** Whether this environment has a Discord App at all. */
  configured: boolean;
  /** Whether this workspace added the Discord App to a server, so a link can be made. */
  available: boolean;
  linked: boolean;
  discord_user_id?: string | null;
  guild_name?: string | null;
  linked_at?: string | null;
  /** Why a linked account stopped receiving messages, or null while it works. */
  problem?: string | null;
}

/** Where to send the caller to link their Discord account, and when that link stops working. */
export interface DiscordLinkUrlRead {
  url: string;
  expires_at: string;
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

/** One release a promotion carried, or the promotion that carried one. */
export interface IncludedReleaseRead {
  release_id: string;
  name: string;
  sha?: string | null;
  pr_number?: number | null;
  pr_url?: string | null;
  issue_count: number;
  current_stage?: ReleaseStageRead | null;
  created_at: string;
}

/** One release with its issues and the notes built from them. */
export interface ReleaseDetailRead extends ReleaseRead {
  issues: ReleaseIssueRead[];
  /** One `KEY title` line per issue, in key order. */
  notes: string;
  /** The references a write named that matched no issue of the team. */
  skipped_issues?: string[];
  /** The earlier releases this promotion carried, newest first. */
  included_releases?: IncludedReleaseRead[];
  /** The promotion that carried this release to a later stage. */
  included_in_release?: IncludedReleaseRead | null;
}

/** One cursor page of a team's releases, newest first. */
export interface ReleaseListRead {
  releases: ReleaseRead[];
  next_cursor?: string | null;
}

/**
 * The paging a release list takes. `show_included` also lists the releases a
 * promotion carried, which the default listing leaves out.
 */
export interface ReleaseListQuery {
  cursor?: string;
  limit?: number;
  show_included?: boolean;
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
  /** The promotion that carried this release to a later stage, if one did. */
  included_in?: string | null;
  included_in_name?: string | null;
  created_at: string;
}

/** The releases one issue shipped in, newest first. */
export interface IssueReleaseListRead {
  releases: IssueReleaseRead[];
}

/**
 * One release with the issues it carries, as an issue list groups and labels
 * its rows by it. `stage_position` is where `current_stage` sits in the
 * team's pipeline, `-1` when the release reached no stage.
 */
export interface ReleaseIndexEntryRead {
  release_id: string;
  team_id: string;
  name: string;
  current_stage?: ReleaseStageRead | null;
  stage_position: number;
  included_in?: string | null;
  created_at: string;
  issue_ids: string[];
}

/** Every release of the teams the caller can see, newest first, each with its issues. */
export interface ReleaseIndexRead {
  releases: ReleaseIndexEntryRead[];
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
export type ImportPreset =
  'generic' | 'jira' | 'linear' | 'asana' | 'shortcut' | 'pivotal' | 'trello';

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
  | 'created_at'
  | 'parent'
  | 'completed';

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
  parent_row?: number | null;
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
  parent_links?: number;
}

/** Where an issue import job is. */
export type ImportStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** What an import reads: an uploaded CSV, a Linear, Shortcut, Asana or Jira workspace through its API, or a GitHub repository's Issues. */
export type ImportKind =
  'csv' | 'linear' | 'shortcut' | 'asana' | 'jira' | 'github';

/** The tallies a Linear import keeps, by name. */
export type LinearImportCount =
  | 'issues_created'
  | 'issues_updated'
  | 'comments'
  | 'labels'
  | 'cycles'
  | 'projects'
  | 'milestones'
  | 'project_updates'
  | 'initiatives'
  | 'sub_issues'
  | 'relations'
  | 'project_relations'
  | 'statuses'
  | 'templates';

/** The tallies a GitHub import keeps, by name. */
export type GitHubImportCount =
  | 'issues_created'
  | 'issues_updated'
  | 'comments'
  | 'labels'
  | 'already_synced'
  | 'pull_requests_skipped';

/** The tallies an Asana import keeps, by name. */
export type AsanaImportCount =
  | 'issues_created'
  | 'issues_updated'
  | 'comments'
  | 'labels'
  | 'projects'
  | 'sub_issues';

/** The tallies a Jira import keeps, by name. */
export type JiraImportCount =
  | 'issues_created'
  | 'issues_updated'
  | 'comments'
  | 'labels'
  | 'projects'
  | 'cycles'
  | 'sub_issues'
  | 'relations';

/** How a Jira import writes epics: as Standupless projects, or as parent issues. */
export type JiraEpicsAs = 'projects' | 'parents';

/** One Jira project or JQL filter a Jira import reads, the team it writes into, and how it maps. */
export interface JiraProjectMappingRead {
  site_url: string;
  project_key?: string | null;
  jql?: string | null;
  name: string;
  team_id: string;
  epics_as: JiraEpicsAs;
  statuses?: Record<string, string>;
}

/** One Asana project an Asana import reads, the team it writes into, and how its tasks map. */
export interface AsanaProjectMappingRead {
  project_gid: string;
  name: string;
  team_id: string;
  create_project: boolean;
  status_field_gid?: string | null;
  status_field_name?: string | null;
  statuses?: Record<string, string>;
}

/** One Linear team a Linear import reads and the Standupless team it writes into. */
export interface LinearTeamMappingRead {
  linear_team_id: string;
  linear_key: string;
  name: string;
  team_id: string;
  /** Whether the import creates a status for each Linear state the team lacks. */
  create_statuses?: boolean;
  /** Whether the import brings the team's Linear issue templates over. */
  import_templates?: boolean;
}

/** One team of the tool an API import reads, such as a Shortcut team, and the Standupless team it writes into. */
export interface SourceTeamMappingRead {
  source_id: string;
  key: string;
  name: string;
  team_id: string;
}

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
  linked_count?: number;
  problem_count: number;
  problems: RowProblemRead[];
  problems_truncated: boolean;
  error?: string | null;
  kind?: ImportKind;
  /** How many issues a Linear import found already imported and updated. */
  updated_count?: number;
  counts?: Partial<
    Record<
      | LinearImportCount
      | AsanaImportCount
      | JiraImportCount
      | GitHubImportCount,
      number
    >
  >;
  linear_teams?: LinearTeamMappingRead[];
  /** The teams a Shortcut import reads, in the order it reads them. */
  source_teams?: SourceTeamMappingRead[];
  asana_projects?: AsanaProjectMappingRead[];
  jira_projects?: JiraProjectMappingRead[];
  /** The repository a GitHub import reads; its full name is the file name. */
  github_repository_id?: string | null;
  /** What a running Linear or GitHub import is reading now. */
  phase?: string | null;
  phase_index?: number;
  phase_count?: number;
}

/** The body the import list answers with, newest first. */
export interface IssueImportListRead {
  items: IssueImportRead[];
}

/** One team a Linear key can read. */
export interface LinearTeamRead {
  id: string;
  key: string;
  name: string;
}

/** Every team a Linear key can read. */
export interface LinearTeamListRead {
  items: LinearTeamRead[];
}

/** One Linear team to import and the Standupless team it goes into. */
export interface LinearTeamChoice {
  linear_team_id: string;
  team_id: string;
  /** Create a status for each Linear workflow state the team has no status of the same name for. */
  create_statuses?: boolean;
  /** Bring the Linear team's issue templates over, skipping names the team already has. */
  import_templates?: boolean;
}

/** The body a Linear import or its preview starts with. The key is used for the job only. */
export interface LinearImportRequest {
  api_key: string;
  teams: LinearTeamChoice[];
}

/** What the optional phases of importing one Linear team would create. */
export interface LinearPreviewTeamRead {
  linear_team_id: string;
  linear_key: string;
  name: string;
  team_id: string;
  new_statuses: string[];
  new_templates: string[];
  status_count: number;
  template_count: number;
}

/** What a Linear import would create in each team, computed without writing anything. */
export interface LinearImportPreviewRead {
  teams: LinearPreviewTeamRead[];
}

/** One team a Shortcut API token can read. */
export interface ShortcutTeamRead {
  id: string;
  /** The team's mention name in Shortcut. */
  key: string;
  name: string;
}

/** Every team a Shortcut API token can read that is not archived. */
export interface ShortcutTeamListRead {
  items: ShortcutTeamRead[];
}

/** One Shortcut team to import and the Standupless team it goes into. */
export interface ShortcutTeamChoice {
  shortcut_team_id: string;
  team_id: string;
}

/** The body a Shortcut import or its preview starts with. The token is used for the job only. */
export interface ShortcutImportRequest {
  api_token: string;
  teams: ShortcutTeamChoice[];
}

/** What importing one Shortcut team would bring over. */
export interface ShortcutPreviewTeamRead {
  shortcut_team_id: string;
  name: string;
  team_id: string;
  stories: number;
  /** Whether the team holds more stories than the preview counts. */
  stories_capped: boolean;
  epics: number;
  iterations: number;
  statuses: StatusMappingRead[];
  new_labels: string[];
  matched_owners: number;
  unmatched_owners: number;
}

/** What a Shortcut import would do, team by team, computed without writing anything. */
export interface ShortcutImportPreviewRead {
  teams: ShortcutPreviewTeamRead[];
}

/** One project an Asana personal access token can read. */
export interface AsanaProjectRead {
  gid: string;
  name: string;
  workspace_gid: string;
  workspace_name: string;
  team_name?: string | null;
  archived: boolean;
  completed: boolean;
  url?: string | null;
}

/** Every project an Asana token can read across its Asana workspaces. */
export interface AsanaProjectListRead {
  items: AsanaProjectRead[];
}

/** One Asana project to import, the team it goes into, and how its tasks map. */
export interface AsanaProjectChoice {
  project_gid: string;
  team_id: string;
  create_project?: boolean;
  /** A single choice custom field whose options set the status instead of the section. */
  status_field_gid?: string | null;
  /** Section or option name to the id of the team status it lands in. */
  statuses?: Record<string, string>;
}

/** The body an Asana import or its preview takes. The token is used for the job only. */
export interface AsanaImportRequest {
  token: string;
  projects: AsanaProjectChoice[];
}

/** Where one section or option of an Asana project lands. */
export interface AsanaStatusPlanRead {
  source: string;
  status_id: string;
  status_name: string;
}

/** One single choice custom field that could set the status instead of the section. */
export interface AsanaStatusFieldRead {
  gid: string;
  name: string;
  options: string[];
}

/** What importing one Asana project would do. */
export interface AsanaProjectPreviewRead {
  project_gid: string;
  name: string;
  team_id: string;
  create_project: boolean;
  status_field_gid?: string | null;
  status_field_name?: string | null;
  task_count: number;
  completed_count: number;
  sections: string[];
  status_fields: AsanaStatusFieldRead[];
  statuses: AsanaStatusPlanRead[];
}

/** What an Asana import would do, project by project, writing nothing. */
export interface AsanaImportPreviewRead {
  projects: AsanaProjectPreviewRead[];
}

/** The Jira Cloud site and account an import signs in with. The token is used for the job only. */
export interface JiraCredentials {
  site_url: string;
  email: string;
  token: string;
}

/** One project a Jira Cloud account can browse. */
export interface JiraProjectRead {
  id: string;
  key: string;
  name: string;
  project_type?: string | null;
  team_managed: boolean;
  archived: boolean;
  url?: string | null;
}

/** Every project a Jira Cloud account can browse, with the site they are on. */
export interface JiraProjectListRead {
  site_url: string;
  items: JiraProjectRead[];
}

/** One Jira project or JQL filter to import, the team it goes into, and how its issues map. */
export interface JiraProjectChoice {
  project_key?: string | null;
  /** A JQL filter narrowing the project, or naming the issues on its own. */
  jql?: string | null;
  team_id: string;
  epics_as?: JiraEpicsAs;
  /** Jira status name to the id of the team status it lands in. */
  statuses?: Record<string, string>;
}

/** The body a Jira import or its preview takes. */
export interface JiraImportRequest extends JiraCredentials {
  projects: JiraProjectChoice[];
}

/** Where one Jira status lands. */
export interface JiraStatusPlanRead {
  source: string;
  category?: string | null;
  status_id: string;
  status_name: string;
}

/** What importing one Jira project or filter would do. */
export interface JiraProjectPreviewRead {
  project_key?: string | null;
  jql?: string | null;
  name: string;
  team_id: string;
  epics_as: JiraEpicsAs;
  issue_count: number;
  done_count: number;
  estimate_field?: string | null;
  sprint_field?: string | null;
  statuses: JiraStatusPlanRead[];
}

/** What a Jira import would do, choice by choice, writing nothing. */
export interface JiraImportPreviewRead {
  site_url: string;
  projects: JiraProjectPreviewRead[];
}

/** One repository the workspace's installed GitHub App covers, to import the Issues of. */
export interface GitHubImportRepositoryRead {
  repository_id: string;
  full_name: string;
  private: boolean;
  /** The team the repository is pinned to, if any. */
  team_id?: string | null;
}

/** Every repository the installation covers; empty when the App is not installed or is suspended. */
export interface GitHubImportRepositoryListRead {
  items: GitHubImportRepositoryRead[];
}

/** The body a GitHub import starts with: one covered repository and the team its issues go into. */
export interface GitHubImportRequest {
  repository_id: string;
  team_id: string;
}

/** Why an open issue assigned to the caller needs attention now. */
export type HomeFocusReason =
  'overdue' | 'due_soon' | 'sla_breached' | 'sla_at_risk' | 'blocked';

/** One assigned issue that needs attention, with every reason that applies. */
export interface HomeAttentionItem {
  issue: IssueRead;
  reasons: HomeFocusReason[];
}

/**
 * The caller's open assigned work. Each issue appears in one group only,
 * attention first; the counts cover the whole group, the lists its first few.
 */
export interface HomeFocusRead {
  open_count: number;
  truncated: boolean;
  attention_count: number;
  in_progress_count: number;
  up_next_count: number;
  attention: HomeAttentionItem[];
  in_progress: IssueRead[];
  up_next: IssueRead[];
}

/** One issue completed in the window, and who is credited with it. */
export interface HomeShippedItem {
  issue: IssueRead;
  completed_at: string;
  completed_by: string | null;
}

/** Issues completed on the caller's teams in the last week, newest first. */
export interface HomeShippedRead {
  since: string;
  count: number;
  mine: number;
  items: HomeShippedItem[];
}

/** The newest update of one project, named so the line reads without a lookup. */
export interface HomePulseItem {
  project_id: string;
  project_name: string;
  update: ProjectUpdateRead;
}

/** One open or draft pull request on an issue assigned to the caller. */
export interface HomePullRequestItem {
  issue: IssueRead;
  pull_request: PullRequestSummaryEntryRead;
}

/** The unread count, capped like the inbox badge, and the newest unread rows. */
export interface HomeInboxRead {
  unread_count: number;
  items: NotificationRead[];
}

/**
 * Everything the workspace home draws, read in one request. `team_ids` is
 * the scope the team sections cover: the caller's own teams, or every team
 * they can see when they belong to none.
 */
export interface HomeRead {
  generated_at: string;
  today: string;
  team_ids: string[];
  focus: HomeFocusRead;
  cycles: CycleRead[];
  projects: ProjectRead[];
  projects_total: number;
  shipped: HomeShippedRead;
  pulse: HomePulseItem[];
  inbox: HomeInboxRead;
  pull_requests: HomePullRequestItem[];
  releases: ReleaseRead[];
}

/** The three kinds of record a document can sit under. */
export type DocumentParentKind = 'project' | 'initiative' | 'team';

/**
 * One document without its body, as a listing answers it. `can_edit` and
 * `can_delete` say what this caller may do with it.
 */
export interface DocumentSummaryRead {
  document_id: string;
  workspace_id: string;
  parent_kind: DocumentParentKind;
  parent_id: string;
  parent_name: string;
  title: string;
  /** An emoji or a project glyph name, null when the document has none. */
  icon?: string | null;
  author_id: string;
  updated_by: string;
  source?: string | null;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
  can_delete: boolean;
}

/** One issue a document mentions, as its key was written. */
export interface DocumentMentionRead {
  key: string;
  issue_id: string;
  team_id: string;
}

/** One document with its Markdown and the visible issues it mentions. */
export interface DocumentRead extends DocumentSummaryRead {
  body: string;
  mentions: DocumentMentionRead[];
}

/** The body a document create takes; the parent comes from the path. */
export interface DocumentCreate {
  /** Required unless `template_id` is sent, whose title fills it. */
  title?: string;
  body?: string;
  icon?: string | null;
  /** A document template the parent offers, filling what was left out. */
  template_id?: string;
}

/**
 * The body a document edit takes. `base_updated_at` is the `updated_at` the
 * editor last read, so an edit over someone else's newer one is a 409. A null
 * `icon` clears it, and `parent_kind` with `parent_id` moves the document.
 */
export interface DocumentPatch {
  title?: string;
  body?: string;
  icon?: string | null;
  parent_kind?: DocumentParentKind;
  parent_id?: string;
  base_updated_at?: string;
}

/** A list of documents, most recently edited first. */
export interface DocumentListRead {
  documents: DocumentSummaryRead[];
}

/** An earlier title and body of a document, as one edit session left it. */
export interface DocumentVersionRead {
  version_id: string;
  document_id: string;
  title: string;
  body: string;
  edited_by: string;
  edited_at: string;
}

/** A document's kept versions, newest first. */
export interface DocumentVersionListRead {
  versions: DocumentVersionRead[];
}

/** What a favorite stars. */
export type FavoriteKind =
  'issue' | 'project' | 'cycle' | 'view' | 'team' | 'document' | 'initiative';

/** One favorite named by its kind and id, as an add or a reorder sends it. */
export interface FavoriteRef {
  kind: FavoriteKind;
  target_id: string;
  /** The cycle's team, needed only for a cycle. */
  team_id?: string | null;
  /** The folder it goes in, null for the top level, or left out to keep where it is. */
  folder_id?: string | null;
}

/** The caller's favorites in their new order, and their folders' when `folders` is sent. */
export interface FavoriteOrder {
  items: FavoriteRef[];
  folders?: string[] | null;
}

/** One favorite as the sidebar draws it, resolved against its target at read time. */
export interface FavoriteRead {
  kind: FavoriteKind;
  target_id: string;
  /** The issue title, or the name of the project, cycle, view, team, document or initiative. */
  title: string;
  team_id?: string | null;
  /** The key prefix of the team the target belongs to, which team and cycle links are built from. */
  team_key_prefix?: string | null;
  issue_key?: string | null;
  status?: StatusRead | null;
  icon?: string | null;
  color?: string | null;
  /** For a document, whether it hangs off a project or an initiative. */
  parent_kind?: string | null;
  parent_id?: string | null;
  /** The folder it sits in, or null at the top level. */
  folder_id?: string | null;
}

/** A named folder the caller groups favorites under. */
export interface FavoriteFolderRead {
  folder_id: string;
  name: string;
  position: number;
}

/** A new name for a favorite folder, or the name of a new one. */
export interface FavoriteFolderWrite {
  name: string;
}

/** The caller's favorites and folders in their order. */
export interface FavoriteListRead {
  favorites: FavoriteRead[];
  folders?: FavoriteFolderRead[];
}

/** One of the caller's unposted comment drafts, on an issue or one reply thread of it. */
export interface DraftRead {
  issue_id: string;
  /** The root comment a reply draft answers, or null for a draft on the issue itself. */
  parent_comment_id?: string | null;
  team_id: string;
  body: string;
  issue_key?: string | null;
  issue_title?: string | null;
  created_at: string;
  updated_at: string;
}

/** The caller's drafts, newest saved first. */
export interface DraftListRead {
  drafts: DraftRead[];
}

/** The body a draft save takes, replacing what the thread's draft held. */
export interface DraftWrite {
  body: string;
}

/** Everything a new issue draft save takes, replacing what the draft held. */
export interface IssueDraftWrite {
  team_id: string;
  title?: string;
  body?: string;
  template_id?: string | null;
  template_title?: string;
  template_body?: string;
  answers?: Record<string, string | boolean>;
  status_id?: string | null;
  priority?: IssuePriority;
  assignee_id?: string | null;
  label_ids?: string[];
  estimate?: string | null;
  project_id?: string | null;
  project_milestone_id?: string | null;
  cycle_id?: string | null;
  start_date?: string | null;
  due_date?: string | null;
  parent_id?: string | null;
  parent_key?: string | null;
  parent_title?: string | null;
  sub_issues?: string[];
}

/** One of the caller's new issue drafts, with every field the create dialog held. */
export interface IssueDraftRead {
  draft_id: string;
  team_id: string;
  title: string;
  body: string;
  template_id?: string | null;
  template_title?: string;
  template_body?: string;
  answers?: Record<string, string | boolean>;
  status_id?: string | null;
  priority?: string;
  assignee_id?: string | null;
  label_ids?: string[];
  estimate?: string | null;
  project_id?: string | null;
  project_milestone_id?: string | null;
  cycle_id?: string | null;
  start_date?: string | null;
  due_date?: string | null;
  parent_id?: string | null;
  parent_key?: string | null;
  parent_title?: string | null;
  sub_issues?: string[];
  created_at: string;
  updated_at: string;
}

/** The caller's new issue drafts, newest saved first, with the most they may keep. */
export interface IssueDraftListRead {
  drafts: IssueDraftRead[];
  limit: number;
}

/** The two kinds of record a customer request can name. */
export type CustomerTargetKind = 'issue' | 'project';

/** Where a customer stands with the workspace, from a fixed set. */
export type CustomerStatus = 'lead' | 'trial' | 'active' | 'paused' | 'churned';

/**
 * One customer of the workspace, with how many requests this caller can see
 * from it and how many of those are important. `can_edit` and `can_delete` say
 * what this caller may do with it.
 */
export interface CustomerRead {
  customer_id: string;
  workspace_id: string;
  name: string;
  domains: string[];
  status: CustomerStatus | null;
  tier: string | null;
  owner_id: string | null;
  revenue: number | null;
  size: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  request_count: number;
  important_count: number;
  can_edit: boolean;
  can_delete: boolean;
}

/** The body a customer create takes; only the name is required. */
export interface CustomerCreate {
  name: string;
  domains?: string[];
  status?: CustomerStatus | null;
  tier?: string | null;
  owner_id?: string | null;
  revenue?: number | null;
  size?: number | null;
}

/** The body a customer edit takes; a field left out is kept and null clears it. */
export type CustomerPatch = Partial<CustomerCreate>;

/** The workspace's customers, by name. */
export interface CustomerListRead {
  customers: CustomerRead[];
  next_cursor: string | null;
}

/**
 * One customer request: a customer asking for an issue or a project, with an
 * optional quote and an important flag. `target_key` is the issue key and empty
 * for a project. `can_edit` says whether this caller may edit or move it.
 */
export interface CustomerRequestRead {
  request_id: string;
  workspace_id: string;
  customer_id: string;
  customer_name: string;
  target_kind: CustomerTargetKind;
  target_id: string;
  target_key: string;
  target_title: string;
  body: string;
  important: boolean;
  author_id: string;
  source?: string | null;
  created_at: string;
  updated_at?: string | null;
  can_edit: boolean;
  can_delete: boolean;
}

/** The body a request create takes; the issue or project comes from the path. */
export interface CustomerRequestCreate {
  customer_id: string;
  body?: string;
  important?: boolean;
}

/**
 * The body a request edit takes; a field left out is kept. `target_kind` and
 * `target_id` move the request together.
 */
export interface CustomerRequestPatch {
  customer_id?: string;
  body?: string;
  important?: boolean;
  target_kind?: CustomerTargetKind;
  target_id?: string;
}

/** A list of customer requests, newest first. */
export interface CustomerRequestListRead {
  requests: CustomerRequestRead[];
  next_cursor: string | null;
}

/** A workspace member as their member page shows them, without an email. */
export interface MemberProfileRead {
  user_id: string;
  display_name: string;
  full_name?: string;
  avatar_url?: string | null;
  role: 'owner' | 'admin' | 'member' | 'guest';
  joined_at: string;
  /** The teams the member belongs to that the viewer can see. */
  team_ids?: string[];
}

/** A comment as a member's activity feed carries it, its body cut to an excerpt. */
export interface MemberCommentRead {
  comment_id: string;
  body: string;
  parent_comment_id?: string | null;
}

/** One row of a member's activity: an issue change or a comment. */
export interface MemberActivityRead {
  type: 'issue_change' | 'comment';
  id: string;
  created_at: string;
  issue_id: string;
  issue_key: string;
  issue_title: string;
  team_id: string;
  activity?: ActivityRead | null;
  comment?: MemberCommentRead | null;
}

/** A page of a member's activity, newest first. */
export interface MemberActivityListRead {
  activity: MemberActivityRead[];
  next_cursor?: string | null;
}
