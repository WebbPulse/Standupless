/**
 * The card a project chip or project reference opens on hover, after Linear's
 * project card: the project's mark and name, its status, its latest health
 * with when the newest update was posted, its lead, its target date, how far
 * through its scope it is, and the teams it runs on. Clicking the name opens
 * the project.
 *
 * The project is read only once a card opens, under the same query key the
 * project page and the reference chip poll, so a project already in the cache
 * paints at once and is not read again. A project the reader cannot see shows
 * a short note, and a trigger that already knows it cannot see the project
 * draws plain with no card.
 */

import React, { useContext } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { Link, useInRouterContext } from 'react-router-dom';
import { getProject } from '../../api/planning';
import { useMemberById } from '../../contexts/MentionMembersContextDefinition';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import { useProjectStatuses } from '../../hooks/useProjectStatuses';
import { useTeamsFor } from '../../hooks/useTeams';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import { projectPath } from '../../lib/paths';
import {
  progressLabel,
  progressPercent,
  type MeasuredProgress,
} from '../../lib/planningDisplay';
import { healthLabel } from '../../lib/projectLook';
import { shortDateLabel } from '../../lib/propertyOptions';
import { projectDetailKey } from '../../lib/queryKeys';
import { fullTimestamp, relativeTime } from '../../lib/relativeTime';
import type {
  ProjectHealth,
  ProjectIconName,
  ProjectStatus,
  ProjectStatusRead,
} from '../../types/Api';
import ProgressRing from '../planning/ProgressRing';
import ProjectHealthGlyph from '../planning/ProjectHealthGlyph';
import ProjectIcon from '../planning/ProjectIcon';
import ProjectStatusGlyph from '../planning/ProjectStatusGlyph';
import Avatar from './avatar';
import { HoverCard, type HoverCardTriggerProps } from './hover-card';
import { Skeleton } from './skeleton';

/** How often an open card re-reads its project. */
const POLL_MS = 60000;

/** The project fields the card draws. */
export interface ProjectCardProject extends MeasuredProgress {
  project_id: string;
  name: string;
  icon: ProjectIconName | null;
  color: string | null;
  status: ProjectStatus;
  health: ProjectHealth | null;
  target_date: string | null;
  last_update_at?: string | null;
}

/** Props for ProjectCard: the project and what the workspace lists add. */
export interface ProjectCardProps {
  project: ProjectCardProject;
  /** The workspace status the project sits in. */
  status: Pick<ProjectStatusRead, 'name' | 'category' | 'color'>;
  /** The lead, when the project has one the member list knows. */
  lead?: Assignable | undefined;
  /** Whether the project names a lead at all. */
  hasLead?: boolean;
  teams?: { id: string; name: string }[];
  /** Where the name links to, or null outside a routed workspace. */
  href?: string | null;
}

/** One labelled fact on the card, such as the target date. */
const ProjectCardRow: React.FC<{
  label: string;
  children: React.ReactNode;
}> = ({ label, children }) => (
  <div className="flex items-center gap-2 text-xs">
    <dt className="w-16 shrink-0 text-text-faint">{label}</dt>
    <dd className="flex min-w-0 items-center gap-1.5 text-text">{children}</dd>
  </div>
);

