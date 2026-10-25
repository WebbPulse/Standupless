/**
 * The agent profiles settings page: the caller's private copies of their local
 * Claude guidance, saved by an agent through MCP and restored on another machine.
 *
 * Any member reaches it, because a profile belongs to the person and not to the
 * workspace, and nobody else, admins included, can see it. The page lists what is
 * kept, opens a profile's versions on demand, and deletes a profile after a
 * confirmation that says the versions go with it. File contents are never drawn
 * here: restoring is the agent's or the CLI's job.
 */

import React, { useState } from 'react';
import { LuChevronDown, LuChevronRight, LuLayers } from 'react-icons/lu';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import {
  deleteMyAgentProfile,
  listMyAgentProfiles,
  listMyAgentProfileVersions,
} from '../../api/agentProfiles';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import RelativeTime from '../../components/ui/relative-time';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { errorMessage } from '../../lib/errors';
import {
  MY_AGENT_PROFILES_KEY,
  myAgentProfileVersionsKey,
} from '../../lib/queryKeys';
import type { AgentProfileRead } from '../../types/Api';

/** How often the lists are re-read while the page is open. */
const POLL_MS = 60000;

/** A byte count as a person reads it. */
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** "3 files, 4.2 KB", the size line every row and version shares. */
const sizeLine = (files: number, bytes: number): string =>
  `${files} ${files === 1 ? 'file' : 'files'}, ${formatBytes(bytes)}`;

/** The command that restores a profile on a fresh machine. */
const pullCommand = (name: string): string =>
  `uvx --from standupless-cli standupless agent pull ${name}`;

