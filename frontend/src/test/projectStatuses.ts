/**
 * A stand-in for the workspace project statuses hook, for component tests that
 * render without an auth provider. It answers the six seeded defaults, the
 * same list the real hook falls back to before its read lands.
 */

import {
  DEFAULT_PROJECT_STATUSES,
  projectStatusOf,
  type HasProjectStatus,
} from '../lib/projectStatuses';
import { projectStatusesKey } from '../lib/queryKeys';
import type { WorkspaceProjectStatuses } from '../hooks/useProjectStatuses';

/** The hook's answer over the seeded defaults. */
const defaults: WorkspaceProjectStatuses = {
  statuses: DEFAULT_PROJECT_STATUSES,
  byId: new Map(DEFAULT_PROJECT_STATUSES.map((row) => [row.id, row])),
  statusOf: (project: HasProjectStatus) =>
    projectStatusOf(project, DEFAULT_PROJECT_STATUSES),
  error: null,
  isLoading: false,
  queryKey: projectStatusesKey('test'),
};

/** Answers the seeded defaults whatever workspace is asked for. */
export const useProjectStatuses = (): WorkspaceProjectStatuses => defaults;

export default useProjectStatuses;
