/**
 * The new issue dialog. The title and description come first because they
 * are what a person arrives with, and every other property sits in a row of
 * chips underneath that can be left alone: the server allocates the key and
 * defaults the status to the lowest position backlog one, or to Triage while
 * the team has triage on, so filing something never waits on deciding where
 * it belongs.
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
 *
 * A form template is the exception. Its questions sit under the description
 * and the issue waits until every required one is answered, then the dialog
 * sends the template id with the answers and every field set explicitly, so
 * the server renders the answers into the description, applies the labels and
 * priority a chosen option maps to, and files the issue to triage.
 *
 * Milestone, parent, sub-issues and attachments are filed in the same save.
 * The milestone chip appears once a project is chosen, the parent chip
 * searches the team's top level issues, and sub-issue rows become issues
 * under the new one, carrying its project, milestone and cycle. A file
 * pasted, dropped or picked is held with a placeholder in the description
 * and uploaded once the issue exists, the placeholder becoming its embed.
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
import {
  LuCircleDashed,
  LuMaximize2,
  LuMinimize2,
  LuPaperclip,
  LuPlus,
  LuX,
} from 'react-icons/lu';
import { uploadAttachment } from '../../api/discussion';
import { createIssue, createLink, updateIssue } from '../../api/issues';
import { listTeamTemplates } from '../../api/templates';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import { useAutoGrow } from '../../hooks/useAutoGrow';
import { useTeamOptions } from '../../hooks/useTeamOptions';
import { useTriageOn } from '../../hooks/useTriageTeams';
import { canWriteIssues } from '../../lib/capabilities';
import { dragHasFiles, filesFrom } from '../../lib/attachments';
import { cn } from '../../lib/cn';
import {
  namesPending,
  pendingReference,
  resolvePending,
  stripPending,
} from '../../lib/draftUploads';
import { errorMessage } from '../../lib/errors';
import { contentPath, mediaKindOf } from '../../lib/media';
import type { Assignable } from '../../lib/issuePeople';
import {
  templatePrefill,
  type TemplatePrefill,
} from '../../lib/issueTemplates';
import { templatesKey } from '../../lib/queryKeys';
import { sortStatuses } from '../../lib/propertyOptions';
import { issuePath } from '../../lib/paths';
import { submitKeysLabel } from '../../lib/platform';
import { showErrorToast, showToast } from '../../lib/toast';
import { TRIAGE_STATUS_ID } from '../../lib/triageStatus';
import {
  UPLOAD_CONTENT_TYPES,
  describeUploadRefusal,
  sizeLabel,
} from '../../lib/uploads';
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
import Button, { IconButton } from '../ui/button';
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
import { DraftParentPicker, type DraftParent } from './DraftParentPicker';
import { IssueMilestonePicker } from './PlanningPickers';
import { useTeams } from '../../hooks/useTeams';
import { SimilarIssues, useSimilarIssues } from './SimilarIssues';
import { teamTree } from '../../lib/teamOrder';
import { TemplatePicker } from './TemplatePicker';
import {
  FormQuestions,
  missingAnswers,
  sentAnswers,
  type FormAnswers,
} from './FormQuestions';
import { LOOKUP_POLL_MS } from '../../lib/polling';

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
  parent: DraftParent | null;
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
  parent: null,
};

/** The draft a preset starts from. */
const presetDraft = (preset: CreateIssuePreset | undefined): Draft => ({
  ...EMPTY_DRAFT,
  statusId: preset?.statusId ?? '',
  assigneeId: preset?.assigneeId ?? null,
  projectId: preset?.projectId ?? null,
  cycleId: preset?.cycleId ?? null,
  parent:
    preset?.parentId === undefined
      ? null
      : { id: preset.parentId, key: preset.parentKey ?? 'Parent', title: '' },
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
  parent: null,
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
const TEMPLATES_POLL_MS = LOOKUP_POLL_MS;

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
  ...(draft.parent === null ? {} : { parent_id: draft.parent.id }),
});