/** The card's body for one project. */
export const ProjectCard: React.FC<ProjectCardProps> = ({
  project,
  status,
  lead,
  hasLead = lead !== undefined,
  teams = [],
  href = null,
}) => {
  const updatedAt = project.last_update_at ?? null;
  const leadName = hasLead ? personLabel(lead) : null;
  const percent = progressPercent(project);
  return (
    <div className="flex flex-col gap-2.5 p-3" data-testid="project-card">
      <div className="flex items-center gap-2">
        <ProjectIcon icon={project.icon} color={project.color} />
        {href === null ? (
          <p className="min-w-0 truncate font-medium text-text">
            {project.name}
          </p>
        ) : (
          <Link
            to={href}
            className="min-w-0 truncate rounded-sm font-medium text-text hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            {project.name}
          </Link>
        )}
      </div>
      <dl className="flex flex-col gap-1.5">
        <ProjectCardRow label="Status">
          <ProjectStatusGlyph
            status={status.category}
            percent={percent}
            color={status.color}
          />
          <span className="truncate">{status.name}</span>
        </ProjectCardRow>
        <ProjectCardRow label="Health">
          <ProjectHealthGlyph health={project.health} />
          <span className="truncate">{healthLabel(project.health)}</span>
          {updatedAt !== null && (
            <span
              className="shrink-0 text-text-faint"
              title={fullTimestamp(updatedAt)}
            >
              · {relativeTime(updatedAt)}
            </span>
          )}
        </ProjectCardRow>
        <ProjectCardRow label="Lead">
          {leadName === null ? (
            <span className="text-text-muted">No lead</span>
          ) : (
            <>
              <Avatar
                name={leadName}
                src={lead?.avatar_url ?? null}
                size="xs"
              />
              <span className="truncate">{leadName}</span>
            </>
          )}
        </ProjectCardRow>
        <ProjectCardRow label="Target">
          {project.target_date === null ? (
            <span className="text-text-muted">No target date</span>
          ) : (
            <span>{shortDateLabel(project.target_date)}</span>
          )}
        </ProjectCardRow>
        <ProjectCardRow label="Progress">
          <ProgressRing percent={percent} />
          <span data-testid="project-card-progress">{percent}%</span>
          <span className="truncate text-text-faint">
            · {progressLabel(project)}
          </span>
        </ProjectCardRow>
        {teams.length > 0 && (
          <ProjectCardRow label="Teams">
            <ul aria-label="Teams" className="flex flex-wrap gap-1">
              {teams.map((team) => (
                <li
                  key={team.id}
                  className="inline-flex h-5 items-center rounded-full border border-line px-1.5 text-2xs text-text-muted"
                >
                  {team.name}
                </li>
              ))}
            </ul>
          </ProjectCardRow>
        )}
      </dl>
    </div>
  );
};

/** The card body while the project's first read is in flight. */
const ProjectCardSkeleton: React.FC = () => (
  <div className="flex flex-col gap-2 p-3" aria-busy="true">
    <Skeleton className="h-4 w-40" />
    <Skeleton className="h-3 w-full" />
    <Skeleton className="h-3 w-3/4" />
    <Skeleton className="h-3 w-1/2" />
  </div>
);

/** The card's content for one project of the open workspace, read on open. */
export const ProjectCardBody: React.FC<{ projectId: string }> = ({
  projectId,
}) => {
  const workspace = useContext(WorkspaceContext)?.workspace ?? null;
  const workspaceId = workspace?.id ?? '';
  const routed = useInRouterContext();
  const auth = useQueryAuth();
  const { data: project, isLoading } = usePolledQuery(
    ({ signal }) => getProject(workspaceId, projectId, undefined, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '' && projectId !== '',
      queryKey: projectDetailKey(workspaceId, projectId),
      auth,
    }
  );
  const { statusOf } = useProjectStatuses(workspaceId);
  const lead = useMemberById(project?.lead_id);
  const { data: allTeams } = useTeamsFor(workspaceId);
  if (project === null && isLoading) {
    return <ProjectCardSkeleton />;
  }
  if (project === null || workspace === null) {
    return (
      <p className="p-3 text-xs text-text-muted">
        This project was not found, or you do not have access to it.
      </p>
    );
  }
  const ids = new Set(project.team_ids);
  const teams = (allTeams ?? [])
    .filter((team) => ids.has(team.id))
    .map((team) => ({ id: team.id, name: team.name }));
  return (
    <ProjectCard
      project={project}
      status={statusOf(project)}
      lead={lead}
      hasLead={project.lead_id !== null}
      teams={teams}
      href={routed ? projectPath(workspace.slug, project) : null}
    />
  );
};

/** Props for ProjectHoverTrigger: the project and the element the card hangs off. */
export interface ProjectHoverTriggerProps {
  /** The project's id, or null when the trigger names none. */
  projectId: string | null | undefined;
  /** Draws the trigger plain, for a project the reader cannot see. */
  disabled?: boolean;
  children: (trigger: Partial<HoverCardTriggerProps>) => React.ReactElement;
}

/** Wraps a trigger so resting on it opens the project's card, or draws it plain with no project. */
export const ProjectHoverTrigger: React.FC<ProjectHoverTriggerProps> = ({
  projectId,
  disabled = false,
  children,
}) => {
  const workspace = useContext(WorkspaceContext)?.workspace ?? null;
  const id = projectId ?? '';
  const known = !disabled && workspace !== null && id !== '';
  return (
    <HoverCard
      disabled={!known}
      className="w-72"
      content={() => <ProjectCardBody projectId={id} />}
    >
      {children}
    </HoverCard>
  );
};

export default ProjectHoverTrigger;
