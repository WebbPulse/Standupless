/**
 * The sub-issues an issue template creates under every issue made from it,
 * as in Linear. Each row is a title, a description and the properties the
 * sub-issue starts with, in the order they are created, and moves up or down
 * a place or is removed. A row keeps the key it was saved with, so the create
 * dialog can name the ones it keeps.
 */

import React from 'react';
import { LuArrowDown, LuArrowUp, LuPlus, LuX } from 'react-icons/lu';
import type { Assignable } from '../../lib/issuePeople';
import { nextTemplateKey } from '../../lib/projectTemplates';
import type { EstimateOptions } from '../../lib/validation';
import type {
  EstimateScale,
  IssuePriority,
  LabelRead,
  StatusRead,
  TemplateSubIssue,
  TemplateSubIssueRead,
} from '../../types/Api';
import {
  AssigneePicker,
  EstimatePicker,
  LabelsPicker,
  PriorityPicker,
  StatusPicker,
} from '../issues/PropertyPickers';
import Button, { IconButton } from '../ui/button';
import { Input, Textarea } from '../ui/input';

/** How many sub-issues one template adds. */
export const SUB_ISSUES_MAX = 25;

/** The editor's working copy of one sub-issue. */
export interface SubIssueDraft {
  key: string;
  title: string;
  body: string;
  statusId: string | null;
  priority: IssuePriority;
  assigneeId: string | null;
  labelIds: string[];
  estimate: string | null;
}

/** The rows a saved template's sub-issues open into. */
export const subIssueDrafts = (
  saved: readonly TemplateSubIssueRead[] | undefined
): SubIssueDraft[] =>
  (saved ?? []).map((item) => ({
    key: item.key,
    title: item.title,
    body: item.body ?? '',
    statusId: item.status_id ?? null,
    priority: item.priority ?? 'none',
    assigneeId: item.assignee_id ?? null,
    labelIds: item.label_ids,
    estimate: item.estimate ?? null,
  }));

/** The sub-issues a template write sends, blanks as null and untitled rows left out. */
export const subIssuesOf = (
  drafts: readonly SubIssueDraft[]
): TemplateSubIssue[] =>
  drafts
    .filter((row) => row.title.trim() !== '')
    .map((row) => ({
      key: row.key,
      title: row.title.trim(),
      body: row.body.trim() === '' ? null : row.body,
      status_id: row.statusId,
      priority: row.priority === 'none' ? null : row.priority,
      assignee_id: row.assigneeId,
      label_ids: row.labelIds,
      estimate: row.estimate,
    }));

/** Props for SubIssuesEditor. */
export interface SubIssuesEditorProps {
  rows: SubIssueDraft[];
  onChange: (rows: SubIssueDraft[]) => void;
  statuses: StatusRead[];
  labels: LabelRead[];
  /** Team templates name people and an estimate; a workspace template does not. */
  team: boolean;
  people?: Assignable[];
  estimateScale?: EstimateScale;
  estimateOptions?: EstimateOptions;
}

/** Adds, edits, reorders and removes an issue template's sub-issues. */
export const SubIssuesEditor: React.FC<SubIssuesEditorProps> = ({
  rows,
  onChange,
  statuses,
  labels,
  team,
  people = [],
  estimateScale = 'off',
  estimateOptions,
}) => {
  const set = (key: string, change: Partial<SubIssueDraft>): void => {
    onChange(
      rows.map((row) => (row.key === key ? { ...row, ...change } : row))
    );
  };
  const add = (): void => {
    onChange([
      ...rows,
      {
        key: nextTemplateKey(
          's',
          rows.map((row) => row.key)
        ),
        title: '',
        body: '',
        statusId: null,
        priority: 'none',
        assigneeId: null,
        labelIds: [],
        estimate: null,
      },
    ]);
  };
  const move = (index: number, by: number): void => {
    const target = index + by;
    if (target < 0 || target >= rows.length) return;
    const order = [...rows];
    const [moved] = order.splice(index, 1);
    if (moved === undefined) return;
    order.splice(target, 0, moved);
    onChange(order);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-text-muted">Sub-issues</p>
        <Button
          size="sm"
          variant="ghost"
          disabled={rows.length >= SUB_ISSUES_MAX}
          onClick={add}
        >
          <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />
          Add sub-issue
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-text-faint">
          No sub-issues. Each one added is created under every issue made from
          this template.
        </p>
      ) : (
        <ol aria-label="Template sub-issues" className="space-y-2">
          {rows.map((row, index) => {
            const number = String(index + 1);
            return (
              <li
                key={row.key}
                className="space-y-1.5 rounded-md border border-line p-2"
              >
                <div className="flex items-center gap-1.5">
                  <Input
                    aria-label={`Sub-issue ${number} title`}
                    value={row.title}
                    placeholder="Sub-issue title"
                    onChange={(event) => {
                      set(row.key, { title: event.target.value });
                    }}
                  />
                  <IconButton
                    size="sm"
                    label={`Move sub-issue ${number} up`}
                    disabled={index === 0}
                    onClick={() => {
                      move(index, -1);
                    }}
                  >
                    <LuArrowUp className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    size="sm"
                    label={`Move sub-issue ${number} down`}
                    disabled={index === rows.length - 1}
                    onClick={() => {
                      move(index, 1);
                    }}
                  >
                    <LuArrowDown className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    size="sm"
                    label={`Remove sub-issue ${number}`}
                    onClick={() => {
                      onChange(rows.filter((held) => held.key !== row.key));
                    }}
                  >
                    <LuX className="h-3.5 w-3.5" />
                  </IconButton>
                </div>
                <Textarea
                  aria-label={`Sub-issue ${number} description`}
                  rows={2}
                  value={row.body}
                  placeholder="Description"
                  onChange={(event) => {
                    set(row.key, { body: event.target.value });
                  }}
                />
                <div
                  role="group"
                  aria-label={`Sub-issue ${number} properties`}
                  className="flex flex-wrap items-center gap-1.5"
                >
                  <StatusPicker
                    variant="chip"
                    statuses={statuses}
                    value={row.statusId}
                    onChange={(statusId) => {
                      set(row.key, { statusId });
                    }}
                  />
                  <PriorityPicker
                    variant="chip"
                    value={row.priority}
                    onChange={(priority) => {
                      set(row.key, { priority });
                    }}
                  />
                  {team && (
                    <AssigneePicker
                      variant="chip"
                      people={people}
                      value={row.assigneeId}
                      onChange={(assigneeId) => {
                        set(row.key, { assigneeId });
                      }}
                    />
                  )}
                  <LabelsPicker
                    variant="chip"
                    labels={labels}
                    value={row.labelIds}
                    onChange={(labelIds) => {
                      set(row.key, { labelIds });
                    }}
                  />
                  {team && estimateScale !== 'off' && (
                    <EstimatePicker
                      variant="chip"
                      scale={estimateScale}
                      extended={estimateOptions?.extended ?? false}
                      allowZero={estimateOptions?.allowZero ?? false}
                      value={row.estimate}
                      onChange={(estimate) => {
                        set(row.key, { estimate });
                      }}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
};

export default SubIssuesEditor;
