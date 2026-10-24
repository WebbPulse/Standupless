/**
 * The issue import, led by an import assistant laid out like Linear's: one row
 * per provider, each opening its own flow. Linear and Shortcut read a
 * workspace through their APIs, Asana reads projects through Asana's API with
 * a pasted token, and GitHub reads a repository's Issues through the installed
 * App. Jira opens the file flow with its export preset chosen until its API
 * importer lands, and the file row takes any CSV
 * export or a Trello board's JSON. For a file the admin picks the tracker it
 * came from, a target team and the file, checks what every row would become,
 * adjusts the column mapping, and starts a job that writes the issues in the
 * background.
 *
 * The dry run runs again on every mapping change, so the summary always
 * describes the mapping the start button would send. The job list polls
 * quickly while an import is queued or running and slowly after, and offers
 * a cancel on a job that has not finished.
 */

import React, { useState } from 'react';
import { LuChevronLeft, LuChevronRight, LuUpload } from 'react-icons/lu';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  invalidateQueries,
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import {
  cancelIssueImport,
  listIssueImports,
  previewIssueImport,
  startIssueImport,
} from '../../api/imports';
import { useTeamsFor } from '../../hooks/useTeams';
import { errorMessage } from '../../lib/errors';
import { workspaceImportsKey } from '../../lib/queryKeys';
import type {
  AsanaImportCount,
  GitHubImportCount,
  ImportField,
  ImportPreset,
  ImportStatus,
  IssueImportPreviewRead,
  IssueImportRead,
  IssueImportRequest,
  LinearImportCount,
  RowProblemRead,
  TeamRead,
  WorkspaceRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Badge, { type BadgeTone } from '../ui/badge';
import Button from '../ui/button';
import Label from '../ui/label';
import TextLink from '../ui/link';
import RelativeTime from '../ui/relative-time';
import { Select, SelectField } from '../ui/select';
import Spinner from '../ui/spinner';
import AsanaImportForm from './AsanaImportForm';
import GitHubImportForm from './GitHubImportForm';
import ImportProviderIcon, { type ImportProvider } from './ImportProviderIcon';
import LinearImportForm from './LinearImportForm';
import ShortcutImportForm from './ShortcutImportForm';

/** Props for WorkspaceImportSection: the workspace issues are imported into. */
export interface WorkspaceImportSectionProps {
  workspace: WorkspaceRead;
}

/** How often the list is read while a job is still writing. */
const ACTIVE_POLL_MS = 3000;

/** How often the list is read once every job has settled. */
const IDLE_POLL_MS = 60000;

/** Where an import reads from: Linear, Shortcut or Asana through its API, GitHub through the App, or a file. */
type Source = 'linear' | 'shortcut' | 'asana' | 'github' | 'csv';

/** One row of the import assistant: what it is called, the flow it opens and the preset a file flow starts on. */
interface ProviderRow {
  value: ImportProvider;
  title: string;
  detail: string;
  source: Source;
  preset?: ImportPreset;
  comingSoon?: boolean;
}

/** The import assistant's rows, in the order Linear lists them, with the file row last. */
const PROVIDERS: ProviderRow[] = [
  {
    value: 'asana',
    title: 'Asana',
    detail: 'Projects, tasks and comments through the Asana API',
    source: 'asana',
  },
  {
    value: 'shortcut',
    title: 'Shortcut',
    detail: 'Teams, stories, epics and iterations through the Shortcut API',
    source: 'shortcut',
  },
  {
    value: 'github',
    title: 'GitHub',
    detail: "One repository's issues through the installed GitHub App",
    source: 'github',
  },
  {
    value: 'jira',
    title: 'Jira',
    detail: 'Issues exported as CSV',
    source: 'csv',
    preset: 'jira',
    comingSoon: true,
  },
  {
    value: 'linear',
    title: 'Linear',
    detail: 'Teams, issues, cycles and projects through the Linear API',
    source: 'linear',
  },
  {
    value: 'file',
    title: 'CSV or file',
    detail: 'Pivotal Tracker, a Trello board or any other CSV export',
    source: 'csv',
    preset: 'generic',
  },
];

/** The trackers a file can come from, in the order the picker offers them. */
const PRESETS: { value: ImportPreset; label: string }[] = [
  { value: 'asana', label: 'Asana' },
  { value: 'jira', label: 'Jira' },
  { value: 'linear', label: 'Linear' },
  { value: 'pivotal', label: 'Pivotal Tracker' },
  { value: 'shortcut', label: 'Shortcut' },
  { value: 'trello', label: 'Trello board (JSON)' },
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
  { field: 'parent', label: 'Parent' },
  { field: 'completed', label: 'Completed' },
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
    cancelled: { label: 'Cancelled', tone: 'neutral' },
  };

/** How each step of a Linear import reads while it runs. */
const PHASE_LABELS: Record<string, string> = {
  cycles: 'Reading cycles',
  projects: 'Reading projects',
  issues: 'Reading issues',
  links: 'Linking sub-issues and relations',
  initiatives: 'Reading initiatives',
  project_relations: 'Linking project dependencies',
};

/** How many steps each Linear team takes, matching the server's phase list. */
const TEAM_PHASES = 4;

/** The tallies a finished Linear import lists, in order, with the noun each counts. */
const LINEAR_TALLIES: { name: LinearImportCount; noun: string }[] = [
  { name: 'comments', noun: 'comment' },
  { name: 'labels', noun: 'new label' },
  { name: 'sub_issues', noun: 'sub-issue link' },
  { name: 'relations', noun: 'relation' },
  { name: 'cycles', noun: 'cycle' },
  { name: 'projects', noun: 'project' },
  { name: 'milestones', noun: 'milestone' },
  { name: 'project_updates', noun: 'project update' },
  { name: 'initiatives', noun: 'initiative' },
  { name: 'project_relations', noun: 'project dependency link' },
];

/** How each step of a Shortcut import reads while it runs. */
const SHORTCUT_PHASE_LABELS: Record<string, string> = {
  iterations: 'Reading iterations',
  epics: 'Reading epics',
  stories: 'Reading stories',
};

/** How many steps each Shortcut team takes, matching the server's phase list. */
const SHORTCUT_TEAM_PHASES = 3;

/** The tallies a finished Shortcut import lists, in order, with the noun each counts. */
const SHORTCUT_TALLIES: { name: LinearImportCount; noun: string }[] = [
  { name: 'comments', noun: 'comment' },
  { name: 'labels', noun: 'new label' },
  { name: 'sub_issues', noun: 'sub-issue link' },
  { name: 'relations', noun: 'relation' },
  { name: 'cycles', noun: 'cycle' },
  { name: 'projects', noun: 'project' },
];

/** How each step of an Asana import reads while it runs. */
const ASANA_PHASE_LABELS: Record<string, string> = {
  project: 'Reading the project',
  tasks: 'Reading tasks',
};

/** How many steps each Asana project takes, matching the server's phase list. */
const ASANA_PROJECT_PHASES = 2;

/** The tallies a finished Asana import lists, in order, with the noun each counts. */
const ASANA_TALLIES: { name: AsanaImportCount; noun: string }[] = [
  { name: 'comments', noun: 'comment' },
  { name: 'labels', noun: 'new label' },
  { name: 'sub_issues', noun: 'sub-issue link' },
  { name: 'projects', noun: 'project' },
];

/** The tallies a finished GitHub import lists after its issue counts, in order. */
const GITHUB_TALLIES: { name: GitHubImportCount; noun: string }[] = [
  { name: 'comments', noun: 'comment' },
  { name: 'labels', noun: 'new label' },
];

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

/**
 * A Trello board export without its activity log. The import reads only the
 * board's lists, cards, labels, members and checklists, and the `actions`
 * array is most of an export's size, so dropping it keeps a board under the
 * upload limit. Anything that is not a JSON object is returned unchanged.
 */
const withoutTrelloActions = (text: string): string => {
  if (!text.trimStart().startsWith('{')) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return text;
    if (!('actions' in parsed)) return text;
    const board: Record<string, unknown> = { ...parsed };
    delete board['actions'];
    return JSON.stringify(board);
  } catch {
    return text;
  }
};