/** One profile's kept versions, read when the row is opened. */
const Versions: React.FC<{ name: string }> = ({ name }) => {
  const auth = useQueryAuth();
  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listMyAgentProfileVersions(name, signal),
    {
      intervalMs: POLL_MS,
      queryKey: myAgentProfileVersionsKey(name),
      auth,
    }
  );

  if (error !== null) {
    return (
      <ErrorAlert message={errorMessage(error, 'Could not load versions.')} />
    );
  }
  if (isLoading && data === null) {
    return <Spinner label={`Loading versions of ${name}`} />;
  }
  const versions = data?.versions ?? [];
  return (
    <ol aria-label={`Versions of ${name}`} className="space-y-1.5">
      {versions.map((version) => (
        <li
          key={version.version}
          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-muted"
        >
          <span className="font-mono text-text">v{version.version}</span>
          {version.latest && (
            <span className="rounded-sm border border-line px-1 text-text-faint">
              Latest
            </span>
          )}
          <RelativeTime value={version.created_at} />
          <span aria-hidden="true">/</span>
          <span>{sizeLine(version.file_count, version.total_bytes)}</span>
          <span aria-hidden="true">/</span>
          <span>via {version.source}</span>
          {version.note !== undefined && version.note !== '' && (
            <span className="w-full truncate text-text-faint">
              {version.note}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
};

/** Props for DeleteDialog: the profile being deleted and the call that does it. */
interface DeleteDialogProps {
  profile: AgentProfileRead | null;
  busy: boolean;
  error: unknown;
  onCancel: () => void;
  onConfirm: () => void;
}

/** The confirmation every delete goes through. */
const DeleteDialog: React.FC<DeleteDialogProps> = ({
  profile,
  busy,
  error,
  onCancel,
  onConfirm,
}) => (
  <Dialog
    open={profile !== null}
    onClose={() => {
      if (!busy) onCancel();
    }}
    title={`Delete ${profile?.name ?? 'this profile'}?`}
    size="sm"
  >
    <div className="space-y-4">
      <p className="text-sm text-text-muted">
        Every kept version of {profile?.name ?? 'this profile'} is deleted and
        cannot be restored on any machine. Files already restored stay where
        they are.
      </p>
      {profile !== null && error !== null && (
        <ErrorAlert message={errorMessage(error, 'Could not delete.')} />
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="danger" disabled={busy} onClick={onConfirm}>
          {busy ? 'Deleting' : 'Delete profile'}
        </Button>
      </div>
    </div>
  </Dialog>
);

/** Lists the caller's agent profiles, each with its versions on demand and a delete. */
const AgentProfilesSection: React.FC = () => {
  const auth = useQueryAuth();
  const [open, setOpen] = useState<string | null>(null);
  const [pending, setPending] = useState<AgentProfileRead | null>(null);
  const [deleteError, setDeleteError] = useState<unknown>(null);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listMyAgentProfiles(signal),
    { intervalMs: POLL_MS, queryKey: MY_AGENT_PROFILES_KEY, auth }
  );
  const { mutate: remove, isMutating } = useMutationWithRefetch(
    (name: string) => deleteMyAgentProfile(name),
    MY_AGENT_PROFILES_KEY
  );

  const profiles = data?.profiles ?? [];

  const close = (): void => {
    setPending(null);
    setDeleteError(null);
  };

  const onConfirm = (): void => {
    if (pending === null) return;
    const name = pending.name;
    void remove(name)
      .then(() => {
        setPending(null);
        if (open === name) setOpen(null);
      })
      .catch((failure: unknown) => {
        setDeleteError(failure);
      });
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Agent profiles</h2>
        <p className="text-sm text-text-muted">
          Your local Claude guidance, such as ~/.claude/CLAUDE.md, untracked
          project CLAUDE.md files and a project&apos;s memory folder, saved by
          an agent so another machine can restore it. Only you can see your
          profiles, in every workspace. Saves that contain anything that looks
          like a credential are refused.
        </p>
        {data !== null && data.versions_kept > 0 && (
          <p className="text-xs text-text-faint">
            The last {data.versions_kept} versions of each profile are kept.
          </p>
        )}
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load your agent profiles.')}
        />
      )}

      {isLoading && data === null ? (
        <Spinner label="Loading your agent profiles" />
      ) : profiles.length === 0 ? (
        error === null && (
          <div className="rounded-md border border-dashed border-line">
            <EmptyState
              className="py-10"
              icon={<LuLayers />}
              message="No agent profiles yet. Ask an agent connected over MCP to save your Claude guidance with save_agent_profile, and it shows up here."
            />
          </div>
        )
      ) : (
        <ul className="rounded-md border border-line">
          {profiles.map((profile) => {
            const expanded = open === profile.name;
            return (
              <li
                key={profile.name}
                className="space-y-3 border-b border-line px-3 py-2 last:border-b-0"
              >
                <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? 'Hide' : 'Show'} versions of ${profile.name}`}
                    className="flex h-7 w-7 items-center justify-center rounded-sm text-text-muted hover:bg-raised hover:text-text"
                    onClick={() => {
                      setOpen(expanded ? null : profile.name);
                    }}
                  >
                    {expanded ? <LuChevronDown /> : <LuChevronRight />}
                  </button>
                  <div className="min-w-0 space-y-0.5">
                    <p className="truncate text-sm font-medium text-text">
                      {profile.name}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-1 text-xs text-text-muted">
                      <span>v{profile.latest_version}</span>
                      <span aria-hidden="true">/</span>
                      <span>
                        {sizeLine(profile.file_count, profile.total_bytes)}
                      </span>
                      <span aria-hidden="true">/</span>
                      <span>Saved</span>
                      <RelativeTime value={profile.updated_at} />
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDeleteError(null);
                      setPending(profile);
                    }}
                  >
                    Delete
                  </Button>
                </div>
                {expanded && (
                  <div className="space-y-3 pl-10">
                    <Versions name={profile.name} />
                    <p className="text-xs text-text-faint">
                      Restore on another machine with{' '}
                      <code className="break-all rounded-sm bg-raised px-1 font-mono text-text">
                        {pullCommand(profile.name)}
                      </code>
                      , or ask an agent to restore it with get_agent_profile.
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <DeleteDialog
        profile={pending}
        busy={isMutating}
        error={deleteError}
        onCancel={close}
        onConfirm={onConfirm}
      />
    </section>
  );
};

/** Renders the caller's private agent profiles. */
const AgentProfilesSettings: React.FC = () => {
  const { workspace } = useWorkspace();

  return (
    <WorkspaceShell title="Settings">
      {workspace !== null && (
        <div className="max-w-2xl">
          <AgentProfilesSection />
        </div>
      )}
    </WorkspaceShell>
  );
};

export default AgentProfilesSettings;
