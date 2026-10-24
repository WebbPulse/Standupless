/**
 * The Asana import form: paste a personal access token, load the projects it
 * can read, tick the ones to bring over, pick the Standupless team they go
 * into, preview where every section lands, adjust it, and start.
 *
 * The token lives only in this form's state until the start request carries
 * it, and is cleared as soon as the job is queued. Any change to the projects,
 * the team or the project toggle drops the preview, so the start button always
 * sends the mapping the admin last saw.
 */

import React, { useState } from 'react';
import { LuDownload } from 'react-icons/lu';
import {
  listAsanaProjects,
  previewAsanaImport,
  startAsanaImport,
} from '../../api/imports';
import { listStatuses } from '../../api/teams';
import { errorMessage } from '../../lib/errors';
import type {
  AsanaProjectChoice,
  AsanaProjectPreviewRead,
  AsanaProjectRead,
  IssueImportRead,
  StatusRead,
  TeamRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import Field from '../ui/field';
import { LINK_CLASS } from '../ui/link';
import { Select, SelectField } from '../ui/select';

/** Props for AsanaImportForm: the workspace, its teams and the hook that starts a job. */
export interface AsanaImportFormProps {
  workspaceId: string;
  teams: TeamRead[];
  /** Whether another import is still running, which the server would refuse. */
  importing: boolean;
  /** Called with the queued job so the caller can refresh its list. */
  onStarted: (job: IssueImportRead) => void;
}

/** Where Asana lists a member's personal access tokens. */
const ASANA_TOKENS_URL = 'https://app.asana.com/0/my-apps';

/** The status source value that means a task's section sets its status. */
const SECTIONS = '';

/** Says how many of a thing there are, with the plural when it needs one. */
const count = (n: number, noun: string): string =>
  `${n} ${noun}${n === 1 ? '' : 's'}`;

/** What a project row says under its name: its Asana workspace, team and state. */
const projectDetail = (project: AsanaProjectRead): string => {
  const parts = [project.workspace_name];
  const team = project.team_name ?? '';
  if (team !== '') parts.push(team);
  if (project.archived) parts.push('archived');
  else if (project.completed) parts.push('completed');
  return parts.filter((part) => part !== '').join(', ');
};

/** Reads Asana projects with a pasted token, previews them and starts an import of the chosen ones. */
export const AsanaImportForm: React.FC<AsanaImportFormProps> = ({
  workspaceId,
  teams,
  importing,
  onStarted,
}) => {
  const [token, setToken] = useState('');
  const [projects, setProjects] = useState<AsanaProjectRead[] | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [teamId, setTeamId] = useState('');
  const [createProject, setCreateProject] = useState(true);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<
    Record<string, Record<string, string>>
  >({});
  const [preview, setPreview] = useState<AsanaProjectPreviewRead[] | null>(
    null
  );
  const [statuses, setStatuses] = useState<StatusRead[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<{
    reason: unknown;
    fallback: string;
  } | null>(null);

  const chosenTeam =
    teams.find((team) => team.id === teamId)?.id ?? teams[0]?.id ?? '';
  const chosen = (projects ?? []).filter(
    (project) => selected[project.gid] === true
  );

  const dropPreview = (): void => {
    setPreview(null);
    setOverrides({});
    setError(null);
  };

  const onToken = (value: string): void => {
    setToken(value);
    setProjects(null);
    setSelected({});
    setFields({});
    dropPreview();
  };

  const onLoad = (): void => {
    setLoading(true);
    setError(null);
    void listAsanaProjects(workspaceId, token.trim())
      .then((found) => {
        setProjects(found);
        setSelected(
          Object.fromEntries(
            found.map((project) => [project.gid, !project.archived])
          )
        );
      })
      .catch((reason: unknown) => {
        setProjects(null);
        setError({ reason, fallback: 'Could not read projects from Asana.' });
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const choices = (
    statusFields: Record<string, string>,
    statusOverrides: Record<string, Record<string, string>>
  ): AsanaProjectChoice[] =>
    chosen.map((project) => {
      const field = statusFields[project.gid] ?? SECTIONS;
      return {
        project_gid: project.gid,
        team_id: chosenTeam,
        create_project: createProject,
        status_field_gid: field === SECTIONS ? null : field,
        statuses: statusOverrides[project.gid] ?? {},
      };
    });

  const runPreview = (
    statusFields: Record<string, string>,
    statusOverrides: Record<string, Record<string, string>>
  ): void => {
    setPreviewing(true);
    setError(null);
    void Promise.all([
      previewAsanaImport(workspaceId, {
        token: token.trim(),
        projects: choices(statusFields, statusOverrides),
      }),
      listStatuses(workspaceId, chosenTeam),
    ])
      .then(([answer, teamStatuses]) => {
        setPreview(answer.projects);
        setStatuses(teamStatuses);
      })
      .catch((reason: unknown) => {
        setPreview(null);
        setError({ reason, fallback: 'Could not preview the import.' });
      })
      .finally(() => {
        setPreviewing(false);
      });
  };

  const onStatusField = (projectGid: string, field: string): void => {
    const nextFields = { ...fields, [projectGid]: field };
    const nextOverrides = { ...overrides, [projectGid]: {} };
    setFields(nextFields);
    setOverrides(nextOverrides);
    runPreview(nextFields, nextOverrides);
  };

  const onOverride = (
    projectGid: string,
    source: string,
    statusId: string
  ): void => {
    setOverrides((current) => ({
      ...current,
      [projectGid]: { ...(current[projectGid] ?? {}), [source]: statusId },
    }));
  };

  const onStart = (): void => {
    setStarting(true);
    setError(null);
    void startAsanaImport(workspaceId, {
      token: token.trim(),
      projects: choices(fields, overrides),
    })
      .then((job) => {
        setToken('');
        setProjects(null);
        setSelected({});
        setFields({});
        dropPreview();
        onStarted(job);
      })
      .catch((reason: unknown) => {
        setError({ reason, fallback: 'Could not start the import.' });
      })
      .finally(() => {
        setStarting(false);
      });
  };

  const canPreview =
    projects !== null &&
    chosen.length > 0 &&
    chosenTeam !== '' &&
    !previewing &&
    !starting;
  const canStart = preview !== null && canPreview && !importing;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Field
          id="asana-token"
          label="Asana personal access token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => {
            onToken(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && token.trim() !== '' && !loading) {
              event.preventDefault();
              onLoad();
            }
          }}
        />
        <p className="text-xs text-text-faint">
          Create a personal access token in the{' '}
          <a
            href={ASANA_TOKENS_URL}
            target="_blank"
            rel="noreferrer"
            className={LINK_CLASS}
          >
            Asana developer console
          </a>
          . It is used for this import only, kept sealed while the import runs
          and deleted when it ends. A project exported as CSV can still be
          imported as a file instead.
        </p>
        <Button
          variant="secondary"
          size="sm"
          disabled={token.trim() === '' || loading}
          onClick={onLoad}
        >
          {loading ? 'Loading projects' : 'Load projects'}
        </Button>
      </div>

      {projects !== null && (
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-xs font-medium text-text-muted">
              Projects to import
            </h3>
            {projects.length === 0 ? (
              <p className="text-sm text-text-muted">
                This token cannot read any projects.
              </p>
            ) : (
              <ul
                className="rounded-md border border-line"
                aria-label="Asana projects"
              >
                {projects.map((project) => (
                  <li
                    key={project.gid}
                    className="flex min-h-row items-center gap-3 border-b border-line px-3 py-1.5 last:border-b-0"
                  >
                    <Checkbox
                      className="min-w-0 flex-1"
                      checked={selected[project.gid] === true}
                      disabled={starting}
                      onChange={(event) => {
                        setSelected((current) => ({
                          ...current,
                          [project.gid]: event.target.checked,
                        }));
                        dropPreview();
                      }}
                      label={
                        <span className="min-w-0 truncate">
                          {project.name}
                          <span className="ml-2 text-2xs text-text-faint">
                            {projectDetail(project)}
                          </span>
                        </span>
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              id="asana-team"
              label="Team"
              value={chosenTeam}
              disabled={teams.length === 0 || starting}
              onChange={(event) => {
                setTeamId(event.target.value);
                dropPreview();
              }}
            >
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </SelectField>
          </div>
          <Checkbox
            checked={createProject}
            disabled={starting}
            onChange={(event) => {
              setCreateProject(event.target.checked);
              dropPreview();
            }}
            label="Create a Standupless project for each Asana project"
          />
          <p className="text-xs text-text-faint">
            Tasks, subtasks as sub-issues, tags as labels, due dates and
            comments come across. People match by email, and anyone without an
            account here is shown by name. Running it again updates what it
            imported before.
          </p>
          <Button
            variant="secondary"
            size="sm"
            disabled={!canPreview}
            onClick={() => {
              runPreview(fields, overrides);
            }}
          >
            {previewing ? 'Previewing' : 'Preview import'}
          </Button>
        </div>
      )}

      {preview !== null && (
        <div className="space-y-4" aria-label="Import preview">
          {preview.map((project) => (
            <div key={project.project_gid} className="space-y-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="text-sm font-medium text-text">
                  {project.name}
                </h3>
                <span className="text-xs text-text-faint">
                  {`${count(project.task_count, 'task')}, ${project.completed_count} completed`}
                </span>
              </div>
              {project.status_fields.length > 0 && (
                <SelectField
                  id={`asana-status-source-${project.project_gid}`}
                  label="Status comes from"
                  className="max-w-xs"
                  value={fields[project.project_gid] ?? SECTIONS}
                  disabled={previewing || starting}
                  onChange={(event) => {
                    onStatusField(project.project_gid, event.target.value);
                  }}
                >
                  <option value={SECTIONS}>Sections</option>
                  {project.status_fields.map((field) => (
                    <option key={field.gid} value={field.gid}>
                      {`Field: ${field.name}`}
                    </option>
                  ))}
                </SelectField>
              )}
              {project.statuses.length === 0 ? (
                <p className="text-xs text-text-muted">
                  No sections or options to map. Tasks land in the team's
                  default status.
                </p>
              ) : (
                <ul
                  className="rounded-md border border-line"
                  aria-label={`Statuses for ${project.name}`}
                >
                  {project.statuses.map((plan) => (
                    <li
                      key={plan.source}
                      className="flex min-h-row flex-wrap items-center gap-3 border-b border-line px-3 py-1.5 last:border-b-0"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {plan.source}
                      </span>
                      <span className="text-text-faint" aria-hidden="true">
                        to
                      </span>
                      <Select
                        aria-label={`Status for ${plan.source}`}
                        className="w-auto min-w-40"
                        value={
                          overrides[project.project_gid]?.[plan.source] ??
                          plan.status_id
                        }
                        disabled={starting}
                        onChange={(event) => {
                          onOverride(
                            project.project_gid,
                            plan.source,
                            event.target.value
                          );
                        }}
                      >
                        {statuses.length === 0 ? (
                          <option value={plan.status_id}>
                            {plan.status_name}
                          </option>
                        ) : (
                          statuses.map((status) => (
                            <option key={status.id} value={status.id}>
                              {status.name}
                            </option>
                          ))
                        )}
                      </Select>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <p className="text-xs text-text-faint">
            Completed tasks always land in a completed status.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          disabled={!canStart}
          onClick={onStart}
        >
          <LuDownload aria-hidden="true" className="h-3.5 w-3.5" />
          {importing
            ? 'Import in progress'
            : starting
              ? 'Starting import'
              : chosen.length === 0
                ? 'Start import'
                : `Import ${count(chosen.length, 'project')}`}
        </Button>
      </div>

      {error !== null && (
        <ErrorAlert message={errorMessage(error.reason, error.fallback)} />
      )}
    </div>
  );
};

export default AsanaImportForm;
