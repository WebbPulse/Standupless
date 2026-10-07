/**
 * The marker a project carries once its update is due or overdue against its
 * cadence, on the project list, the project header and the updates tab. An
 * upcoming update draws nothing, so a quiet list stays quiet.
 */

import React from 'react';
import { updateDueLabel } from '../../lib/planningDisplay';
import type { ProjectRead } from '../../types/Api';
import Badge from '../ui/badge';

/** Props for UpdateDueBadge: the project's due state and date. */
export interface UpdateDueBadgeProps {
  project: Pick<ProjectRead, 'update_due_state' | 'next_update_due_at'>;
  className?: string;
}

/** "Update due" in amber or "Update overdue" in red, with the due date as its title. */
export const UpdateDueBadge: React.FC<UpdateDueBadgeProps> = ({
  project,
  className = '',
}) => {
  const label = updateDueLabel(project.update_due_state);
  if (label === null) return null;
  const day = project.next_update_due_at?.slice(0, 10);
  return (
    <Badge
      tone={project.update_due_state === 'overdue' ? 'danger' : 'warning'}
      title={day === undefined ? label : `${label} since ${day}`}
      className={className}
    >
      {label}
    </Badge>
  );
};

export default UpdateDueBadge;
