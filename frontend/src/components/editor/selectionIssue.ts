/**
 * Filing an issue from selected text, as Linear's selection toolbar does. The
 * first line of the selection becomes the title and the rest becomes the
 * description, read back as the Markdown it was written in. Once the issue
 * exists the selection is replaced by its key, which the editor draws as the
 * same chip a `#` reference leaves.
 *
 * A surface that sits on an issue also files sub-issues of it. A selection
 * made of two or more list items files one sub-issue per item at once, each
 * item's text replaced by its new key, and any other selection opens the
 * dialog on a sub-issue prefilled the same way a plain issue is.
 */

import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Mapping } from '@tiptap/pm/transform';
import type { Transaction } from '@tiptap/pm/state';
import type { CreateIssueOptions } from '../../hooks/useCreateIssue';
import {
  createSubIssues,
  resolveSubIssueParent,
  type SubIssueParent,
} from '../../lib/subIssueCreation';
import { errorMessage } from '../../lib/errors';
import { titleOfLine } from '../../lib/subIssueLines';
import { showErrorToast } from '../../lib/toast';
import { readRangeMarkdown } from './markdownCodec';

export { titleOfLine };

/** Where an issue filed from a surface's selection lands and what it links to. */
export interface SelectionIssueSource {
  /** The team the dialog starts on, such as the host issue's or document's. */
  teamId?: string;
  /** The issue the text sits on, which the new issue relates to. */
  issueId?: string;
  /** The issue sub-issues filed from the selection hang off. Unset offers none. */
  parent?: SubIssueParent;
}

/** The title and description a selection fills the create dialog with. */
export interface SelectionPrefill {
  title: string;
  description: string;
}

/** A selected range and the text it held, to check it before replacing it. */
export interface SelectedRange {
  from: number;
  to: number;
  text: string;
}

/** The end of a line and where the text after it starts. */
interface LineBreak {
  end: number;
  rest: number;
}

/**
 * Where the first line of a range ends: at its first hard break, or at the end
 * of the first block it touches, whichever comes first.
 */
const firstLine = (
  doc: ProseMirrorNode,
  from: number,
  to: number
): LineBreak => {
  const found: LineBreak[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (found.length > 0) return false;
    if (!node.isTextblock) return true;
    const start = pos + 1;
    let end = Math.min(pos + node.nodeSize - 1, to);
    let rest = Math.min(pos + node.nodeSize, to);
    node.forEach((child, offset) => {
      const at = start + offset;
      if (child.type.name === 'hardBreak' && at >= from && at < end) {
        end = at;
        rest = Math.min(at + child.nodeSize, to);
      }
    });
    found.push({ end, rest });
    return false;
  });
  return found[0] ?? { end: to, rest: to };
};

/**
 * The prefill a selected range gives: its first line with text in it as the
 * title, and everything after that line as Markdown for the description.
 */
export const selectionPrefill = (
  editor: Editor,
  from: number,
  to: number
): SelectionPrefill => {
  const { doc } = editor.state;
  let start = from;
  while (start < to) {
    const line = firstLine(doc, start, to);
    const title = titleOfLine(doc.textBetween(start, line.end, ' ', ' '));
    if (title !== '') {
      return {
        title,
        description: readRangeMarkdown(editor, line.rest, to),
      };
    }
    if (line.rest <= start) break;
    start = line.rest;
  }
  return { title: '', description: '' };
};

/** The text of a range, as {@link SelectedRange} holds it. */
const rangeText = (editor: Editor, from: number, to: number): string =>
  editor.state.doc.textBetween(from, to, '\n', ' ');

/**
 * Replaces a selected range with an issue key, when the range still holds the
 * text it was selected with. Answers whether it was replaced.
 */
export const replaceWithIssueKey = (
  editor: Editor,
  range: SelectedRange,
  key: string
): boolean => {
  if (editor.isDestroyed) return false;
  if (range.to > editor.state.doc.content.size) return false;
  if (rangeText(editor, range.from, range.to) !== range.text) return false;
  return editor
    .chain()
    .insertContentAt({ from: range.from, to: range.to }, key)
    .run();
};

/**
 * Opens the create dialog on the editor's selection, prefilled from it, with
 * the selection replaced by the new issue's key once it is filed. Cancelling
 * the dialog leaves the text as it was. Answers whether the dialog opened.
 */
export const createIssueFromSelection = (
  editor: Editor,
  source: SelectionIssueSource,
  open: (options: CreateIssueOptions) => void
): boolean => {
  const { from, to } = editor.state.selection;
  const prefill = selectionPrefill(editor, from, to);
  if (prefill.title === '') return false;
  const range: SelectedRange = { from, to, text: rangeText(editor, from, to) };
  open({
    ...(source.teamId === undefined ? {} : { teamId: source.teamId }),
    ...(source.issueId === undefined ? {} : { relatedIssueId: source.issueId }),
    title: prefill.title,
    ...(prefill.description === '' ? {} : { description: prefill.description }),
    onCreated: (issue) => {
      replaceWithIssueKey(editor, range, issue.key);
    },
  });
  return true;
};

/** The node types whose first text block is one list item's line. */
const LIST_ITEMS: ReadonlySet<string> = new Set(['listItem', 'taskItem']);

/** One list item's line inside a selection, and the title it gives. */
export interface SelectedListItem extends SelectedRange {
  title: string;
}

