/**
 * Every saved view the caller can open, read through the views route under
 * the scope they pick: their own, their teams' shared views, or both. A view
 * is created from the board's views panel, where the filters it stores are
 * set, so this page lists and opens rather than offering a second editor.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuLayers, LuSquareKanban, LuList } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { listViews } from '../../api/views';
import { ErrorAlert } from '../../components/ui/alert';
import EmptyState from '../../components/ui/empty-state';
import { Select } from '../../components/ui/select';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { errorMessage } from '../../lib/errors';
import { viewPath } from '../../lib/paths';
import { viewsKey } from '../../lib/queryKeys';
import type { ViewListScope } from '../../types/Api';

/** How often the view list is re-read while the page is open. */
const POLL_MS = 60000;

/** The scopes the list route takes, with their interface wording. */
const SCOPES: { value: ViewListScope; label: string }[] = [
  { value: 'all', label: 'All views' },
  { value: 'mine', label: 'My views' },
  { value: 'team', label: 'Team views' },
];

/** The saved views list. */
export const Views: React.FC = () => {
  const { workspace } = useWorkspace();
  const { teams } = useTeam(undefined);
  const auth = useQueryAuth();
  const [scope, setScope] = useState<ViewListScope>('all');
  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listViews(workspaceId, { scope }, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: viewsKey(workspaceId, scope, ''),
      auth,
    }
  );

  const teamName = (teamId: string | null): string =>
    teamId === null
      ? 'Personal'
      : (teams.find((team) => team.id === teamId)?.name ?? 'Team');

  return (
    <WorkspaceShell
      title="Views"
      toolbar={
        <Select
          aria-label="Which views"
          value={scope}
          className="h-7 w-auto text-xs"
          onChange={(event) => {
            setScope(event.target.value as ViewListScope);
          }}
        >
          {SCOPES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      }
      flush
    >
      {error !== null && (
        <div className="px-4 pt-3 lg:px-6">
          <ErrorAlert message={errorMessage(error, 'Could not load views.')} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading || data === null ? (
          <SkeletonRows />
        ) : data.length === 0 ? (
          <EmptyState
            icon={<LuLayers />}
            message="No saved views yet. Save one from a team's board to keep a set of filters one click away."
            className="py-16"
          />
        ) : (
          <ul aria-label="Saved views">
            {data.map((view) => {
              const Icon = view.kind === 'board' ? LuSquareKanban : LuList;
              return (
                <li key={view.view_id} className="border-b border-line">
                  <Link
                    to={viewPath(slug, view.view_id)}
                    className="flex h-row items-center gap-3 px-4 text-sm transition-colors duration-100 hover:bg-surface focus-visible:bg-surface focus-visible:outline-none lg:px-6"
                  >
                    <Icon
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-text-faint"
                    />
                    <span className="min-w-0 flex-1 truncate font-medium text-text">
                      {view.name}
                    </span>
                    <span className="shrink-0 text-xs text-text-faint">
                      {teamName(view.team_id)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </WorkspaceShell>
  );
};

export default Views;
