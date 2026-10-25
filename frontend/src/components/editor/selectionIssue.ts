/**
 * Filing an issue from selected text, as Linear's selection toolbar does. The
 * first line of the selection becomes the title and the rest becomes the
 * description, read back as the Markdown it was written in. Once the issue
 * exists the selection is replaced by its key, which the editor draws as the
 * same chip a `#` reference leaves. Everything here is a plain text transform.
 */

import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { CreateIssueOptions } from '../../hooks/useCreateIssue';
import { TITLE_MAX } from '../../lib/validation';
import { readRangeMarkdown } from './markdownCodec';

/** Where an issue filed from a surface's selection lands and what it links to. */
export interface SelectionIssueSource {
  /** The team the dialog starts on, such as the host issue's or document's. */
  teamId?: string;
  /** The issue the text sits on, which the new issue relates to. */
  issueId?: string;
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

/** A title as the dialog accepts it: spaces collapsed and at most the limit. */
export const titleOfLine = (line: string): string =>
  line.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX).trimEnd();

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
