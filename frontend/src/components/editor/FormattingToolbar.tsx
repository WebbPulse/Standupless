/**
 * The compact toolbar that floats over selected text, as in Linear: the
 * inline marks and a link, the three heading levels, the three lists, and the
 * quote and code block, then a button that files an issue from the selection
 * where the surface allows it, and one that files a sub-issue per item when
 * the selection is a list on a surface with a parent issue. Each formatting button shows whether its formatting is already on
 * and names its keys in its tooltip, so the toolbar also teaches the chords.
 *
 * Buttons never take focus from the document, so pressing one formats the
 * selection in place and leaves the caret where it was.
 */

import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import React from 'react';
import { LuCirclePlus, LuListTree } from 'react-icons/lu';
import Tooltip from '../ui/tooltip';
import {
  actionTooltip,
  CREATE_ISSUE_LABEL,
  CREATE_SUB_ISSUES_KEYS,
  CREATE_SUB_ISSUES_LABEL,
  shortcutLabel,
  FORMAT_ACTIONS,
  FORMAT_GROUPS,
  formattingToolbarKey,
  shouldShowToolbar,
  type FormatContext,
} from './formatting';
import { isListSelection } from './selectionIssue';

/** Props for FormattingButtons and FormattingToolbar. */
export interface FormattingButtonsProps {
  editor: Editor;
  context: FormatContext;
}

/** The toolbar's row of buttons, without the floating behaviour. */
export const FormattingButtons: React.FC<FormattingButtonsProps> = ({
  editor,
  context,
}) => {
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      Object.fromEntries(
        FORMAT_ACTIONS.map((action) => [action.id, action.isActive(current)])
      ) as Record<string, boolean>,
  });
  const createIssue = context.createIssue;
  const listSelected = useEditorState({
    editor,
    selector: ({ editor: current }) => isListSelection(current),
  });
  const createSubIssues = listSelected ? context.createSubIssues : undefined;

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex items-center gap-px rounded-md border border-line bg-overlay p-0.5 shadow-overlay"
    >
      {FORMAT_GROUPS.map((group, at) => (
        <React.Fragment key={group[0]?.id ?? String(at)}>
          {at > 0 && (
            <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />
          )}
          {group.map((action) => {
            const Icon = action.icon;
            const on = active[action.id] === true;
            return (
              <Tooltip key={action.id} text={actionTooltip(action)} side="top">
                <button
                  type="button"
                  aria-label={action.label}
                  aria-pressed={on}
                  data-action={action.id}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-text-muted hover:bg-hover hover:text-text active:bg-press aria-pressed:bg-press aria-pressed:text-text"
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => {
                    action.run(editor, context);
                  }}
                >
                  <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            );
          })}
        </React.Fragment>
      ))}
      {createIssue !== undefined && (
        <>
          <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />
          <Tooltip text={CREATE_ISSUE_LABEL} side="top">
            <button
              type="button"
              aria-label={CREATE_ISSUE_LABEL}
              data-action="createIssue"
              className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-text-muted hover:bg-hover hover:text-text active:bg-press"
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={createIssue}
            >
              <LuCirclePlus aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </>
      )}
      {createSubIssues !== undefined && (
        <>
          {createIssue === undefined && (
            <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />
          )}
          <Tooltip
            text={`${CREATE_SUB_ISSUES_LABEL}  ${shortcutLabel(CREATE_SUB_ISSUES_KEYS)}`}
            side="top"
          >
            <button
              type="button"
              aria-label={CREATE_SUB_ISSUES_LABEL}
              data-action="createSubIssues"
              className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-text-muted hover:bg-hover hover:text-text active:bg-press"
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={createSubIssues}
            >
              <LuListTree aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </>
      )}
    </div>
  );
};

/** Where the toolbar floats, kept stable so the menu is never reconfigured. */
const PLACEMENT = {
  placement: 'top',
  offset: 6,
  flip: {},
  shift: { padding: 8 },
} as const;

/** Whether the toolbar shows, kept stable for the same reason. */
const showToolbar = ({
  editor,
  view,
  state,
  element,
}: {
  editor: Editor;
  view: { hasFocus: () => boolean };
  state: Parameters<typeof shouldShowToolbar>[1];
  element: HTMLElement;
}): boolean =>
  shouldShowToolbar(
    editor,
    state,
    view.hasFocus() || element.contains(document.activeElement)
  );

/** The buttons, floating over the selection while text is selected. */
export const FormattingToolbar: React.FC<FormattingButtonsProps> = ({
  editor,
  context,
}) => (
  <BubbleMenu
    editor={editor}
    pluginKey={formattingToolbarKey}
    className="z-30"
    updateDelay={100}
    shouldShow={showToolbar}
    options={PLACEMENT}
  >
    <FormattingButtons editor={editor} context={context} />
  </BubbleMenu>
);

export default FormattingToolbar;
