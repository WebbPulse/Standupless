/**
 * A team's release pipeline: the ordered stages a release moves through and
 * the GitHub environments whose deployments mark each one reached.
 *
 * The stages are held as a draft and saved together, because the server
 * replaces the pipeline whole and a half edited order is not one a release
 * should be measured against. A renamed stage keeps its id, so the releases
 * that already reached it stay reached.
 */

import React, { useId, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { LuArrowDown, LuArrowUp, LuPlus, LuTrash2 } from 'react-icons/lu';
import { getReleasePipeline, updateReleasePipeline } from '../../api/releases';
import { errorMessage } from '../../lib/errors';
import { releasePipelineKey, releasesKey } from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import type { PipelineStageRead, PipelineStageWrite } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button, { IconButton } from '../ui/button';
import { Input } from '../ui/input';
import Spinner from '../ui/spinner';

/** Props for ReleasePipelineSection: which team, and whether the caller may edit. */
export interface ReleasePipelineSectionProps {
  workspaceId: string;
  teamId: string;
  /** Whether the caller administers the team. */
  canEdit: boolean;
}

/** How often the pipeline is re-read while the settings tab is open. */
const POLL_MS = 30000;

/** The most stages a pipeline holds. */
const MAX_STAGES = 10;

/** One stage as the draft holds it, with its environments as typed text. */
interface DraftStage {
  key: string;
  stageId: string | null;
  name: string;
  environments: string;
}

/** The environment names a comma separated field lists. */
const splitEnvironments = (text: string): string[] =>
  text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

/** The draft rows a saved pipeline starts from. */
const draftOf = (stages: PipelineStageRead[]): DraftStage[] =>
  stages.map((stage) => ({
    key: stage.stage_id,
    stageId: stage.stage_id,
    name: stage.name,
    environments: stage.github_environments.join(', '),
  }));

/** The body a draft saves as. */
const writeOf = (draft: DraftStage[]): PipelineStageWrite[] =>
  draft.map((row) => ({
    ...(row.stageId === null ? {} : { stage_id: row.stageId }),
    name: row.name.trim(),
    github_environments: splitEnvironments(row.environments),
  }));

/** Why a draft cannot be saved, or null when it can. */
const pipelineDraftError = (draft: DraftStage[]): string | null => {
  if (draft.length === 0) return 'A pipeline needs at least one stage.';
  if (draft.length > MAX_STAGES) {
    return `A pipeline holds at most ${String(MAX_STAGES)} stages.`;
  }
  const names = new Set<string>();
  const environments = new Set<string>();
  for (const row of draft) {
    const name = row.name.trim();
    if (name === '') return 'Every stage needs a name.';
    const folded = name.toLowerCase();
    if (names.has(folded)) return `Two stages are named ${name}.`;
    names.add(folded);
    for (const environment of splitEnvironments(row.environments)) {
      if (environments.has(environment)) {
        return `The ${environment} environment is mapped to two stages.`;
      }
      environments.add(environment);
    }
  }
  return null;
};

/** Whether a draft differs from the saved stages. */
const isDirty = (draft: DraftStage[], saved: PipelineStageRead[]): boolean =>
  JSON.stringify(writeOf(draft)) !== JSON.stringify(writeOf(draftOf(saved)));

/** Shows and edits a team's ordered release stages. */
export const ReleasePipelineSection: React.FC<ReleasePipelineSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
}) => {
  const auth = useQueryAuth();
  const prefix = useId();
  const queryKey = releasePipelineKey(workspaceId, teamId);
  const [draft, setDraft] = useState<DraftStage[] | null>(null);
  const [nextKey, setNextKey] = useState(0);

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getReleasePipeline(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const {
    mutate: save,
    error: saveError,
    isMutating: saving,
  } = useMutationWithRefetch(
    (stages: PipelineStageWrite[]) =>
      updateReleasePipeline(workspaceId, teamId, { stages }),
    [queryKey, releasesKey(workspaceId, teamId)]
  );

  const saved = data?.stages ?? [];
  const current = draft ?? draftOf(saved);
  const dirty = draft !== null && isDirty(draft, saved);
  const draftError = dirty ? pipelineDraftError(current) : null;
  const locked = !canEdit || saving;

  const edit = (index: number, patch: Partial<DraftStage>): void => {
    setDraft(
      current.map((row, at) => (at === index ? { ...row, ...patch } : row))
    );
  };

  const move = (index: number, to: number): void => {
    if (to < 0 || to >= current.length) return;
    const next = [...current];
    const [row] = next.splice(index, 1);
    if (row === undefined) return;
    next.splice(to, 0, row);
    setDraft(next);
  };

  const remove = (index: number): void => {
    setDraft(current.filter((_, at) => at !== index));
  };

  const add = (): void => {
    setDraft([
      ...current,
      {
        key: `new-${String(nextKey)}`,
        stageId: null,
        name: '',
        environments: '',
      },
    ]);
    setNextKey((held) => held + 1);
  };

  const onSave = async (): Promise<void> => {
    if (!dirty || locked || draftError !== null) return;
    try {
      await save(writeOf(current));
      await refetch();
      setDraft(null);
      showToast('Release pipeline saved.');
    } catch {
      return;
    }
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Releases</h3>
        <p className="text-sm text-text-muted">
          The stages a release moves through, in order. A successful GitHub
          deployment to an environment marks the matching stage reached.
          Releases with no pipeline land on Production.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the release pipeline.')}
        />
      )}
      {saveError !== null && (
        <ErrorAlert
          message={errorMessage(
            saveError,
            'Could not save the release pipeline.'
          )}
        />
      )}

      {isLoading && data === null ? (
        <Spinner label="Loading the release pipeline" />
      ) : (
        <div className="space-y-3">
          {data !== null && !data.configured && draft === null && (
            <p className="flex items-center gap-2 text-xs text-text-muted">
              <Badge tone="neutral">Default</Badge>
              Using the default pipeline
            </p>
          )}

          <ol className="rounded-md border border-line">
            {current.map((row, index) => {
              const nameId = `${prefix}-name-${row.key}`;
              const envId = `${prefix}-env-${row.key}`;
              return (
                <li
                  key={row.key}
                  className="flex min-h-row flex-wrap items-center gap-2 border-b border-line px-3 py-2 last:border-b-0 sm:flex-nowrap"
                  data-testid="pipeline-stage"
                >
                  <span className="w-5 shrink-0 text-xs text-text-faint tabular-nums">
                    {String(index + 1)}
                  </span>
                  <label htmlFor={nameId} className="sr-only">
                    {`Stage ${String(index + 1)} name`}
                  </label>
                  <Input
                    id={nameId}
                    className="sm:w-48"
                    value={row.name}
                    placeholder="Stage name"
                    maxLength={120}
                    readOnly={!canEdit}
                    disabled={saving}
                    onChange={(event) => {
                      edit(index, { name: event.target.value });
                    }}
                  />
                  <label htmlFor={envId} className="sr-only">
                    {`Stage ${String(index + 1)} GitHub environments`}
                  </label>
                  <Input
                    id={envId}
                    className="min-w-0 flex-1 font-mono"
                    value={row.environments}
                    placeholder={
                      canEdit
                        ? 'GitHub environments, comma separated'
                        : 'No environments'
                    }
                    readOnly={!canEdit}
                    disabled={saving}
                    onChange={(event) => {
                      edit(index, { environments: event.target.value });
                    }}
                  />
                  {canEdit && (
                    <span className="flex shrink-0 items-center">
                      <IconButton
                        label={`Move ${row.name || 'stage'} up`}
                        size="sm"
                        disabled={locked || index === 0}
                        onClick={() => {
                          move(index, index - 1);
                        }}
                      >
                        <LuArrowUp className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton
                        label={`Move ${row.name || 'stage'} down`}
                        size="sm"
                        disabled={locked || index === current.length - 1}
                        onClick={() => {
                          move(index, index + 1);
                        }}
                      >
                        <LuArrowDown className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton
                        label={`Remove ${row.name || 'stage'}`}
                        size="sm"
                        disabled={locked || current.length === 1}
                        onClick={() => {
                          remove(index);
                        }}
                      >
                        <LuTrash2 className="h-3.5 w-3.5" />
                      </IconButton>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>

          <ErrorAlert message={draftError} />

          {canEdit && (
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={locked || current.length >= MAX_STAGES}
                onClick={add}
              >
                <LuPlus aria-hidden="true" />
                Add stage
              </Button>
              <div className="flex gap-2">
                {dirty && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() => {
                      setDraft(null);
                    }}
                  >
                    Discard
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!dirty || saving || draftError !== null}
                  onClick={() => {
                    void onSave();
                  }}
                >
                  {saving ? 'Saving' : 'Save'}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default ReleasePipelineSection;
