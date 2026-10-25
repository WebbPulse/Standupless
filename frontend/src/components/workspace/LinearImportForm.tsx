/**
 * The Linear import form, laid out the way Linear's own importer is: paste a
 * personal API key, load the teams it can read, tick the ones to bring over,
 * point each at a new or an existing Standupless team, choose per team whether
 * to create the statuses it lacks and bring its issue templates over, preview
 * what those would add, and start.
 *
 * The key lives only in this form's state until the start request carries it,
 * and is cleared as soon as the job is queued. Teams marked new are created
 * first, named and keyed after their Linear team, so the preview and the job
 * only ever read and write teams that exist.
 */

import React, { useState } from 'react';
import { LuDownload, LuEye } from 'react-icons/lu';
import { invalidateQueries } from '@webbpulse/api-client/react';
import {
  listLinearTeams,
  previewLinearImport,
  startLinearImport,
} from '../../api/imports';
import { createTeam } from '../../api/teams';
import { errorMessage } from '../../lib/errors';
import { teamsKey } from '../../lib/queryKeys';
import type {
  IssueImportRead,
  LinearImportPreviewRead,
  LinearPreviewTeamRead,
  LinearTeamChoice,
  LinearTeamRead,
  TeamRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import Field from '../ui/field';
import { LINK_CLASS } from '../ui/link';
import { Select } from '../ui/select';

/** Props for LinearImportForm: the workspace, its teams and the hook that starts a job. */
export interface LinearImportFormProps {
  workspaceId: string;
  teams: TeamRead[];
  /** Whether another import is still running, which the server would refuse. */
  importing: boolean;
  /** Called with the queued job so the caller can refresh its list. */
  onStarted: (job: IssueImportRead) => void;
}

/** The target value that means a new team is created for a Linear team. */
const NEW_TEAM = 'new';

/** Where Linear lists a member's personal API keys. */
const LINEAR_KEYS_URL = 'https://linear.app/settings/account/security';

/** The pattern a Standupless team key must match. */
const TEAM_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,5}$/;

/** One Linear team as the form holds it: whether it is ticked, where it goes and its optional phases. */
interface TeamChoice {
  selected: boolean;
  target: string;
  createStatuses: boolean;
  importTemplates: boolean;
}

/** A choice for a team nobody has touched yet. */
const blankChoice = (target: string): TeamChoice => ({
  selected: false,
  target,
  createStatuses: false,
  importTemplates: false,
});

/** The Standupless key a new team takes from a Linear team's key. */
const teamKeyFor = (linearKey: string): string =>
  linearKey
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);

/** The existing team a Linear team lands in by default: the one with its key, if any. */
const defaultTarget = (team: LinearTeamRead, teams: TeamRead[]): string =>
  teams.find((t) => t.key_prefix === teamKeyFor(team.key))?.id ?? NEW_TEAM;

/** Says how many teams there are, with the plural when it needs one. */
const teamCount = (n: number): string => `${n} team${n === 1 ? '' : 's'}`;

/** Says how many of a thing there are, with the plural when it needs one. */
const count = (n: number, noun: string, plural = `${noun}s`): string =>
  `${n} ${n === 1 ? noun : plural}`;

/** The lines a previewed team reads as: the statuses and templates it would gain. */
const previewLines = (team: LinearPreviewTeamRead): string[] => [
  team.status_count === 0
    ? 'Has a status for every Linear state'
    : `${count(team.status_count, 'new status', 'new statuses')}: ${team.new_statuses.join(', ')}`,
  team.template_count === 0
    ? 'No issue templates to bring over'
    : `${count(team.template_count, 'issue template')}: ${team.new_templates.join(', ')}`,
];

