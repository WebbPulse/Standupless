/**
 * The prefilled create routes, `/w/:slug/new` and `/w/:slug/team/:keyPrefix/new`.
 * The page reads the query, loads only the team lists the query names values
 * from, resolves them, opens the workspace's create dialog with what matched
 * and replaces the URL with the workspace home or the team's issues, so the
 * dialog opens over a real page and closing it leaves the person somewhere.
 *
 * The team comes from the `team` query value when it names a team the caller
 * may write issues in, else from the path, else the first such team. Nothing is
 * created until the person submits the dialog.
 */

import React, { useEffect, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { listCycles, listMilestones, listProjects } from '../../api/planning';
import { listLabels, listStatuses, listTeamMembers } from '../../api/teams';
import { listTeamTemplates } from '../../api/templates';
import Spinner from '../../components/ui/spinner';
import { useAuth } from '../../hooks/useAuth';
import { useCreateIssue } from '../../hooks/useCreateIssue';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues } from '../../lib/capabilities';
import {
  parseNewIssueParams,
  resolveNewIssueOptions,
  resolveTeam,
  type NewIssueLookups,
  type NewIssueParams,
} from '../../lib/newIssueUrl';
import { teamPath, workspacePath } from '../../lib/paths';
import { activeTeams } from '../../lib/teamRetirement';
import { estimateChoices, estimateOptionsOf } from '../../lib/validation';
import type { TeamRead } from '../../types/Api';

/** The most rows one lookup page asks for, the most the list routes allow. */
const PAGE_SIZE = 100;

/** A read that answers undefined rather than failing, so one miss drops one value. */
const settle = <T,>(read: Promise<T>): Promise<T | undefined> =>
  read.then(
    (value) => value,
    () => undefined
  );

/**
 * Loads the team lists the query names values from, and only those, so a
 * link that sets a title alone opens without a round trip.
 */
export const loadNewIssueLookups = async (
  workspaceId: string,
  team: TeamRead,
  params: NewIssueParams
): Promise<NewIssueLookups> => {
  const wants = (value: string | undefined): boolean => value !== undefined;
  const [statuses, labels, people, cycles, projects, templates] =
    await Promise.all([
      wants(params.status)
        ? settle(listStatuses(workspaceId, team.id))
        : undefined,
      params.labels.length > 0
        ? settle(listLabels(workspaceId, team.id))
        : undefined,
      params.assignee !== undefined && params.assignee.toLowerCase() !== 'me'
        ? settle(listTeamMembers(workspaceId, team.id))
        : undefined,
      wants(params.cycle)
        ? settle(
            listCycles(workspaceId, { team_id: team.id, limit: PAGE_SIZE })
          )
        : undefined,
      wants(params.project)
        ? settle(
            listProjects(workspaceId, { team_id: team.id, limit: PAGE_SIZE })
          )
        : undefined,
      wants(params.template)
        ? settle(listTeamTemplates(workspaceId, team.id))
        : undefined,
    ]);
  const project =
    params.project === undefined || projects === undefined
      ? undefined
      : resolveNewIssueOptions(
          { project: params.project, labels: [], links: [] },
          { projects: projects.projects }
        ).projectId;
  const milestones =
    project === undefined || params.projectMilestone === undefined
      ? undefined
      : await settle(listMilestones(workspaceId, project));
  return {
    estimates: estimateChoices(team.estimate_scale, estimateOptionsOf(team)),
    ...(statuses === undefined ? {} : { statuses }),
    ...(labels === undefined ? {} : { labels }),
    ...(people === undefined ? {} : { people }),
    ...(cycles === undefined ? {} : { cycles: cycles.cycles }),
    ...(projects === undefined ? {} : { projects: projects.projects }),
    ...(milestones === undefined ? {} : { milestones }),
    ...(templates === undefined ? {} : { templates: templates.templates }),
  };
};

/** Opens the create dialog from the URL, then steps aside to a real page. */
export const NewIssue: React.FC = () => {
  const { keyPrefix } = useParams<{ keyPrefix: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { workspace } = useWorkspace();
  const { teams, isLoading } = useTeam(undefined);
  const { user } = useAuth();
  const createIssue = useCreateIssue();
  const started = useRef(false);

  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  const role = workspace?.role;
  const viewerId = user?.id;
  const search = location.search;
  const open = createIssue.open;

  useEffect(() => {
    if (started.current || workspaceId === '' || isLoading) return;
    started.current = true;
    const params = parseNewIssueParams(search);
    const writable = activeTeams(teams).filter((row) =>
      canWriteIssues(role, row.role)
    );
    const fromPath =
      keyPrefix === undefined
        ? undefined
        : writable.find(
            (row) => row.key_prefix.toUpperCase() === keyPrefix.toUpperCase()
          );
    const team =
      (params.team === undefined
        ? undefined
        : resolveTeam(params.team, writable)) ??
      fromPath ??
      writable[0];
    const landing =
      keyPrefix === undefined
        ? workspacePath(slug)
        : teamPath(slug, fromPath?.key_prefix ?? keyPrefix);
    if (team === undefined) {
      void navigate(landing, { replace: true });
      return;
    }
    void loadNewIssueLookups(workspaceId, team, params).then((lookups) => {
      const options = resolveNewIssueOptions(params, {
        ...lookups,
        ...(viewerId === undefined ? {} : { viewerId }),
      });
      open({ ...options, teamId: team.id });
      void navigate(landing, { replace: true });
    });
  }, [
    workspaceId,
    isLoading,
    search,
    teams,
    role,
    keyPrefix,
    slug,
    viewerId,
    open,
    navigate,
  ]);

  return <Spinner label="Opening a new issue" />;
};

export default NewIssue;
