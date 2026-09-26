/**
 * Every project across the teams the caller can see. The API reads projects
 * one team at a time, because the planning table files them under the team's
 * own prefix, so this page fans the read out over the visible teams and merges
 * what comes back. The team filter narrows that fan-out to a single read.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { LuPlus, LuTarget } from 'react-icons/lu';
import { Link, useSearchParams } from 'react-router-dom';
import { createProject, listProjects } from '../../api/planning';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import Field from '../../components/ui/field';
import { SelectField } from '../../components/ui/select';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import ProjectStatusBadge from '../../components/planning/ProjectStatusBadge';
import ProgressBar from '../../components/planning/ProgressBar';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  completionPercent,
  dateLabel,
  shortCountsLabel,
} from '../../lib/planningDisplay';
import { projectsKey } from '../../lib/queryKeys';
import { validateTargetDate } from '../../lib/validation';
import { projectPath } from '../../lib/paths';
import type { ProjectRead, TeamRead } from '../../types/Api';

/** How often the lists re-read. */
const POLL_MS = 60000;

/** One project with the team it belongs to, which its own row does not carry. */
interface Row {
  project: ProjectRead;
  team: TeamRead;
}

/** The latest result of one team's paginated read. */
interface TeamProjectResult {
  rows: Row[];
  error: unknown;
  isLoading: boolean;
}

/** Props for ProjectRow: one project and the workspace it lives in. */
interface ProjectRowProps {
  row: Row;
  slug: string;
}

/** One project as a dense row linking to its page. */
const ProjectRow: React.FC<ProjectRowProps> = ({ row, slug }) => {
  const { project, team } = row;
  return (
    <li className="border-b border-line last:border-b-0">
      <Link
        to={projectPath(slug, project.project_id, team.key_prefix)}
        className="flex h-row items-center gap-3 px-3 text-sm transition-colors duration-100 hover:bg-surface focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
      >
        <LuTarget
          className="h-4 w-4 shrink-0 text-text-faint"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate font-medium">
          {project.name}
        </span>
        <span className="hidden shrink-0 text-xs text-text-faint sm:block">
          {team.name}
        </span>
        <ProjectStatusBadge status={project.status} />
        <span className="shrink-0 text-xs whitespace-nowrap text-text-muted tabular-nums">
          {dateLabel(project.target_date, 'No target date')}
        </span>
        <ProgressBar
          percent={completionPercent(project.counts)}
          className="hidden w-20 shrink-0 md:block"
        />
        <span className="hidden shrink-0 text-xs text-text-muted tabular-nums md:block">
          {shortCountsLabel(project.counts)}
        </span>
      </Link>
    </li>
  );
};

/** Props for TeamProjects: one team's read, reported up to the page. */
interface TeamProjectsProps {
  workspaceId: string;
  team: TeamRead;
  onResult: (teamId: string, result: TeamProjectResult) => void;
}

/**
 * One team's project read. Rendered as an invisible child per team because
 * the number of teams is only known at runtime and a hook cannot be called in
 * a loop; each child owns one read and hands its rows to the page.
 */
const TeamProjects: React.FC<TeamProjectsProps> = ({
  workspaceId,
  team,
  onResult,
}) => {
  const auth = useQueryAuth();

  const read = useCallback(
    async ({ signal }: { signal?: AbortSignal }) => {
      const projects: ProjectRead[] = [];
      let cursor: string | null = null;
      do {
        const page = await listProjects(
          workspaceId,
          { team_id: team.id, ...(cursor === null ? {} : { cursor }) },
          signal
        );
        projects.push(...page.projects);
        if (page.next_cursor !== null && page.next_cursor === cursor) {
          throw new Error('Project pagination returned a repeated cursor');
        }
        cursor = page.next_cursor;
      } while (cursor !== null);
      return { projects };
    },
    [workspaceId, team.id]
  );

  const { data, error, isLoading } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: workspaceId !== '',
    queryKey: projectsKey(workspaceId, team.id, ''),
    auth,
  });

  const rows = useMemo(
    () => (data?.projects ?? []).map((project) => ({ project, team })),
    [data, team]
  );

  React.useEffect(() => {
    onResult(team.id, { rows, error, isLoading });
  }, [error, isLoading, onResult, rows, team.id]);

  return null;
};