/** Reads Linear teams with a pasted key and starts an import of the chosen ones. */
export const LinearImportForm: React.FC<LinearImportFormProps> = ({
  workspaceId,
  teams,
  importing,
  onStarted,
}) => {
  const [apiKey, setApiKey] = useState('');
  const [linearTeams, setLinearTeams] = useState<LinearTeamRead[] | null>(null);
  const [choices, setChoices] = useState<Record<string, TeamChoice>>({});
  const [preview, setPreview] = useState<LinearImportPreviewRead | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<{
    reason: unknown;
    fallback: string;
  } | null>(null);

  const chosen = (linearTeams ?? []).filter(
    (team) => choices[team.id]?.selected === true
  );
  const badKeys = chosen.filter(
    (team) =>
      choices[team.id]?.target === NEW_TEAM &&
      !TEAM_KEY_PATTERN.test(teamKeyFor(team.key))
  );

  const onKey = (value: string): void => {
    setApiKey(value);
    setLinearTeams(null);
    setChoices({});
    setPreview(null);
    setError(null);
  };

  const onLoad = (): void => {
    setLoading(true);
    setError(null);
    void listLinearTeams(workspaceId, apiKey.trim())
      .then((found) => {
        setLinearTeams(found);
        setChoices(
          Object.fromEntries(
            found.map((team) => [
              team.id,
              { ...blankChoice(defaultTarget(team, teams)), selected: true },
            ])
          )
        );
      })
      .catch((reason: unknown) => {
        setLinearTeams(null);
        setError({ reason, fallback: 'Could not read teams from Linear.' });
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const update = (teamId: string, change: Partial<TeamChoice>): void => {
    setChoices((current) => ({
      ...current,
      [teamId]: { ...(current[teamId] ?? blankChoice(NEW_TEAM)), ...change },
    }));
    setPreview(null);
  };

  const resolveTargets = async (): Promise<LinearTeamChoice[]> => {
    const resolved: LinearTeamChoice[] = [];
    let created = false;
    for (const team of chosen) {
      const choice = choices[team.id] ?? blankChoice(NEW_TEAM);
      const flags = {
        create_statuses: choice.createStatuses,
        import_templates: choice.importTemplates,
      };
      if (choice.target !== NEW_TEAM) {
        resolved.push({
          linear_team_id: team.id,
          team_id: choice.target,
          ...flags,
        });
        continue;
      }
      const made = await createTeam(workspaceId, {
        name: team.name,
        key_prefix: teamKeyFor(team.key),
      });
      created = true;
      setChoices((current) => ({
        ...current,
        [team.id]: { ...choice, selected: true, target: made.id },
      }));
      resolved.push({ linear_team_id: team.id, team_id: made.id, ...flags });
    }
    if (created) invalidateQueries(teamsKey(workspaceId));
    return resolved;
  };

  const onPreview = (): void => {
    setPreviewing(true);
    setError(null);
    void resolveTargets()
      .then((resolved) =>
        previewLinearImport(workspaceId, {
          api_key: apiKey.trim(),
          teams: resolved,
        })
      )
      .then(setPreview)
      .catch((reason: unknown) => {
        setPreview(null);
        setError({ reason, fallback: 'Could not preview the import.' });
      })
      .finally(() => {
        setPreviewing(false);
      });
  };

  const onStart = (): void => {
    setStarting(true);
    setError(null);
    void resolveTargets()
      .then((resolved) =>
        startLinearImport(workspaceId, {
          api_key: apiKey.trim(),
          teams: resolved,
        })
      )
      .then((job) => {
        setApiKey('');
        setLinearTeams(null);
        setChoices({});
        setPreview(null);
        onStarted(job);
      })
      .catch((reason: unknown) => {
        setError({ reason, fallback: 'Could not start the import.' });
      })
      .finally(() => {
        setStarting(false);
      });
  };

  const busy = previewing || starting;
  const canPreview =
    linearTeams !== null && chosen.length > 0 && badKeys.length === 0 && !busy;
  const canStart = canPreview && !importing;
  const teamName = (teamId: string): string =>
    teams.find((t) => t.id === teamId)?.name ?? 'the new team';
  const newTeams = chosen.filter(
    (team) => choices[team.id]?.target === NEW_TEAM
  );

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Field
          id="linear-api-key"
          label="Linear API key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="lin_api_..."
          value={apiKey}
          onChange={(event) => {
            onKey(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && apiKey.trim() !== '' && !loading) {
              event.preventDefault();
              onLoad();
            }
          }}
        />
        <p className="text-xs text-text-faint">
          Create a personal API key with read access in{' '}
          <a
            href={LINEAR_KEYS_URL}
            target="_blank"
            rel="noreferrer"
            className={LINK_CLASS}
          >
            Linear security settings
          </a>
          . It is used for this import only, kept sealed while the import runs
          and deleted when it ends.
        </p>
        <Button
          variant="secondary"
          size="sm"
          disabled={apiKey.trim() === '' || loading}
          onClick={onLoad}
        >
          {loading ? 'Loading teams' : 'Load teams'}
        </Button>
      </div>

      {linearTeams !== null && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-text-muted">
            Teams to import
          </h3>
          {linearTeams.length === 0 ? (
            <p className="text-sm text-text-muted">
              This key cannot read any teams.
            </p>
          ) : (
            <ul className="rounded-md border border-line" aria-label="Teams">
              {linearTeams.map((team) => {
                const choice = choices[team.id];
                const selected = choice?.selected === true;
                return (
                  <li
                    key={team.id}
                    className="flex min-h-row flex-wrap items-center gap-3 border-b border-line px-3 py-1.5 last:border-b-0"
                  >
                    <Checkbox
                      className="min-w-0 flex-1"
                      checked={selected}
                      onChange={(event) => {
                        update(team.id, { selected: event.target.checked });
                      }}
                      label={
                        <span className="min-w-0 truncate">
                          {team.name}
                          <span className="ml-2 font-mono text-2xs text-text-faint">
                            {team.key}
                          </span>
                        </span>
                      }
                    />
                    <span className="text-text-faint" aria-hidden="true">
                      to
                    </span>
                    <Select
                      aria-label={`Standupless team for ${team.name}`}
                      className="w-auto min-w-40"
                      value={choice?.target ?? NEW_TEAM}
                      disabled={!selected || busy}
                      onChange={(event) => {
                        update(team.id, { target: event.target.value });
                      }}
                    >
                      <option value={NEW_TEAM}>
                        {`New team ${teamKeyFor(team.key)}`}
                      </option>
                      {teams.map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.name}
                        </option>
                      ))}
                    </Select>
                    {selected && (
                      <div className="flex basis-full flex-wrap gap-x-5 gap-y-1 pl-6">
                        <Checkbox
                          className="text-xs text-text-muted"
                          aria-label={`Create missing statuses for ${team.name}`}
                          checked={choice?.createStatuses === true}
                          disabled={busy}
                          onChange={(event) => {
                            update(team.id, {
                              createStatuses: event.target.checked,
                            });
                          }}
                          label="Create missing statuses"
                        />
                        <Checkbox
                          className="text-xs text-text-muted"
                          aria-label={`Import issue templates for ${team.name}`}
                          checked={choice?.importTemplates === true}
                          disabled={busy}
                          onChange={(event) => {
                            update(team.id, {
                              importTemplates: event.target.checked,
                            });
                          }}
                          label="Import issue templates"
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {badKeys.length > 0 && (
            <p className="text-xs text-danger">
              {`${badKeys.map((team) => team.name).join(', ')} needs an existing team: its Linear key does not fit a Standupless team key.`}
            </p>
          )}
          <p className="text-xs text-text-faint">
            Issues, comments, labels, cycles, projects with their milestones and
            updates, and initiatives come across. People match by email, and
            anyone without an account here is shown by name. Issues in a Linear
            state the team has no status for land in the closest category,
            unless you create the missing statuses. Running it again updates
            what it imported before.
            {newTeams.length > 0 &&
              ' Previewing creates the new teams first, so the preview can read their statuses.'}
          </p>
        </div>
      )}

      {preview !== null && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-text-muted">Preview</h3>
          <ul className="rounded-md border border-line" aria-label="Preview">
            {preview.teams.map((team) => (
              <li
                key={team.linear_team_id}
                className="space-y-1 border-b border-line px-3 py-2 text-sm last:border-b-0"
              >
                <p className="font-medium text-text">
                  {`${team.name} to ${teamName(team.team_id)}`}
                </p>
                {previewLines(team).map((line) => (
                  <p key={line} className="text-text-muted">
                    {line}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={!canPreview}
          onClick={onPreview}
        >
          <LuEye aria-hidden="true" className="h-3.5 w-3.5" />
          {previewing ? 'Previewing' : 'Preview'}
        </Button>
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
                : `Import ${teamCount(chosen.length)}`}
        </Button>
      </div>

      {error !== null && (
        <ErrorAlert message={errorMessage(error.reason, error.fallback)} />
      )}
    </div>
  );
};

export default LinearImportForm;
