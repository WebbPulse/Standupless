/**
 * The workspace home: what the signed in person should look at first, read in
 * one request. A greeting carries the day in plain numbers; the main column
 * holds their open work, grouped by what needs attention, what is started and
 * what is next, then what their teams shipped this week; the side column holds
 * the cycles running now, the projects in flight, the latest project updates
 * and the newest unread notifications.
 *
 * The whole page is one keyboard list: j and k move row by row across every
 * section, Shift+J and Shift+K jump between sections and Enter opens the row.
 * The last read is kept in memory, so a return visit draws at once.
 *
 * A workspace with no team yet, or an admin's workspace still missing people
 * or GitHub, shows the setup steps instead of empty panels.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuCircleCheck, LuPlus } from 'react-icons/lu';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { browserTimezone, getHome } from '../../api/home';
import { readInstallation } from '../../api/integrations';
import IssueRow from '../../components/issues/IssueRow';
import { ErrorAlert } from '../../components/ui/alert';
import { Kbd } from '../../components/ui/badge';
import Button from '../../components/ui/button';
import EmptyState from '../../components/ui/empty-state';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useAuth } from '../../hooks/useAuth';
import { useCreateIssue } from '../../hooks/useCreateIssue';
import { useCreateTeam } from '../../hooks/useCreateTeam';
import { useIssueContext } from '../../hooks/useIssueContext';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { useShortcut } from '../../hooks/useShortcuts';
import { useTeams } from '../../hooks/useTeams';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { errorMessage } from '../../lib/errors';
import {
  cyclePath,
  inboxPath,
  issuePath,
  myIssuesPath,
  projectPath,
  projectsPath,
  roadmapPath,
  settingsPath,
  teamCyclesPath,
} from '../../lib/paths';
import { installationKey } from '../../lib/queryKeys';
import type { HomeRead, TeamRead } from '../../types/Api';
import {
  CycleRow,
  GroupHeading,
  HomeSection,
  InboxRow,
  KeyHints,
  ProjectRow,
  PulseRow,
  SectionLink,
  SectionNote,
  SetupChecklist,
  ShippedRow,
  type SetupStep,
} from './home/HomeParts';
import { cachedHome, rememberHome } from './home/homeCache';
import {
  countLabel,
  focusGroups,
  greetingFor,
  jumpSection,
  navItems,
  sectionStarts,
  type HomeNavItem,
} from './home/homeModel';

/** How often the home re-reads. */
const POLL_MS = 30000;

/** How often an admin's GitHub connection is re-read for the setup steps. */
const INSTALL_POLL_MS = 300000;

/** The setup steps for a workspace, done or not. */
const setupSteps = ({
  slug,
  hasTeams,
  memberCount,
  github,
  canCreateTeam,
  onCreateTeam,
}: {
  slug: string;
  hasTeams: boolean;
  memberCount: number;
  github: 'installed' | 'not_installed' | 'not_configured' | null;
  canCreateTeam: boolean;
  onCreateTeam: () => void;
}): SetupStep[] => {
  const steps: SetupStep[] = [
    {
      id: 'team',
      icon: 'team',
      title: 'Create a team',
      detail: 'Issues, cycles and projects all live in a team.',
      done: hasTeams,
      action: canCreateTeam ? (
        <Button variant="primary" size="sm" onClick={onCreateTeam}>
          <LuPlus className="h-3.5 w-3.5" aria-hidden="true" />
          Create a team
        </Button>
      ) : null,
    },
    {
      id: 'invite',
      icon: 'invite',
      title: 'Invite your people',
      detail: 'Bring in the software engineers you plan and ship with.',
      done: memberCount > 1,
      action: (
        <Link
          to={settingsPath(slug)}
          className="shrink-0 text-xs text-accent hover:underline"
        >
          Invite people
        </Link>
      ),
    },
  ];
  if (github !== 'not_configured') {
    steps.push({
      id: 'github',
      icon: 'github',
      title: 'Connect GitHub',
      detail: 'Link pull requests to issues and move them as code ships.',
      done: github === 'installed',
      action: (
        <Link
          to={settingsPath(slug)}
          className="shrink-0 text-xs text-accent hover:underline"
        >
          Connect GitHub
        </Link>
      ),
    });
  }
  return steps;
};

