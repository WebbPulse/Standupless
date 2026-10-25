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
  backlog: 'neutral',
  planned: 'neutral',
  in_progress: 'accent',
  paused: 'warning',
  completed: 'success',
  canceled: 'danger',
};

/** Props for ProjectStatusBadge: the category, and the workspace status's name. */
export interface ProjectStatusBadgeProps {
  status: ProjectStatus;
  /** The workspace status's name, in place of the category's. */
  name?: string;
}

/** One project's status as a pill tinted by its category. */
export const ProjectStatusBadge: React.FC<ProjectStatusBadgeProps> = ({
  status,
  name,
}) => (
  <Badge tone={TONES[status]}>{name ?? PROJECT_STATUS_LABELS[status]}</Badge>
);

export default ProjectStatusBadge;
