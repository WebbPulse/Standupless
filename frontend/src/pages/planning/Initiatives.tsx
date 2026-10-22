/**
 * Every initiative in the workspace, grouped by status. An initiative groups
 * projects across teams, so each row shows its health, owner, how many
 * projects it holds, its target date and how far those projects have come.
 * Sub-initiatives sit indented under their parent, and a parent folds away.
 */

import React, { useMemo, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { LuChevronDown, LuChevronRight, LuGoal, LuPlus } from 'react-icons/lu';
import { Link, useNavigate } from 'react-router-dom';
import CreateInitiativeDialog from '../../components/planning/CreateInitiativeDialog';
import ProgressRing from '../../components/planning/ProgressRing';
import ProjectHealthGlyph from '../../components/planning/ProjectHealthGlyph';
import ProjectStatusGlyph from '../../components/planning/ProjectStatusGlyph';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import Button from '../../components/ui/button';
import EmptyState from '../../components/ui/empty-state';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useAuth } from '../../hooks/useAuth';
import { useInitiatives } from '../../hooks/useInitiatives';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import {
  initiativeTreeRows,
  type InitiativeTreeRow,
} from '../../lib/initiativeTree';
import {
  personAvatar,
  personLabel,
  type Assignable,
} from '../../lib/issuePeople';
import { initiativePath } from '../../lib/paths';
import {
  INITIATIVE_STATUSES,
  INITIATIVE_STATUS_GLYPHS,
  INITIATIVE_STATUS_LABELS,
  progressPercent,
} from '../../lib/planningDisplay';
import { shortDateLabel } from '../../lib/propertyOptions';

/** The grid every header and row lines up on. */
const GRID =
  'grid grid-cols-[minmax(0,1fr)_3.5rem] items-center gap-3 md:grid-cols-[minmax(0,1fr)_4rem_3.5rem_5.5rem_6rem_4.5rem]';

/** How far each level of sub-initiative is indented, in rem. */
const INDENT_REM = 1.25;

/** Props for InitiativeRow: its place in the tree and the people its owner is among. */
interface InitiativeRowProps {
  row: InitiativeTreeRow;
  slug: string;
  people: Assignable[];
  collapsed: boolean;
  onToggle: (initiativeId: string) => void;
}

