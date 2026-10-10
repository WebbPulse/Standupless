/**
 * The issue import: an admin picks the tracker a CSV came from, a target team
 * and the file, checks what every row would become, adjusts the column
 * mapping, and starts a job that writes the issues in the background.
 *
 * The dry run runs again on every mapping change, so the summary always
 * describes the mapping the start button would send. The job list polls
 * quickly while an import is queued or running and slowly after.
 */

import React, { useState } from 'react';
import { LuUpload } from 'react-icons/lu';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import {
  listIssueImports,
  previewIssueImport,
  startIssueImport,
} from '../../api/imports';
import { useTeamsFor } from '../../hooks/useTeams';
import { errorMessage } from '../../lib/errors';
import { workspaceImportsKey } from '../../lib/queryKeys';
import type {
  ImportField,
  ImportPreset,
  ImportStatus,
  IssueImportPreviewRead,
  IssueImportRead,
  IssueImportRequest,
  WorkspaceRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Badge, { type BadgeTone } from '../ui/badge';
import Button from '../ui/button';
import Label from '../ui/label';
import RelativeTime from '../ui/relative-time';
import { Select, SelectField } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for WorkspaceImportSection: the workspace issues are imported into. */
export interface WorkspaceImportSectionProps {
  workspace: WorkspaceRead;
}

/** How often the list is read while a job is still writing. */
const ACTIVE_POLL_MS = 3000;

/** How often the list is read once every job has settled. */
const IDLE_POLL_MS = 60000;

/** The trackers a file can come from, in the order the picker offers them. */
const PRESETS: { value: ImportPreset; label: string }[] = [
  { value: 'jira', label: 'Jira' },
  { value: 'linear', label: 'Linear' },
  { value: 'generic', label: 'Other CSV' },
];

/** The fields a column can map to, in the order the mapping lists them. */
const FIELDS: { field: ImportField; label: string }[] = [
  { field: 'title', label: 'Title' },
  { field: 'description', label: 'Description' },
  { field: 'status', label: 'Status' },
  { field: 'priority', label: 'Priority' },
  { field: 'assignee', label: 'Assignee' },
  { field: 'labels', label: 'Labels' },
  { field: 'estimate', label: 'Estimate' },
  { field: 'due_date', label: 'Due date' },
  { field: 'source_key', label: 'Source key' },
  { field: 'created_at', label: 'Created' },
];

/** The select value that means a field reads no column. */
const UNMAPPED = '';

/** How many row problems the dry run lists before folding the rest. */
const PROBLEMS_SHOWN = 50;

/** How each job state reads, and the tint its badge takes. */
const STATUS_DISPLAY: Record<ImportStatus, { label: string; tone: BadgeTone }> =
  {
    queued: { label: 'Queued', tone: 'neutral' },
    running: { label: 'Importing', tone: 'accent' },
    completed: { label: 'Completed', tone: 'success' },
    failed: { label: 'Failed', tone: 'danger' },
  };

/** A file the admin picked, read as text. */
interface PickedFile {
  name: string;
  text: string;
}

/** Whether a job is still on its way to completed or failed. */
const isActive = (job: IssueImportRead): boolean =>
  job.status === 'queued' || job.status === 'running';

/** Reads a picked file as text. */
const readFile = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('Could not read the file.'));
    };
    reader.readAsText(file);
  });

