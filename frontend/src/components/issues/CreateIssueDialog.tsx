/**
 * The new issue dialog. The title and description come first because they
 * are what a person arrives with, and every other property sits in a row of
 * chips underneath that can be left alone: the server allocates the key and
 * defaults the status to the lowest position backlog one, so filing something
 * never waits on deciding where it belongs.
 *
 * The keyboard carries the whole flow. Cmd or Ctrl and Enter files the issue,
 * Escape closes, and typed text is guarded so a stray Escape does not throw a
 * paragraph away. "Create more" keeps the dialog open with the chosen
 * properties held, for filing a run of related issues in one sitting.
 *
 * A template prefills the draft. The team's default is applied as the dialog
 * opens and fills only what the caller did not preset, and picking one in the
 * header starts the draft over from that template. The fields stay editable
 * and the dialog sends what they hold, never the template id, so a field the
 * person clears stays cleared.
 */

import React, {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { createIssue, createLink } from '../../api/issues';
import { listTeamTemplates } from '../../api/templates';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import { useAutoGrow } from '../../hooks/useAutoGrow';
import { useTeamOptions } from '../../hooks/useTeamOptions';
import { canWriteIssues } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import type { Assignable } from '../../lib/issuePeople';
import {
  templatePrefill,
  type TemplatePrefill,
} from '../../lib/issueTemplates';
import { templatesKey } from '../../lib/queryKeys';
import { sortStatuses } from '../../lib/propertyOptions';
import { issuePath } from '../../lib/paths';
import { submitKeysLabel } from '../../lib/platform';
import { showToast } from '../../lib/toast';
import {
  estimateOptionsOf,
  validateDateRange,
  validateTitle,
  type EstimateOptions,
} from '../../lib/validation';
import type {
  EstimateScale,
  IssueCreate,
  IssuePriority,
  IssueRead,
  LabelRead,
  StatusRead,
  SimilarIssueRead,
  TeamRead,
  TemplateListRead,
  TemplateRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import { Combobox, type ComboboxOption } from '../ui/combobox';
import Dialog from '../ui/dialog';
import { Popover } from '../ui/popover';
import {
  AssigneePicker,
  CyclePicker,
  DatePicker,
  EstimatePicker,
  LabelsPicker,
  PriorityPicker,
  ProjectPicker,
  StatusPicker,
} from './PropertyPickers';
import { useTeams } from '../../hooks/useTeams';
import { SimilarIssues, useSimilarIssues } from './SimilarIssues';
import { teamTree } from '../../lib/teamOrder';
import { TemplatePicker } from './TemplatePicker';

/** Props for CreateIssueDialog: where the issue lands and what it may carry. */
export interface CreateIssueDialogProps {
  workspaceId: string;
  teamId: string;
  estimateScale: EstimateScale;
  /** The home team's extended and zero toggles. Defaults to neither. */
  estimateOptions?: EstimateOptions;
  statuses: StatusRead[];
  labels: LabelRead[];
  people: Assignable[];
  /**
   * Called with the created issue when the dialog is done, so the caller can
   * close it and re-read its list. With "Create more" on, this is called once
   * on close with the last issue filed.
   */
  onCreated: (issue: IssueRead) => void;
  onClose: () => void;
  /** Called with each issue filed while "Create more" keeps the dialog open. */
  onCreatedMore?: (issue: IssueRead) => void;
  /** Lists the signed in person first in the assignee picker. */
  currentUserId?: string;
  /** The starting team's name, shown before the team list has loaded. */
  teamName?: string;
  /** Properties the draft starts on, such as the status column it was opened from. */
  preset?: CreateIssuePreset;
}

/** What a caller may start a draft on. Each is dropped if the team changes. */
export interface CreateIssuePreset {
  statusId?: string;
  assigneeId?: string;
  projectId?: string;
  cycleId?: string;
  parentId?: string;
  /** The parent's key, shown in the header so the person sees where it lands. */
  parentKey?: string;
  /** The template the draft starts from, in place of the team's default. */
  templateId?: string;
}

/** The properties a draft holds, all of them team scoped except the last. */
interface Draft {
  statusId: string;
  assigneeId: string | null;
  labelIds: string[];
  estimate: string | null;
  projectId: string | null;
  projectMilestoneId: string | null;
  cycleId: string | null;
  priority: IssuePriority;
  startDate: string | null;
  dueDate: string | null;
  parentId: string | null;
}

const EMPTY_DRAFT: Draft = {
  statusId: '',
  assigneeId: null,
  labelIds: [],
  estimate: null,
  projectId: null,
  projectMilestoneId: null,
  cycleId: null,
  priority: 'none',
  startDate: null,
  dueDate: null,
  parentId: null,
};

/** The draft a preset starts from. */
const presetDraft = (preset: CreateIssuePreset | undefined): Draft => ({
  ...EMPTY_DRAFT,
  statusId: preset?.statusId ?? '',
  assigneeId: preset?.assigneeId ?? null,
  projectId: preset?.projectId ?? null,
  cycleId: preset?.cycleId ?? null,
  parentId: preset?.parentId ?? null,
});

/** The team scoped half of a draft, cleared when the team changes. */
const clearTeamScoped = (draft: Draft): Draft => ({
  ...draft,
  statusId: '',
  assigneeId: null,
  labelIds: [],
  estimate: null,
  projectId: null,
  projectMilestoneId: null,
  cycleId: null,
  parentId: null,
});

/** The draft with a template's properties filled into what is still unset. */
const withTemplate = (draft: Draft, fill: TemplatePrefill): Draft => {
  const project =
    draft.projectId === null
      ? {
          projectId: fill.projectId ?? null,
          projectMilestoneId: fill.projectMilestoneId ?? null,
        }
      : {};
  return {
    ...draft,
    ...project,
    statusId: draft.statusId === '' ? (fill.statusId ?? '') : draft.statusId,
    priority:
      draft.priority === 'none' ? (fill.priority ?? 'none') : draft.priority,
    assigneeId: draft.assigneeId ?? fill.assigneeId ?? null,
    labelIds:
      draft.labelIds.length === 0 ? (fill.labelIds ?? []) : draft.labelIds,
    estimate: draft.estimate ?? fill.estimate ?? null,
    cycleId: draft.cycleId ?? fill.cycleId ?? null,
  };
};

/** The title and description a template wrote, compared to spot edits. */
interface TemplateText {
  title: string;
  body: string;
}

const NO_TEXT: TemplateText = { title: '', body: '' };

/** A template list tagged with the team it was read for. */
interface TeamTemplates extends TemplateListRead {
  teamId: string;
}

/** How often the dialog re-reads the team's templates while open. */
const TEMPLATES_POLL_MS = 60000;

/** Builds the create body, leaving out every field still at its default. */
const toPayload = (
  teamId: string,
  title: string,
  body: string,
  draft: Draft
): IssueCreate => ({
  team_id: teamId,
  title: title.trim(),
  ...(body.trim() === '' ? {} : { body }),
  ...(draft.statusId === '' ? {} : { status_id: draft.statusId }),
  ...(draft.priority === 'none' ? {} : { priority: draft.priority }),
  ...(draft.assigneeId === null ? {} : { assignee_id: draft.assigneeId }),
  ...(draft.labelIds.length === 0 ? {} : { label_ids: draft.labelIds }),
  ...(draft.estimate === null ? {} : { estimate: draft.estimate }),
  ...(draft.startDate === null ? {} : { start_date: draft.startDate }),
  ...(draft.dueDate === null ? {} : { due_date: draft.dueDate }),
  ...(draft.projectId === null ? {} : { project_id: draft.projectId }),
  ...(draft.projectMilestoneId === null
    ? {}
    : { project_milestone_id: draft.projectMilestoneId }),
  ...(draft.cycleId === null ? {} : { cycle_id: draft.cycleId }),
  ...(draft.parentId === null ? {} : { parent_id: draft.parentId }),
});

/** Props for TeamSwitcher: the teams a person may file into and the choice. */
interface TeamSwitcherProps {
  teams: TeamRead[];
  value: string;
  fallbackName: string;
  onChange: (team: TeamRead) => void;
}

/**
 * The chip in the header naming the team the issue lands in. It opens a
 * list when there is more than one team the person may write to, and is a
 * plain label otherwise.
 */
const TeamSwitcher: React.FC<TeamSwitcherProps> = ({
  teams,
  value,
  fallbackName,
  onChange,
}) => {
  const current = teams.find((team) => team.id === value);
  const name = current?.name ?? fallbackName;
  const options: ComboboxOption[] = teamTree(teams).map(
    ({ team, nested, parentName }) => ({
      value: team.id,
      label: team.name,
      detail: team.key_prefix,
      keywords: [
        team.key_prefix,
        ...(parentName === undefined ? [] : [parentName]),
      ],
      indent: nested,
    })
  );
  const chip =
    'inline-flex h-6 max-w-48 items-center gap-1.5 truncate rounded-sm border border-line px-2 text-xs text-text-muted';
  if (teams.length < 2) {
    return <span className={chip}>{name}</span>;
  }
  return (
    <Popover
      label="Team"
      contentClassName="w-64"
      trigger={(trigger) => (
        <button
          type="button"
          aria-label={`Team: ${name}`}
          {...trigger}
          className={cn(chip, 'hover:border-line-strong hover:bg-raised')}
        >
          {name}
        </button>
      )}
    >
      {(close) => (
        <Combobox
          label="Team"
          placeholder="Move to team"
          options={options}
          selected={[value]}
          onSelect={(picked) => {
            close();
            const team = teams.find((item) => item.id === picked);
            if (team !== undefined && team.id !== value) onChange(team);
          }}
        />
      )}
    </Popover>
  );
};

/** A dialog holding the form for one new issue. */
export const CreateIssueDialog: React.FC<CreateIssueDialogProps> = ({
  workspaceId,
  teamId,
  estimateScale,
  estimateOptions,
  statuses,
  labels,
  people,
  onCreated,
  onClose,
  onCreatedMore,
  currentUserId,
  teamName,
  preset,
}) => {
  const workspace = useContext(WorkspaceContext)?.workspace ?? null;
  const auth = useQueryAuth();
  const [activeTeamId, setActiveTeamId] = useState(teamId);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [templateText, setTemplateText] = useState<TemplateText>(NO_TEXT);
  const pendingTemplate = useRef<{ teamId: string; id: string | null } | null>({
    teamId,
    id: preset?.templateId ?? null,
  });
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState<Draft>(() => presetDraft(preset));
  const [createMore, setCreateMore] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const [lastCreated, setLastCreated] = useState<IssueRead | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<SimilarIssueRead | null>(null);
  const similar = useSimilarIssues(workspaceId, title);
  const shownSimilar =
    duplicateOf === null ||
    similar.some((issue) => issue.issue_id === duplicateOf.issue_id)
      ? similar
      : [duplicateOf, ...similar];
  const titleInput = useRef<HTMLInputElement>(null);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(bodyInput, 320);

  const { data: teams } = useTeams();
  const writable = (teams ?? []).filter((team) =>
    canWriteIssues(workspace?.role, team.role)
  );
  const activeTeam = teams?.find((team) => team.id === activeTeamId);
  const options = useTeamOptions(workspaceId, activeTeamId, { planning: true });
  const onHomeTeam = activeTeamId === teamId;
  const teamStatuses =
    onHomeTeam && statuses.length > 0 ? statuses : options.statuses;
  const teamLabels = onHomeTeam && labels.length > 0 ? labels : options.labels;
  const teamPeople = onHomeTeam && people.length > 0 ? people : options.people;
  const scale = onHomeTeam
    ? estimateScale
    : (activeTeam?.estimate_scale ?? 'off');
  const scaleOptions = onHomeTeam
    ? (estimateOptions ?? {})
    : estimateOptionsOf(activeTeam);
  const defaultStatus =
    sortStatuses(teamStatuses).find(
      (status) => status.category === 'backlog'
    ) ?? sortStatuses(teamStatuses)[0];

  const titleError = validateTitle(title);
  const dateError = validateDateRange(
    draft.startDate ?? '',
    draft.dueDate ?? ''
  );
  const canSubmit =
    title.trim() !== '' &&
    titleError === null &&
    dateError === null &&
    !isSaving;
  const dirty =
    title.trim() !== templateText.title.trim() ||
    body.trim() !== templateText.body.trim();

  const { data: templateList } = usePolledQuery(
    async ({ signal }): Promise<TeamTemplates> => ({
      ...(await listTeamTemplates(workspaceId, activeTeamId, signal)),
      teamId: activeTeamId,
    }),
    {
      intervalMs: TEMPLATES_POLL_MS,
      queryKey: [...templatesKey(activeTeamId), 'picker'],
      auth,
    }
  );
  const templates =
    templateList?.teamId === activeTeamId ? templateList.templates : [];

  const prefillOf = (template: TemplateRead): TemplatePrefill =>
    templatePrefill(template, {
      statuses: teamStatuses,
      labels: teamLabels,
      people: teamPeople,
    });

  const applyTemplate = (template: TemplateRead | null): void => {
    const fill: TemplatePrefill = template === null ? {} : prefillOf(template);
    const text = { title: fill.title ?? '', body: fill.body ?? '' };
    const base = onHomeTeam ? presetDraft(preset) : EMPTY_DRAFT;
    setTemplateId(template?.id ?? null);
    setDraft(withTemplate(base, fill));
    if (title.trim() === '' || title === templateText.title) {
      setTitle(text.title);
    }
    if (body.trim() === '' || body === templateText.body) {
      setBody(text.body);
    }
    setTemplateText(text);
    setConfirming(false);
  };

  useEffect(() => {
    const pending = pendingTemplate.current;
    if (pending === null || pending.teamId !== activeTeamId) return;
    if (templateList === null || templateList.teamId !== activeTeamId) return;
    pendingTemplate.current = null;
    const id = pending.id ?? templateList.default_template_id;
    const template = templateList.templates.find((item) => item.id === id);
    if (template === undefined) return;
    const fill = templatePrefill(template, {
      statuses: teamStatuses,
      labels: teamLabels,
      people: teamPeople,
    });
    const text = { title: fill.title ?? '', body: fill.body ?? '' };
    setTemplateId(template.id);
    setTemplateText(text);
    setDraft((held) => withTemplate(held, fill));
    setTitle((held) => (held.trim() === '' ? text.title : held));
    setBody((held) => (held.trim() === '' ? text.body : held));
  }, [activeTeamId, templateList, teamStatuses, teamLabels, teamPeople]);

  const state = useRef({ dirty, confirming, lastCreated, onCreated, onClose });
  useEffect(() => {
    state.current = { dirty, confirming, lastCreated, onCreated, onClose };
  });

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      titleInput.current?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  const finish = useCallback((): void => {
    const current = state.current;
    if (current.lastCreated === null) current.onClose();
    else current.onCreated(current.lastCreated);
  }, []);

  const requestClose = useCallback((): void => {
    const current = state.current;
    if (current.confirming) {
      setConfirming(false);
      titleInput.current?.focus();
      return;
    }
    if (current.dirty) {
      setConfirming(true);
      return;
    }
    finish();
  }, [finish]);

  const patch = (change: Partial<Draft>): void => {
    setDraft((held) => ({ ...held, ...change }));
  };

  const submit = (): void => {
    if (!canSubmit) return;
    setIsSaving(true);
    setError(null);
    const original = duplicateOf;
    createIssue(workspaceId, toPayload(activeTeamId, title, body, draft))
      .then(async (issue) => {
        if (original !== null) {
          await createLink(workspaceId, issue.id, {
            type: 'duplicate_of',
            target_issue_id: original.issue_id,
          }).catch(() => {
            showToast(
              `Created ${issue.key}, but could not mark it a duplicate of ${original.key}`,
              'error'
            );
          });
        }
        setDuplicateOf(null);
        if (!createMore) {
          onCreated(issue);
          return;
        }
        setLastCreated(issue);
        setTitle(templateText.title);
        setBody(templateText.body);
        setConfirming(false);
        showToast(
          `Created ${issue.key}`,
          'info',
          workspace === null
            ? {}
            : {
                action: {
                  label: 'Open',
                  to: issuePath(workspace.slug, issue.key),
                },
              }
        );
        onCreatedMore?.(issue);
        titleInput.current?.focus();
      })
      .catch((failure: unknown) => {
        setError(failure);
      })
      .finally(() => {
        setIsSaving(false);
      });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLFormElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <Dialog open onClose={requestClose} title="New issue" size="lg" hideTitle>
      <form
        aria-label="New issue"
        className="-mt-8 space-y-3"
        onKeyDown={onKeyDown}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex h-7 items-center gap-2 pr-9 text-sm">
          <TeamSwitcher
            teams={writable}
            value={activeTeamId}
            fallbackName={
              activeTeam?.name ??
              (activeTeamId === teamId ? teamName : undefined) ??
              'Team'
            }
            onChange={(team) => {
              pendingTemplate.current = { teamId: team.id, id: null };
              setActiveTeamId(team.id);
              setDraft(clearTeamScoped);
              setTemplateId(null);
              if (title === templateText.title) setTitle('');
              if (body === templateText.body) setBody('');
              setTemplateText(NO_TEXT);
            }}
          />
          <span aria-hidden="true" className="text-text-faint">
            /
          </span>
          <span className="text-text-muted">
            {draft.parentId !== null && preset?.parentKey !== undefined
              ? `New sub-issue of ${preset.parentKey}`
              : 'New issue'}
          </span>
          {templates.length > 0 && (
            <span className="ml-auto">
              <TemplatePicker
                templates={templates}
                value={templateId}
                onChange={applyTemplate}
              />
            </span>
          )}
        </div>

        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not create that issue.')}
          />
        )}

        <div className="space-y-1 pt-2">
          <input
            ref={titleInput}
            aria-label="Title"
            placeholder="Issue title"
            autoComplete="off"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setConfirming(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                bodyInput.current?.focus();
              }
            }}
            className="w-full bg-transparent text-lg font-semibold text-text outline-none placeholder:text-text-faint"
          />
          <ErrorAlert message={titleError} />
          <SimilarIssues
            issues={shownSimilar}
            hrefOf={(issue) =>
              workspace === null ? null : issuePath(workspace.slug, issue.key)
            }
            duplicateOfId={duplicateOf?.issue_id ?? null}
            onMarkDuplicate={setDuplicateOf}
          />
          <textarea
            ref={bodyInput}
            aria-label="Description"
            placeholder="Add description..."
            rows={3}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              setConfirming(false);
            }}
            className="block min-h-16 w-full resize-none bg-transparent text-sm text-text outline-none placeholder:text-text-faint"
          />
        </div>

        <div
          role="group"
          aria-label="Properties"
          className="flex flex-wrap items-center gap-1.5"
        >
          <StatusPicker
            variant="chip"
            statuses={teamStatuses}
            value={
              draft.statusId === ''
                ? (defaultStatus?.id ?? null)
                : draft.statusId
            }
            onChange={(statusId) => {
              patch({ statusId });
            }}
          />
          <PriorityPicker
            variant="chip"
            value={draft.priority}
            onChange={(priority) => {
              patch({ priority });
            }}
          />
          <AssigneePicker
            variant="chip"
            people={teamPeople}
            value={draft.assigneeId}
            {...(currentUserId === undefined ? {} : { currentUserId })}
            onChange={(assigneeId) => {
              patch({ assigneeId });
            }}
          />
          <LabelsPicker
            variant="chip"
            labels={teamLabels}
            value={draft.labelIds}
            onChange={(labelIds) => {
              patch({ labelIds });
            }}
          />
          <EstimatePicker
            variant="chip"
            scale={scale}
            extended={scaleOptions.extended ?? false}
            allowZero={scaleOptions.allowZero ?? false}
            value={draft.estimate}
            onChange={(estimate) => {
              patch({ estimate });
            }}
          />
          <ProjectPicker
            variant="chip"
            projects={options.projects}
            value={draft.projectId}
            onChange={(projectId) => {
              patch({ projectId, projectMilestoneId: null });
            }}
          />
          <CyclePicker
            variant="chip"
            cycles={options.cycles}
            value={draft.cycleId}
            onChange={(cycleId) => {
              patch({ cycleId });
            }}
          />
          <DatePicker
            variant="chip"
            field="Start date"
            value={draft.startDate}
            {...(draft.dueDate === null ? {} : { max: draft.dueDate })}
            onChange={(startDate) => {
              patch({ startDate });
            }}
          />
          <DatePicker
            variant="chip"
            field="Due date"
            value={draft.dueDate}
            {...(draft.startDate === null ? {} : { min: draft.startDate })}
            onChange={(dueDate) => {
              patch({ dueDate });
            }}
          />
        </div>
        <ErrorAlert message={dateError} />

        {confirming ? (
          <div
            role="alertdialog"
            aria-label="Discard this issue?"
            className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3"
          >
            <p className="text-sm text-text">
              Discard this issue? The title and description will be lost.
            </p>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirming(false);
                  titleInput.current?.focus();
                }}
              >
                Keep editing
              </Button>
              <Button variant="danger" onClick={finish}>
                Discard
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-text-muted select-none">
              <button
                type="button"
                role="switch"
                aria-checked={createMore}
                aria-label="Create more"
                onClick={() => {
                  setCreateMore((held) => !held);
                }}
                className={cn(
                  'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors duration-100',
                  createMore
                    ? 'bg-accent hover:bg-accent-strong'
                    : 'bg-line-strong hover:bg-text-faint',
                  'active:brightness-90'
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'inline-block h-3 w-3 rounded-full bg-white transition-transform duration-100',
                    createMore ? 'translate-x-3.5' : 'translate-x-0.5'
                  )}
                />
              </button>
              <span aria-hidden="true">Create more</span>
            </label>
            <Button type="submit" variant="primary" disabled={!canSubmit}>
              {isSaving ? 'Creating' : 'Create issue'}
              <kbd
                aria-hidden="true"
                className="ml-2 font-sans text-[10px] opacity-70 pointer-coarse:hidden"
              >
                {submitKeysLabel()}
              </kbd>
            </Button>
          </div>
        )}
      </form>
    </Dialog>
  );
};

export default CreateIssueDialog;
