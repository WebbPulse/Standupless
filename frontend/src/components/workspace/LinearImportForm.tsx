/**
 * The Linear import form, laid out the way Linear's own importer is: paste a
 * personal API key, load the teams it can read, tick the ones to bring over,
 * point each at a new or an existing Standupless team, and start.
 *
 * The key lives only in this form's state until the start request carries it,
 * and is cleared as soon as the job is queued. Teams marked new are created
 * first, named and keyed after their Linear team, so the job only ever writes
 * into teams that exist.
 */

import React, { useState } from 'react';
import { LuDownload } from 'react-icons/lu';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { listLinearTeams, startLinearImport } from '../../api/imports';
import { createTeam } from '../../api/teams';
import { errorMessage } from '../../lib/errors';
import { teamsKey } from '../../lib/queryKeys';
import type {
  IssueImportRead,
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

/** One Linear team as the form holds it: whether it is ticked and where it goes. */
interface TeamChoice {
  selected: boolean;
  target: string;
}

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
  const [loading, setLoading] = useState(false);
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
              { selected: true, target: defaultTarget(team, teams) },
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
      [teamId]: {
        selected: current[teamId]?.selected ?? false,
        target: current[teamId]?.target ?? NEW_TEAM,
        ...change,
      },
    }));
  };

  const resolveTargets = async (): Promise<LinearTeamChoice[]> => {
    const resolved: LinearTeamChoice[] = [];
    let created = false;
    for (const team of chosen) {
      const target = choices[team.id]?.target ?? NEW_TEAM;
      if (target !== NEW_TEAM) {
        resolved.push({ linear_team_id: team.id, team_id: target });
        continue;
      }
      const made = await createTeam(workspaceId, {
        name: team.name,
        key_prefix: teamKeyFor(team.key),
      });
      created = true;
      setChoices((current) => ({
        ...current,
        [team.id]: { selected: true, target: made.id },
      }));
      resolved.push({ linear_team_id: team.id, team_id: made.id });
    }
    if (created) invalidateQueries(teamsKey(workspaceId));
    return resolved;
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
        onStarted(job);
      })
      .catch((reason: unknown) => {
        setError({ reason, fallback: 'Could not start the import.' });
      })
      .finally(() => {
        setStarting(false);
      });
  };

  const canStart =
    linearTeams !== null &&
    chosen.length > 0 &&
    badKeys.length === 0 &&
    !importing &&
    !starting;

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
                      disabled={!selected || starting}
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
            anyone without an account here is shown by name. Running it again
            updates what it imported before.
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
