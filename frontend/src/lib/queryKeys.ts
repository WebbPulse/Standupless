/**
 * The refetch keys the polled lists register under and the writes invalidate.
 * Kept apart from the components so a component file exports only components
 * and stays refresh safe.
 *
 * Keys are arrays rather than joined strings, because `usePolledQuery` compares
 * them by value and restarts the query when one changes. A list therefore puts
 * its filters and cursor in the key instead of forcing a remount.
 */

import type { QueryKey } from '@webbpulse/api-client/react';
import type { FilterState } from './issueFilters';
import type { DocumentParentKind } from '../types/Api';

/** The filter values an issue list key varies on. */
export type IssueListKeyFilters = FilterState;

/** The caller's workspace list. */
export const WORKSPACES_KEY: QueryKey = ['workspaces'];

/** The cache key for the workspaces the caller may join by email domain. */
export const JOINABLE_WORKSPACES_KEY: QueryKey = ['joinable-workspaces'];

/** One workspace's team list. */
export const teamsKey = (workspaceId: string): QueryKey => [
  'teams',
  workspaceId,
];

/** One workspace's member list. */
export const membersKey = (workspaceId: string): QueryKey => [
  'members',
  workspaceId,
];

/** One workspace's member list as the Members settings section reads it, invites and suspensions included. */
export const memberDirectoryKey = (workspaceId: string): QueryKey => [
  'members',
  workspaceId,
  'directory',
];

/** One workspace's invite list. */
export const invitesKey = (workspaceId: string): QueryKey => [
  'invites',
  workspaceId,
];

/** One team's status list. */
export const statusesKey = (teamId: string): QueryKey => ['statuses', teamId];

/** One team's label list. */
export const labelsKey = (teamId: string): QueryKey => ['labels', teamId];

/** One team's status list including the inherited ones it hid, for its settings. */
export const allStatusesKey = (teamId: string): QueryKey => [
  'statuses',
  teamId,
  'all',
];

/** One team's label list including the inherited ones it hid, for its settings. */
export const allLabelsKey = (teamId: string): QueryKey => [
  'labels',
  teamId,
  'all',
];

/** The issue templates one team offers, with its default. */
export const templatesKey = (teamId: string): QueryKey => ['templates', teamId];

/** One team's saved default templates, issue and project. */
export const templateSettingsKey = (teamId: string): QueryKey => [
  'templates',
  teamId,
  'settings',
];

/** The project templates one team offers, with its default. */
export const projectTemplatesKey = (teamId: string): QueryKey => [
  'project-templates',
  teamId,
];

/** The document templates one team offers, with its default. */
export const documentTemplatesKey = (teamId: string): QueryKey => [
  'document-templates',
  teamId,
];

/** The document templates a document parent offers, with its defaults. */
export const parentDocumentTemplatesKey = (
  parentKind: DocumentParentKind,
  parentId: string
): QueryKey => ['document-templates', parentKind, parentId];

/** One team's recurring issues. */
export const recurringKey = (teamId: string): QueryKey => [
  'recurring-issues',
  teamId,
];

/** The issue templates a workspace offers every team. */
export const workspaceTemplatesKey = (workspaceId: string): QueryKey => [
  'workspace-templates',
  workspaceId,
];

/** The project templates a workspace offers every team. */
export const workspaceProjectTemplatesKey = (workspaceId: string): QueryKey => [
  'workspace-project-templates',
  workspaceId,
];

/** The document templates a workspace offers every team. */
export const workspaceDocumentTemplatesKey = (
  workspaceId: string
): QueryKey => ['workspace-document-templates', workspaceId];

/** The statuses a workspace defines for every team. */
export const workspaceStatusesKey = (workspaceId: string): QueryKey => [
  'workspace-statuses',
  workspaceId,
];

/** The workspace's custom emoji. */
export const customEmojiKey = (workspaceId: string): QueryKey => [
  'custom-emoji',
  workspaceId,
];

/** The workspace's project statuses. */
export const projectStatusesKey = (workspaceId: string): QueryKey => [
  'project-statuses',
  workspaceId,
];

/** The workspace's project labels. */
export const projectLabelsKey = (workspaceId: string): QueryKey => [
  'project-labels',
  workspaceId,
];

