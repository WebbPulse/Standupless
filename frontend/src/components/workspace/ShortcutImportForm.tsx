/**
 * The Shortcut import form: paste an API token, load the teams it can read,
 * tick the ones to bring over, point each at a new or an existing Standupless
 * team, preview what would come across, and start.
 *
 * The token lives only in this form's state until a request carries it, and is
 * cleared as soon as the job is queued. Teams marked new are created before the
 * preview or the start, named and keyed after their Shortcut team, because both
 * read the statuses and labels of the team each Shortcut team lands in.
 */

import React, { useState } from 'react';
import { LuDownload, LuEye } from 'react-icons/lu';
import { invalidateQueries } from '@webbpulse/api-client/react';
import {
  listShortcutTeams,
  previewShortcutImport,
  startShortcutImport,
} from '../../api/imports';
import { createTeam } from '../../api/teams';
import { errorMessage } from '../../lib/errors';
import { teamsKey } from '../../lib/queryKeys';
import type {
  IssueImportRead,
  ShortcutImportPreviewRead,
  ShortcutPreviewTeamRead,
  ShortcutTeamChoice,
  ShortcutTeamRead,
  TeamRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import Field from '../ui/field';
import { LINK_CLASS } from '../ui/link';
import { Select } from '../ui/select';

/** Props for ShortcutImportForm: the workspace, its teams and the hook that starts a job. */
export interface ShortcutImportFormProps {
  workspaceId: string;
  teams: TeamRead[];
  /** Whether another import is still running, which the server would refuse. */
  importing: boolean;
  /** Called with the queued job so the caller can refresh its list. */
  onStarted: (job: IssueImportRead) => void;
}

/** The target value that means a new team is created for a Shortcut team. */
const NEW_TEAM = 'new';

/** Where Shortcut lists a member's API tokens. */
const SHORTCUT_TOKENS_URL =
  'https://app.shortcut.com/settings/account/api-tokens';

/** The pattern a Standupless team key must match. */
const TEAM_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,5}$/;

/** One Shortcut team as the form holds it: whether it is ticked and where it goes. */
interface TeamChoice {
  selected: boolean;
  target: string;
}

/** The Standupless key a new team takes from a Shortcut team's mention name. */
const teamKeyFor = (mentionName: string): string =>
  mentionName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);

/** The existing team a Shortcut team lands in by default: the one with its key, if any. */
const defaultTarget = (team: ShortcutTeamRead, teams: TeamRead[]): string =>
  teams.find((t) => t.key_prefix === teamKeyFor(team.key))?.id ?? NEW_TEAM;

/** Says how many of a thing there are, with the plural when it needs one. */
const count = (n: number, noun: string, plural = `${noun}s`): string =>
  `${n} ${n === 1 ? noun : plural}`;

/** The line a previewed team reads as, listing what it would bring over. */
const previewLine = (team: ShortcutPreviewTeamRead): string => {
  const stories = count(team.stories, 'story', 'stories');
  const parts = [
    team.stories_capped ? `${stories} or more` : stories,
    count(team.epics, 'epic'),
    count(team.iterations, 'iteration'),
  ];
  if (team.new_labels.length > 0)
    parts.push(count(team.new_labels.length, 'new label'));
  return parts.join(', ');
};

/** The line saying how story owners match members. */
const ownerLine = (team: ShortcutPreviewTeamRead): string => {
  const parts = [`${count(team.matched_owners, 'owner')} matched by email`];
  if (team.unmatched_owners > 0)
    parts.push(
      `${team.unmatched_owners} without an account here, left unassigned`
    );
  return parts.join(', ');
};

