/**
 * The static index the settings search and the command palette read: every
 * settings page, its main sections and the controls worth landing on, each
 * with a title, a few synonyms and the route and anchor it opens on.
 *
 * Gating follows the settings nav: a page the nav hides from the viewer is
 * left out with everything on it, so a search never offers a page that would
 * only say the caller may not see it. Danger zones are left out, since deleting
 * something is not a place to land on from a search.
 *
 * Ranking is deterministic, the order Linear's settings search uses: an exact
 * title, then a title prefix, then every word a prefix of a title word, then a
 * synonym, then a match anywhere in the section path. Ties keep index order.
 */

import { canManageMembers } from './capabilities';
import {
  agentProfilesPath,
  apiKeysPath,
  auditLogSettingsPath,
  billingSettingsPath,
  connectedAppsPath,
  exportSettingsPath,
  importSettingsPath,
  integrationsSettingsPath,
  labelsSettingsPath,
  mcpAndCliPath,
  notificationSettingsPath,
  preferencesSettingsPath,
  profileSettingsPath,
  accountSecuritySettingsPath,
  settingsPath,
  settingsTeamsPath,
  shareLinksSettingsPath,
  teamSettingsPath,
  templatesSettingsPath,
  workflowSettingsPath,
  workspaceSecuritySettingsPath,
} from './paths';
import type { TeamRead, WorkspaceRead } from '../types/Api';

/** Which group of settings an entry belongs to. */
export type SettingsScope = 'account' | 'workspace' | 'team';

/** One resolved place the settings search can open. */
export interface SettingsEntry {
  /** Unique within one built index. */
  id: string;
  title: string;
  synonyms: readonly string[];
  /** The groups above the entry, outermost first, such as Engine then Cycles. */
  trail: readonly string[];
  scope: SettingsScope;
  /** The route, with the anchor of the section when it has one. */
  to: string;
}

/** A section or control of a workspace or account page. */
interface PageItem {
  id: string;
  title: string;
  synonyms?: readonly string[];
  /** The element id it scrolls to, or none to open the page at its top. */
  anchor?: string;
  /** The title of the section a control sits in, for the trail. */
  under?: string;
}

/** A workspace or account settings page. */
export interface SettingsPage {
  id: string;
  title: string;
  scope: 'account' | 'workspace';
  synonyms: readonly string[];
  path: (slug: string) => string;
  adminOnly?: boolean;
  /** The row's name in the command palette, or none when the palette offers the page elsewhere. */
  paletteLabel?: string;
  items?: readonly PageItem[];
}

/** The element id a workspace or account settings section carries. */
export const settingsAnchorId = (id: string): string => `settings-${id}`;

/** The element id a section of a team's settings page carries. */
export const teamSettingsAnchorId = (section: string): string =>
  `team-settings-${section}`;

