/**
 * The workspace export: an admin starts a job that writes every team, member,
 * issue, comment, project, cycle, view and release as a zip of NDJSON files,
 * and downloads it once it is ready.
 *
 * The list polls quickly while a job is queued or running and slowly after,
 * and the download button reads the one job again at the moment of the click,
 * because its presigned link lasts minutes and a link held by the list would
 * already be stale by the time somebody pressed it.
 */

import React, { useState } from 'react';
import { LuDownload } from 'react-icons/lu';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import {
  getWorkspaceExport,
  listWorkspaceExports,
  startWorkspaceExport,
} from '../../api/exports';
import { errorMessage } from '../../lib/errors';
import { workspaceExportsKey } from '../../lib/queryKeys';
import type {
  WorkspaceExportRead,
  WorkspaceExportStatus,
  WorkspaceRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Badge, { type BadgeTone } from '../ui/badge';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import RelativeTime from '../ui/relative-time';
import Spinner from '../ui/spinner';

/** Props for WorkspaceExportSection: the workspace being exported. */
export interface WorkspaceExportSectionProps {
  workspace: WorkspaceRead;
}

/** How often the list is read while a job is still building. */
const ACTIVE_POLL_MS = 3000;

/** How often the list is read once every job has settled. */
const IDLE_POLL_MS = 60000;

/** How each job state reads, and the tint its badge takes. */
const STATUS_DISPLAY: Record<
  WorkspaceExportStatus,
  { label: string; tone: BadgeTone }
> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Building', tone: 'accent' },
  ready: { label: 'Ready', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

/** Whether a job is still on its way to ready or failed. */
const isActive = (job: WorkspaceExportRead): boolean =>
  job.status === 'queued' || job.status === 'running';

/** A byte count in the unit a person reads it in. */
export const sizeLabel = (bytes: number | null | undefined): string => {
  const value = bytes ?? 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

/** The number of issues a job carried, the count a person checks first. */
const issueCount = (job: WorkspaceExportRead): number =>
  job.counts?.issues ?? 0;

/** Sends the browser to a download link. */
const openLink = (url: string): void => {
  window.location.assign(url);
};

/** Starts workspace exports and lists the recent ones with their downloads. */
export const WorkspaceExportSection: React.FC<WorkspaceExportSectionProps> = ({
  workspace,
}) => {
  const auth = useQueryAuth();
  const queryKey = workspaceExportsKey(workspace.id);
  const [maskEmails, setMaskEmails] = useState(false);
  const [polling, setPolling] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<unknown>(null);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listWorkspaceExports(workspace.id, signal),
    {
      intervalMs: polling ? ACTIVE_POLL_MS : IDLE_POLL_MS,
      queryKey,
      auth,
    }
  );

  const jobs = data ?? [];
  const building = jobs.some(isActive);
  if (building !== polling) setPolling(building);

  const {
    mutate: start,
    isMutating: starting,
    error: startError,
  } = useMutationWithRefetch(
    () =>
      startWorkspaceExport(workspace.id, { include_emails: !maskEmails }),
    queryKey
  );

  const onDownload = (exportId: string): void => {
    setDownloading(exportId);
    setDownloadError(null);
    void getWorkspaceExport(workspace.id, exportId)
      .then((job) => {
        if (job.download_url) {
          openLink(job.download_url);
        } else {
          setDownloadError(new Error('This export has no download.'));
        }
      })
      .catch(setDownloadError)
      .finally(() => {
        setDownloading(null);
      });
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Export workspace</h2>
        <p className="text-sm text-text-muted">
          Download everything in {workspace.name} as a zip of JSON files: teams,
          members, workflow, labels, issues with their relations, comments and
          attachment links, projects, cycles, views and releases. The bundle is
          kept for 7 days. You get an inbox notice when it is ready.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          disabled={starting || building}
          onClick={() => {
            void start().catch(() => undefined);
          }}
        >
          {building ? 'Export in progress' : 'Start export'}
        </Button>
        <Checkbox
          label="Mask member emails"
          checked={maskEmails}
          onChange={(event) => {
            setMaskEmails(event.target.checked);
          }}
        />
      </div>

      {startError !== null && (
        <ErrorAlert
          message={errorMessage(startError, 'Could not start the export.')}
        />
      )}
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the exports.')}
        />
      )}
      {downloadError !== null && (
        <ErrorAlert
          message={errorMessage(
            downloadError,
            'Could not get a download link for that export.'
          )}
        />
      )}

      {isLoading ? (
        <Spinner label="Loading exports" />
      ) : jobs.length === 0 ? (
        <p className="text-sm text-text-muted">No exports yet.</p>
      ) : (
        <ul className="rounded-md border border-line">
          {jobs.map((job) => {
            const display = STATUS_DISPLAY[job.status];
            return (
              <li
                key={job.export_id}
                className="flex min-h-row items-center gap-3 border-b border-line px-3 py-1.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-sm text-text">
                    Started <RelativeTime value={job.created_at} />
                  </p>
                  <p className="text-xs text-text-faint">
                    {job.status === 'ready'
                      ? `${issueCount(job)} issues, ${sizeLabel(job.size_bytes)}${job.emails_masked ? ', emails masked' : ''}`
                      : job.status === 'failed'
                        ? 'The export stopped before it finished.'
                        : 'Building the bundle.'}
                  </p>
                </div>
                <Badge tone={display.tone}>{display.label}</Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={job.status !== 'ready' || downloading !== null}
                  aria-label={`Download the export started ${job.created_at}`}
                  onClick={() => {
                    onDownload(job.export_id);
                  }}
                >
                  <LuDownload aria-hidden="true" className="h-3.5 w-3.5" />
                  Download
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default WorkspaceExportSection;