/** The labels a workspace defines for every team. */
export const workspaceLabelsKey = (workspaceId: string): QueryKey => [
  'workspace-labels',
  workspaceId,
];

/** One team's member list. */
export const teamMembersKey = (teamId: string): QueryKey => [
  'team-members',
  teamId,
];

/** Builds the link an invited person opens to redeem their invite. */
export const inviteLink = (token: string): string =>
  `${globalThis.location.origin}/invites/accept?token=${encodeURIComponent(token)}`;

/**
 * One issue list. Every filter the read varies on is its own segment, so a
 * filter change is a different key and restarts the query rather than refining
 * the one already held. `scope` names which list this is, because the team
 * tab and the cross-team list read the same route under different fixed
 * filters.
 */
export const issuesKey = (
  workspaceId: string,
  scope: string,
  filters: IssueListKeyFilters
): QueryKey => [
  'issues',
  workspaceId,
  scope,
  filters.statusId,
  filters.assigneeId,
  filters.labelId,
  filters.priority,
  filters.q,
  filters.sort,
];

/** One issue, read by id or resolved from its key. */
export const issueKey = (workspaceId: string, issueId: string): QueryKey => [
  'issue',
  workspaceId,
  issueId,
];

/** One team's recently deleted issues, the trash a restore takes them out of. */
export const trashKey = (workspaceId: string, teamId: string): QueryKey => [
  'issue-trash',
  workspaceId,
  teamId,
];

/** One issue's direct children. */
export const childrenKey = (issueId: string): QueryKey => ['children', issueId];

/** One issue's links. */
export const linksKey = (issueId: string): QueryKey => ['links', issueId];

/** One issue's activity. */
export const activityKey = (issueId: string): QueryKey => ['activity', issueId];

/** One issue's kept description versions. */
export const descriptionVersionsKey = (issueId: string): QueryKey => [
  'descriptionVersions',
  issueId,
];

/** The candidate parents offered by one issue's parent picker. */
export const parentsKey = (teamId: string): QueryKey => ['parents', teamId];

/** One issue link search, which re-reads as the search term changes. */
export const linkSearchKey = (issueId: string, term: string): QueryKey => [
  'link-search',
  issueId,
  term,
];

/** The parent picker's search of one team's top level issues for a term. */
export const parentSearchKey = (teamId: string, term: string): QueryKey => [
  'parent-search',
  teamId,
  term,
];

/** One issue's comment thread. */
export const commentsKey = (issueId: string): QueryKey => ['comments', issueId];

/** The reaction groups on one issue or comment. */
export const reactionsKey = (
  targetKind: string,
  targetId: string
): QueryKey => ['reactions', targetKind, targetId];

/** One issue's attachments. */
export const attachmentsKey = (issueId: string): QueryKey => [
  'attachments',
  issueId,
];

/** The media tokens that open one issue's inline images and videos. */
export const mediaTokensKey = (issueId: string): QueryKey => [
  'media-tokens',
  issueId,
];

/**
 * One board. The filters are segments rather than a closed-over object, so
 * changing one restarts the read instead of refining the board already held.
 */
export const boardKey = (
  workspaceId: string,
  teamId: string,
  filters: BoardKeyFilters
): QueryKey => [
  'board',
  workspaceId,
  teamId,
  filters.assigneeId,
  filters.labelId,
  filters.priority,
];

/** The filter values a board key varies on. */
export interface BoardKeyFilters {
  assigneeId: string;
  labelId: string;
  priority: string;
}

/** One workspace's saved views, which vary by the scope asked for. */
export const viewsKey = (
  workspaceId: string,
  scope: string,
  teamId: string
): QueryKey => ['views', workspaceId, scope, teamId];

/** One workspace's dashboards, as one list scope and team narrow them. */
export const dashboardsKey = (
  workspaceId: string,
  scope: string,
  teamId: string
): QueryKey => ['dashboards', workspaceId, scope, teamId];

/** One dashboard read by id. */
export const dashboardKey = (
  workspaceId: string,
  dashboardId: string
): QueryKey => ['dashboard', workspaceId, dashboardId];

/** One widget's breakdown, read again when the dashboard changes. */
export const dashboardWidgetKey = (
  workspaceId: string,
  dashboardId: string,
  widgetId: string,
  updatedAt: string
): QueryKey => [
  'dashboard-widget',
  workspaceId,
  dashboardId,
  widgetId,
  updatedAt,
];