/** The workspace and personal settings pages, in settings nav order. */
export const SETTINGS_PAGES: readonly SettingsPage[] = [
  {
    id: 'profile',
    title: 'Profile',
    scope: 'account',
    synonyms: ['account', 'me', 'personal'],
    path: profileSettingsPath,
    items: [
      {
        id: 'name',
        title: 'Full name',
        synonyms: ['name', 'display name'],
        anchor: settingsAnchorId('profile'),
      },
      {
        id: 'username',
        title: 'Username',
        synonyms: ['handle', 'mention'],
        anchor: settingsAnchorId('profile'),
      },
      {
        id: 'avatar',
        title: 'Avatar',
        synonyms: ['photo', 'picture', 'profile image'],
        anchor: settingsAnchorId('avatar'),
      },
    ],
  },
  {
    id: 'preferences',
    title: 'Preferences',
    scope: 'account',
    synonyms: ['appearance', 'interface', 'personal'],
    path: preferencesSettingsPath,
    items: [
      {
        id: 'home-view',
        title: 'Default home view',
        synonyms: ['start page', 'landing page'],
        anchor: settingsAnchorId('preferences'),
        under: 'General',
      },
      {
        id: 'week-start',
        title: 'First day of the week',
        synonyms: ['week start', 'monday', 'sunday', 'calendar'],
        anchor: settingsAnchorId('preferences'),
        under: 'General',
      },
      {
        id: 'people-display',
        title: 'Show people by',
        synonyms: ['full name', 'username', 'display names'],
        anchor: settingsAnchorId('preferences'),
        under: 'General',
      },
      {
        id: 'theme',
        title: 'Theme',
        synonyms: ['dark mode', 'light mode', 'colors', 'appearance'],
        anchor: settingsAnchorId('preferences'),
        under: 'Interface',
      },
      {
        id: 'font-size',
        title: 'Font size',
        synonyms: ['text size', 'zoom', 'density'],
        anchor: settingsAnchorId('preferences'),
        under: 'Interface',
      },
      {
        id: 'auto-assign',
        title: 'Auto-assign to self',
        synonyms: ['assign me', 'new issues'],
        anchor: settingsAnchorId('preferences'),
        under: 'Workflow',
      },
      {
        id: 'git-branch-copy',
        title: 'On git branch copy',
        synonyms: ['branch name', 'copy branch', 'move to started'],
        anchor: settingsAnchorId('preferences'),
        under: 'Workflow',
      },
      {
        id: 'coding-tool',
        title: 'Default coding tool',
        synonyms: [
          'open in coding tool',
          'cursor',
          'claude code',
          'vs code',
          'codex',
        ],
        anchor: settingsAnchorId('preferences'),
        under: 'Workflow',
      },
    ],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    scope: 'account',
    paletteLabel: 'Notification settings',
    synonyms: [
      'notifications',
      'preferences',
      'email',
      'digest',
      'timezone',
      'alerts',
      'subscriptions',
      'account',
    ],
    path: notificationSettingsPath,
    items: [
      {
        id: 'email',
        title: 'Send email notifications',
        synonyms: ['email', 'mail', 'unsubscribe'],
      },
      {
        id: 'timezone',
        title: 'Timezone',
        synonyms: ['time zone', 'zone', 'clock'],
      },
      {
        id: 'digest',
        title: 'Digest',
        synonyms: ['daily summary', 'weekly summary'],
      },
      {
        id: 'chat',
        title: 'Slack and Discord messages',
        synonyms: ['slack', 'discord', 'direct messages', 'dm'],
      },
    ],
  },
  {
    id: 'account-security',
    title: 'Security & access',
    scope: 'account',
    synonyms: ['account security', 'login', 'sign in'],
    path: accountSecuritySettingsPath,
    items: [
      {
        id: 'email',
        title: 'Email address',
        synonyms: ['change email', 'login email'],
        anchor: settingsAnchorId('email'),
      },
      {
        id: 'sessions',
        title: 'Sessions',
        synonyms: ['devices', 'sign out', 'log out everywhere'],
        anchor: settingsAnchorId('sessions'),
      },
      {
        id: 'passkeys',
        title: 'Passkeys',
        synonyms: ['webauthn', 'security key', 'face id', 'touch id'],
        anchor: settingsAnchorId('passkeys'),
      },
      {
        id: 'two-factor',
        title: 'Two-factor authentication',
        synonyms: ['2fa', 'mfa', 'authenticator', 'totp', 'recovery codes'],
        anchor: settingsAnchorId('two-factor'),
      },
      {
        id: 'connected-accounts',
        title: 'Connected accounts',
        synonyms: ['google login', 'github login', 'sign in with'],
        anchor: settingsAnchorId('connected-accounts'),
      },
      {
        id: 'api-keys',
        title: 'API keys',
        synonyms: ['tokens', 'personal access token'],
        anchor: settingsAnchorId('api-keys'),
      },
    ],
  },
  {
    id: 'workspace',
    title: 'Workspace',
    scope: 'workspace',
    paletteLabel: 'Workspace settings',
    synonyms: [
      'general',
      'workspace',
      'name',
      'url',
      'members',
      'invite',
      'people',
      'roles',
      'seats',
    ],
    path: settingsPath,
    adminOnly: true,
    items: [
      {
        id: 'logo',
        title: 'Logo',
        synonyms: ['workspace icon', 'image', 'brand'],
        anchor: settingsAnchorId('logo'),
      },
      {
        id: 'accent',
        title: 'Accent color',
        synonyms: ['brand color', 'custom color', 'colour'],
        anchor: settingsAnchorId('accent'),
      },
      {
        id: 'project-updates',
        title: 'Project updates',
        synonyms: ['default cadence', 'update reminders'],
        anchor: settingsAnchorId('project-updates'),
      },
      {
        id: 'members',
        title: 'Members',
        synonyms: [
          'people',
          'roles',
          'seats',
          'remove member',
          'suspend member',
          'export members',
        ],
        anchor: settingsAnchorId('members'),
      },
      {
        id: 'invites',
        title: 'Invites',
        synonyms: ['invite someone', 'add member', 'invitation'],
        anchor: settingsAnchorId('invites'),
      },
      {
        id: 'github',
        title: 'GitHub',
        synonyms: ['repositories', 'connect github', 'github app'],
        anchor: settingsAnchorId('github'),
      },
      {
        id: 'webhooks',
        title: 'Webhooks',
        synonyms: ['outbound', 'http', 'events'],
        anchor: settingsAnchorId('webhooks'),
      },
      {
        id: 'export',
        title: 'Export issues',
        synonyms: ['csv', 'download'],
        anchor: settingsAnchorId('export'),
      },
    ],
  },
  {
    id: 'security',
    title: 'Security',
    scope: 'workspace',
    paletteLabel: 'Workspace security',
    synonyms: [
      'security',
      'sso',
      'saml',
      'single sign-on',
      'two-factor',
      '2fa',
      'policy',
      'approved domains',
      'authentication',
    ],
    path: workspaceSecuritySettingsPath,
    adminOnly: true,
    items: [
      {
        id: 'authentication',
        title: 'Authentication',
        synonyms: ['login methods', 'require two-factor', 'password'],
        anchor: settingsAnchorId('authentication'),
      },
      {
        id: 'permissions',
        title: 'Permissions',
        synonyms: ['who can invite', 'invite permission'],
        anchor: settingsAnchorId('permissions'),
      },
      {
        id: 'third-party-apps',
        title: 'Third-party applications',
        synonyms: [
          'require admin approval',
          'oauth apps',
          'app approval',
          'third party apps',
        ],
        anchor: settingsAnchorId('third-party-apps'),
      },
      {
        id: 'approved-domains',
        title: 'Approved email domains',
        synonyms: ['allowed domains', 'auto join'],
        anchor: settingsAnchorId('approved-domains'),
      },
      {
        id: 'sso',
        title: 'Single sign-on',
        synonyms: ['sso', 'saml', 'oidc', 'identity provider', 'okta', 'scim'],
        anchor: settingsAnchorId('sso'),
      },
    ],
  },
  {
    id: 'teams',
    title: 'Teams',
    scope: 'workspace',
    synonyms: ['create team', 'new team', 'manage teams'],
    path: settingsTeamsPath,
  },
  {
    id: 'workflow',
    title: 'Workflow',
    scope: 'workspace',
    paletteLabel: 'Workspace workflow',
    synonyms: ['workflow', 'statuses', 'states', 'inherited'],
    path: workflowSettingsPath,
  },
  {
    id: 'labels',
    title: 'Labels',
    scope: 'workspace',
    paletteLabel: 'Workspace labels',
    synonyms: ['labels', 'tags', 'inherited'],
    path: labelsSettingsPath,
  },
  {
    id: 'project-labels',
    title: 'Project labels',
    scope: 'workspace',
    synonyms: ['project tags'],
    path: (slug) => `${settingsPath(slug)}/project-labels`,
  },
  {
    id: 'emoji',
    title: 'Emoji',
    scope: 'workspace',
    paletteLabel: 'Custom emoji',
    synonyms: ['custom emoji', 'emoticons', 'reactions'],
    path: (slug) => `${settingsPath(slug)}/emoji`,
  },
  {
    id: 'project-statuses',
    title: 'Project statuses',
    scope: 'workspace',
    synonyms: ['project stages', 'project workflow', 'project states'],
    path: (slug) => `${settingsPath(slug)}/project-statuses`,
  },
  {
    id: 'customers',
    title: 'Customers',
    scope: 'workspace',
    paletteLabel: 'Customer statuses and tiers',
    synonyms: ['customer statuses', 'customer tiers', 'account tiers'],
    path: (slug) => `${settingsPath(slug)}/customers`,
  },
  {
    id: 'templates',
    title: 'Templates',
    scope: 'workspace',
    paletteLabel: 'Workspace templates',
    synonyms: ['templates', 'issue templates'],
    path: templatesSettingsPath,
  },
  {
    id: 'billing',
    title: 'Billing',
    scope: 'workspace',
    paletteLabel: 'Billing and plan',
    synonyms: [
      'billing',
      'plan',
      'subscription',
      'upgrade',
      'invoices',
      'payment',
      'seats',
      'pricing',
    ],
    path: billingSettingsPath,
  },
  {
    id: 'api-keys',
    title: 'API keys',
    scope: 'workspace',
    paletteLabel: 'API keys',
    synonyms: ['api keys', 'tokens', 'personal access', 'mint a key'],
    path: apiKeysPath,
  },
  {
    id: 'integrations',
    title: 'Integrations',
    scope: 'workspace',
    paletteLabel: 'Integrations',
    synonyms: ['integrations', 'slack', 'discord', 'channels', 'connect'],
    path: integrationsSettingsPath,
    adminOnly: true,
  },
  {
    id: 'connected-apps',
    title: 'Connected apps',
    scope: 'workspace',
    paletteLabel: 'Connected apps',
    synonyms: ['connected apps', 'oauth', 'authorized clients', 'revoke'],
    path: connectedAppsPath,
  },
  {
    id: 'mcp-and-cli',
    title: 'MCP and CLI',
    scope: 'workspace',
    synonyms: ['agents', 'assistant'],
    path: mcpAndCliPath,
    items: [
      {
        id: 'mcp',
        title: 'MCP server',
        synonyms: [
          'model context protocol',
          'claude',
          'cursor',
          'connector',
          'server url',
        ],
        anchor: 'mcp',
      },
      {
        id: 'cli',
        title: 'CLI',
        synonyms: ['command line', 'terminal', 'install'],
        anchor: 'cli',
      },
    ],
  },
  {
    id: 'agent-profiles',
    title: 'Agent profiles',
    scope: 'workspace',
    paletteLabel: 'Agent profiles',
    synonyms: ['agent profiles', 'claude', 'guidance', 'instructions'],
    path: agentProfilesPath,
  },
  {
    id: 'share-links',
    title: 'Share links',
    scope: 'workspace',
    paletteLabel: 'Share links',
    synonyms: ['share links', 'public', 'published', 'revoke'],
    path: shareLinksSettingsPath,
  },
  {
    id: 'export',
    title: 'Export',
    scope: 'workspace',
    paletteLabel: 'Export workspace',
    synonyms: ['export', 'download', 'backup', 'json', 'data'],
    path: exportSettingsPath,
    adminOnly: true,
    items: [
      {
        id: 'mask-emails',
        title: 'Mask member emails',
        synonyms: ['privacy', 'hide emails'],
      },
    ],
  },
  {
    id: 'import',
    title: 'Import',
    scope: 'workspace',
    paletteLabel: 'Import issues',
    synonyms: [
      'import',
      'csv',
      'linear',
      'jira',
      'github',
      'asana',
      'shortcut',
      'migrate',
      'upload',
    ],
    path: importSettingsPath,
    adminOnly: true,
    items: [
      {
        id: 'dry-run',
        title: 'Dry run',
        synonyms: ['preview import'],
      },
    ],
  },
  {
    id: 'audit-log',
    title: 'Audit log',
    scope: 'workspace',
    paletteLabel: 'Audit log',
    synonyms: ['audit', 'events', 'history', 'activity', 'security'],
    path: auditLogSettingsPath,
    adminOnly: true,
  },
];

