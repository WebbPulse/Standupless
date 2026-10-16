/**
 * The Follow toggle on a project or initiative page, which decides whether its
 * updates, health changes and completed milestones reach the caller's Pulse.
 * Leads, members and owners follow by default, so the button reads the state
 * the server works out rather than assuming one, and an explicit choice either
 * way wins over that default.
 */

import React, { useState } from 'react';
import { LuBell, LuBellOff } from 'react-icons/lu';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import { getFollow, setFollow, type FollowSubject } from '../../api/pulse';
import { errorMessage } from '../../lib/errors';
import { LOOKUP_POLL_MS } from '../../lib/polling';
import { pulseCountKey, pulseFollowKey, pulseKey } from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import type { PulseFollowRead } from '../../types/Api';
import Button from '../ui/button';

/** Props for FollowButton: what is followed. */
export interface FollowButtonProps {
  workspaceId: string;
  subject: FollowSubject;
  subjectId: string;
}

/** A Follow or Following button for one project or initiative. */
export const FollowButton: React.FC<FollowButtonProps> = ({
  workspaceId,
  subject,
  subjectId,
}) => {
  const auth = useQueryAuth();
  const key = pulseFollowKey(workspaceId, subject, subjectId);
  const [override, setOverride] = useState<PulseFollowRead | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const { data } = usePolledQuery(
    ({ signal }) => getFollow(workspaceId, subject, subjectId, signal),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: workspaceId !== '' && subjectId !== '',
      queryKey: key,
      auth,
    }
  );
  const state = override ?? data;
  if (state === null) return null;

  const following = state.following;
  const noun = subject === 'project' ? 'project' : 'initiative';

  const toggle = (): void => {
    const next = !following;
    setIsSaving(true);
    setOverride({ following: next, explicit: true });
    setFollow(workspaceId, subject, subjectId, next).then(
      (saved) => {
        setOverride(saved);
        setIsSaving(false);
        invalidateQueries([
          key,
          pulseKey(workspaceId, 'for_me'),
          pulseCountKey(workspaceId),
        ]);
        showToast(
          next
            ? `Following this ${noun} in Pulse`
            : `Stopped following this ${noun}`
        );
      },
      (failure: unknown) => {
        setOverride(null);
        setIsSaving(false);
        showErrorToast(errorMessage(failure, 'Could not change the follow.'));
      }
    );
  };

  return (
    <Button
      variant="secondary"
      size="sm"
      aria-pressed={following}
      disabled={isSaving}
      onClick={toggle}
      title={
        following
          ? `Its updates reach your Pulse. Click to stop following this ${noun}.`
          : `Follow this ${noun} to see its updates in Pulse.`
      }
    >
      {following ? (
        <LuBell aria-hidden="true" />
      ) : (
        <LuBellOff aria-hidden="true" />
      )}
      {following ? 'Following' : 'Follow'}
    </Button>
  );
};

export default FollowButton;
