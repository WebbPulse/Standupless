/**
 * A team's ordered triage rules. Each rule names a filter and the actions it
 * takes, and the rules run top to bottom on every issue that enters the
 * team's triage inbox: the first match applies and stops the run unless it
 * asks to continue, and a rule that moves the issue to another team always
 * ends it.
 *
 * The whole list saves as one patch, so reordering, switching a rule off and
 * deleting one each send the list as it now stands. A rule whose label,
 * project, user or team was deleted arrives off with the server's warning,
 * and it can still be moved or deleted until it is edited to a real target.
 */

import React, { useId, useMemo, useState } from 'react';
import {
  LuArrowDown,
  LuArrowUp,
  LuPause,
  LuPencil,
  LuPlay,
  LuTrash2,
  LuTriangleAlert,
} from 'react-icons/lu';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { listProjects } from '../../api/planning';
import { listLabels } from '../../api/teams';
import { useTeamsFor } from '../../hooks/useTeams';
import { errorMessage } from '../../lib/errors';
import { PRIORITY_LABELS } from '../../lib/issueDisplay';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import { labelsKey, projectsKey } from '../../lib/queryKeys';
import type {
  IssuePriority,
  TriageRuleActions,
  TriageRuleBody,
  TriageRuleRead,
  TriageRuleSource,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import { Badge } from '../ui/badge';
import Button, { IconButton } from '../ui/button';
import Checkbox from '../ui/checkbox';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import { SelectField } from '../ui/select';

/** One person a rule can filter on or assign to. */
export type RulePerson = Assignable & { user_id: string };

/** Props for TriageRulesSection: the saved rules and how to save a new list. */
export interface TriageRulesSectionProps {
  workspaceId: string;
  teamId: string;
  canEdit: boolean;
  rules: TriageRuleRead[];
  /** The team's members who can be assigned, guests left out. */
  assignees: RulePerson[];
  /** Everyone in the workspace, who may have filed an issue. */
  creators: RulePerson[];
  saving: boolean;
  /** Saves the whole ordered list, rejecting when the server refuses it. */
  onSave: (rules: TriageRuleBody[], done: string) => Promise<void>;
}

/** How often the label and project lists are re-read. */
const POLL_MS = 60000;

const PRIORITIES: readonly IssuePriority[] = [
  'urgent',
  'high',
  'medium',
  'low',
  'none',
];

const SOURCES: readonly { value: TriageRuleSource; label: string }[] = [
  { value: 'web', label: 'Web app' },
  { value: 'form', label: 'Form' },
  { value: 'api', label: 'API' },
  { value: 'mcp', label: 'MCP' },
  { value: 'cli', label: 'CLI' },
  { value: 'github', label: 'GitHub' },
  { value: 'system', label: 'Automation' },
];

/** The editor's working copy of one rule. */
interface Draft {
  ruleId: string | null;
  name: string;
  enabled: boolean;
  continueAfter: boolean;
  labelIds: string[];
  priorities: IssuePriority[];
  creatorIds: string[];
  sources: TriageRuleSource[];
  text: string;
  addLabelIds: string[];
  priority: string;
  assigneeId: string;
  projectId: string;
  teamId: string;
}

/** A new rule's empty draft. */
const emptyDraft = (): Draft => ({
  ruleId: null,
  name: '',
  enabled: true,
  continueAfter: false,
  labelIds: [],
  priorities: [],
  creatorIds: [],
  sources: [],
  text: '',
  addLabelIds: [],
  priority: '',
  assigneeId: '',
  projectId: '',
  teamId: '',
});

/** The draft a saved rule opens into. */
const draftOf = (rule: TriageRuleRead): Draft => ({
  ruleId: rule.rule_id,
  name: rule.name,
  enabled: rule.warning ? true : rule.enabled,
  continueAfter: rule.continue_after,
  labelIds: rule.filter.label_ids ?? [],
  priorities: rule.filter.priorities ?? [],
  creatorIds: rule.filter.creator_ids ?? [],
  sources: rule.filter.sources ?? [],
  text: rule.filter.text ?? '',
  addLabelIds: rule.actions.add_label_ids ?? [],
  priority: rule.actions.priority ?? '',
  assigneeId: rule.actions.assignee_id ?? '',
  projectId: rule.actions.project_id ?? '',
  teamId: rule.actions.team_id ?? '',
});

/** The body a draft sends. */
const bodyOfDraft = (draft: Draft): TriageRuleBody => ({
  rule_id: draft.ruleId,
  name: draft.name.trim(),
  enabled: draft.enabled,
  continue_after: draft.teamId === '' ? draft.continueAfter : false,
  filter: {
    label_ids: draft.labelIds,
    priorities: draft.priorities,
    creator_ids: draft.creatorIds,
    sources: draft.sources,
    text: draft.text.trim() === '' ? null : draft.text.trim(),
  },
  actions: {
    add_label_ids: draft.addLabelIds,
    priority:
      draft.priority === ''
        ? null
        : (draft.priority as Exclude<IssuePriority, 'none'>),
    assignee_id: draft.assigneeId || null,
    project_id: draft.projectId || null,
    team_id: draft.teamId || null,
  },
});

/** The body a saved rule sends back unchanged, apart from `update`. */
const bodyOf = (
  rule: TriageRuleRead,
  update: Partial<TriageRuleBody> = {}
): TriageRuleBody => ({
  rule_id: rule.rule_id,
  name: rule.name,
  enabled: rule.enabled,
  continue_after: rule.continue_after,
  filter: rule.filter,
  actions: rule.actions,
  ...update,
});

/** Whether a draft sets at least one action. */
const hasAction = (draft: Draft): boolean =>
  draft.addLabelIds.length > 0 ||
  draft.priority !== '' ||
  draft.assigneeId !== '' ||
  draft.projectId !== '' ||
  draft.teamId !== '';

/** Adds or removes one value from a list. */
const toggled = <T,>(list: T[], value: T, on: boolean): T[] =>
  on ? [...list, value] : list.filter((item) => item !== value);

/** The names a lookup knows, for a rule's summary. */
interface Names {
  labels: Map<string, string>;
  people: Map<string, string>;
  projects: Map<string, string>;
  teams: Map<string, string>;
}

/** One short sentence of what a rule does. */
const actionSummary = (actions: TriageRuleActions, names: Names): string => {
  const parts: string[] = [];
  const labels = (actions.add_label_ids ?? []).map(
    (id) => names.labels.get(id) ?? 'a deleted label'
  );
  if (labels.length > 0) parts.push(`add ${labels.join(', ')}`);
  if (actions.priority) {
    parts.push(`set priority ${PRIORITY_LABELS[actions.priority]}`);
  }
  if (actions.assignee_id) {
    parts.push(
      `assign ${names.people.get(actions.assignee_id) ?? 'a former member'}`
    );
  }
  if (actions.project_id) {
    parts.push(
      `add to ${names.projects.get(actions.project_id) ?? 'a deleted project'}`
    );
  }
  if (actions.team_id) {
    parts.push(
      `move to ${names.teams.get(actions.team_id) ?? 'a deleted team'}`
    );
  }
  const sentence = parts.join(', ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
};

/** One short sentence of what a rule matches. */
const filterSummary = (rule: TriageRuleRead, names: Names): string => {
  const filter = rule.filter;
  const parts: string[] = [];
  const labels = (filter.label_ids ?? []).map(
    (id) => names.labels.get(id) ?? 'a deleted label'
  );
  if (labels.length > 0) parts.push(`labeled ${labels.join(' or ')}`);
  if ((filter.priorities ?? []).length > 0) {
    parts.push(
      `priority ${(filter.priorities ?? []).map((p) => PRIORITY_LABELS[p]).join(' or ')}`
    );
  }
  if ((filter.creator_ids ?? []).length > 0) {
    parts.push(
      `filed by ${(filter.creator_ids ?? []).map((id) => names.people.get(id) ?? 'a former member').join(' or ')}`
    );
  }
  if ((filter.sources ?? []).length > 0) {
    parts.push(
      `from ${(filter.sources ?? [])
        .map((s) => SOURCES.find((row) => row.value === s)?.label ?? s)
        .join(' or ')}`
    );
  }
  if (filter.text) parts.push(`mentioning "${filter.text}"`);
  return parts.length === 0
    ? 'Every issue entering triage'
    : `Issues ${parts.join(', ')}`;
};

/** Props for RuleEditor: the draft to open and where it goes. */
interface RuleEditorProps {
  initial: Draft;
  teamId: string;
  labels: { id: string; name: string }[];
  projects: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  assignees: RulePerson[];
  creators: RulePerson[];
  saving: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (draft: Draft) => void;
}

/** The add and edit form for one rule, inside a dialog. */
const RuleEditor: React.FC<RuleEditorProps> = ({
  initial,
  teamId,
  labels,
  projects,
  teams,
  assignees,
  creators,
  saving,
  error,
  onCancel,
  onSubmit,
}) => {
  const id = useId();
  const [draft, setDraft] = useState<Draft>(initial);
  const set = (update: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...update }));
  };
  const ready = draft.name.trim() !== '' && hasAction(draft);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !saving) onSubmit(draft);
      }}
    >
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not save the triage rule.')}
        />
      )}
      <Field
        id={`${id}-name`}
        label="Name"
        value={draft.name}
        maxLength={80}
        onChange={(event) => {
          set({ name: event.target.value });
        }}
      />

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-text">
          When an issue matches
        </legend>
        <p className="text-xs text-text-muted">
          Every condition you set must hold. Leave them all empty to match every
          issue.
        </p>
        <Field
          id={`${id}-text`}
          label="Title or description contains"
          value={draft.text}
          maxLength={200}
          onChange={(event) => {
            set({ text: event.target.value });
          }}
        />
        <ChoiceGroup
          legend="Has any of these labels"
          options={labels.map((row) => ({ value: row.id, label: row.name }))}
          picked={draft.labelIds}
          onChange={(labelIds) => {
            set({ labelIds });
          }}
        />
        <ChoiceGroup
          legend="Priority is"
          options={PRIORITIES.map((value) => ({
            value,
            label: PRIORITY_LABELS[value],
          }))}
          picked={draft.priorities}
          onChange={(priorities) => {
            set({ priorities: priorities as IssuePriority[] });
          }}
        />
        <ChoiceGroup
          legend="Filed by"
          options={creators.map((person) => ({
            value: person.user_id,
            label: personLabel(person),
          }))}
          picked={draft.creatorIds}
          onChange={(creatorIds) => {
            set({ creatorIds });
          }}
        />
        <ChoiceGroup
          legend="Filed from"
          options={SOURCES.map((row) => ({ ...row }))}
          picked={draft.sources}
          onChange={(sources) => {
            set({ sources: sources as TriageRuleSource[] });
          }}
        />
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-text">Then</legend>
        <ChoiceGroup
          legend="Add labels"
          options={labels.map((row) => ({ value: row.id, label: row.name }))}
          picked={draft.addLabelIds}
          onChange={(addLabelIds) => {
            set({ addLabelIds });
          }}
        />
        <SelectField
          id={`${id}-priority`}
          label="Set priority"
          value={draft.priority}
          onChange={(event) => {
            set({ priority: event.target.value });
          }}
        >
          <option value="">Leave as is</option>
          {PRIORITIES.filter((value) => value !== 'none').map((value) => (
            <option key={value} value={value}>
              {PRIORITY_LABELS[value]}
            </option>
          ))}
        </SelectField>
        <SelectField
          id={`${id}-assignee`}
          label="Assign to"
          value={draft.assigneeId}
          onChange={(event) => {
            set({ assigneeId: event.target.value });
          }}
        >
          <option value="">Leave as is</option>
          {assignees.map((person) => (
            <option key={person.user_id} value={person.user_id}>
              {personLabel(person)}
            </option>
          ))}
        </SelectField>
        <SelectField
          id={`${id}-project`}
          label="Add to project"
          value={draft.projectId}
          onChange={(event) => {
            set({ projectId: event.target.value });
          }}
        >
          <option value="">Leave as is</option>
          {projects.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          id={`${id}-team`}
          label="Move to team"
          value={draft.teamId}
          onChange={(event) => {
            set({ teamId: event.target.value });
          }}
        >
          <option value="">Keep in this team</option>
          {teams
            .filter((row) => row.id !== teamId)
            .map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
        </SelectField>
      </fieldset>

      <Checkbox
        label="Keep running later rules after this one applies"
        checked={draft.teamId === '' && draft.continueAfter}
        disabled={draft.teamId !== ''}
        onChange={(event) => {
          set({ continueAfter: event.target.checked });
        }}
      />
      {draft.teamId !== '' && (
        <p className="text-xs text-text-muted">
          A rule that moves the issue always ends the run.
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!ready || saving}>
          Save rule
        </Button>
      </div>
    </form>
  );
};

/** Props for ChoiceGroup: its options, which are picked and the change. */
interface ChoiceGroupProps {
  legend: string;
  options: { value: string; label: string }[];
  picked: string[];
  onChange: (picked: string[]) => void;
}

/** A labelled set of checkboxes that scrolls when the list is long. */
const ChoiceGroup: React.FC<ChoiceGroupProps> = ({
  legend,
  options,
  picked,
  onChange,
}) => (
  <fieldset className="space-y-1">
    <legend className="text-xs font-medium text-text-muted">{legend}</legend>
    {options.length === 0 ? (
      <p className="text-xs text-text-faint">None to pick from.</p>
    ) : (
      <div className="flex max-h-32 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
        {options.map((option) => (
          <Checkbox
            key={option.value}
            label={option.label}
            checked={picked.includes(option.value)}
            onChange={(event) => {
              onChange(toggled(picked, option.value, event.target.checked));
            }}
          />
        ))}
      </div>
    )}
  </fieldset>
);

/** Lists, orders and edits a team's triage rules. */
export const TriageRulesSection: React.FC<TriageRulesSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
  rules,
  assignees,
  creators,
  saving,
  onSave,
}) => {
  const auth = useQueryAuth();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [editError, setEditError] = useState<unknown>(null);

  const { data: labelRows } = usePolledQuery(
    (context) => listLabels(workspaceId, teamId, context),
    { intervalMs: POLL_MS, queryKey: labelsKey(teamId), auth }
  );
  const { data: projectPage } = usePolledQuery(
    ({ signal }) => listProjects(workspaceId, { team_id: teamId }, signal),
    {
      intervalMs: POLL_MS,
      enabled: canEdit,
      queryKey: projectsKey(workspaceId, teamId, 'all'),
      auth,
    }
  );
  const { data: teamRows } = useTeamsFor(workspaceId);

  const labels = useMemo(
    () =>
      (labelRows ?? [])
        .filter((row) => row.is_group !== true)
        .map((row) => ({ id: row.id, name: row.name })),
    [labelRows]
  );
  const projects = useMemo(
    () =>
      (projectPage?.projects ?? []).map((row) => ({
        id: row.project_id,
        name: row.name,
      })),
    [projectPage]
  );
  const teams = useMemo(
    () => (teamRows ?? []).map((row) => ({ id: row.id, name: row.name })),
    [teamRows]
  );
  const names = useMemo<Names>(
    () => ({
      labels: new Map(labels.map((row) => [row.id, row.name])),
      projects: new Map(projects.map((row) => [row.id, row.name])),
      teams: new Map(teams.map((row) => [row.id, row.name])),
      people: new Map(
        [...creators, ...assignees].map((person) => [
          person.user_id,
          personLabel(person),
        ])
      ),
    }),
    [labels, projects, teams, creators, assignees]
  );

  const saveList = (next: TriageRuleBody[], done: string): void => {
    if (!canEdit || saving) return;
    void onSave(next, done).catch(() => undefined);
  };

  const move = (index: number, by: number): void => {
    const next = rules.map((rule) => bodyOf(rule));
    const [picked] = next.splice(index, 1);
    next.splice(index + by, 0, picked);
    saveList(next, 'Triage rules reordered.');
  };

  const flip = (target: TriageRuleRead): void => {
    saveList(
      rules.map((rule) =>
        rule.rule_id === target.rule_id
          ? bodyOf(rule, { enabled: !rule.enabled })
          : bodyOf(rule)
      ),
      target.enabled ? 'Triage rule turned off.' : 'Triage rule turned on.'
    );
  };

  const remove = (target: TriageRuleRead): void => {
    setConfirming(null);
    saveList(
      rules
        .filter((rule) => rule.rule_id !== target.rule_id)
        .map((rule) => bodyOf(rule)),
      'Triage rule deleted.'
    );
  };

  const submit = (draft: Draft): void => {
    const body = bodyOfDraft(draft);
    const next =
      draft.ruleId === null
        ? [...rules.map((rule) => bodyOf(rule)), body]
        : rules.map((rule) =>
            rule.rule_id === draft.ruleId ? body : bodyOf(rule)
          );
    setEditError(null);
    onSave(next, 'Triage rule saved.').then(
      () => {
        setEditing(null);
      },
      (caught: unknown) => {
        setEditError(caught);
      }
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <span className="block text-sm font-medium text-text">Rules</span>
          <p className="text-xs text-text-muted">
            Rules run in order on every issue entering triage. The first match
            applies, and later rules run only when it says to continue.
          </p>
        </div>
        {canEdit && (
          <Button
            size="sm"
            disabled={saving}
            onClick={() => {
              setEditError(null);
              setEditing(emptyDraft());
            }}
          >
            Add rule
          </Button>
        )}
      </div>

      {rules.length === 0 ? (
        <p className="text-xs text-text-muted">No rules yet.</p>
      ) : (
        <ol
          aria-label="Triage rules"
          className="divide-y divide-line rounded-md border border-line"
        >
          {rules.map((rule, index) => (
            <li
              key={rule.rule_id}
              className="flex items-start justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-text-faint tabular-nums">
                    {index + 1}
                  </span>
                  <span className="truncate text-sm font-medium text-text">
                    {rule.name}
                  </span>
                  {!rule.enabled && rule.warning == null && <Badge>Off</Badge>}
                  {rule.continue_after && <Badge>Continues</Badge>}
                </div>
                <p className="text-xs text-text-muted">
                  {filterSummary(rule, names)}
                </p>
                <p className="text-xs text-text-muted">
                  {actionSummary(rule.actions, names)}
                </p>
                {rule.warning != null && (
                  <p
                    role="status"
                    className="flex items-center gap-1 text-xs text-warning"
                  >
                    <LuTriangleAlert
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0"
                    />
                    Off: {rule.warning}. Edit the rule to turn it back on.
                  </p>
                )}
              </div>
              {canEdit &&
                (confirming === rule.rule_id ? (
                  <div
                    role="alertdialog"
                    aria-label={`Delete the ${rule.name} rule?`}
                    className="flex items-center gap-2"
                  >
                    <span className="text-xs text-text-muted">Delete?</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setConfirming(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        remove(rule);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <IconButton
                      size="sm"
                      label={`Move ${rule.name} up`}
                      disabled={saving || index === 0}
                      onClick={() => {
                        move(index, -1);
                      }}
                    >
                      <LuArrowUp className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      label={`Move ${rule.name} down`}
                      disabled={saving || index === rules.length - 1}
                      onClick={() => {
                        move(index, 1);
                      }}
                    >
                      <LuArrowDown className="h-3.5 w-3.5" />
                    </IconButton>
                    {rule.warning == null && (
                      <IconButton
                        size="sm"
                        label={
                          rule.enabled
                            ? `Turn off ${rule.name}`
                            : `Turn on ${rule.name}`
                        }
                        disabled={saving}
                        onClick={() => {
                          flip(rule);
                        }}
                      >
                        {rule.enabled ? (
                          <LuPause className="h-3.5 w-3.5" />
                        ) : (
                          <LuPlay className="h-3.5 w-3.5" />
                        )}
                      </IconButton>
                    )}
                    <IconButton
                      size="sm"
                      label={`Edit ${rule.name}`}
                      disabled={saving}
                      onClick={() => {
                        setEditError(null);
                        setEditing(draftOf(rule));
                      }}
                    >
                      <LuPencil className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      label={`Delete ${rule.name}`}
                      disabled={saving}
                      onClick={() => {
                        setConfirming(rule.rule_id);
                      }}
                    >
                      <LuTrash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                ))}
            </li>
          ))}
        </ol>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => {
          setEditing(null);
        }}
        title={editing?.ruleId == null ? 'New triage rule' : 'Edit triage rule'}
        size="lg"
      >
        {editing !== null && (
          <RuleEditor
            initial={editing}
            teamId={teamId}
            labels={labels}
            projects={projects}
            teams={teams}
            assignees={assignees}
            creators={creators}
            saving={saving}
            error={editError}
            onCancel={() => {
              setEditing(null);
            }}
            onSubmit={submit}
          />
        )}
      </Dialog>
    </div>
  );
};

export default TriageRulesSection;
