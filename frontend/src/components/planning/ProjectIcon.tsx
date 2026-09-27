/**
 * The small tinted mark a project row leads with. Projects carry no icon of
 * their own, so the tint is picked from the project id: the same project
 * always wears the same colour, and neighbouring rows tell apart at a glance.
 */

import React from 'react';
import { LuBox } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { projectTone } from '../../lib/projectList';

/** The tints a project icon can take, each a soft fill with a strong glyph. */
const TONES = [
  'bg-accent-soft text-accent',
  'bg-success-soft text-success',
  'bg-warning-soft text-warning',
  'bg-danger-soft text-danger',
  'bg-raised text-text-muted',
];

/** Props for ProjectIcon: the project id the tint comes from. */
export interface ProjectIconProps {
  projectId: string;
  className?: string;
}

/** A decorative tinted box glyph for one project. */
export const ProjectIcon: React.FC<ProjectIconProps> = ({
  projectId,
  className = '',
}) => (
  <span
    aria-hidden="true"
    data-tone={projectTone(projectId, TONES.length)}
    className={cn(
      'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm',
      TONES[projectTone(projectId, TONES.length)],
      className
    )}
  >
    <LuBox className="h-3.5 w-3.5" />
  </span>
);

export default ProjectIcon;
