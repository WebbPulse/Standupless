/**
 * The Jira import form: enter the Jira Cloud site, the Atlassian account email
 * and an API token, load the projects the account can browse, tick the ones to
 * bring over or write a JQL filter, pick the Standupless team they go into and
 * whether epics become projects or parent issues, preview where every Jira
 * status lands, adjust it, and start.
 *
 * The token lives only in this form's state until the start request carries
 * it, and is cleared as soon as the job is queued. Any change to the site, the
 * account, the projects, the filter, the team or the epic choice drops the
 * preview, so the start button always sends the mapping the admin last saw.
 */

import React, { useState } from 'react';
import { LuDownload } from 'react-icons/lu';
import {
  listJiraProjects,
  previewJiraImport,
  startJiraImport,
} from '../../api/imports';
import { listStatuses } from '../../api/teams';
import { errorMessage } from '../../lib/errors';
import type {
  IssueImportRead,
  JiraEpicsAs,
  JiraProjectChoice,
  JiraProjectPreviewRead,
  JiraProjectRead,
  StatusRead,
  TeamRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import Field from '../ui/field';
import { LINK_CLASS } from '../ui/link';
import { Select, SelectField } from '../ui/select';

/** Props for JiraImportForm: the workspace, its teams and the hook that starts a job. */
export interface JiraImportFormProps {
  workspaceId: string;
  teams: TeamRead[];
  /** Whether another import is still running, which the server would refuse. */
  importing: boolean;
  /** Called with the queued job so the caller can refresh its list. */
  onStarted: (job: IssueImportRead) => void;
}

/** Where an Atlassian account creates its API tokens. */
const JIRA_TOKENS_URL =
  'https://id.atlassian.com/manage-profile/security/api-tokens';

/** The key a preview row's status overrides are kept under: its project, or the filter alone. */
const FILTER_ONLY = '';

/** Says how many of a thing there are, with the plural when it needs one. */
const count = (n: number, noun: string): string =>
  `${n} ${noun}${n === 1 ? '' : 's'}`;

/** What a project row says beside its name: its key, kind and state. */
const projectDetail = (project: JiraProjectRead): string => {
  const parts = [project.key];
  const kind = project.project_type ?? '';
  if (kind !== '') parts.push(kind);
  if (project.team_managed) parts.push('team-managed');
  if (project.archived) parts.push('archived');
  return parts.join(', ');
};

/** The key one preview row's overrides live under. */
const rowKey = (project: JiraProjectPreviewRead): string =>
  project.project_key ?? FILTER_ONLY;

/** Reads Jira projects with an account's API token, previews them and starts an import of the chosen ones. */
export const JiraImportForm: React.FC<JiraImportFormProps> = ({
  workspaceId,
  teams,
  importing,
  onStarted,
}) => {
  const [site, setSite] = useState('');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [projects, setProjects] = useState<JiraProjectRead[] | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [jql, setJql] = useState('');
  const [teamId, setTeamId] = useState('');
  const [epicsAs, setEpicsAs] = useState<JiraEpicsAs>('projects');
  const [overrides, setOverrides] = useState<
    Record<string, Record<string, string>>
  >({});
  const [preview, setPreview] = useState<JiraProjectPreviewRead[] | null>(null);
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
    (project) => selected[project.key] === true
  );
  const filter = jql.trim();
  const signedIn =
    site.trim() !== '' && email.trim() !== '' && token.trim() !== '';

  const credentials = () => ({
    site_url: siteUrl || site.trim(),
    email: email.trim(),
    token: token.trim(),
  });

  const dropPreview = (): void => {
    setPreview(null);
    setOverrides({});
    setError(null);
  };

  const onSignIn = (change: () => void): void => {
    change();
    setSiteUrl('');
    setProjects(null);
    setSelected({});
    dropPreview();
  };

  const onLoad = (): void => {
    setLoading(true);
    setError(null);
    void listJiraProjects(workspaceId, {
      site_url: site.trim(),
      email: email.trim(),
      token: token.trim(),
    })
      .then((found) => {
        setSiteUrl(found.site_url);
        setProjects(found.items);
        setSelected({});
      })
      .catch((reason: unknown) => {
        setProjects(null);
        setError({ reason, fallback: 'Could not read projects from Jira.' });
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const choices = (
    statusOverrides: Record<string, Record<string, string>>
  ): JiraProjectChoice[] => {
    const shared = {
      jql: filter === '' ? null : filter,
      team_id: chosenTeam,
      epics_as: epicsAs,
    };
    if (chosen.length === 0) {
      return filter === ''
        ? []
        : [{ ...shared, statuses: statusOverrides[FILTER_ONLY] ?? {} }];
    }
    return chosen.map((project) => ({
      ...shared,
      project_key: project.key,
      statuses: statusOverrides[project.key] ?? {},
    }));
  };

  const runPreview = (): void => {
    setPreviewing(true);
    setError(null);
    void Promise.all([
      previewJiraImport(workspaceId, {
        ...credentials(),
        projects: choices(overrides),
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

  const onOverride = (key: string, source: string, statusId: string): void => {
    setOverrides((current) => ({
      ...current,
      [key]: { ...(current[key] ?? {}), [source]: statusId },
    }));
  };

  const onStart = (): void => {
    setStarting(true);
    setError(null);
    void startJiraImport(workspaceId, {
      ...credentials(),
      projects: choices(overrides),
    })
      .then((job) => {
        setToken('');
        setProjects(null);
        setSelected({});
        setJql('');
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
    (chosen.length > 0 || filter !== '') &&
    chosenTeam !== '' &&
    !previewing &&
    !starting;
  const canStart = preview !== null && canPreview && !importing;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="jira-site"
            label="Jira site"
            placeholder="your-site.atlassian.net"
            autoComplete="off"
            spellCheck={false}
            value={site}
            onChange={(event) => {
              onSignIn(() => {
                setSite(event.target.value);
              });
            }}
          />
          <Field
            id="jira-email"
            label="Atlassian account email"
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={email}
            onChange={(event) => {
              onSignIn(() => {
                setEmail(event.target.value);
              });
            }}
          />
        </div>
        <Field
          id="jira-token"
          label="Jira API token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => {
            onSignIn(() => {
              setToken(event.target.value);
            });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && signedIn && !loading) {
              event.preventDefault();
              onLoad();
            }
          }}
        />
        <p className="text-xs text-text-faint">
          Create an API token in your{' '}
          <a
            href={JIRA_TOKENS_URL}
            target="_blank"
            rel="noreferrer"
            className={LINK_CLASS}
          >
            Atlassian account settings
          </a>
          . It is used for this import only, kept sealed while the import runs
          and deleted when it ends. Issues exported as CSV can still be imported
          as a file instead.
        </p>
        <Button
          variant="secondary"
          size="sm"
          disabled={!signedIn || loading}
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
                This account cannot browse any projects.
              </p>
            ) : (
              <ul
                className="max-h-80 overflow-y-auto rounded-md border border-line"
                aria-label="Jira projects"
              >
                {projects.map((project) => (
                  <li
                    key={project.key}
                    className="flex min-h-row items-center gap-3 border-b border-line px-3 py-1.5 last:border-b-0"
                  >
                    <Checkbox
                      className="min-w-0 flex-1"
                      checked={selected[project.key] === true}
                      disabled={starting}
                      onChange={(event) => {
                        setSelected((current) => ({
                          ...current,
                          [project.key]: event.target.checked,
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

          <div className="space-y-1">
            <Field
              id="jira-jql"
              label="JQL filter (optional)"
              placeholder="labels = payments AND created >= -90d"
              autoComplete="off"
              spellCheck={false}
              value={jql}
              disabled={starting}
              onChange={(event) => {
                setJql(event.target.value);
                dropPreview();
              }}
            />
            <p className="text-xs text-text-faint">
              With projects ticked, the filter narrows each of them. With none
              ticked, it picks the issues on its own.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              id="jira-team"
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
            <SelectField
              id="jira-epics"
              label="Epics become"
              value={epicsAs}
              disabled={starting}
              onChange={(event) => {
                setEpicsAs(event.target.value as JiraEpicsAs);
                dropPreview();
              }}
            >
              <option value="projects">Projects</option>
              <option value="parents">Parent issues</option>
            </SelectField>
          </div>
          <p className="text-xs text-text-faint">
            Issue types and labels become labels, sprints become cycles,
            sub-tasks become sub-issues, issue links become relations and story
            points become estimates. People match by email, and anyone without
            an account here is shown by name. Running it again updates what it
            imported before.
          </p>
          <Button
            variant="secondary"
            size="sm"
            disabled={!canPreview}
            onClick={runPreview}
          >
            {previewing ? 'Previewing' : 'Preview import'}
          </Button>
        </div>
      )}

      {preview !== null && (
        <div className="space-y-4" aria-label="Import preview">
          {preview.map((project) => (
            <div key={rowKey(project)} className="space-y-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="text-sm font-medium text-text">
                  {project.name}
                </h3>
                <span className="text-xs text-text-faint">
                  {`${count(project.issue_count, 'issue')}, ${project.done_count} done`}
                </span>
              </div>
              <p className="text-xs text-text-muted">
                {[
                  project.estimate_field
                    ? `Estimates from ${project.estimate_field}`
                    : 'No story point field found',
                  project.sprint_field
                    ? `cycles from ${project.sprint_field}`
                    : 'no sprint field found',
                ].join(', ')}
              </p>
              {project.statuses.length === 0 ? (
                <p className="text-xs text-text-muted">
                  No statuses to map. Issues land in the team's default status.
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
                          overrides[rowKey(project)]?.[plan.source] ??
                          plan.status_id
                        }
                        disabled={starting}
                        onChange={(event) => {
                          onOverride(
                            rowKey(project),
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
            Issues in Jira's Done category always land in a completed status.
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

export default JiraImportForm;
