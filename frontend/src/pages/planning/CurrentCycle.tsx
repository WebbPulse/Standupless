/**
 * `/team/:keyPrefix/cycles/current`, a stable address for a team's running
 * cycle that the sidebar and the go-to shortcut open. It reads which cycle is
 * running and replaces itself with that cycle's page, or with the cycles list
 * and a short notice when none is running, so the address never lands on an
 * empty page and the back button skips it.
 */

import React, { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorAlert } from '../../components/ui/alert';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { findActiveCycle } from '../../lib/currentCycle';
import { errorMessage } from '../../lib/errors';
import { cyclePath, teamCyclesPath } from '../../lib/paths';
import { showErrorToast, showToast } from '../../lib/toast';

/** Redirects to the team's running cycle, or to its cycles list when none runs. */
export const CurrentCycle: React.FC = () => {
  const { keyPrefix } = useParams<{ keyPrefix: string }>();
  const { workspace } = useWorkspace();
  const slug = workspace?.slug ?? '';
  const navigate = useNavigate();
  const { team, workspaceId, notFound, error } = useTeam(keyPrefix);
  const prefix = keyPrefix ?? '';
  const teamId = team?.id ?? '';
  const teamName = team?.name ?? '';

  useEffect(() => {
    if (slug === '' || prefix === '') return;
    const list = teamCyclesPath(slug, prefix);
    if (notFound) {
      void navigate(list, { replace: true });
      return;
    }
    if (workspaceId === '' || teamId === '') return;
    const controller = new AbortController();
    void findActiveCycle(workspaceId, teamId, controller.signal).then(
      (cycle) => {
        if (controller.signal.aborted) return;
        if (cycle === null) {
          showToast(`No cycle is running in ${teamName} right now.`);
          void navigate(list, { replace: true });
          return;
        }
        void navigate(cyclePath(slug, prefix, cycle.cycle_id), {
          replace: true,
        });
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        showErrorToast(
          errorMessage(failure, 'Could not find the current cycle.')
        );
        void navigate(list, { replace: true });
      }
    );
    return () => {
      controller.abort();
    };
  }, [slug, prefix, notFound, workspaceId, teamId, teamName, navigate]);

  return (
    <WorkspaceShell title="Current cycle">
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load this team.')}
        />
      )}
      <Spinner label="Opening the current cycle" />
    </WorkspaceShell>
  );
};

export default CurrentCycle;
