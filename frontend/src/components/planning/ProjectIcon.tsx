/**
 * The small tinted mark a project leads with: the glyph it picked, in the
 * colour it picked. A project that has picked neither wears a plain grey box,
 * so an unstyled project never borrows a colour it did not choose.
 */

import React from 'react';
import { cn } from '../../lib/cn';
import { projectGlyph } from '../../lib/projectLook';
import type { ProjectIconName } from '../../types/Api';

/** Props for ProjectIcon: the project's chosen glyph and colour. */
export interface ProjectIconProps {
  icon?: ProjectIconName | null;
  color?: string | null;
  className?: string;
}

/** A decorative project mark, tinted with the project's own colour. */
export const ProjectIcon: React.FC<ProjectIconProps> = ({
  icon = null,
  color = null,
  className = '',
}) => {
  const tinted = color !== null;
  return (
    <span
      aria-hidden="true"
      data-icon={icon ?? 'box'}
      data-color={color ?? ''}
      className={cn(
        'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm',
        !tinted && 'bg-raised text-text-muted',
        className
      )}
      style={
        tinted
          ? {
              color,
              backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)`,
            }
          : undefined
      }
    >
      {React.createElement(projectGlyph(icon), { className: 'h-3.5 w-3.5' })}
    </span>
  );
};

export default ProjectIcon;