/** The home page of one workspace. */
const WorkspaceHome: React.FC = () => {
  const { slug = '' } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const auth = useQueryAuth();
  const { user } = useAuth();
  const { workspace } = useWorkspace();
  const createTeam = useCreateTeam();
  const createIssue = useCreateIssue();
  const workspaceId = workspace?.id ?? '';
  const userId = user?.id ?? '';
  const isAdmin = workspace?.role === 'owner' || workspace?.role === 'admin';
  const [timezone] = useState(browserTimezone);
  const [hour] = useState(() => new Date().getHours());

  const {
    data: teams,
    isLoading: teamsLoading,
    error: teamsError,
  } = useTeams();
  const hasTeams = teams !== null && teams.length > 0;
  const enabled = workspaceId !== '' && hasTeams;

  const fetchHome = useCallback(
    async ({ signal }: { signal: AbortSignal }): Promise<HomeRead> => {
      const fresh = await getHome(workspaceId, timezone, signal);
      rememberHome(userId, workspaceId, fresh);
      return fresh;
    },
    [workspaceId, timezone, userId]
  );
  const homeQuery = usePolledQuery(fetchHome, {
    intervalMs: POLL_MS,
    enabled,
    queryKey: ['home', workspaceId, timezone],
    auth,
  });
  const home = homeQuery.data ?? cachedHome(userId, workspaceId);

  const members = useWorkspaceMembers(
    workspaceId,
    workspaceId !== '' && isAdmin
  );
  const installation = usePolledQuery(
    ({ signal }) => readInstallation(workspaceId, signal),
    {
      intervalMs: INSTALL_POLL_MS,
      enabled: workspaceId !== '' && isAdmin,
      queryKey: installationKey(workspaceId),
      auth,
    }
  );
  const github = installation.data?.status ?? null;

  const groups = useMemo(
    () => (home === null ? [] : focusGroups(home.focus)),
    [home]
  );
  const items: HomeNavItem[] = useMemo(
    () => (home === null ? [] : navItems(home, groups)),
    [home, groups]
  );
  const starts = useMemo(() => sectionStarts(items), [items]);

  const teamById = useMemo(
    () => new Map((teams ?? []).map((team) => [team.id, team])),
    [teams]
  );

  const issueTeamIds = useMemo(
    () => [
      ...new Set(
        groups.flatMap((group) => group.issues.map((issue) => issue.team_id))
      ),
    ],
    [groups]
  );
  const { context } = useIssueContext(workspaceId, issueTeamIds, user?.id);

  const memberName = useMemo(() => {
    const names = new Map(
      members.map((member) => [
        member.user_id,
        member.display_name ?? 'A teammate',
      ])
    );
    for (const person of context.people) {
      if (!names.has(person.user_id) && person.display_name !== null) {
        names.set(person.user_id, person.display_name);
      }
    }
    return (id: string) => names.get(id) ?? 'A teammate';
  }, [members, context.people]);

  const hrefFor = useCallback(
    (item: HomeNavItem): string | null => {
      if (home === null) return null;
      switch (item.section) {
        case 'focus':
        case 'shipped': {
          const issue =
            groups
              .flatMap((group) => group.issues)
              .find((row) => row.id === item.id) ??
            home.shipped.items.find((row) => row.issue.id === item.id)?.issue;
          return issue === undefined ? null : issuePath(slug, issue.key);
        }
        case 'cycles': {
          const cycle = home.cycles.find((row) => row.cycle_id === item.id);
          const team =
            cycle === undefined ? undefined : teamById.get(cycle.team_id);
          return cycle === undefined || team === undefined
            ? null
            : cyclePath(slug, team.key_prefix, cycle.cycle_id);
        }
        case 'projects':
          return projectPath(slug, item.id);
        case 'pulse': {
          const pulse = home.pulse.find(
            (row) => row.update.update_id === item.id
          );
          return pulse === undefined
            ? null
            : projectPath(slug, pulse.project_id);
        }
        case 'inbox':
          return inboxPath(slug);
      }
    },
    [home, groups, slug, teamById]
  );

  const { activeIndex, setActiveIndex, registerItem } = useListKeyboardNav({
    count: items.length,
    resetKey: items.map((item) => item.id).join(','),
    onActivate: (index) => {
      const item = items[index];
      const href = item === undefined ? null : hrefFor(item);
      if (href !== null) void navigate(href);
    },
  });

  useShortcut({
    keys: 'shift+j',
    label: 'Next section',
    scope: 'page',
    group: 'Home',
    enabled: items.length > 0,
    handler: () => {
      setActiveIndex(jumpSection(items, activeIndex, 1));
    },
  });
  useShortcut({
    keys: 'shift+k',
    label: 'Previous section',
    scope: 'page',
    group: 'Home',
    enabled: items.length > 0,
    handler: () => {
      setActiveIndex(jumpSection(items, activeIndex, -1));
    },
  });

  const rowProps = (index: number) => ({
    isActive: activeIndex === index,
    rowRef: registerItem(index),
    onPointerEnter: () => {
      setActiveIndex(index);
    },
  });

  const openCreateTeam = () => {
    createTeam.open();
  };

  if (teamsLoading || teams === null) {
    return (
      <WorkspaceShell title="Home">
        {teamsError !== null ? (
          <ErrorAlert
            message={errorMessage(teamsError, 'Could not load your teams.')}
          />
        ) : (
          <SkeletonRows label="Loading your workspace" />
        )}
      </WorkspaceShell>
    );
  }

  if (!hasTeams) {
    return (
      <WorkspaceShell title="Home">
        <div className="mx-auto max-w-xl space-y-4 pt-10">
          {createTeam.canCreate ? (
            <>
              <div className="space-y-1">
                <p className="text-lg font-semibold tracking-tight text-text">
                  Welcome to {workspace?.name ?? 'your workspace'}
                </p>
                <p className="text-sm text-text-muted">
                  Three steps and the home fills with your team&apos;s work.
                </p>
              </div>
              <SetupChecklist
                steps={setupSteps({
                  slug,
                  hasTeams,
                  memberCount: members.length,
                  github: isAdmin ? github : 'not_configured',
                  canCreateTeam: true,
                  onCreateTeam: openCreateTeam,
                })}
              />
            </>
          ) : (
            <EmptyState message="You are not on a team in this workspace yet. Ask a workspace admin to add you to one." />
          )}
        </div>
      </WorkspaceShell>
    );
  }

  const firstName = (user?.display_name ?? '').trim().split(/\s+/)[0] ?? '';
  const greeting = greetingFor(hour);

  const showSetup =
    isAdmin &&
    members.length > 0 &&
    (members.length === 1 || github === 'not_installed');

  const createIssueAction = createIssue.canCreate ? (
    <Button
      variant="primary"
      size="sm"
      onClick={() => {
        createIssue.open();
      }}
    >
      <LuPlus className="h-3.5 w-3.5" aria-hidden="true" />
      New issue
    </Button>
  ) : undefined;

  const teamName = (team: TeamRead | undefined) => team?.name ?? 'Team';

  function renderSummary(data: HomeRead): React.ReactNode {
    const focus = data.focus;
    const open = data.focus.truncated
      ? `${String(focus.open_count)}+`
      : String(focus.open_count);
    const parts: { id: string; node: React.ReactNode }[] = [
      {
        id: 'open',
        node: (
          <Link to={myIssuesPath(slug)} className="hover:text-text">
            {open} open
          </Link>
        ),
      },
    ];
    if (focus.attention_count > 0) {
      parts.push({
        id: 'attention',
        node: (
          <span className="text-warning">
            {String(focus.attention_count)} need attention
          </span>
        ),
      });
    }
    parts.push(
      {
        id: 'progress',
        node: <span>{String(focus.in_progress_count)} in progress</span>,
      },
      {
        id: 'shipped',
        node: (
          <span>
            {countLabel(data.shipped.count, 'issue')} shipped this week
          </span>
        ),
      },
      {
        id: 'inbox',
        node: (
          <Link to={inboxPath(slug)} className="hover:text-text">
            {String(data.inbox.unread_count)} unread
          </Link>
        ),
      }
    );
    return (
      <p className="flex flex-wrap items-center gap-x-2 text-sm text-text-muted tabular-nums">
        {parts.map((part, index) => (
          <React.Fragment key={part.id}>
            {index > 0 && (
              <span aria-hidden="true" className="text-text-faint">
                ·
              </span>
            )}
            {part.node}
          </React.Fragment>
        ))}
      </p>
    );
  }

  function renderBody(data: HomeRead): React.ReactNode {
    const focusStart = starts.get('focus') ?? 0;
    const shippedStart = starts.get('shipped') ?? 0;
    const cyclesStart = starts.get('cycles') ?? 0;
    const projectsStart = starts.get('projects') ?? 0;
    const pulseStart = starts.get('pulse') ?? 0;
    const inboxStart = starts.get('inbox') ?? 0;
    const firstTeam = teams?.[0];
    let focusIndex = focusStart;

    return (
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-5">
          <HomeSection
            id="home-focus"
            title="Your focus"
            count={
              data.focus.truncated
                ? `${String(data.focus.open_count)}+`
                : String(data.focus.open_count)
            }
            action={
              <SectionLink to={myIssuesPath(slug)}>My issues</SectionLink>
            }
          >
            {groups.length === 0 ? (
              <EmptyState
                className="py-8"
                icon={<LuCircleCheck />}
                message="Nothing open is assigned to you. Pick something up, or file a new issue."
                action={
                  createIssue.canCreate ? (
                    <span className="flex items-center gap-2 text-xs text-text-faint">
                      Press <Kbd>C</Kbd> to create an issue
                    </span>
                  ) : undefined
                }
              />
            ) : (
              <ul aria-label="Your open issues" className="-mb-px">
                {groups.map((group) => (
                  <React.Fragment key={group.id}>
                    <GroupHeading
                      label={group.label}
                      total={group.total}
                      tone={group.tone}
                    />
                    {group.issues.map((issue) => {
                      const index = focusIndex++;
                      const name = teamById.get(issue.team_id)?.name;
                      return (
                        <IssueRow
                          key={issue.id}
                          issue={issue}
                          slug={slug}
                          statuses={context.statuses}
                          labels={context.labels}
                          people={context.people}
                          {...(name === undefined ? {} : { teamName: name })}
                          {...rowProps(index)}
                        />
                      );
                    })}
                  </React.Fragment>
                ))}
              </ul>
            )}
          </HomeSection>

          <HomeSection
            id="home-shipped"
            title="Shipped this week"
            count={String(data.shipped.count)}
            meta={
              data.shipped.mine > 0 ? (
                <span className="text-xs text-text-faint">
                  · {String(data.shipped.mine)} by you
                </span>
              ) : undefined
            }
          >
            {data.shipped.items.length === 0 ? (
              <SectionNote>
                Nothing has moved to done on your teams in the last seven days.
              </SectionNote>
            ) : (
              <ul aria-label="Shipped this week">
                {data.shipped.items.map((item, offset) => {
                  const name = teamById.get(item.issue.team_id)?.name;
                  return (
                    <ShippedRow
                      key={item.issue.id}
                      item={item}
                      href={issuePath(slug, item.issue.key)}
                      {...(name === undefined ? {} : { teamName: name })}
                      {...rowProps(shippedStart + offset)}
                    />
                  );
                })}
              </ul>
            )}
          </HomeSection>
        </div>

        <aside className="min-w-0 space-y-5" aria-label="Planning">
          {showSetup && (
            <SetupChecklist
              steps={setupSteps({
                slug,
                hasTeams,
                memberCount: members.length,
                github,
                canCreateTeam: createTeam.canCreate,
                onCreateTeam: openCreateTeam,
              })}
            />
          )}

          <HomeSection
            id="home-cycles"
            title="Active cycles"
            count={String(data.cycles.length)}
            action={<SectionLink to={roadmapPath(slug)}>Roadmap</SectionLink>}
          >
            {data.cycles.length === 0 ? (
              <SectionNote
                action={
                  firstTeam === undefined ? undefined : (
                    <Link
                      to={teamCyclesPath(slug, firstTeam.key_prefix)}
                      className="shrink-0 text-accent hover:underline"
                    >
                      Plan a cycle
                    </Link>
                  )
                }
              >
                None of your teams has a cycle running.
              </SectionNote>
            ) : (
              <ul aria-label="Active cycles">
                {data.cycles.map((cycle, offset) => {
                  const team = teamById.get(cycle.team_id);
                  return (
                    <CycleRow
                      key={cycle.cycle_id}
                      cycle={cycle}
                      teamName={teamName(team)}
                      href={
                        team === undefined
                          ? null
                          : cyclePath(slug, team.key_prefix, cycle.cycle_id)
                      }
                      {...rowProps(cyclesStart + offset)}
                    />
                  );
                })}
              </ul>
            )}
          </HomeSection>

          <HomeSection
            id="home-projects"
            title="Projects"
            count={String(data.projects_total)}
            action={
              <SectionLink to={projectsPath(slug)}>All projects</SectionLink>
            }
          >
            {data.projects.length === 0 ? (
              <SectionNote
                action={
                  <Link
                    to={projectsPath(slug)}
                    className="shrink-0 text-accent hover:underline"
                  >
                    Start a project
                  </Link>
                }
              >
                No projects are planned or in progress.
              </SectionNote>
            ) : (
              <ul aria-label="Projects in flight">
                {data.projects.map((project, offset) => (
                  <ProjectRow
                    key={project.project_id}
                    project={project}
                    href={projectPath(slug, project.project_id)}
                    {...rowProps(projectsStart + offset)}
                  />
                ))}
              </ul>
            )}
          </HomeSection>

          {data.pulse.length > 0 && (
            <HomeSection id="home-pulse" title="Project updates">
              <ul aria-label="Project updates">
                {data.pulse.map((item, offset) => (
                  <PulseRow
                    key={item.update.update_id}
                    item={item}
                    href={projectPath(slug, item.project_id)}
                    author={memberName(item.update.author_id)}
                    {...rowProps(pulseStart + offset)}
                  />
                ))}
              </ul>
            </HomeSection>
          )}

          <HomeSection
            id="home-inbox"
            title="Inbox"
            count={`${String(data.inbox.unread_count)} unread`}
            action={<SectionLink to={inboxPath(slug)}>Open inbox</SectionLink>}
          >
            {data.inbox.items.length === 0 ? (
              <SectionNote>You are all caught up.</SectionNote>
            ) : (
              <ul aria-label="Unread notifications">
                {data.inbox.items.map((item, offset) => (
                  <InboxRow
                    key={item.notification_id}
                    item={item}
                    href={inboxPath(slug)}
                    {...rowProps(inboxStart + offset)}
                  />
                ))}
              </ul>
            )}
          </HomeSection>
        </aside>
      </div>
    );
  }

  const body =
    home === null ? (
      homeQuery.error !== null ? (
        <ErrorAlert
          message={errorMessage(homeQuery.error, 'Could not load your home.')}
        />
      ) : (
        <SkeletonRows count={8} label="Loading your home" />
      )
    ) : (
      renderBody(home)
    );

  return (
    <WorkspaceShell title="Home" actions={createIssueAction}>
      <div className="mx-auto max-w-[1680px] space-y-5">
        <header className="space-y-1">
          <p className="text-lg font-semibold tracking-tight text-text">
            {firstName === '' ? greeting : `${greeting}, ${firstName}`}
          </p>
          {home === null ? (
            <p className="text-sm text-text-muted">
              Here is the day in {workspace?.name ?? 'this workspace'}.
            </p>
          ) : (
            renderSummary(home)
          )}
        </header>
        {body}
        {home !== null && items.length > 0 && <KeyHints />}
      </div>
    </WorkspaceShell>
  );
};

export default WorkspaceHome;