/** A control inside a team settings section. */
interface TeamControl {
  id: string;
  title: string;
  synonyms: readonly string[];
}

/** A section of a team's settings page. */
export interface TeamSettingsSection {
  /** The id the page's anchor carries. */
  id: string;
  title: string;
  /** The row's name in the command palette. */
  paletteLabel: string;
  synonyms: readonly string[];
  controls?: readonly TeamControl[];
}

/** The sections of a team's settings page, in page order, without the danger zone. */
export const TEAM_SETTINGS_SECTIONS: readonly TeamSettingsSection[] = [
  {
    id: 'general',
    title: 'General',
    paletteLabel: 'General settings',
    synonyms: ['team', 'name', 'key', 'prefix', 'icon', 'parent', 'privacy'],
    controls: [
      { id: 'name', title: 'Team name', synonyms: ['rename team'] },
      {
        id: 'key',
        title: 'Team key',
        synonyms: ['identifier', 'prefix', 'issue key'],
      },
      { id: 'icon', title: 'Team icon', synonyms: ['avatar', 'image'] },
      {
        id: 'estimates',
        title: 'Estimates',
        synonyms: ['points', 'story points', 'estimate scale', 't-shirt'],
      },
      {
        id: 'unestimated',
        title: 'Count unestimated issues',
        synonyms: ['default estimate', 'progress'],
      },
      {
        id: 'timezone',
        title: 'Team timezone',
        synonyms: ['time zone', 'cycle start', 'midnight', 'rollover'],
      },
      {
        id: 'parent',
        title: 'Parent team',
        synonyms: ['sub-team', 'nest', 'hierarchy'],
      },
      {
        id: 'privacy',
        title: 'Privacy',
        synonyms: ['private team', 'visibility'],
      },
    ],
  },
  {
    id: 'members',
    title: 'Members',
    paletteLabel: 'Members',
    synonyms: ['team members', 'people', 'invite', 'roles'],
    controls: [{ id: 'role', title: 'Team role', synonyms: ['team admin'] }],
  },
  {
    id: 'workflow',
    title: 'Workflow',
    paletteLabel: 'Workflow statuses',
    synonyms: ['team workflow', 'statuses', 'states'],
  },
  {
    id: 'labels',
    title: 'Labels',
    paletteLabel: 'Labels',
    synonyms: ['team labels', 'tags'],
  },
  {
    id: 'projects',
    title: 'Projects',
    paletteLabel: 'Project labels and statuses',
    synonyms: ['team project labels', 'project statuses'],
  },
  {
    id: 'templates',
    title: 'Templates',
    paletteLabel: 'Templates',
    synonyms: ['team issue templates'],
    controls: [
      {
        id: 'default-template',
        title: 'Default template',
        synonyms: ['new issue template'],
      },
      {
        id: 'document-templates',
        title: 'Document templates',
        synonyms: ['update template'],
      },
      {
        id: 'project-templates',
        title: 'Project templates',
        synonyms: ['default project template'],
      },
    ],
  },
  {
    id: 'recurring',
    title: 'Recurring issues',
    paletteLabel: 'Recurring issues',
    synonyms: ['team recurring', 'repeat', 'schedule', 'interval'],
  },
  {
    id: 'cycles',
    title: 'Cycles',
    paletteLabel: 'Cycle settings',
    synonyms: ['team cycles', 'sprints', 'iterations', 'automatic'],
    controls: [
      {
        id: 'enable',
        title: 'Enable cycles',
        synonyms: ['turn on cycles', 'sprints'],
      },
      {
        id: 'length',
        title: 'Cycle length',
        synonyms: ['duration', 'weeks', 'sprint length'],
      },
      {
        id: 'start-day',
        title: 'Cycle start day',
        synonyms: ['starts on', 'weekday'],
      },
      {
        id: 'cooldown',
        title: 'Cooldown',
        synonyms: ['cool down', 'break', 'gap between cycles'],
      },
      {
        id: 'upcoming',
        title: 'Upcoming cycles',
        synonyms: ['future cycles', 'planned cycles'],
      },
      {
        id: 'auto-add',
        title: 'Auto-add started issues',
        synonyms: ['add to cycle', 'automatic'],
      },
      {
        id: 'rollover',
        title: 'Move unfinished issues to the next cycle',
        synonyms: ['rollover', 'carry over', 'unfinished'],
      },
    ],
  },
  {
    id: 'triage',
    title: 'Triage',
    paletteLabel: 'Triage settings',
    synonyms: ['team triage', 'intake', 'inbox'],
  },
  {
    id: 'email',
    title: 'Create by email',
    paletteLabel: 'Create by email settings',
    synonyms: ['email', 'intake address', 'forward', 'mail to issue'],
  },
  {
    id: 'sla',
    title: 'SLAs',
    paletteLabel: 'SLA settings',
    synonyms: [
      'team sla',
      'service level agreement',
      'breach',
      'response time',
    ],
  },
  {
    id: 'auto-close',
    title: 'Auto-close',
    paletteLabel: 'Auto-close settings',
    synonyms: ['team auto close', 'autoclose', 'stale'],
  },
  {
    id: 'parent-auto-close',
    title: 'Parent and sub-issues',
    paletteLabel: 'Parent and sub-issue auto-close settings',
    synonyms: [
      'auto-close parent issues',
      'auto-close sub-issues',
      'subissues',
      'child issues',
    ],
  },
  {
    id: 'archive',
    title: 'Auto-archive',
    paletteLabel: 'Auto-archive settings',
    synonyms: ['team auto archive', 'autoarchive'],
  },
  {
    id: 'standup',
    title: 'Standup',
    paletteLabel: 'Standup settings',
    synonyms: ['team standup', 'daily', 'async'],
  },
  {
    id: 'github',
    title: 'GitHub',
    paletteLabel: 'GitHub settings',
    synonyms: ['team github', 'repository', 'sync', 'pull requests'],
    controls: [
      {
        id: 'transitions',
        title: 'Pull request transitions',
        synonyms: ['automation', 'move on merge', 'transitions'],
      },
      {
        id: 'branch-rules',
        title: 'Branch rules',
        synonyms: ['target branch'],
      },
      {
        id: 'issue-sync',
        title: 'Issue sync',
        synonyms: ['two way sync', 'github issues', 'sync labels'],
      },
      {
        id: 'pr-labels',
        title: 'Pull request labels',
        synonyms: ['sync issue labels'],
      },
    ],
  },
  {
    id: 'releases',
    title: 'Releases',
    paletteLabel: 'Release pipeline',
    synonyms: ['team releases', 'pipeline', 'deploy', 'stages'],
    controls: [
      {
        id: 'github-release',
        title: 'Publish a GitHub Release',
        synonyms: ['release notes', 'tag'],
      },
    ],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    paletteLabel: 'Notification channels',
    synonyms: ['team notifications', 'slack', 'discord', 'channels'],
  },
  {
    id: 'webhooks',
    title: 'Webhooks',
    paletteLabel: 'Webhooks',
    synonyms: ['team webhooks', 'outbound', 'http', 'events'],
  },
];

