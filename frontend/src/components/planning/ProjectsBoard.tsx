/**
 * The projects page's board: one column per group, each project a card
 * carrying the properties the Display menu keeps on.
 * Dragging a card to another column changes the field the columns are by,
 * such as its status, health, priority, initiative or lead; a move that
 * closes a project with open issues first asks what to do with them. Team
 * columns show where a project sits but take no drops, since a project can be
 * on several teams.
 */

import React, { useMemo, useState } from 'react';
import { LuPlus } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import CloseProjectDialog, { type ClosingStatus } from './CloseProjectDialog';
import ProgressRing from './ProgressRing';
import ProjectGroupGlyph from './ProjectGroupGlyph';
import ProjectHealthGlyph from './ProjectHealthGlyph';
import ProjectDependencyMarkers from './ProjectDependencyMarkers';
import ProjectIcon from './ProjectIcon';
import ProjectStatusGlyph from './ProjectStatusGlyph';
import { TeamKey } from './ProjectPickers';
import UpdateDueBadge from './UpdateDueBadge';
import Avatar from '../ui/avatar';
import { IconButton } from '../ui/button';
import { PriorityGlyph } from '../ui/glyphs';
import {
  asksAboutOpenIssues,
  moveTargets,
  openIssueCount,
} from '../../hooks/useCloseProjectPrompt';
import { cn } from '../../lib/cn';
import { PRIORITY_LABELS } from '../../lib/issueDisplay';
import {
  personAvatar,
  personLabel,
  type Assignable,
} from '../../lib/issuePeople';
import { projectPath } from '../../lib/paths';
import {
  PROJECT_STATUS_LABELS,
  progressPercent,
} from '../../lib/planningDisplay';
import { canEditProject } from '../../lib/planningModel';
import { healthLabel } from '../../lib/projectLook';
import {
  groupPatch,
  inGroup,
  type ProjectColumn,
  type ProjectGroup,
  type ProjectMove,
} from '../../lib/projectList';
import { shortDateLabel } from '../../lib/propertyOptions';
import type {
  ProjectOpenIssues,
  ProjectRead,
  TeamRead,
  WorkspaceRole,
} from '../../types/Api';

/** The properties a card carries when the page names none. */
const DEFAULT_CARD_PROPERTIES: readonly ProjectColumn[] = [
  'health',
  'priority',
  'target',
  'teams',
  'lead',
  'progress',
];

/** Props for BoardCard: one project and how it is dragged. */
interface BoardCardProps {
  project: ProjectRead;
  /** Every loaded project by id, so the dependency flags can name their projects. */
  byId: ReadonlyMap<string, ProjectRead>;
  shown: readonly ProjectColumn[];
  slug: string;
  teams: TeamRead[];
  people: Assignable[];
  draggable: boolean;
  dimmed: boolean;
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: () => void;
}