/** How many issues one saved view selects, read again when the view changes. */
export const viewCountKey = (
  workspaceId: string,
  viewId: string,
  updatedAt: string
): QueryKey => ['view-count', workspaceId, viewId, updatedAt];

/** One saved view read by id. */
export const viewKey = (workspaceId: string, viewId: string): QueryKey => [
  'view',
  workspaceId,
  viewId,
];

/**
 * One search. The term is a segment, so typing restarts the read rather than
 * leaving the previous term's hits on screen under the new one.
 */
export const searchKey = (
  workspaceId: string,
  term: string,
  teamId: string,
  type = '',
  statusCategory = ''
): QueryKey => ['search', workspaceId, term, teamId, type, statusCategory];

/** Which slice of the inbox a list reads, serialised from its filter and display options. */
export type InboxFilter = string;

/** The caller's inbox, which varies on which slice it reads. */
export const inboxKey = (
  workspaceId: string,
  filter: InboxFilter
): QueryKey => ['inbox', workspaceId, filter];

/** The caller's pending reminder on one issue. */
export const issueReminderKey = (
  workspaceId: string,
  issueId: string
): QueryKey => ['issue-reminder', workspaceId, issueId];

/** The unread badge count, polled by the shell on every page. */
export const inboxCountKey = (workspaceId: string): QueryKey => [
  'inbox-count',
  workspaceId,
];

/** Every unread count, which the inbox page reads for its Priority and Other tabs. */
export const inboxCountsKey = (workspaceId: string): QueryKey => [
  'inbox-counts',
  workspaceId,
];

/** The caller's favorites, read by the sidebar and every star toggle alike. */
export const favoritesKey = (workspaceId: string): QueryKey => [
  'favorites',
  workspaceId,
];

/** The caller's favorite folders, read beside the favorites by the sidebar. */
export const favoriteFoldersKey = (workspaceId: string): QueryKey => [
  'favorites',
  workspaceId,
  'folders',
];

/** The caller's Reviews list, read by the page and the sidebar badge alike. */
export const reviewsKey = (workspaceId: string): QueryKey => [
  'reviews',
  workspaceId,
];

/** The caller's Pulse, which varies on which feed it reads. */
export const pulseKey = (workspaceId: string, scope: string): QueryKey => [
  'pulse',
  workspaceId,
  scope,
];

/** The Pulse unread count the sidebar badge shows. */
export const pulseCountKey = (workspaceId: string): QueryKey => [
  'pulse-count',
  workspaceId,
];

/** Whether the caller follows one project or initiative in Pulse. */
export const pulseFollowKey = (
  workspaceId: string,
  subject: string,
  subjectId: string
): QueryKey => ['pulse-follow', workspaceId, subject, subjectId];

/** One team's triage inbox, waiting or snoozed. */
export const triageKey = (
  workspaceId: string,
  teamId: string,
  snoozed: boolean
): QueryKey => ['triage', workspaceId, teamId, snoozed];

/** The per-team triage counts, polled by the sidebar on every page. */
export const triageSummaryKey = (workspaceId: string): QueryKey => [
  'triage-summary',
  workspaceId,
];

/** A team's triage switch. */
export const triageSettingsKey = (
  workspaceId: string,
  teamId: string
): QueryKey => ['triage-settings', workspaceId, teamId];

/** The cache key for the caller's own notification subscription to a team. */
export const teamSubscriptionKey = (
  workspaceId: string,
  teamId: string
): QueryKey => ['team-subscription', workspaceId, teamId];

/** One team's cycle list, which varies on the status filter applied. */
export const cyclesKey = (
  workspaceId: string,
  teamId: string,
  status: string
): QueryKey => ['cycles', workspaceId, teamId, status];

/** A team's automatic cycle schedule. */
export const cycleSettingsKey = (
  workspaceId: string,
  teamId: string
): QueryKey => ['cycle-settings', workspaceId, teamId];

/** One team's project list, which varies on the status filter applied. */
export const projectsKey = (
  workspaceId: string,
  teamId: string,
  status: string
): QueryKey => ['projects', workspaceId, teamId, status];

/** One project read by its id, as its page polls it. */
export const projectDetailKey = (
  workspaceId: string,
  projectId: string
): QueryKey => ['project', workspaceId, projectId];