/** The trail label of each scope's pages. */
const SCOPE_LABEL: Record<'account' | 'workspace', string> = {
  account: 'Account',
  workspace: 'Workspace',
};

/** The settings pages the viewer may open, by the settings nav's gate. */
export const visibleSettingsPages = (
  role: WorkspaceRead['role'] | undefined
): SettingsPage[] => {
  const admin = canManageMembers(role);
  return SETTINGS_PAGES.filter((page) => admin || page.adminOnly !== true);
};

/** The entries of one team's settings page, itself first. */
export const teamSettingsEntries = (
  slug: string,
  team: Pick<TeamRead, 'name' | 'key_prefix'>
): SettingsEntry[] => {
  const base = teamSettingsPath(slug, team.key_prefix);
  const entries: SettingsEntry[] = [
    {
      id: `team:${team.key_prefix}`,
      title: `${team.name} settings`,
      synonyms: [team.key_prefix, 'team settings'],
      trail: ['Teams'],
      scope: 'team',
      to: base,
    },
  ];
  for (const section of TEAM_SETTINGS_SECTIONS) {
    const to = `${base}#${teamSettingsAnchorId(section.id)}`;
    entries.push({
      id: `team:${team.key_prefix}:${section.id}`,
      title: section.title,
      synonyms: section.synonyms,
      trail: [team.name],
      scope: 'team',
      to,
    });
    for (const control of section.controls ?? []) {
      entries.push({
        id: `team:${team.key_prefix}:${section.id}:${control.id}`,
        title: control.title,
        synonyms: control.synonyms,
        trail: [team.name, section.title],
        scope: 'team',
        to,
      });
    }
  }
  return entries;
};