/** Reads Shortcut teams with a pasted token, previews and starts an import of the chosen ones. */
export const ShortcutImportForm: React.FC<ShortcutImportFormProps> = ({
  workspaceId,
  teams,
  importing,
  onStarted,
}) => {
  const [apiToken, setApiToken] = useState('');
  const [shortcutTeams, setShortcutTeams] = useState<ShortcutTeamRead[] | null>(
    null
  );
  const [choices, setChoices] = useState<Record<string, TeamChoice>>({});
  const [preview, setPreview] = useState<ShortcutImportPreviewRead | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<{
    reason: unknown;
    fallback: string;
  } | null>(null);

  const chosen = (shortcutTeams ?? []).filter(
    (team) => choices[team.id]?.selected === true
  );
  const badKeys = chosen.filter(
    (team) =>
      choices[team.id]?.target === NEW_TEAM &&
      !TEAM_KEY_PATTERN.test(teamKeyFor(team.key))
  );
  const newTeams = chosen.filter(
    (team) => choices[team.id]?.target === NEW_TEAM
  );

  const onToken = (value: string): void => {
    setApiToken(value);
    setShortcutTeams(null);
    setChoices({});
    setPreview(null);
    setError(null);
  };

  const onLoad = (): void => {
    setLoading(true);
    setError(null);
    setPreview(null);
    void listShortcutTeams(workspaceId, apiToken.trim())
      .then((found) => {
        setShortcutTeams(found);
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
        setShortcutTeams(null);
        setError({ reason, fallback: 'Could not read teams from Shortcut.' });
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const update = (teamId: string, change: Partial<TeamChoice>): void => {
    setPreview(null);
    setChoices((current) => ({
      ...current,
      [teamId]: {
        selected: current[teamId]?.selected ?? false,
        target: current[teamId]?.target ?? NEW_TEAM,
        ...change,
      },
    }));
  };

  const resolveTargets = async (): Promise<ShortcutTeamChoice[]> => {
    const resolved: ShortcutTeamChoice[] = [];
    let created = false;
    for (const team of chosen) {
      const target = choices[team.id]?.target ?? NEW_TEAM;
      if (target !== NEW_TEAM) {
        resolved.push({ shortcut_team_id: team.id, team_id: target });
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
      resolved.push({ shortcut_team_id: team.id, team_id: made.id });
    }
    if (created) invalidateQueries(teamsKey(workspaceId));
    return resolved;
  };

  const onPreview = (): void => {
    setPreviewing(true);
    setError(null);
    void resolveTargets()
      .then((resolved) =>
        previewShortcutImport(workspaceId, {
          api_token: apiToken.trim(),
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
        startShortcutImport(workspaceId, {
          api_token: apiToken.trim(),
          teams: resolved,
        })
      )
      .then((job) => {
        setApiToken('');
        setShortcutTeams(null);
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
    shortcutTeams !== null &&
    chosen.length > 0 &&
    badKeys.length === 0 &&
    !busy;
  const canStart = canPreview && preview !== null && !importing;
  const teamName = (teamId: string): string =>
    teams.find((t) => t.id === teamId)?.name ?? 'the new team';

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Field
          id="shortcut-api-token"
          label="Shortcut API token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiToken}
          onChange={(event) => {
            onToken(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && apiToken.trim() !== '' && !loading) {
              event.preventDefault();
              onLoad();
            }
          }}
        />
        <p className="text-xs text-text-faint">
          Generate an API token in{' '}
          <a
            href={SHORTCUT_TOKENS_URL}
            target="_blank"
            rel="noreferrer"
            className={LINK_CLASS}
          >
            Shortcut API token settings
          </a>
          . It is used for this import only, kept sealed while the import runs
          and deleted when it ends.
        </p>
        <Button
          variant="secondary"
          size="sm"
          disabled={apiToken.trim() === '' || loading}
          onClick={onLoad}
        >
          {loading ? 'Loading teams' : 'Load teams'}
        </Button>
      </div>

      {shortcutTeams !== null && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-text-muted">
            Teams to import
          </h3>
          {shortcutTeams.length === 0 ? (
            <p className="text-sm text-text-muted">
              This token cannot read any teams.
            </p>
          ) : (
            <ul className="rounded-md border border-line" aria-label="Teams">
              {shortcutTeams.map((team) => {
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
                  </li>
                );
              })}
            </ul>
          )}
          {badKeys.length > 0 && (
            <p className="text-xs text-danger">
              {`${badKeys.map((team) => team.name).join(', ')} needs an existing team: its Shortcut mention name does not fit a Standupless team key.`}
            </p>
          )}
          <p className="text-xs text-text-faint">
            Stories, comments, labels, owners, estimates, epics as projects and
            iterations as cycles come across, with sub-task stories as
            sub-issues and story links as relations. Owners match by email.
            Running it again updates what it imported before.
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
                key={team.shortcut_team_id}
                className="space-y-1 border-b border-line px-3 py-2 text-sm last:border-b-0"
              >
                <p className="font-medium text-text">
                  {`${team.name} to ${teamName(team.team_id)}`}
                </p>
                <p className="text-text-muted">{previewLine(team)}</p>
                <p className="text-xs text-text-faint">{ownerLine(team)}</p>
                {team.statuses.length > 0 && (
                  <p className="text-xs text-text-faint">
                    {team.statuses
                      .map(
                        (status) =>
                          `${status.source} becomes ${status.status_name}`
                      )
                      .join(', ')}
                  </p>
                )}
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
          {previewing ? 'Previewing' : 'Preview import'}
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
                : `Import ${count(chosen.length, 'team')}`}
        </Button>
      </div>

      {error !== null && (
        <ErrorAlert message={errorMessage(error.reason, error.fallback)} />
      )}
    </div>
  );
};

export default ShortcutImportForm;