/** One project as a board card that opens the project. */
const BoardCard: React.FC<BoardCardProps> = ({
  project,
  byId,
  shown,
  slug,
  teams,
  people,
  draggable,
  dimmed,
  onDragStart,
  onDragEnd,
}) => {
  const percent = progressPercent(project);
  const lead = people.find((person) => person.user_id === project.lead_id);
  const projectTeams = teams.filter((team) =>
    project.team_ids.includes(team.id)
  );
  const has = (column: ProjectColumn): boolean => shown.includes(column);
  const summary =
    has('summary') && project.description !== null
      ? (project.description.split('\n')[0] ?? '')
      : '';
  const dated = (value: string | null, field: string): React.ReactNode => (
    <span
      className={cn(
        'whitespace-nowrap tabular-nums',
        value === null && 'text-text-faint'
      )}
    >
      <span className="sr-only">{`${field} `}</span>
      {value === null ? 'No date' : shortDateLabel(value)}
    </span>
  );
  return (
    <li
      data-project-id={project.project_id}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        'group/card relative flex flex-col gap-2 rounded-md border border-line bg-raised px-3 py-2 shadow-xs transition-colors duration-100 hover:border-line-strong hover:shadow-sm',
        dimmed && 'opacity-40',
        draggable && 'cursor-grab active:cursor-grabbing'
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <ProjectIcon icon={project.icon} color={project.color} />
        <Link
          to={projectPath(slug, project.project_id)}
          draggable={false}
          data-hover="parent"
          className="min-w-0 flex-1 truncate text-sm font-medium text-text after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-accent"
        >
          {project.name}
        </Link>
        {has('dependencies') && (
          <ProjectDependencyMarkers project={project} byId={byId} />
        )}
        <UpdateDueBadge project={project} className="shrink-0" />
      </div>
      {summary !== '' && (
        <p className="truncate text-xs text-text-faint">{summary}</p>
      )}
      <div className="flex min-w-0 items-center gap-2 text-xs text-text-muted">
        {has('status') && (
          <ProjectStatusGlyph
            status={project.status}
            percent={percent}
            name={PROJECT_STATUS_LABELS[project.status]}
          />
        )}
        {has('health') && (
          <ProjectHealthGlyph
            health={project.health}
            name={healthLabel(project.health)}
          />
        )}
        {has('priority') && (
          <PriorityGlyph
            priority={project.priority}
            name={PRIORITY_LABELS[project.priority]}
          />
        )}
        {has('start') && dated(project.start_date, 'Start')}
        {has('target') && dated(project.target_date, 'Target')}
        {has('teams') && (
          <span className="flex min-w-0 items-center gap-1">
            {projectTeams.slice(0, 2).map((team) => (
              <TeamKey key={team.id} keyPrefix={team.key_prefix} />
            ))}
          </span>
        )}
        {has('issues') && (
          <span className="whitespace-nowrap tabular-nums">
            <span aria-hidden="true">{`${String(project.counts.done)}/${String(project.counts.total)}`}</span>
            <span className="sr-only">{`${String(project.counts.done)} of ${String(project.counts.total)} issues done`}</span>
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 tabular-nums">
          {has('lead') && lead !== undefined && (
            <span title={personLabel(lead)}>
              <Avatar
                name={personLabel(lead)}
                src={personAvatar(lead)}
                size="xs"
              />
              <span className="sr-only">{`Lead ${personLabel(lead)}`}</span>
            </span>
          )}
          {has('progress') && (
            <>
              <ProgressRing percent={percent} />
              <span>{`${String(percent)}%`}</span>
            </>
          )}
        </span>
      </div>
    </li>
  );
};

/** Props for ProjectsBoard: the columns and what a move needs. */
export interface ProjectsBoardProps {
  columns: ProjectGroup[];
  /** Every project the caller sees, for the close dialog's move targets. */
  projects: ProjectRead[];
  /** The properties each card carries, in drawing order. */
  shown?: readonly ProjectColumn[] | undefined;
  slug: string;
  workspaceId: string;
  teams: TeamRead[];
  people: Assignable[];
  workspaceRole: WorkspaceRole | undefined;
  onMove: (
    project: ProjectRead,
    change: ProjectMove,
    openIssues?: ProjectOpenIssues
  ) => void;
  /** The create action for a column, or undefined where it offers none. */
  createIn?: ((column: ProjectGroup) => (() => void) | undefined) | undefined;
}

/** A card being dragged and the column it came from. */
interface BoardDrag {
  projectId: string;
  column: string;
}

/** A close waiting on the open issue question. */
interface PendingClose {
  project: ProjectRead;
  status: ClosingStatus;
  change: ProjectMove;
}

/** The board of project cards in columns. */
export const ProjectsBoard: React.FC<ProjectsBoardProps> = ({
  columns,
  projects,
  shown = DEFAULT_CARD_PROPERTIES,
  slug,
  teams,
  people,
  workspaceRole,
  onMove,
  createIn,
}) => {
  const [drag, setDrag] = useState<BoardDrag | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [closing, setClosing] = useState<PendingClose | null>(null);

  const byId = useMemo(
    () => new Map(projects.map((project) => [project.project_id, project])),
    [projects]
  );

  const dragged =
    drag === null
      ? undefined
      : projects.find((project) => project.project_id === drag.projectId);

  const accepts = (column: ProjectGroup): boolean =>
    dragged !== undefined &&
    groupPatch(column) !== null &&
    !inGroup(dragged, column);

  const drop = (column: ProjectGroup): void => {
    const project = dragged;
    setDrag(null);
    setOver(null);
    if (project === undefined || inGroup(project, column)) return;
    const change = groupPatch(column);
    if (change === null) return;
    if (
      change.status !== undefined &&
      asksAboutOpenIssues(project, change.status)
    ) {
      setClosing({ project, status: change.status, change });
      return;
    }
    onMove(project, change);
  };

  return (
    <div className="min-h-0 flex-1 scroll-px-3 overflow-auto pointer-coarse:snap-x pointer-coarse:snap-mandatory lg:scroll-px-5">
      <div className="inline-flex min-w-full gap-2 px-3 pt-3 pb-6 lg:px-5">
        {columns.map((column) => {
          const onCreate = createIn?.(column);
          const isTarget = over === column.key && accepts(column);
          return (
            <section
              key={column.key}
              aria-label={column.label}
              className="group/col flex w-72 shrink-0 snap-start flex-col gap-1.5"
            >
              <div className="flex h-8 items-center gap-2 px-2 pointer-coarse:h-11">
                <ProjectGroupGlyph group={column} teams={teams} />
                <span className="truncate text-sm font-medium text-text">
                  {column.label}
                </span>
                <span className="text-xs text-text-faint tabular-nums">
                  {String(column.rows.length)}
                </span>
                {onCreate !== undefined && (
                  <IconButton
                    label={`New project in ${column.label}`}
                    size="sm"
                    className="ml-auto opacity-0 group-hover/col:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                    onClick={onCreate}
                  >
                    <LuPlus className="h-3.5 w-3.5" />
                  </IconButton>
                )}
              </div>
              <ul
                aria-label={`${column.label} projects`}
                onDragOver={(event) => {
                  if (!accepts(column)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  if (over !== column.key) setOver(column.key);
                }}
                onDragLeave={(event) => {
                  if (
                    over === column.key &&
                    !event.currentTarget.contains(event.relatedTarget as Node)
                  ) {
                    setOver(null);
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  drop(column);
                }}
                className={cn(
                  'flex min-h-24 flex-1 flex-col gap-1.5 rounded-md p-1.5 transition-colors',
                  isTarget
                    ? 'bg-surface/80 ring-1 ring-accent/40'
                    : 'bg-surface/40'
                )}
              >
                {column.rows.map((project) => (
                  <BoardCard
                    key={project.project_id}
                    project={project}
                    byId={byId}
                    shown={shown}
                    slug={slug}
                    teams={teams}
                    people={people}
                    draggable={canEditProject(workspaceRole, project, teams)}
                    dimmed={drag?.projectId === project.project_id}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', project.name);
                      setDrag({
                        projectId: project.project_id,
                        column: column.key,
                      });
                    }}
                    onDragEnd={() => {
                      setDrag(null);
                      setOver(null);
                    }}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {closing !== null && (
        <CloseProjectDialog
          project={closing.project}
          status={closing.status}
          openIssues={openIssueCount(closing.project)}
          targets={moveTargets(closing.project, projects)}
          onConfirm={(choice) => {
            onMove(closing.project, closing.change, choice);
            setClosing(null);
          }}
          onClose={() => {
            setClosing(null);
          }}
        />
      )}
    </div>
  );
};

export default ProjectsBoard;