/** What the index is built for: the workspace and the teams to cover. */
export interface SettingsIndexInput {
  workspace: Pick<WorkspaceRead, 'slug' | 'role'>;
  teams?: readonly Pick<TeamRead, 'name' | 'key_prefix'>[];
}

/** Every settings page, section and control the viewer may open, in index order. */
export const buildSettingsIndex = ({
  workspace,
  teams = [],
}: SettingsIndexInput): SettingsEntry[] => {
  const entries: SettingsEntry[] = [];
  for (const page of visibleSettingsPages(workspace.role)) {
    const group = SCOPE_LABEL[page.scope];
    const to = page.path(workspace.slug);
    entries.push({
      id: `${page.scope}:${page.id}`,
      title: page.title,
      synonyms: page.synonyms,
      trail: [group],
      scope: page.scope,
      to,
    });
    for (const item of page.items ?? []) {
      entries.push({
        id: `${page.scope}:${page.id}:${item.id}`,
        title: item.title,
        synonyms: item.synonyms ?? [],
        trail:
          item.under === undefined
            ? [group, page.title]
            : [group, page.title, item.under],
        scope: page.scope,
        to: item.anchor === undefined ? to : `${to}#${item.anchor}`,
      });
    }
  }
  for (const team of teams) {
    entries.push(...teamSettingsEntries(workspace.slug, team));
  }
  return entries;
};