/** The first page of one project's updates, newest first. */
export const projectUpdatesKey = (
  workspaceId: string,
  projectId: string
): QueryKey => ['projectUpdates', workspaceId, projectId];

/** The key for one project update's replies. */
export const projectUpdateCommentsKey = (
  workspaceId: string,
  projectId: string,
  updateId: string
): QueryKey => ['projectUpdateComments', workspaceId, projectId, updateId];

/**
 * One project's activity feed, nested under the project's own key so every
 * write that re-reads the project re-reads what it recorded too.
 */
export const projectActivityKey = (
  workspaceId: string,
  projectId: string
): QueryKey => ['project', workspaceId, projectId, 'activity'];

/**
 * One project's progress history. It sits under the project's own key, so a
 * write that re-reads the project re-reads its graph too.
 */
export const projectHistoryKey = (
  workspaceId: string,
  projectId: string
): QueryKey => ['project', workspaceId, projectId, 'history'];

/** The workspace's initiative list, which varies on the status filter. */
export const initiativesKey = (
  workspaceId: string,
  status: string
): QueryKey => ['initiatives', workspaceId, status];

/** One initiative's progress graph over its whole subtree. */
export const initiativeProgressKey = (
  workspaceId: string,
  initiativeId: string
): QueryKey => ['initiativeProgress', workspaceId, initiativeId];

/** One initiative read by its id, as its page polls it. */
export const initiativeDetailKey = (
  workspaceId: string,
  initiativeId: string
): QueryKey => ['initiative', workspaceId, initiativeId];

/** The first page of one initiative's updates, newest first. */
export const initiativeUpdatesKey = (
  workspaceId: string,
  initiativeId: string
): QueryKey => ['initiativeUpdates', workspaceId, initiativeId];

/** One project's or initiative's documents, most recently edited first. */
export const documentsKey = (
  workspaceId: string,
  parentKind: string,
  parentId: string
): QueryKey => ['documents', workspaceId, parentKind, parentId];

/** Every document the caller can read, as the command palette lists them. */
export const workspaceDocumentsKey = (workspaceId: string): QueryKey => [
  'workspaceDocuments',
  workspaceId,
];

/** One linked pull request a chip looks up by `owner/repo#number`. */
export const pullRequestLookupKey = (
  workspaceId: string,
  reference: string
): QueryKey => ['pull-request', workspaceId, reference];

/** One document read by its id, as its page polls it. */
export const documentKey = (
  workspaceId: string,
  documentId: string
): QueryKey => ['document', workspaceId, documentId];

/** One document's kept versions, newest first. */
export const documentVersionsKey = (
  workspaceId: string,
  documentId: string
): QueryKey => ['documentVersions', workspaceId, documentId];

/** The documents that mention one issue, for its rail. */
export const issueDocumentsKey = (
  workspaceId: string,
  issueId: string
): QueryKey => ['issueDocuments', workspaceId, issueId];

/** One project's milestones, in their manual order. */
export const milestonesKey = (
  workspaceId: string,
  projectId: string
): QueryKey => ['milestones', workspaceId, projectId];

/**
 * One workspace's roadmap. The team and kind filters are segments, so
 * narrowing the roadmap restarts the merged read rather than refining a page
 * built from a cursor the old filters produced.
 */
export const roadmapKey = (
  workspaceId: string,
  teamId: string,
  kind: string
): QueryKey => ['roadmap', workspaceId, teamId, kind];

/** The cycles and projects one issue's pickers choose from. */
export const planningOptionsKey = (teamId: string): QueryKey => [
  'planning-options',
  teamId,
];

/** One workspace's GitHub App installation, or the absence of one. */
export const installationKey = (workspaceId: string): QueryKey => [
  'github-installation',
  workspaceId,
];

/** The repositories one workspace's installation can see. */
export const repositoriesKey = (workspaceId: string): QueryKey => [
  'github-repositories',
  workspaceId,
];

/** The pull requests linked to one issue. */
export const githubLinksKey = (
  workspaceId: string,
  issueId: string
): QueryKey => ['github-links', workspaceId, issueId];

/** One team's issue sync link to a repository. */
export const teamSyncKey = (workspaceId: string, teamId: string): QueryKey => [
  'github-team-sync',
  workspaceId,
  teamId,
];

