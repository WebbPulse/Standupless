/**
 * Whether a viewer last chose to show triage issues on a project's issues,
 * kept in this browser only and per project, so the list reopens the way it
 * was left. Nothing held means off, as in Linear.
 */

/** The prefix each project's triage choice is stored under. */
export const PROJECT_TRIAGE_STORAGE_PREFIX = 'standupless-project-triage:';

/** True when triage issues were last shown on this project here. */
export const readProjectShowTriage = (projectId: string): boolean => {
  try {
    return (
      globalThis.localStorage.getItem(
        `${PROJECT_TRIAGE_STORAGE_PREFIX}${projectId}`
      ) === '1'
    );
  } catch {
    return false;
  }
};

/** Records the triage choice just made for a project, dropping it when off. */
export const rememberProjectShowTriage = (
  projectId: string,
  shown: boolean
): void => {
  try {
    const key = `${PROJECT_TRIAGE_STORAGE_PREFIX}${projectId}`;
    if (shown) globalThis.localStorage.setItem(key, '1');
    else globalThis.localStorage.removeItem(key);
  } catch {
    return;
  }
};
