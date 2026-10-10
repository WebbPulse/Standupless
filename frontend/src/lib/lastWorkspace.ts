/**
 * The workspace this browser last opened, kept in this browser only, so the
 * home page can send a signed in visitor back into it. The picker checks the
 * slug against the caller's workspace list before following it, so a stale or
 * foreign slug falls back to the choice rather than to a missing workspace.
 */

/** The storage key the last opened workspace slug is held under. */
export const LAST_WORKSPACE_STORAGE_KEY = 'standupless-last-workspace';

/** The router state the home page hands the picker to resume the last workspace. */
export interface ResumeState {
  resume: true;
}

/** The state that asks the picker to resume the last opened workspace. */
export const RESUME_STATE: ResumeState = { resume: true };

/** Whether a router state asks the picker to resume the last opened workspace. */
export const wantsResume = (state: unknown): boolean =>
  typeof state === 'object' &&
  state !== null &&
  (state as Partial<ResumeState>).resume === true;

/** The slug of the workspace last opened here, or null when none is held. */
export const readLastWorkspace = (): string | null => {
  try {
    const held = globalThis.localStorage.getItem(LAST_WORKSPACE_STORAGE_KEY);
    return held === null || held === '' ? null : held;
  } catch {
    return null;
  }
};

/** Records the workspace just opened as the one to resume. */
export const rememberWorkspace = (slug: string): void => {
  if (slug === '') return;
  try {
    globalThis.localStorage.setItem(LAST_WORKSPACE_STORAGE_KEY, slug);
  } catch {
    return;
  }
};
