/**
 * One project's milestones, read on a poll and written optimistically. A
 * rename, a new date or a drag shows the moment it is made: the change is laid
 * over a local copy, the write goes out, and the local copy is dropped only
 * once a read after every pending write has landed, so a reorder never jumps
 * back for the length of a round trip. A failed write is undone with a notice.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import {
  createMilestone,
  deleteMilestone,
  listMilestones,
  updateMilestone,
} from '../api/planning';
import { errorMessage } from '../lib/errors';
import { byMilestoneOrder } from '../lib/milestones';
import { milestonesKey } from '../lib/queryKeys';
import { showErrorToast } from '../lib/toast';
import type {
  MilestoneCreate,
  MilestoneRead,
  MilestoneUpdate,
} from '../types/Api';

/** How often the milestones re-read, which is how their progress refreshes. */
const POLL_MS = 30000;

/** What {@link useProjectMilestones} hands back. */
export interface ProjectMilestones {
  /** The milestones in their manual order, with pending changes laid over. */
  milestones: MilestoneRead[];
  isLoading: boolean;
  error: unknown;
  /** Adds a milestone and answers it, or null when the write failed. */
  create: (body: MilestoneCreate) => Promise<MilestoneRead | null>;
  /** Edits one milestone. Resolves false when the write failed and was undone. */
  update: (milestoneId: string, patch: MilestoneUpdate) => Promise<boolean>;
  /** Deletes one milestone. Resolves false when the write failed and was undone. */
  remove: (milestoneId: string) => Promise<boolean>;
}

/** Reads and writes one project's milestones. */
export const useProjectMilestones = (
  workspaceId: string,
  projectId: string,
  enabled = true
): ProjectMilestones => {
  const auth = useQueryAuth();
  const queryKey = milestonesKey(workspaceId, projectId);
  const { data, isLoading, error, refetch } = usePolledQuery(
    ({ signal }) => listMilestones(workspaceId, projectId, signal),
    {
      intervalMs: POLL_MS,
      enabled: enabled && workspaceId !== '' && projectId !== '',
      queryKey,
      auth,
    }
  );

  const [local, setLocal] = useState<MilestoneRead[] | null>(null);
  const pending = useRef(0);
  const current = useRef<MilestoneRead[]>([]);
  const milestones = useMemo(
    () => [...(local ?? data ?? [])].sort(byMilestoneOrder),
    [local, data]
  );
  current.current = milestones;

  const run = useCallback(
    async <T>(
      next: (held: MilestoneRead[]) => MilestoneRead[],
      write: () => Promise<T>,
      failure: string
    ): Promise<T | null> => {
      pending.current += 1;
      setLocal(next(current.current));
      let result: T | null = null;
      try {
        result = await write();
      } catch (problem) {
        showErrorToast(errorMessage(problem, failure));
      }
      pending.current -= 1;
      await refetch();
      if (pending.current === 0) setLocal(null);
      return result;
    },
    [refetch]
  );

  const create = useCallback(
    async (body: MilestoneCreate): Promise<MilestoneRead | null> => {
      let made: MilestoneRead | null = null;
      await run(
        (held) => held,
        async () => {
          made = await createMilestone(workspaceId, projectId, body);
          const created = made;
          setLocal((held) => [...(held ?? current.current), created]);
          return made;
        },
        'Could not add that milestone.'
      );
      return made;
    },
    [run, workspaceId, projectId]
  );

  const update = useCallback(
    async (milestoneId: string, patch: MilestoneUpdate): Promise<boolean> =>
      (await run(
        (held) =>
          held.map((milestone) =>
            milestone.milestone_id === milestoneId
              ? { ...milestone, ...patch }
              : milestone
          ),
        async () => {
          await updateMilestone(workspaceId, projectId, milestoneId, patch);
          return true;
        },
        'Could not update that milestone. It has been undone.'
      )) === true,
    [run, workspaceId, projectId]
  );

  const remove = useCallback(
    async (milestoneId: string): Promise<boolean> =>
      (await run(
        (held) =>
          held.filter((milestone) => milestone.milestone_id !== milestoneId),
        async () => {
          await deleteMilestone(workspaceId, projectId, milestoneId);
          return true;
        },
        'Could not delete that milestone. It has been restored.'
      )) === true,
    [run, workspaceId, projectId]
  );

  return {
    milestones,
    isLoading: isLoading && data === null,
    error,
    create,
    update,
    remove,
  };
};

export default useProjectMilestones;