/** The linked pull requests and GitHub issue an issue's threads may sync to. */
export const threadTargetsKey = (
  workspaceId: string,
  issueId: string
): QueryKey => ['github-thread-targets', workspaceId, issueId];

/** The GitHub issue one issue mirrors. */
export const issueSyncKey = (
  workspaceId: string,
  issueId: string
): QueryKey => ['github-issue-sync', workspaceId, issueId];

/** One team's pull request transition rules. */
export const transitionsKey = (
  workspaceId: string,
  teamId: string
): QueryKey => ['github-transitions', workspaceId, teamId];

/** The Slack and Discord channels one team, or with no team the workspace, posts its notifications to. */
export const channelsKey = (
  workspaceId: string,
  teamId: string | null
): QueryKey => ['channels', workspaceId, teamId];

/** Whether the workspace installed the Slack App, and into which Slack workspace. */
export const slackConnectionKey = (workspaceId: string): QueryKey => [
  'slack-connection',
  workspaceId,
];

/** The Slack channels the installed bot can post to, offered when adding a team or workspace channel. */
export const slackChannelsKey = (
  workspaceId: string,
  teamId: string | null
): QueryKey => ['slack-channels', workspaceId, teamId];

/** Whether the workspace added the Discord App, and to which Discord server. */
export const discordConnectionKey = (workspaceId: string): QueryKey => [
  'discord-connection',
  workspaceId,
];

/** Whether the caller's Discord account is linked for direct messages in this workspace. */
export const discordLinkKey = (workspaceId: string): QueryKey => [
  'discord-link',
  workspaceId,
];

/** The Discord channels the installed bot can post to, offered when adding a team or workspace channel. */
export const discordChannelsKey = (
  workspaceId: string,
  teamId: string | null
): QueryKey => ['discord-channels', workspaceId, teamId];

/**
 * The webhooks of a workspace, or of one team in it. The two are different
 * reads, since the workspace one includes every team's, so the team is a
 * segment.
 */
export const webhooksKey = (
  workspaceId: string,
  teamId: string | null
): QueryKey => ['webhooks', workspaceId, teamId ?? 'workspace'];

/** One webhook's delivery log. */
export const webhookDeliveriesKey = (webhookId: string): QueryKey => [
  'webhook-deliveries',
  webhookId,
];

/**
 * One workspace's API keys. The listing scope is a segment because `mine` and
 * `workspace` are different questions the same route answers, so switching
 * between them restarts the read rather than refining the list already held.
 */
export const apiKeysKey = (workspaceId: string, scope: string): QueryKey => [
  'api-keys',
  workspaceId,
  scope,
];

/** One workspace's share links, which vary on the target filter applied. */
export const shareLinksKey = (
  workspaceId: string,
  targetType: string,
  targetId: string
): QueryKey => ['share-links', workspaceId, targetType, targetId];

/** What one share token resolves to, read by the anonymous share page. */
export const sharedTargetKey = (token: string): QueryKey => [
  'shared-target',
  token,
];

/** The one issue a share token resolves to. */
export const sharedIssueKey = (token: string): QueryKey => [
  'shared-issue',
  token,
];

/** The issues a shared view selects. */
export const sharedViewKey = (token: string): QueryKey => [
  'shared-view',
  token,
];

/** One issue's subscribers. */
export const subscribersKey = (
  workspaceId: string,
  issueId: string
): QueryKey => ['subscribers', workspaceId, issueId];

/** The signed in person's own profile and notification preferences. */
export const CURRENT_USER_KEY: QueryKey = ['current-user'];

/** The caller's account deletion plan. */
export const ACCOUNT_DELETION_PLAN_KEY: QueryKey = ['account-deletion-plan'];

/** The OAuth clients the signed in person has authorized, across workspaces. */
export const MY_CONNECTED_APPS_KEY: QueryKey = ['connected-apps', 'me'];

/** Every member's OAuth client grant in one workspace, for an admin. */
export const workspaceConnectedAppsKey = (workspaceId: string): QueryKey => [
  'connected-apps',
  'workspace',
  workspaceId,
];

/** A workspace's third-party app approval records, for an admin. */
export const appApprovalsKey = (workspaceId: string): QueryKey => [
  'app-approvals',
  workspaceId,
];

/** The signed in person's private agent profiles. */
export const MY_AGENT_PROFILES_KEY: QueryKey = ['agent-profiles', 'me'];