/** Says how many of a thing there are, with the plural when it needs one. */
const count = (n: number, noun: string): string =>
  `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The line under a running Linear job that says which step it is on. */
const linearProgress = (job: IssueImportRead): string => {
  if (job.status === 'queued') return 'Waiting to start';
  const index = job.phase_index ?? 0;
  const total = job.phase_count ?? 0;
  const teams = job.linear_teams ?? [];
  const team =
    index < teams.length * TEAM_PHASES
      ? teams[Math.floor(index / TEAM_PHASES)]
      : undefined;
  const step = PHASE_LABELS[job.phase ?? ''] ?? 'Importing';
  const parts = [team === undefined ? step : `${step} in ${team.linear_key}`];
  if (total > 0) parts.push(`step ${Math.min(index + 1, total)} of ${total}`);
  parts.push(`${count(job.created_count, 'issue')} so far`);
  return parts.join(', ');
};

/** The line under a finished Linear job that lists what it brought over. */
const linearOutcome = (job: IssueImportRead): string => {
  const counts = job.counts ?? {};
  const parts = [`${count(job.created_count, 'issue')} created`];
  const updated = job.updated_count ?? counts.issues_updated ?? 0;
  if (updated > 0) parts.push(`${updated} updated`);
  for (const { name, noun } of LINEAR_TALLIES) {
    const n = counts[name] ?? 0;
    if (n > 0) parts.push(count(n, noun));
  }
  return parts.join(', ');
};

/** The line under a running Shortcut job that says which step it is on. */
const shortcutProgress = (job: IssueImportRead): string => {
  if (job.status === 'queued') return 'Waiting to start';
  const index = job.phase_index ?? 0;
  const total = job.phase_count ?? 0;
  const teams = job.source_teams ?? [];
  const team =
    index < teams.length * SHORTCUT_TEAM_PHASES
      ? teams[Math.floor(index / SHORTCUT_TEAM_PHASES)]
      : undefined;
  const step = SHORTCUT_PHASE_LABELS[job.phase ?? ''] ?? 'Importing';
  const parts = [team === undefined ? step : `${step} in ${team.name}`];
  if (total > 0) parts.push(`step ${Math.min(index + 1, total)} of ${total}`);
  parts.push(`${count(job.created_count, 'issue')} so far`);
  return parts.join(', ');
};

/** The line under a finished Shortcut job that lists what it brought over. */
const shortcutOutcome = (job: IssueImportRead): string => {
  const counts = job.counts ?? {};
  const parts = [`${count(job.created_count, 'issue')} created`];
  const updated = job.updated_count ?? counts.issues_updated ?? 0;
  if (updated > 0) parts.push(`${updated} updated`);
  for (const { name, noun } of SHORTCUT_TALLIES) {
    const n = counts[name] ?? 0;
    if (n > 0) parts.push(count(n, noun));
  }
  return parts.join(', ');
};

/** The line under a running Asana job that says which project and step it is on. */
const asanaProgress = (job: IssueImportRead): string => {
  if (job.status === 'queued') return 'Waiting to start';
  const index = job.phase_index ?? 0;
  const total = job.phase_count ?? 0;
  const project = (job.asana_projects ?? [])[
    Math.floor(index / ASANA_PROJECT_PHASES)
  ];
  const step = ASANA_PHASE_LABELS[job.phase ?? ''] ?? 'Importing';
  const parts = [project === undefined ? step : `${step} in ${project.name}`];
  if (total > 0) parts.push(`step ${Math.min(index + 1, total)} of ${total}`);
  parts.push(`${count(job.created_count, 'issue')} so far`);
  return parts.join(', ');
};

/** The line under a finished Asana job that lists what it brought over. */
const asanaOutcome = (job: IssueImportRead): string => {
  const counts = job.counts ?? {};
  const parts = [`${count(job.created_count, 'issue')} created`];
  const updated = job.updated_count ?? counts.issues_updated ?? 0;
  if (updated > 0) parts.push(`${updated} updated`);
  for (const { name, noun } of ASANA_TALLIES) {
    const n = counts[name] ?? 0;
    if (n > 0) parts.push(count(n, noun));
  }
  return parts.join(', ');
};

/** The line under a running GitHub job that says how far it got. */
const githubProgress = (job: IssueImportRead): string => {
  if (job.status === 'queued') return 'Waiting to start';
  return `Reading issues, ${count(job.created_count, 'issue')} so far`;
};

/** The line under a finished GitHub job that lists what it brought over and skipped. */
const githubOutcome = (job: IssueImportRead): string => {
  const counts = job.counts ?? {};
  const parts = [`${count(job.created_count, 'issue')} created`];
  const updated = job.updated_count ?? counts.issues_updated ?? 0;
  if (updated > 0) parts.push(`${updated} updated`);
  for (const { name, noun } of GITHUB_TALLIES) {
    const n = counts[name] ?? 0;
    if (n > 0) parts.push(count(n, noun));
  }
  const synced = counts.already_synced ?? 0;
  if (synced > 0) parts.push(`${synced} already synced`);
  const pulls = counts.pull_requests_skipped ?? 0;
  if (pulls > 0) parts.push(`${count(pulls, 'pull request')} skipped`);
  return parts.join(', ');
};

/** The line under a job that says how far it got. */
const jobSummary = (job: IssueImportRead): string => {
  if (job.status === 'cancelled') {
    return `Cancelled after ${count(job.created_count, 'issue')}.`;
  }
  if (job.kind === 'linear') {
    if (job.status === 'completed') return linearOutcome(job);
    if (job.status !== 'failed') return linearProgress(job);
  }
  if (job.kind === 'shortcut') {
    if (job.status === 'completed') return shortcutOutcome(job);
    if (job.status !== 'failed') return shortcutProgress(job);
  }
  if (job.kind === 'asana') {
    if (job.status === 'completed') return asanaOutcome(job);
    if (job.status !== 'failed') return asanaProgress(job);
  }
  if (job.kind === 'github') {
    if (job.status === 'completed') return githubOutcome(job);
    if (job.status !== 'failed') return githubProgress(job);
  }
  if (job.status === 'failed') {
    return `Stopped after ${count(job.created_count, 'issue')}. ${job.error ?? ''}`.trim();
  }
  if (job.status === 'completed') {
    const parts = [`${count(job.created_count, 'issue')} created`];
    if (job.skipped_count > 0) parts.push(`${job.skipped_count} skipped`);
    if (job.labels_created > 0)
      parts.push(count(job.labels_created, 'new label'));
    const linked = job.linked_count ?? 0;
    if (linked > 0) parts.push(`${count(linked, 'sub-issue')} linked`);
    return parts.join(', ');
  }
  return `${job.processed_rows} of ${job.total_rows} rows`;
};

/** What a job row is called: the file or repository it read, or the Linear, Shortcut or Asana teams and projects and where they went. */
const jobTitle = (job: IssueImportRead, teams: TeamRead[]): string => {
  if (job.kind === 'linear') {
    const mapped = (job.linear_teams ?? []).map((row) => {
      const target = teams.find((t) => t.id === row.team_id);
      return target === undefined
        ? row.linear_key
        : `${row.linear_key} into ${target.name}`;
    });
    return mapped.length === 0 ? 'Linear' : `Linear ${mapped.join(', ')}`;
  }
  if (job.kind === 'shortcut') {
    const mapped = (job.source_teams ?? []).map((row) => {
      const target = teams.find((t) => t.id === row.team_id);
      return target === undefined
        ? row.name
        : `${row.name} into ${target.name}`;
    });
    return mapped.length === 0 ? 'Shortcut' : `Shortcut ${mapped.join(', ')}`;
  }
  if (job.kind === 'asana') {
    const names = (job.asana_projects ?? []).map((row) => row.name);
    const into = teams.find((t) => t.id === job.asana_projects?.[0]?.team_id);
    const title = names.length === 0 ? 'Asana' : `Asana ${names.join(', ')}`;
    return into === undefined ? title : `${title} into ${into.name}`;
  }
  const target = teams.find((t) => t.id === job.team_id);
  if (job.kind === 'github') {
    const repository = `GitHub ${job.file_name || 'repository'}`;
    return target === undefined
      ? repository
      : `${repository} into ${target.name}`;
  }
  const name = job.file_name || 'Untitled file';
  return target === undefined ? name : `${name} into ${target.name}`;
};

/** Props for JobProblems: the per item problems a job recorded. */
interface JobProblemsProps {
  problems: RowProblemRead[];
  truncated: boolean;
}

/** The problems a job recorded, folded away until asked for. */
const JobProblems: React.FC<JobProblemsProps> = ({ problems, truncated }) => (
  <details className="text-xs">
    <summary className="cursor-pointer text-text-muted hover:text-text">
      {count(problems.length, 'problem')}
    </summary>
    <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto">
      {problems.slice(0, PROBLEMS_SHOWN).map((problem) => (
        <li
          key={`${problem.row}-${problem.field ?? ''}-${problem.message}`}
          className="text-text-faint"
        >
          {problem.message}
        </li>
      ))}
    </ul>
    {(problems.length > PROBLEMS_SHOWN || truncated) && (
      <p className="text-text-faint">Only the first problems are listed.</p>
    )}
  </details>
);

/** Props for ImportSummary: a dry run's result. */
interface ImportSummaryProps {
  preview: IssueImportPreviewRead;
}

/** What a dry run found: the counts, where statuses land, new labels and row problems. */
const ImportSummary: React.FC<ImportSummaryProps> = ({ preview }) => {
  const errors = preview.problems.filter((p) => p.severity === 'error').length;
  const warnings = preview.problems.length - errors;
  const links = preview.parent_links ?? 0;
  return (
    <div className="space-y-4" aria-label="Dry run">
      <p className="text-sm text-text">
        {`${count(preview.importable_rows, 'issue')} will be created from ${count(preview.total_rows, 'row')}.`}
        {errors > 0 && ` ${count(errors, 'row')} will be skipped.`}
        {links > 0 && ` ${count(links, 'sub-issue')} will be linked.`}
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
  const [provider, setProvider] = useState<ProviderRow | null>(null);
  const source = provider?.source ?? null;

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

  const {
    mutate: cancel,
    isMutating: cancelling,
    error: cancelError,
  } = useMutationWithRefetch(
    (importId: string) => cancelIssueImport(workspace.id, importId),
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
        setFile({ name: picked.name, text: withoutTrelloActions(text) });
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

  const openProvider = (row: ProviderRow): void => {
    setProvider(row);
    if (row.preset !== undefined) setPreset(row.preset);
    setFile(null);
    setFileKey((key) => key + 1);
    reset();
  };

  const trello = preset === 'trello';

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
          Bring work over from another tracker. Every issue gets a new key, and
          its old key is kept as its source reference, so importing again
          updates instead of duplicating. Statuses match by name or type, people
          by email, and labels the team lacks are created. Imported issues send
          no notifications, syncs or webhooks.
        </p>
      </div>

      {provider === null ? (
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-text-muted">
            Import assistant
          </h3>
          <ul
            aria-label="Import assistant"
            className="rounded-md border border-line"
          >
            {PROVIDERS.map((row) => (
              <li
                key={row.value}
                className="border-b border-line last:border-b-0"
              >
                <button
                  type="button"
                  onClick={() => {
                    openProvider(row);
                  }}
                  className="flex min-h-row w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-raised"
                >
                  <span className="text-text-muted">
                    <ImportProviderIcon provider={row.value} />
                  </span>
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="block text-sm font-medium text-text">
                      {row.title}
                    </span>
                    <span className="block text-xs text-text-faint">
                      {row.detail}
                    </span>
                  </span>
                  <LuChevronRight
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-text-faint"
                  />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="space-y-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setProvider(null);
              reset();
            }}
          >
            <LuChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
            All import sources
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-text-muted">
              <ImportProviderIcon provider={provider.value} />
            </span>
            <h3 className="text-sm font-semibold text-text">
              {provider.value === 'file'
                ? 'Import a file'
                : `Import from ${provider.title}`}
            </h3>
          </div>
          {provider.comingSoon === true && (
            <p className="rounded-md border border-line bg-raised px-3 py-2 text-xs text-text-muted">
              {`Connect via API (coming soon). Until then, export from ${provider.title} as CSV and import the file here; its columns are mapped for you.`}
            </p>
          )}
        </div>
      )}

      {source === null ? null : source === 'linear' ? (
        <LinearImportForm
          workspaceId={workspace.id}
          teams={teamList}
          importing={importing}
          onStarted={() => {
            invalidateQueries(queryKey);
          }}
        />
      ) : source === 'shortcut' ? (
        <ShortcutImportForm
          workspaceId={workspace.id}
          teams={teamList}
          importing={importing}
          onStarted={() => {
            invalidateQueries(queryKey);
          }}
        />
      ) : source === 'asana' ? (
        <AsanaImportForm
          workspaceId={workspace.id}
          teams={teamList}
          importing={importing}
          onStarted={() => {
            invalidateQueries(queryKey);
          }}
        />
      ) : source === 'github' ? (
        <GitHubImportForm
          workspaceId={workspace.id}
          workspaceSlug={workspace.slug}
          teams={teamList}
          importing={importing}
          onStarted={() => {
            invalidateQueries(queryKey);
          }}
        />
      ) : (
        <div className="space-y-6">
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
            <Label htmlFor="import-file">
              {trello ? 'Board JSON' : 'CSV file'}
            </Label>
            <input
              key={fileKey}
              id="import-file"
              type="file"
              accept={trello ? '.json,application/json' : '.csv,text/csv'}
              onChange={onFile}
              className="block w-full text-sm text-text-muted file:mr-3 file:h-8 file:cursor-pointer file:rounded-sm file:border file:border-line file:bg-raised file:px-2.5 file:text-sm file:text-text"
            />
            <p className="text-xs text-text-faint">
              {trello
                ? "Export it from the board's menu under Print, export and share. Cards, lists, labels, members and checklists are read; the activity log is left out before upload."
                : 'Up to 5000 rows and 4 MB, header row first.'}
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
        </div>
      )}

      <div className="space-y-1">
        <h3 className="text-xs font-medium text-text-muted">Recent imports</h3>
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load the imports.')}
          />
        )}
        {cancelError !== null && (
          <ErrorAlert
            message={errorMessage(cancelError, 'Could not cancel the import.')}
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
              const finished = !isActive(job);
              return (
                <li
                  key={job.import_id}
                  className="flex min-h-row items-center gap-3 border-b border-line px-3 py-1.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="truncate text-sm text-text">
                      {jobTitle(job, teamList)}
                    </p>
                    <p className="text-xs text-text-faint">
                      {jobSummary(job)}
                      {', started '}
                      <RelativeTime value={job.created_at} />
                    </p>
                    {finished && job.problems.length > 0 && (
                      <JobProblems
                        problems={job.problems}
                        truncated={job.problems_truncated}
                      />
                    )}
                  </div>
                  {!finished && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={cancelling}
                      onClick={() => {
                        void cancel(job.import_id).catch(() => undefined);
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                  <Badge tone={display.tone}>{display.label}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="space-y-1 border-t border-line pt-6">
        <h2 className="text-base font-semibold">Export</h2>
        <p className="text-sm text-text-muted">
          Download a copy of this workspace's data from the{' '}
          <TextLink to={`/w/${workspace.slug}/settings/export`}>
            export settings
          </TextLink>
          .
        </p>
      </div>
    </section>
  );
};

export default WorkspaceImportSection;
