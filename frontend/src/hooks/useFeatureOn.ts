/**
 * Whether the workspace in view has an optional area on. Outside a workspace
 * provider every area reads as on, so a component rendered on its own, in a
 * test or a shared page, shows what it always did.
 */

import { useContext } from 'react';
import { WorkspaceContext } from '../contexts/WorkspaceContextDefinition';
import { isFeatureOn } from '../lib/features';
import type { WorkspaceFeature } from '../types/Api';

/** Returns true while the current workspace has `feature` on, or when there is no workspace. */
export const useFeatureOn = (feature: WorkspaceFeature): boolean =>
  isFeatureOn(useContext(WorkspaceContext)?.workspace, feature);

export default useFeatureOn;