/** The create body for a form: the template and its answers, with every field the template could fill set explicitly. */
const formPayload = (
  teamId: string,
  title: string,
  body: string,
  draft: Draft,
  template: TemplateRead,
  answers: FormAnswers
): IssueCreate => ({
  ...toPayload(teamId, title, body, draft),
  template_id: template.id,
  form_answers: sentAnswers(template.form_fields ?? [], answers),
  body: body.trim() === '' ? null : body,
  status_id: draft.statusId === '' ? null : draft.statusId,
  priority: draft.priority,
  assignee_id: draft.assigneeId,
  label_ids: draft.labelIds,
  estimate: draft.estimate,
  project_id: draft.projectId,
  project_milestone_id: draft.projectMilestoneId,
  cycle_id: draft.cycleId,
});

/** The rendered body of a form issue with its description swapped for the one carrying uploaded files. */
const withResolvedDescription = (
  rendered: string,
  sent: string,
  resolved: string
): string => {
  const tail = sent.trim();
  const next = resolved.trim();
  if (tail === '') return next === '' ? rendered : `${rendered}\n\n${next}`;
  const at = rendered.lastIndexOf(tail);
  if (at < 0) return rendered;
  return rendered.slice(0, at) + next + rendered.slice(at + tail.length);
};

/** One sub-issue row, filed under the new issue when it is created. */
interface SubIssueRow {
  id: string;
  title: string;
}

/** One file held until the issue it belongs to exists. */
interface HeldFile {
  id: string;
  file: File;
}

