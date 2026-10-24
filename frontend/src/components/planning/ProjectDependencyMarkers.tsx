/**
 * The blocked and blocking flags a project row shows beside its name, drawn
 * with the same glyphs and tones as the issue list's flags so a reader learns
 * one mark. The project carries the ids of the projects it waits on and the
 * ones waiting on it, so the list draws both without asking for relations, and
 * the names in the tooltip come from the projects already on the page.
 *
 * A blocker counts while it is still open, so finishing or canceling it drops
 * the blocked flag, and a project that is itself closed no longer flags the
 * projects it blocks.
 */

import React from 'react';
import { cn } from '../../lib/cn';
import { isClosedProject } from '../../lib/projectList';
import type { ProjectRead } from '../../types/Api';
import {
  BLOCKED_TONE,
  BLOCKING_TONE,
  BlockedGlyph,
  BlockingGlyph,
} from '../issues/RelationGlyphs';
import { Tooltip } from '../ui/tooltip';

/** The most projects a tooltip names before it counts the rest. */
const LINE_LIMIT = 8;

/**
 * The blockers still holding a project up. A blocker the page cannot name,
 * such as one filtered out of view, still counts, since the server only lists
 * projects the reader may see.
 */
export const openBlockers = (
  project: Pick<ProjectRead, 'blocked_by_project_ids'>,
  byId: ReadonlyMap<string, ProjectRead>
): string[] =>
  (project.blocked_by_project_ids ?? []).filter((id) => {
    const blocker = byId.get(id);
    return blocker === undefined || !isClosedProject(blocker);
  });

/** The projects this one holds up, none once it is closed itself. */
export const heldProjects = (project: ProjectRead): string[] =>
  isClosedProject(project) ? [] : (project.blocking_project_ids ?? []);

/** The tooltip lines naming the given projects, the rest counted. */
const nameLines = (
  ids: string[],
  byId: ReadonlyMap<string, ProjectRead>
): string[] => {
  const named = ids
    .slice(0, LINE_LIMIT)
    .map((id) => byId.get(id)?.name ?? 'A project');
  if (ids.length > LINE_LIMIT)
    named.push(`and ${String(ids.length - LINE_LIMIT)} more`);
  return named;
};

/** Props for one flag: its projects, how it is named and how it looks. */
interface FlagProps {
  ids: string[];
  byId: ReadonlyMap<string, ProjectRead>;
  label: string;
  kind: 'blocked_by' | 'blocks';
  glyph: React.FC<{ className?: string }>;
  tone: string;
  className?: string | undefined;
}

/** One flag with a tooltip naming the projects behind it. */
const Flag: React.FC<FlagProps> = ({
  ids,
  byId,
  label,
  kind,
  glyph: Glyph,
  tone,
  className,
}) => {
  if (ids.length === 0) return null;
  const text = [label, ...nameLines(ids, byId)].join('\n');
  return (
    <Tooltip
      text={text}
      className={cn(
        'pointer-events-auto relative z-10 shrink-0 pointer-coarse:pointer-events-none',
        className
      )}
    >
      <span
        role="img"
        aria-label={label}
        data-project-dependency={kind}
        className={cn('inline-flex shrink-0 items-center', tone)}
      >
        <Glyph className="h-3.5 w-3.5" />
      </span>
    </Tooltip>
  );
};

/** Props for ProjectDependencyMarkers: the project and the projects it can name. */
export interface ProjectDependencyMarkersProps {
  project: ProjectRead;
  byId: ReadonlyMap<string, ProjectRead>;
  className?: string;
}

/** Both flags for one project, blocked first, each drawn only when it applies. */
export const ProjectDependencyMarkers: React.FC<
  ProjectDependencyMarkersProps
> = ({ project, byId, className }) => {
  const blockers = openBlockers(project, byId);
  const held = heldProjects(project);
  return (
    <>
      <Flag
        ids={blockers}
        byId={byId}
        kind="blocked_by"
        label={
          blockers.length === 1
            ? 'Blocked by 1 open project'
            : `Blocked by ${String(blockers.length)} open projects`
        }
        glyph={BlockedGlyph}
        tone={BLOCKED_TONE}
        className={className}
      />
      <Flag
        ids={held}
        byId={byId}
        kind="blocks"
        label={
          held.length === 1
            ? 'Blocking 1 project'
            : `Blocking ${String(held.length)} projects`
        }
        glyph={BlockingGlyph}
        tone={BLOCKING_TONE}
        className={className}
      />
    </>
  );
};

export default ProjectDependencyMarkers;
