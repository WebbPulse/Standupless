/**
 * The measure a viewer last chose to read a project's progress in, kept in
 * this browser only and per project, so the overview reopens the way it was
 * left. Nothing held means the project's natural measure.
 */

import type { PlanningMeasure } from './planningModel';

/** The prefix each project's chosen measure is stored under. */
export const PROJECT_MEASURE_STORAGE_PREFIX = 'standupless-project-measure:';

/** The measure last chosen for a project here, or null when none is held. */
export const readProjectMeasure = (
  projectId: string
): PlanningMeasure | null => {
  try {
    const held = globalThis.localStorage.getItem(
      `${PROJECT_MEASURE_STORAGE_PREFIX}${projectId}`
    );
    return held === 'issues' || held === 'points' ? held : null;
  } catch {
    return null;
  }
};

/** Records the measure just chosen for a project. */
export const rememberProjectMeasure = (
  projectId: string,
  measure: PlanningMeasure
): void => {
  try {
    globalThis.localStorage.setItem(
      `${PROJECT_MEASURE_STORAGE_PREFIX}${projectId}`,
      measure
    );
  } catch {
    return;
  }
};