/** One initiative as a row linking to its page, indented under its parent. */
const InitiativeRow: React.FC<InitiativeRowProps> = ({
  row,
  slug,
  people,
  collapsed,
  onToggle,
}) => {
  const { initiative, depth, childCount, parentName } = row;
  const percent = progressPercent(initiative);
  const owner = people.find((person) => person.user_id === initiative.owner_id);
  const projects = initiative.project_count;
  return (
    <li
      className={cn(
        GRID,
        'relative h-11 border-b border-line px-4 text-sm transition-colors duration-100 hover:bg-surface has-[a:active]:bg-raised lg:px-6'
      )}
    >
      <Link
        to={initiativePath(slug, initiative.initiative_id)}
        aria-label={initiative.name}
        data-hover="parent"
        className="absolute inset-0 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset"
      />
      <div
        className="pointer-events-none flex min-w-0 items-center gap-2.5"
        style={{ paddingLeft: `${String(depth * INDENT_REM)}rem` }}
      >
        {childCount > 0 ? (
          <button
            type="button"
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${initiative.name}`}
            aria-expanded={!collapsed}
            onClick={() => {
              onToggle(initiative.initiative_id);
            }}
            className="pointer-events-auto relative z-10 -mx-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-muted hover:bg-raised hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            {collapsed ? (
              <LuChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <LuChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          depth > 0 && (
            <span aria-hidden="true" className="-mx-1 w-5 shrink-0" />
          )
        )}
        <LuGoal
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-text-muted"
        />
        <span className="truncate font-medium text-text">
          {initiative.name}
        </span>
        {collapsed && childCount > 0 && (
          <span className="shrink-0 text-xs text-text-faint tabular-nums">
            {`${String(childCount)} sub-${childCount === 1 ? 'initiative' : 'initiatives'}`}
          </span>
        )}
        {parentName !== null && (
          <span className="hidden shrink-0 truncate text-xs text-text-faint sm:inline">
            {`in ${parentName}`}
          </span>
        )}
        {initiative.description !== null && initiative.description !== '' && (
          <span className="hidden min-w-0 truncate text-xs text-text-faint xl:block">
            {initiative.description.split('\n')[0]}
          </span>
        )}
      </div>
      <span className="pointer-events-none hidden justify-center md:flex">
        <ProjectHealthGlyph
          health={initiative.health}
          name={`Health ${initiative.health === null ? 'not set' : initiative.health.replace('_', ' ')}`}
        />
      </span>
      <span className="pointer-events-none hidden justify-center md:flex">
        {owner === undefined ? (
          <span className="sr-only">No owner</span>
        ) : (
          <>
            <Avatar
              name={personLabel(owner)}
              src={personAvatar(owner)}
              size="xs"
            />
            <span className="sr-only">{`Owner ${personLabel(owner)}`}</span>
          </>
        )}
      </span>
      <span className="pointer-events-none hidden text-xs whitespace-nowrap text-text-muted tabular-nums md:block">
        {`${String(projects)} ${projects === 1 ? 'project' : 'projects'}`}
      </span>
      <span
        className={cn(
          'pointer-events-none hidden text-xs whitespace-nowrap tabular-nums md:block',
          initiative.target_date === null
            ? 'text-text-faint'
            : 'text-text-muted'
        )}
      >
        {initiative.target_date === null
          ? 'No date'
          : shortDateLabel(initiative.target_date)}
      </span>
      <span className="pointer-events-none flex items-center justify-end gap-1.5 text-xs text-text-muted tabular-nums">
        <ProgressRing percent={percent} />
        <span>{`${String(percent)}%`}</span>
      </span>
    </li>
  );
};

/** The workspace's initiatives, grouped by status, with a way to start one. */
export const Initiatives: React.FC = () => {
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const navigate = useNavigate();
  const slug = workspace?.slug ?? '';
  const workspaceId = workspace?.id ?? '';
  const isMember = workspace !== null && workspace.role !== 'guest';
  const { initiatives, error, isLoading, queryKey } = useInitiatives(
    workspaceId,
    isMember
  );
  const members = useWorkspaceMembers(workspaceId, isMember);
  const [isCreating, setIsCreating] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  const toggle = (initiativeId: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(initiativeId)) next.delete(initiativeId);
      else next.add(initiativeId);
      return next;
    });
  };

  const groups = useMemo(
    () =>
      INITIATIVE_STATUSES.map((status) => {
        const rows = initiatives
          .filter((initiative) => initiative.status === status)
          .sort((left, right) =>
            (left.target_date ?? '9999').localeCompare(
              right.target_date ?? '9999'
            )
          );
        return {
          status,
          count: rows.length,
          rows: initiativeTreeRows(rows, initiatives, collapsed),
        };
      }).filter((group) => group.count > 0),
    [initiatives, collapsed]
  );

  return (
    <WorkspaceShell
      title="Initiatives"
      flush
      actions={
        isMember ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setIsCreating(true);
            }}
          >
            <LuPlus aria-hidden="true" />
            New initiative
          </Button>
        ) : undefined
      }
    >
      {error != null && (
        <div className="px-4 pt-3 lg:px-6">
          <ErrorAlert
            message={errorMessage(error, 'Could not load the initiatives.')}
          />
        </div>
      )}
      <div>
        <div
          role="presentation"
          className={cn(
            GRID,
            'sticky top-0 z-20 h-8 border-b border-line bg-bg px-4 text-2xs font-medium tracking-wide text-text-faint uppercase lg:px-6'
          )}
        >
          <span>Name</span>
          <span className="hidden truncate text-center md:block">Health</span>
          <span className="hidden truncate text-center md:block">Owner</span>
          <span className="hidden md:block">Projects</span>
          <span className="hidden md:block">Target</span>
          <span className="text-right">
            <span className="hidden md:inline">Progress</span>
          </span>
        </div>
        {!isMember ? (
          <EmptyState
            icon={<LuGoal />}
            message="Initiatives are open to workspace members, not guests."
          />
        ) : isLoading && initiatives.length === 0 ? (
          <SkeletonRows label="Loading initiatives" />
        ) : groups.length === 0 && error == null ? (
          <EmptyState
            icon={<LuGoal />}
            message="No initiatives yet. An initiative groups projects across teams toward one goal."
          />
        ) : (
          groups.map((group) => (
            <section
              key={group.status}
              aria-label={INITIATIVE_STATUS_LABELS[group.status]}
            >
              <div className="sticky top-8 z-10 flex h-9 items-center gap-2 border-b border-line bg-surface px-4 text-sm font-medium text-text lg:px-6">
                <ProjectStatusGlyph
                  status={INITIATIVE_STATUS_GLYPHS[group.status]}
                />
                <span>{INITIATIVE_STATUS_LABELS[group.status]}</span>
                <span className="text-xs font-normal text-text-faint tabular-nums">
                  {String(group.count)}
                </span>
              </div>
              <ul>
                {group.rows.map((row) => (
                  <InitiativeRow
                    key={row.initiative.initiative_id}
                    row={row}
                    slug={slug}
                    people={members}
                    collapsed={collapsed.has(row.initiative.initiative_id)}
                    onToggle={toggle}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {isCreating && (
        <CreateInitiativeDialog
          workspaceId={workspaceId}
          people={members}
          initialOwnerId={user?.id ?? null}
          onClose={() => {
            setIsCreating(false);
          }}
          onCreated={(initiative) => {
            setIsCreating(false);
            invalidateQueries(queryKey);
            void navigate(initiativePath(slug, initiative.initiative_id));
          }}
        />
      )}
    </WorkspaceShell>
  );
};

export default Initiatives;