/** Says how many of a thing there are, with the plural when it needs one. */
const count = (n: number, noun: string): string =>
  `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The line under a job that says how far it got. */
const jobSummary = (job: IssueImportRead): string => {
  if (job.status === 'failed') {
    return `Stopped after ${count(job.created_count, 'issue')}. ${job.error ?? ''}`.trim();
  }
  if (job.status === 'completed') {
    const parts = [`${count(job.created_count, 'issue')} created`];
    if (job.skipped_count > 0) parts.push(`${job.skipped_count} skipped`);
    if (job.labels_created > 0)
      parts.push(count(job.labels_created, 'new label'));
    return parts.join(', ');
  }
  return `${job.processed_rows} of ${job.total_rows} rows`;
};

/** Props for ImportSummary: a dry run's result. */
interface ImportSummaryProps {
  preview: IssueImportPreviewRead;
}

/** What a dry run found: the counts, where statuses land, new labels and row problems. */
const ImportSummary: React.FC<ImportSummaryProps> = ({ preview }) => {
  const errors = preview.problems.filter((p) => p.severity === 'error').length;
  const warnings = preview.problems.length - errors;
  return (
    <div className="space-y-4" aria-label="Dry run">
      <p className="text-sm text-text">
        {`${count(preview.importable_rows, 'issue')} will be created from ${count(preview.total_rows, 'row')}.`}
        {errors > 0 && ` ${count(errors, 'row')} will be skipped.`}
        {warnings > 0 && ` ${count(warnings, 'warning')}.`}
      </p>

      {preview.statuses.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-text-muted">Statuses</h3>
          <ul className="rounded-md border border-line">
            {preview.statuses.map((status) => (
              <li
                key={status.source}
                className="flex min-h-row items-center gap-3 border-b border-line px-3 py-1.5 text-sm last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate">
                  {status.source || 'No status'}
                </span>
                <span className="text-text-faint" aria-hidden="true">
                  to
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {status.status_name}
                </span>
                <span className="text-xs text-text-faint">
                  {count(status.count, 'issue')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.new_labels.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-text-muted">New labels</h3>
          <p className="flex flex-wrap gap-1">
            {preview.new_labels.map((name) => (
              <Badge key={name}>{name}</Badge>
            ))}
          </p>
        </div>
      )}

      {preview.problems.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-text-muted">Row problems</h3>
          <ul className="max-h-64 overflow-y-auto rounded-md border border-line">
            {preview.problems.slice(0, PROBLEMS_SHOWN).map((problem) => (
              <li
                key={`${problem.row}-${problem.field ?? ''}-${problem.message}`}
                className="flex min-h-row items-center gap-3 border-b border-line px-3 py-1.5 text-sm last:border-b-0"
              >
                <span className="w-14 shrink-0 font-mono text-2xs text-text-faint">
                  Row {problem.row}
                </span>
                <span className="min-w-0 flex-1">{problem.message}</span>
                <Badge
                  tone={problem.severity === 'error' ? 'danger' : 'warning'}
                >
                  {problem.severity === 'error' ? 'Skipped' : 'Warning'}
                </Badge>
              </li>
            ))}
          </ul>
          {(preview.problems.length > PROBLEMS_SHOWN ||
            preview.problems_truncated) && (
            <p className="text-xs text-text-faint">
              Only the first problems are listed.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

/** Dry runs and starts issue imports and lists the recent ones. */
export const WorkspaceImportSection: React.FC<WorkspaceImportSectionProps> = ({
  workspace,
}) => {
  const auth = useQueryAuth();
  const queryKey = workspaceImportsKey(workspace.id);
  const teams = useTeamsFor(workspace.id);
  const [preset, setPreset] = useState<ImportPreset>('jira');
  const [teamId, setTeamId] = useState('');
  const [file, setFile] = useState<PickedFile | null>(null);
  const [mapping, setMapping] = useState<
    Partial<Record<ImportField, string | null>>
  >({});
  const [preview, setPreview] = useState<IssueImportPreviewRead | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [polling, setPolling] = useState(false);
  const [fileKey, setFileKey] = useState(0);

  const teamList = teams.data ?? [];
  const chosenTeam = teamId || (teamList[0]?.id ?? '');

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listIssueImports(workspace.id, signal),
    {
      intervalMs: polling ? ACTIVE_POLL_MS : IDLE_POLL_MS,
      queryKey,
      auth,
    }
  );

  const jobs = data ?? [];
  const importing = jobs.some(isActive);
  if (importing !== polling) setPolling(importing);

  const {
    mutate: start,
    isMutating: starting,
    error: startError,
  } = useMutationWithRefetch(
    (body: IssueImportRequest) => startIssueImport(workspace.id, body),
    queryKey
  );

  const request = (
    picked: PickedFile,
    overrides: Partial<Record<ImportField, string | null>>,
    team: string = chosenTeam,
    source: ImportPreset = preset
  ): IssueImportRequest => ({
    team_id: team,
    preset: source,
    csv: picked.text,
    file_name: picked.name,
    mapping: Object.keys(overrides).length === 0 ? null : overrides,
  });

  const runPreview = (body: IssueImportRequest): void => {
    setPreviewing(true);
    setPreviewError(null);
    void previewIssueImport(workspace.id, body)
      .then(setPreview)
      .catch((reason: unknown) => {
        setPreview(null);
        setPreviewError(reason);
      })
      .finally(() => {
        setPreviewing(false);
      });
  };

  const reset = (): void => {
    setPreview(null);
    setPreviewError(null);
    setMapping({});
  };

  const onFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const picked = event.target.files?.[0];
    reset();
    if (picked === undefined) {
      setFile(null);
      return;
    }
    void readFile(picked)
      .then((text) => {
        setFile({ name: picked.name, text });
      })
      .catch(setPreviewError);
  };

  const onMapping = (field: ImportField, header: string): void => {
    const next = {
      ...mapping,
      [field]: header === UNMAPPED ? null : header,
    };
    setMapping(next);
    if (file !== null) runPreview(request(file, next));
  };

  const onStart = (): void => {
    if (file === null) return;
    void start(request(file, mapping))
      .then(() => {
        setFile(null);
        setFileKey((key) => key + 1);
        reset();
      })
      .catch(() => undefined);
  };

  const canStart =
    file !== null &&
    preview !== null &&
    !previewing &&
    preview.importable_rows > 0 &&
    !importing &&
    !starting;

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Import issues</h2>
        <p className="text-sm text-text-muted">
          Bring issues into a team from a CSV export of Jira, Linear or any
          other tracker. Every issue gets a new key, and its old key is kept as
          its source reference. Statuses match by name, assignees by email, and
          labels the team lacks are created. Imported issues send no
          notifications, syncs or webhooks.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          id="import-preset"
          label="Source"
          value={preset}
          onChange={(event) => {
            setPreset(event.target.value as ImportPreset);
            reset();
          }}
        >
          {PRESETS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
        <SelectField
          id="import-team"
          label="Team"
          value={chosenTeam}
          disabled={teamList.length === 0}
          onChange={(event) => {
            setTeamId(event.target.value);
            reset();
          }}
        >
          {teamList.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </SelectField>
      </div>

      <div className="space-y-1">
        <Label htmlFor="import-file">CSV file</Label>
        <input
          key={fileKey}
          id="import-file"
          type="file"
          accept=".csv,text/csv"
          onChange={onFile}
          className="block w-full text-sm text-text-muted file:mr-3 file:h-8 file:cursor-pointer file:rounded-sm file:border file:border-line file:bg-raised file:px-2.5 file:text-sm file:text-text"
        />
        <p className="text-xs text-text-faint">
          Up to 5000 rows and 4 MB, header row first.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={file === null || chosenTeam === '' || previewing}
          onClick={() => {
            if (file !== null) runPreview(request(file, mapping));
          }}
        >
          {previewing ? 'Checking' : 'Check file'}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!canStart}
          onClick={onStart}
        >
          <LuUpload aria-hidden="true" className="h-3.5 w-3.5" />
          {importing
            ? 'Import in progress'
            : preview === null
              ? 'Start import'
              : `Import ${count(preview.importable_rows, 'issue')}`}
        </Button>
      </div>

      {teams.error !== null && teams.error !== undefined && (
        <ErrorAlert
          message={errorMessage(teams.error, 'Could not load the teams.')}
        />
      )}
      {previewError !== null && (
        <ErrorAlert
          message={errorMessage(previewError, 'Could not check that file.')}
        />
      )}
      {startError !== null && (
        <ErrorAlert
          message={errorMessage(startError, 'Could not start the import.')}
        />
      )}

      {preview !== null && (
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-xs font-medium text-text-muted">
              Column mapping
            </h3>
            <ul className="rounded-md border border-line">
              {FIELDS.map(({ field, label }) => (
                <li
                  key={field}
                  className="flex min-h-row items-center gap-3 border-b border-line px-3 py-1.5 last:border-b-0"
                >
                  <label
                    htmlFor={`import-map-${field}`}
                    className="w-28 shrink-0 text-sm text-text"
                  >
                    {label}
                  </label>
                  <Select
                    id={`import-map-${field}`}
                    value={preview.mapping[field] ?? UNMAPPED}
                    disabled={previewing}
                    onChange={(event) => {
                      onMapping(field, event.target.value);
                    }}
                  >
                    <option value={UNMAPPED}>Not imported</option>
                    {[...new Set(preview.headers)].map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </Select>
                </li>
              ))}
            </ul>
          </div>
          <ImportSummary preview={preview} />
        </div>
      )}

      <div className="space-y-1">
        <h3 className="text-xs font-medium text-text-muted">Recent imports</h3>
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load the imports.')}
          />
        )}
        {isLoading ? (
          <Spinner label="Loading imports" />
        ) : jobs.length === 0 ? (
          <p className="text-sm text-text-muted">No imports yet.</p>
        ) : (
          <ul className="rounded-md border border-line">
            {jobs.map((job) => {
              const display = STATUS_DISPLAY[job.status];
              const team = teamList.find((t) => t.id === job.team_id);
              return (
                <li
                  key={job.import_id}
                  className="flex min-h-row items-center gap-3 border-b border-line px-3 py-1.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="truncate text-sm text-text">
                      {job.file_name || 'Untitled file'}
                      {team !== undefined && (
                        <span className="text-text-faint">
                          {' '}
                          into {team.name}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-text-faint">
                      {jobSummary(job)}
                      {', started '}
                      <RelativeTime value={job.created_at} />
                    </p>
                  </div>
                  <Badge tone={display.tone}>{display.label}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
};

export default WorkspaceImportSection;
