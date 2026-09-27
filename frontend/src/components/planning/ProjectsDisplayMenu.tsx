/**
 * The Display button of the projects list and the roadmap: how rows group
 * and, on the list, what order they run in. It reads like the issue list's
 * Display menu so every list is arranged the same way, and it writes
 * nothing itself.
 */

import React from 'react';
import { LuSlidersHorizontal } from 'react-icons/lu';
import {
  PROJECT_GROUPINGS,
  PROJECT_GROUPING_LABELS,
  PROJECT_ORDERINGS,
  PROJECT_ORDERING_LABELS,
  parseGrouping,
  parseOrdering,
  type ProjectGrouping,
  type ProjectOrdering,
} from '../../lib/projectList';
import Button from '../ui/button';
import { Popover } from '../ui/popover';
import { Select } from '../ui/select';

/** Props for ProjectsDisplayMenu: the current choices and their setters. */
export interface ProjectsDisplayMenuProps {
  grouping: ProjectGrouping;
  onGroupingChange: (grouping: ProjectGrouping) => void;
  /** The ordering, left out where rows keep a fixed order. */
  ordering?: ProjectOrdering;
  onOrderingChange?: (ordering: ProjectOrdering) => void;
  /** Puts both choices back to the page's own, or undefined when they match. */
  onReset?: (() => void) | undefined;
}

/** The Display button and its grouping and ordering panel. */
export const ProjectsDisplayMenu: React.FC<ProjectsDisplayMenuProps> = ({
  grouping,
  ordering,
  onGroupingChange,
  onOrderingChange,
  onReset,
}) => (
  <Popover
    label="Display options"
    align="end"
    contentClassName="w-72 p-0"
    trigger={(props) => (
      <Button {...props} size="sm" variant="secondary" className="gap-1.5">
        <LuSlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
        Display
      </Button>
    )}
  >
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="projects-group" className="text-xs text-text-muted">
          Grouping
        </label>
        <Select
          id="projects-group"
          className="h-7 w-36 py-0 text-xs"
          value={grouping}
          onChange={(event) => {
            onGroupingChange(parseGrouping(event.target.value));
          }}
        >
          {PROJECT_GROUPINGS.map((value) => (
            <option key={value} value={value}>
              {PROJECT_GROUPING_LABELS[value]}
            </option>
          ))}
        </Select>
      </div>
      {ordering !== undefined && onOrderingChange !== undefined && (
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="projects-order" className="text-xs text-text-muted">
            Ordering
          </label>
          <Select
            id="projects-order"
            className="h-7 w-36 py-0 text-xs"
            value={ordering}
            onChange={(event) => {
              onOrderingChange(parseOrdering(event.target.value));
            }}
          >
            {PROJECT_ORDERINGS.map((value) => (
              <option key={value} value={value}>
                {PROJECT_ORDERING_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>
      )}
    </div>
    {onReset !== undefined && (
      <div className="flex justify-end border-t border-line px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onReset}>
          Reset
        </Button>
      </div>
    )}
  </Popover>
);

export default ProjectsDisplayMenu;