/**
 * The list items a range is made of, in document order, nested ones included,
 * or an empty list when the range takes text from any text block that is not
 * the line of a list item. Items whose line holds no text are skipped, and so
 * are blocks the range only grazes, such as an empty trailing paragraph.
 */
export const selectedListItems = (
  doc: ProseMirrorNode,
  from: number,
  to: number
): SelectedListItem[] => {
  const heads = new Set<number>();
  const items: SelectedListItem[] = [];
  let mixed = false;
  doc.nodesBetween(from, to, (node, pos) => {
    if (mixed) return false;
    if (LIST_ITEMS.has(node.type.name)) {
      const head = node.firstChild;
      if (head?.isTextblock === true) {
        const start = pos + 2;
        const end = start + head.content.size;
        heads.add(pos + 1);
        if (end > from && start < to) {
          const text = doc.textBetween(start, end, '\n', ' ');
          const title = titleOfLine(text);
          if (title !== '') items.push({ from: start, to: end, text, title });
        }
      }
      return true;
    }
    if (node.isTextblock) {
      if (!heads.has(pos)) {
        const start = Math.max(from, pos + 1);
        const end = Math.min(to, pos + 1 + node.content.size);
        mixed = end > start && doc.textBetween(start, end).trim() !== '';
      }
      return false;
    }
    return true;
  });
  return mixed ? [] : items;
};

/** Whether the editor's selection is two or more list items, one per sub-issue. */
export const isListSelection = (editor: Editor): boolean => {
  const { selection, doc } = editor.state;
  if (selection.empty) return false;
  return selectedListItems(doc, selection.from, selection.to).length >= 2;
};

/**
 * Follows every change the editor makes while a run is out, so ranges read
 * before it map onto the document as it stands when the run lands.
 */
const trackChanges = (
  editor: Editor
): { mapping: Mapping; stop: () => void } => {
  const mapping = new Mapping();
  const listen = ({ transaction }: { transaction: Transaction }): void => {
    mapping.appendMapping(transaction.mapping);
  };
  editor.on('transaction', listen);
  return {
    mapping,
    stop: () => {
      editor.off('transaction', listen);
    },
  };
};

/**
 * Files one sub-issue per selected list item, in order, and replaces each
 * item's text with its new key, skipping any item edited in the meantime.
 * Answers whether there were items to file.
 */
export const createSubIssuesFromList = (
  editor: Editor,
  workspaceId: string,
  parent: SubIssueParent
): boolean => {
  const { from, to } = editor.state.selection;
  const items = selectedListItems(editor.state.doc, from, to);
  if (items.length < 2) return false;
  const tracking = trackChanges(editor);
  void createSubIssues(
    workspaceId,
    parent,
    items.map((item) => ({ title: item.title }))
  )
    .then(({ created }) => {
      if (editor.isDestroyed) return;
      const placed = created.flatMap((issue, at) => {
        const item = items[at];
        if (item === undefined) return [];
        const mapped = tracking.mapping.mapResult(item.from, 1);
        const end = tracking.mapping.mapResult(item.to, -1);
        if (mapped.deleted || end.deleted) return [];
        return [
          { from: mapped.pos, to: end.pos, text: item.text, key: issue.key },
        ];
      });
      for (const range of placed.reverse()) {
        replaceWithIssueKey(editor, range, range.key);
      }
    })
    .finally(() => {
      tracking.stop();
    });
  return true;
};

/**
 * Opens the create dialog on a sub-issue of the parent, prefilled from the
 * selection and inheriting the parent's team, priority and project, with the
 * selection replaced by the new key once it is filed. Answers whether the
 * selection held a title to start from.
 */
export const createSubIssueFromSelection = (
  editor: Editor,
  workspaceId: string,
  parent: SubIssueParent,
  open: (options: CreateIssueOptions) => void
): boolean => {
  const { from, to } = editor.state.selection;
  const prefill = selectionPrefill(editor, from, to);
  if (prefill.title === '') return false;
  const range: SelectedRange = { from, to, text: rangeText(editor, from, to) };
  const tracking = trackChanges(editor);
  void resolveSubIssueParent(workspaceId, parent)
    .then((resolved) => {
      tracking.stop();
      const start = tracking.mapping.map(range.from, 1);
      const end = tracking.mapping.map(range.to, -1);
      open({
        teamId: resolved.teamId,
        parentId: resolved.id,
        parentKey: resolved.key,
        ...(resolved.priority === 'none'
          ? {}
          : { priority: resolved.priority }),
        ...(resolved.projectId === null
          ? {}
          : { projectId: resolved.projectId }),
        title: prefill.title,
        ...(prefill.description === ''
          ? {}
          : { description: prefill.description }),
        onCreated: (issue) => {
          replaceWithIssueKey(
            editor,
            { from: start, to: end, text: range.text },
            issue.key
          );
        },
      });
    })
    .catch((cause: unknown) => {
      tracking.stop();
      showErrorToast(errorMessage(cause, 'Could not read the parent issue.'));
    });
  return true;
};

/**
 * Files sub-issues from the selection: one per item when it is a list, else
 * one through the dialog. Answers whether the selection was taken.
 */
export const subIssuesFromSelection = (
  editor: Editor,
  workspaceId: string,
  parent: SubIssueParent,
  open: (options: CreateIssueOptions) => void
): boolean =>
  !editor.state.selection.empty &&
  (createSubIssuesFromList(editor, workspaceId, parent) ||
    createSubIssueFromSelection(editor, workspaceId, parent, open));