/** The kept versions of one of the signed in person's agent profiles. */
export const myAgentProfileVersionsKey = (name: string): QueryKey => [
  'agent-profiles',
  'me',
  'versions',
  name,
];

/** One team's release list. */
export const releasesKey = (workspaceId: string, teamId: string): QueryKey => [
  'releases',
  workspaceId,
  teamId,
];

/** One release with its issues. */
export const releaseKey = (
  workspaceId: string,
  teamId: string,
  releaseId: string
): QueryKey => ['release', workspaceId, teamId, releaseId];

/** One team's release pipeline. */
export const releasePipelineKey = (
  workspaceId: string,
  teamId: string
): QueryKey => ['release-pipeline', workspaceId, teamId];

/** The releases one issue shipped in. */
export const issueReleasesKey = (
  workspaceId: string,
  issueId: string
): QueryKey => ['issue-releases', workspaceId, issueId];

/** The cache key for a workspace's export jobs. */
export const workspaceExportsKey = (workspaceId: string): QueryKey => [
  'workspace-exports',
  workspaceId,
];

/** The cache key for a workspace's issue import jobs. */
export const workspaceImportsKey = (workspaceId: string): QueryKey => [
  'workspace-imports',
  workspaceId,
];

/** The repositories a GitHub import can read in one workspace. */
export const githubImportRepositoriesKey = (workspaceId: string): QueryKey => [
  'github-import-repositories',
  workspaceId,
];

/** The cache key for a workspace's authentication policy. */
export const workspaceAuthPolicyKey = (workspaceId: string): QueryKey => [
  'workspace-auth-policy',
  workspaceId,
];

/** The cache key for a workspace's single sign-on settings. */
export const workspaceSsoKey = (workspaceId: string): QueryKey => [
  'workspace-sso',
  workspaceId,
];

/** The cache key for a workspace's SCIM base URL and tokens. */
export const workspaceScimKey = (workspaceId: string): QueryKey => [
  'workspace-scim',
  workspaceId,
];

/** The cache key for a workspace's approved email domains. */
export const workspaceApprovedDomainsKey = (workspaceId: string): QueryKey => [
  'workspace-approved-domains',
  workspaceId,
];

/** The cache key for one filtered read of a workspace's audit log. */
export const workspaceAuditLogKey = (
  workspaceId: string,
  filters: {
    actor_id?: string;
    event?: string;
    since?: string;
    until?: string;
  }
): QueryKey => [
  'workspace-audit-log',
  workspaceId,
  filters.actor_id ?? '',
  filters.event ?? '',
  filters.since ?? '',
  filters.until ?? '',
];

/** The workspace's customers, by name. */
export const customersKey = (workspaceId: string): QueryKey => [
  'customers',
  workspaceId,
];

/** One customer. */
export const customerKey = (
  workspaceId: string,
  customerId: string
): QueryKey => ['customer', workspaceId, customerId];

/** One customer's requests, newest first. */
export const customerRequestsKey = (
  workspaceId: string,
  customerId: string
): QueryKey => ['customerRequests', workspaceId, customerId];

/** Every visible customer request of the workspace, newest first. */
export const workspaceCustomerRequestsKey = (workspaceId: string): QueryKey => [
  'workspaceCustomerRequests',
  workspaceId,
];

/** Every visible release of the workspace with the issues it carries. */
export const releaseIndexKey = (workspaceId: string): QueryKey => [
  'releaseIndex',
  workspaceId,
];

/** The customer requests naming one issue or project, newest first. */
export const targetCustomerRequestsKey = (
  workspaceId: string,
  kind: 'issue' | 'project',
  targetId: string
): QueryKey => ['targetCustomerRequests', workspaceId, kind, targetId];

/** Whether the caller's personal notifications reach their own Slack direct messages in one workspace. */
export const slackLinkKey = (workspaceId: string): QueryKey => [
  'slack-link',
  workspaceId,
];

/** One member's profile as the member page reads it. */
export const memberProfileKey = (
  workspaceId: string,
  userId: string
): QueryKey => ['member', workspaceId, userId, 'profile'];

/** One member's recent activity feed. */
export const memberActivityKey = (
  workspaceId: string,
  userId: string
): QueryKey => ['member', workspaceId, userId, 'activity'];