/** Lower case with every run of punctuation or space folded to one space. */
const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The words of a normalized text. */
const wordsOf = (text: string): string[] =>
  text === '' ? [] : text.split(' ');

/** How strongly an entry matches, by tier. */
export const MATCH_TIER = {
  exactTitle: 0,
  titlePrefix: 1,
  wordPrefix: 2,
  synonym: 3,
  path: 4,
} as const;

/**
 * The tier an entry matches a term at, lower is better, or null when it does
 * not match. An empty term matches nothing.
 */
export const settingsMatchTier = (
  entry: Pick<SettingsEntry, 'title' | 'synonyms' | 'trail'>,
  term: string
): number | null => {
  const query = normalize(term);
  if (query === '') return null;
  const words = wordsOf(query);
  const title = normalize(entry.title);
  if (title === query) return MATCH_TIER.exactTitle;
  if (title.startsWith(query)) return MATCH_TIER.titlePrefix;
  const titleWords = wordsOf(title);
  const prefixOf = (pool: readonly string[]) =>
    words.every((word) => pool.some((candidate) => candidate.startsWith(word)));
  if (prefixOf(titleWords)) return MATCH_TIER.wordPrefix;
  const synonyms = entry.synonyms.map(normalize);
  if (
    synonyms.some((synonym) => synonym.startsWith(query)) ||
    prefixOf([...titleWords, ...synonyms.flatMap(wordsOf)])
  ) {
    return MATCH_TIER.synonym;
  }
  const haystack = [...entry.trail.map(normalize), title, ...synonyms].join(
    ' '
  );
  if (words.every((word) => haystack.includes(word))) return MATCH_TIER.path;
  return null;
};

/** The entries a term matches, best tier first and index order within a tier. */
export const rankSettings = (
  entries: readonly SettingsEntry[],
  term: string,
  limit = Number.POSITIVE_INFINITY
): SettingsEntry[] =>
  entries
    .map((entry, order) => ({
      entry,
      order,
      tier: settingsMatchTier(entry, term),
    }))
    .filter(
      (row): row is { entry: SettingsEntry; order: number; tier: number } =>
        row.tier !== null
    )
    .sort((a, b) => a.tier - b.tier || a.order - b.order)
    .slice(0, limit)
    .map((row) => row.entry);