/** The create body for a sub-issue, carrying its parent's plan. */
const subIssuePayload = (parent: IssueRead, title: string): IssueCreate => ({
  team_id: parent.team_id,
  title: title.trim(),
  parent_id: parent.id,
  ...(parent.project_id === null ? {} : { project_id: parent.project_id }),
  ...(parent.project_milestone_id === null ||
  parent.project_milestone_id === undefined
    ? {}
    : { project_milestone_id: parent.project_milestone_id }),
  ...(parent.cycle_id === null ? {} : { cycle_id: parent.cycle_id }),
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
  const [answers, setAnswers] = useState<FormAnswers>({});
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
  const similar = useSimilarIssues(workspaceId, title, activeTeamId);
  const shownSimilar =
    duplicateOf === null ||
    similar.some((issue) => issue.issue_id === duplicateOf.issue_id)
      ? similar
      : [duplicateOf, ...similar];
  const [expanded, setExpanded] = useState(false);
  const [subIssues, setSubIssues] = useState<SubIssueRow[]>([]);
  const [attached, setAttached] = useState<HeldFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const nextId = useRef(0);
  const subInputs = useRef(new Map<string, HTMLInputElement>());
  const focusRow = useRef<string | null>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(bodyInput, expanded ? 640 : 320);

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
  const triageOn = useTriageOn(activeTeamId);
  const landsInTriage =
    triageOn &&
    (workspace?.role === 'guest' ||
      activeTeam?.is_member === false ||
      draft.parent === null);

  const titleError = validateTitle(title);
  const dateError = validateDateRange(
    draft.startDate ?? '',
    draft.dueDate ?? ''
  );
  const subIssueError =
    subIssues
      .map((row) => (row.title.trim() === '' ? null : validateTitle(row.title)))
      .find((problem) => problem !== null) ?? null;
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
  const formTemplate =
    templates.find(
      (template) =>
        template.id === templateId && (template.form_fields ?? []).length > 0
    ) ?? null;
  const formFields = formTemplate?.form_fields ?? [];
  const unanswered = missingAnswers(formFields, answers);
  const triageShown = landsInTriage || (triageOn && formTemplate !== null);

  const canSubmit =
    title.trim() !== '' &&
    titleError === null &&
    unanswered.length === 0 &&
    dateError === null &&
    subIssueError === null &&
    !isSaving;
  const dirty =
    title.trim() !== templateText.title.trim() ||
    body.trim() !== templateText.body.trim() ||
    attached.length > 0 ||
    Object.values(answers).some(
      (answer) =>
        answer === true || (typeof answer === 'string' && answer.trim() !== '')
    ) ||
    subIssues.some((row) => row.title.trim() !== '');
  const canNest = draft.parent === null;

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
    setAnswers({});
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
    setAnswers({});
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
    setDraft((current) => ({ ...current, ...change }));
  };

  const localId = (prefix: string): string => {
    nextId.current += 1;
    return `${prefix}${String(nextId.current)}`;
  };

  useEffect(() => {
    const id = focusRow.current;
    if (id === null) return;
    focusRow.current = null;
    subInputs.current.get(id)?.focus();
  });

  const addSubIssue = (after?: string): void => {
    const id = localId('sub-');
    focusRow.current = id;
    setSubIssues((rows) => {
      const at =
        after === undefined
          ? rows.length
          : rows.findIndex((row) => row.id === after) + 1;
      return [...rows.slice(0, at), { id, title: '' }, ...rows.slice(at)];
    });
  };

  const removeSubIssue = (id: string): void => {
    const index = subIssues.findIndex((row) => row.id === id);
    const before = subIssues[index - 1];
    setSubIssues((rows) => rows.filter((row) => row.id !== id));
    if (before === undefined) bodyInput.current?.focus();
    else focusRow.current = before.id;
  };

  const holdFiles = (files: File[]): void => {
    const accepted: HeldFile[] = [];
    for (const file of files) {
      const refusal = describeUploadRefusal(file);
      if (refusal !== null) {
        showErrorToast(`${file.name}: ${refusal}`);
        continue;
      }
      accepted.push({ id: localId('file-'), file });
    }
    if (accepted.length === 0) return;
    const field = bodyInput.current;
    const atCaret = field !== null && document.activeElement === field;
    const start = atCaret ? field.selectionStart : body.length;
    const end = atCaret ? field.selectionEnd : body.length;
    const before = body.slice(0, start);
    const after = body.slice(end);
    const lead = before === '' || before.endsWith('\n') ? '' : '\n';
    const trail = after.startsWith('\n') ? '' : '\n';
    const references = accepted
      .map((item) => pendingReference(item.id, item.file))
      .join('\n');
    setBody(`${before}${lead}${references}${trail}${after}`);
    setAttached((current) => [...current, ...accepted]);
    setConfirming(false);
  };

  const dropFile = (id: string): void => {
    setAttached((current) => current.filter((item) => item.id !== id));
    setBody((current) =>
      namesPending(current, id)
        ? resolvePending(current, (other) =>
            other === id ? null : `pending-upload:${other}`
          )
        : current
    );
  };

  const uploadHeld = async (
    issue: IssueRead,
    sentBody: string,
    isForm: boolean
  ): Promise<IssueRead> => {
    if (attached.length === 0) return issue;
    const paths = new Map<string, string>();
    await Promise.all(
      attached.map(async (item) => {
        try {
          const attachment = await uploadAttachment(
            workspaceId,
            issue.id,
            item.file
          );
          paths.set(
            item.id,
            contentPath(
              workspaceId,
              attachment.attachment_id,
              issue.id,
              mediaKindOf(item.file.type)
            )
          );
        } catch (failure: unknown) {
          showErrorToast(
            errorMessage(failure, `Could not upload ${item.file.name}.`)
          );
        }
      })
    );
    if (!attached.some((item) => namesPending(body, item.id))) return issue;
    const description = resolvePending(body, (id) => paths.get(id) ?? null);
    const resolved = isForm
      ? withResolvedDescription(issue.body ?? '', sentBody, description)
      : description;
    try {
      return await updateIssue(workspaceId, issue.id, {
        body: resolved === '' ? null : resolved,
      });
    } catch (failure: unknown) {
      showErrorToast(
        errorMessage(
          failure,
          `Created ${issue.key}, but could not add its files`
        )
      );
      return issue;
    }
  };

  const createSubIssues = async (parent: IssueRead): Promise<void> => {
    const titles = subIssues
      .map((row) => row.title.trim())
      .filter((text) => text !== '');
    let failed = 0;
    for (const text of titles) {
      try {
        await createIssue(workspaceId, subIssuePayload(parent, text));
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) {
      showErrorToast(
        `Created ${parent.key}, but ${String(failed)} of ${String(titles.length)} sub-issues could not be created`
      );
    }
  };

  const submit = (): void => {
    if (!canSubmit) return;
    setIsSaving(true);
    setError(null);
    const original = duplicateOf;
    const sentBody = attached.length === 0 ? body : stripPending(body);
    const form = formTemplate;
    const payload =
      form === null
        ? toPayload(activeTeamId, title, sentBody, draft)
        : formPayload(activeTeamId, title, sentBody, draft, form, answers);
    createIssue(workspaceId, payload)
      .then(async (made) => {
        const issue = await uploadHeld(made, sentBody, form !== null);
        await createSubIssues(issue);
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
        setAnswers({});
        setAttached([]);
        setSubIssues([]);
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

  const dropProps = {
    onDragOver: (event: React.DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
        return;
      }
      setDragging(false);
    },
    onDrop: (event: React.DragEvent) => {
      const files = filesFrom(event.dataTransfer);
      setDragging(false);
      if (files.length === 0) return;
      event.preventDefault();
      holdFiles(files);
    },
  };

  return (
    <Dialog
      open
      onClose={requestClose}
      title="New issue"
      size={expanded ? 'xl' : 'lg'}
      hideTitle
    >
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
              setAnswers({});
              if (title === templateText.title) setTitle('');
              if (body === templateText.body) setBody('');
              setTemplateText(NO_TEXT);
            }}
          />
          <span aria-hidden="true" className="text-text-faint">
            /
          </span>
          <span className="text-text-muted">
            {draft.parent === null
              ? 'New issue'
              : `New sub-issue of ${draft.parent.key}`}
          </span>
          <span className="ml-auto flex items-center gap-1">
            {templates.length > 0 && (
              <TemplatePicker
                templates={templates}
                value={templateId}
                onChange={(template) => {
                  applyTemplate(template);
                  titleInput.current?.focus();
                }}
              />
            )}
            <IconButton
              label={expanded ? 'Collapse' : 'Expand'}
              size="sm"
              aria-pressed={expanded}
              onClick={() => {
                setExpanded((open) => !open);
              }}
            >
              {expanded ? (
                <LuMinimize2 className="h-3.5 w-3.5" />
              ) : (
                <LuMaximize2 className="h-3.5 w-3.5" />
              )}
            </IconButton>
          </span>
        </div>

        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not create that issue.')}
          />
        )}

        <div
          className={cn(
            'space-y-1 rounded-md pt-2 transition-colors duration-100',
            dragging &&
              'bg-accent/5 outline-1 outline-offset-4 outline-accent outline-dashed'
          )}
          {...dropProps}
        >
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
            onPaste={(event) => {
              const files = filesFrom(event.clipboardData);
              if (files.length === 0) return;
              event.preventDefault();
              holdFiles(files);
            }}
            className={cn(
              'block w-full resize-none bg-transparent text-sm text-text outline-none placeholder:text-text-faint',
              expanded ? 'min-h-64' : 'min-h-16'
            )}
          />
          {formTemplate !== null && (
            <FormQuestions
              fields={formFields}
              answers={answers}
              onChange={(next) => {
                setAnswers(next);
                setConfirming(false);
              }}
            />
          )}
          {dragging && (
            <p className="text-xs text-accent">
              Drop to add to the description
            </p>
          )}
          {attached.length > 0 && (
            <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
              {attached.map((item) => (
                <li
                  key={item.id}
                  className="inline-flex h-6 max-w-56 items-center gap-1.5 rounded-sm border border-line pr-0.5 pl-2 text-xs text-text"
                >
                  <LuPaperclip
                    aria-hidden="true"
                    className="h-3 w-3 shrink-0 text-text-faint"
                  />
                  <span className="min-w-0 truncate">{item.file.name}</span>
                  <span className="shrink-0 text-text-faint">
                    {sizeLabel(item.file.size)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${item.file.name}`}
                    onClick={() => {
                      dropFile(item.id);
                    }}
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-text-faint hover:bg-raised hover:text-text"
                  >
                    <LuX aria-hidden="true" className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div
          role="group"
          aria-label="Properties"
          className="flex flex-wrap items-center gap-1.5"
        >
          <StatusPicker
            variant="chip"
            statuses={teamStatuses}
            triage={triageOn}
            value={
              draft.statusId !== ''
                ? draft.statusId
                : triageShown
                  ? TRIAGE_STATUS_ID
                  : (defaultStatus?.id ?? null)
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
          {draft.projectId !== null && (
            <IssueMilestonePicker
              variant="chip"
              workspaceId={workspaceId}
              projectId={draft.projectId}
              value={draft.projectMilestoneId}
              disabled={false}
              onChange={(projectMilestoneId) => {
                patch({ projectMilestoneId });
              }}
            />
          )}
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
          <DraftParentPicker
            workspaceId={workspaceId}
            teamId={activeTeamId}
            value={draft.parent}
            onChange={(parent) => {
              patch({ parent });
              if (parent !== null) setSubIssues([]);
            }}
          />
        </div>
        <ErrorAlert message={dateError} />

        {canNest && subIssues.length > 0 && (
          <ul aria-label="Sub-issues" className="space-y-0.5">
            {subIssues.map((row, index) => (
              <li
                key={row.id}
                className="group flex h-7 items-center gap-2 rounded-sm px-1 hover:bg-raised"
              >
                <LuCircleDashed
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 text-text-faint"
                />
                <input
                  ref={(element) => {
                    if (element === null) subInputs.current.delete(row.id);
                    else subInputs.current.set(row.id, element);
                  }}
                  aria-label={`Sub-issue ${String(index + 1)} title`}
                  placeholder="Sub-issue title"
                  autoComplete="off"
                  value={row.title}
                  onChange={(event) => {
                    const next = event.target.value;
                    setSubIssues((rows) =>
                      rows.map((item) =>
                        item.id === row.id ? { ...item, title: next } : item
                      )
                    );
                    setConfirming(false);
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.metaKey &&
                      !event.ctrlKey
                    ) {
                      event.preventDefault();
                      if (row.title.trim() !== '') addSubIssue(row.id);
                      return;
                    }
                    if (event.key === 'Backspace' && row.title === '') {
                      event.preventDefault();
                      removeSubIssue(row.id);
                    }
                  }}
                  className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-faint"
                />
                <button
                  type="button"
                  aria-label={`Remove sub-issue ${String(index + 1)}`}
                  onClick={() => {
                    removeSubIssue(row.id);
                  }}
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-text-faint opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-text pointer-coarse:opacity-100"
                >
                  <LuX aria-hidden="true" className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <ErrorAlert message={subIssueError} />

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
            <div className="flex items-center gap-1">
              <input
                ref={filePicker}
                type="file"
                multiple
                hidden
                accept={UPLOAD_CONTENT_TYPES.join(',')}
                aria-label="Attach files"
                onChange={(event) => {
                  holdFiles(Array.from(event.target.files ?? []));
                  event.target.value = '';
                }}
              />
              <IconButton
                label="Attach files"
                size="sm"
                onClick={() => {
                  filePicker.current?.click();
                }}
              >
                <LuPaperclip className="h-3.5 w-3.5" />
              </IconButton>
              {canNest && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    addSubIssue();
                  }}
                >
                  <LuPlus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                  Add sub-issues
                </Button>
              )}
            </div>
            <div className="flex items-center gap-3">
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
          </div>
        )}
      </form>
    </Dialog>
  );
};

export default CreateIssueDialog;