/** The projects of every team the caller can see. */
export const Projects: React.FC = () => {
  const { workspace } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const {
    teams,
    workspaceId,
    isLoading: isResolvingTeams,
    error: teamsError,
  } = useTeam(undefined);

  const teamFilter = params.get('team') ?? '';
  const statusFilter = params.get('status') ?? '';

  const [byTeam, setByTeam] = useState<Record<string, TeamProjectResult>>({});
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [description, setDescription] = useState('');
  const [createTeam, setCreateTeam] = useState('');

  const onResult = useCallback(
    (teamId: string, result: TeamProjectResult): void => {
      setByTeam((held) => {
        const previous = held[teamId];
        if (
          previous !== undefined &&
          previous.error === result.error &&
          previous.isLoading === result.isLoading &&
          previous.rows.length === result.rows.length &&
          previous.rows.every(
            (row, index) =>
              row.project.project_id ===
                result.rows[index]?.project.project_id &&
              row.project.updated_at === result.rows[index]?.project.updated_at
          )
        ) {
          return held;
        }
        return { ...held, [teamId]: result };
      });
    },
    []
  );

  const visibleTeams = useMemo(
    () =>
      teamFilter === ''
        ? teams
        : teams.filter((team) => team.key_prefix === teamFilter),
    [teams, teamFilter]
  );

  const rows = useMemo(() => {
    const merged = visibleTeams.flatMap((team) => byTeam[team.id]?.rows ?? []);
    const filtered =
      statusFilter === ''
        ? merged
        : merged.filter((row) => row.project.status === statusFilter);
    return filtered.sort((a, b) => {
      const left = a.project.target_date;
      const right = b.project.target_date;
      if (left === null && right === null)
        return a.project.name.localeCompare(b.project.name);
      if (left === null) return 1;
      if (right === null) return -1;
      return left.localeCompare(right);
    });
  }, [visibleTeams, byTeam, statusFilter]);

  const filteredTeam = teams.find((team) => team.key_prefix === teamFilter);
  const defaultCreateTeam =
    teamFilter === ''
      ? teams.find((team) => canWriteIssues(workspace?.role, team.role))
      : filteredTeam;
  const createTarget =
    teams.find((team) => team.key_prefix === createTeam) ?? defaultCreateTeam;

  const createKey = projectsKey(workspaceId, createTarget?.id ?? '', '');

  const {
    mutate: add,
    isMutating: isAdding,
    error: addError,
  } = useMutationWithRefetch(
    () =>
      createProject(workspaceId, {
        team_id: createTarget?.id ?? '',
        name: name.trim(),
        ...(targetDate === '' ? {} : { target_date: targetDate }),
        ...(description.trim() === ''
          ? {}
          : { description: description.trim() }),
      }),
    createKey
  );

  const setFilter = (field: 'team' | 'status', value: string): void => {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(field);
    else next.set(field, value);
    setParams(next, { replace: true });
  };

  const canCreate =
    defaultCreateTeam !== undefined &&
    canWriteIssues(workspace?.role, defaultCreateTeam.role);
  const dateError = validateTargetDate(targetDate);
  const canAdd =
    name.trim() !== '' &&
    dateError === null &&
    createTarget !== undefined &&
    canWriteIssues(workspace?.role, createTarget.role);

  const closeDialog = useCallback((): void => {
    setIsCreating(false);
  }, []);

  const isLoading =
    teamsError === null &&
    (isResolvingTeams ||
      visibleTeams.some((team) => byTeam[team.id]?.isLoading ?? true));
  const failedTeams = visibleTeams.filter(
    (team) => byTeam[team.id]?.error != null
  );

  return (
    <WorkspaceShell
      title="Projects"
      actions={
        canCreate ? (
          <Button
            variant="primary"
            onClick={() => {
              setCreateTeam(defaultCreateTeam?.key_prefix ?? '');
              setIsCreating(true);
            }}
          >
            <LuPlus aria-hidden="true" />
            New project
          </Button>
        ) : undefined
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <SelectField
            id="projects-team"
            label="Team"
            hideLabel
            className="w-44"
            value={teamFilter}
            onChange={(event) => {
              setFilter('team', event.target.value);
            }}
          >
            <option value="">All teams</option>
            {teams.map((team) => (
              <option key={team.id} value={team.key_prefix}>
                {team.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            id="projects-status"
            label="Status"
            hideLabel
            className="w-40"
            value={statusFilter}
            onChange={(event) => {
              setFilter('status', event.target.value);
            }}
          >
            <option value="">Any status</option>
            {PROJECT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {PROJECT_STATUS_LABELS[value]}
              </option>
            ))}
          </SelectField>
        </div>
      }
    >
      {teamsError !== null && (
        <ErrorAlert
          message={errorMessage(
            teamsError,
            'Could not load teams. Try again shortly.'
          )}
        />
      )}

      {visibleTeams.map((team) => (
        <TeamProjects
          key={team.id}
          workspaceId={workspaceId}
          team={team}
          onResult={onResult}
        />
      ))}

      {failedTeams.map((team) => (
        <ErrorAlert
          key={team.id}
          message={`${team.name}: ${errorMessage(byTeam[team.id]?.error, 'Could not load projects. Try again shortly.')}`}
        />
      ))}

      {isLoading && rows.length === 0 ? (
        <Spinner label="Loading projects" />
      ) : rows.length === 0 &&
        failedTeams.length === 0 &&
        teamsError === null ? (
        <EmptyState
          icon={<LuTarget />}
          message="No projects match these filters. A project is a dated body of work owned by one team."
        />
      ) : rows.length > 0 ? (
        <ul className="rounded-md border border-line">
          {rows.map((row) => (
            <ProjectRow
              key={`${row.team.id}:${row.project.project_id}`}
              row={row}
              slug={workspace?.slug ?? ''}
            />
          ))}
        </ul>
      ) : null}

      {isCreating && createTarget !== undefined && (
        <Dialog open title="New project" onClose={closeDialog}>
          <div className="space-y-4">
            {addError !== null && (
              <ErrorAlert
                message={errorMessage(
                  addError,
                  'Could not create that project.'
                )}
              />
            )}
            <Field
              id="new-project-name"
              label="Name"
              placeholder="Name this project"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <SelectField
              id="new-project-team"
              label="Team"
              value={createTarget.key_prefix}
              onChange={(event) => {
                setCreateTeam(event.target.value);
              }}
            >
              {teams.map((team) => (
                <option key={team.id} value={team.key_prefix}>
                  {team.name}
                </option>
              ))}
            </SelectField>
            <Field
              id="new-project-target"
              label="Target date"
              type="date"
              value={targetDate}
              onChange={(event) => {
                setTargetDate(event.target.value);
              }}
            />
            <Field
              id="new-project-description"
              label="Description"
              placeholder="Optional"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
            <ErrorAlert message={dateError} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={closeDialog}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={isAdding || !canAdd}
                onClick={() => {
                  void add()
                    .then(() => {
                      setName('');
                      setTargetDate('');
                      setDescription('');
                      setIsCreating(false);
                    })
                    .catch(() => undefined);
                }}
              >
                {isAdding ? 'Creating' : 'Create project'}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </WorkspaceShell>
  );
};

export default Projects;
