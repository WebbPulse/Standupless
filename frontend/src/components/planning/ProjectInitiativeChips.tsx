/**
 * The initiatives a project belongs to, as chips that open each initiative.
 * Shared by the projects list and its board so both read alike. An initiative
 * the list cannot name yet draws nothing, so a row never flashes a bare id
 * while the initiatives load.
 */

import React from 'react';
import { LuGoal } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { projectInitiativeIds } from '../../lib/planningModel';
import { initiativePath } from '../../lib/paths';
import type { InitiativeName } from '../../lib/projectList';
import type { ProjectRead } from '../../types/Api';

/** Props for ProjectInitiativeChips. */
export interface ProjectInitiativeChipsProps {
  project: Pick<ProjectRead, 'initiative_id' | 'initiative_ids'>;
  /** The workspace's initiatives by id, whole even on a scoped page. */
  initiatives: ReadonlyMap<string, InitiativeName>;
  slug: string;
  /** How many chips to draw before counting the rest, every one by default. */
  limit?: number;
}

/**
 * The project's initiative chips, or nothing outside any initiative. The links
 * take pointer events themselves because the list row passes them through its
 * cells to the link covering the row.
 */
export const ProjectInitiativeChips: React.FC<ProjectInitiativeChipsProps> = ({
  project,
  initiatives,
  slug,
  limit,
}) => {
  const named = projectInitiativeIds(project).flatMap((id) => {
    const initiative = initiatives.get(id);
    return initiative === undefined ? [] : [initiative];
  });
  const drawn = limit === undefined ? named : named.slice(0, limit);
  const rest = named
    .slice(drawn.length)
    .map((initiative) => initiative.name)
    .join(', ');
  return (
    <>
      {drawn.map((initiative) => (
        <Link
          key={initiative.initiative_id}
          to={initiativePath(slug, initiative)}
          draggable={false}
          title={initiative.name}
          className="pointer-events-auto inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-full border border-line px-1.5 text-2xs text-text-muted transition-colors duration-100 hover:border-line-strong hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
        >
          <LuGoal aria-hidden="true" className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate">{initiative.name}</span>
        </Link>
      ))}
      {named.length > drawn.length && (
        <span
          title={rest}
          className="pointer-events-auto shrink-0 text-2xs text-text-faint"
        >
          <span aria-hidden="true">
            {`+${String(named.length - drawn.length)}`}
          </span>
          <span className="sr-only">{`Also in ${rest}`}</span>
        </span>
      )}
    </>
  );
};

export default ProjectInitiativeChips;
