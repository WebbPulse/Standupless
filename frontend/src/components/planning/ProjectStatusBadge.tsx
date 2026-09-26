/**
 * How a team's stored status reads as a pill. Unlike a cycle's, this status
 * is chosen rather than derived, so it is worth a tint that separates work not
 * started from work under way.
 */

import React from 'react';
import Badge, { type BadgeTone } from '../ui/badge';
import { PROJECT_STATUS_LABELS } from '../../lib/planningDisplay';
import type { ProjectStatus } from '../../types/Api';

/** The tint each team status takes. */
const TONES: Record<ProjectStatus, BadgeTone> = {
  planned: 'neutral',
  in_progress: 'accent',
  done: 'success',
};

/** Props for ProjectStatusBadge: the status to show. */
export interface ProjectStatusBadgeProps {
  status: ProjectStatus;
}

/** One team's status as a tinted pill. */
export const ProjectStatusBadge: React.FC<ProjectStatusBadgeProps> = ({
  status,
}) => <Badge tone={TONES[status]}>{PROJECT_STATUS_LABELS[status]}</Badge>;

export default ProjectStatusBadge;
