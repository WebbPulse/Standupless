/**
 * The date chip node: one calendar day inside running text, inserted from the
 * `/date` picker or the Date group of the `@` menu. It stores as the ISO day
 * in angle brackets, `<2026-10-01>`, documented in `lib/dateChips.ts`, and
 * draws as the day in the viewer's locale, relative when it is close, with
 * the full date on hover.
 */

import type { MarkdownToken } from '@tiptap/core';
import { Node } from '@tiptap/core';
import type { TokenizerExtension } from 'marked';
import {
  dateChipLabel,
  dateChipTitle,
  dateToken,
  isChipDate,
  leadingDateToken,
} from '../../lib/dateChips';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    dateChip: {
      /** Puts a date chip for an ISO day in place of a range, then a space. */
      insertDateChip: (
        value: string,
        range: { from: number; to: number }
      ) => ReturnType;
    };
  }
}

/** The node name a date chip is stored under. */
export const DATE_CHIP = 'dateChip';

/** The marked token a date chip reads from. */
interface DateChipToken extends MarkdownToken {
  value: string;
}

/** The marked inline tokenizer for a stored date chip. */
export const dateChipTokenizer: TokenizerExtension = {
  name: DATE_CHIP,
  level: 'inline',
  start(src) {
    const index = src.search(/<\d{4}-/);
    return index === -1 ? undefined : index;
  },
  tokenizer(src) {
    const found = leadingDateToken(src);
    if (found === null) return undefined;
    return {
      type: DATE_CHIP,
      raw: src.slice(0, found.length),
      value: found.value,
      tokens: [],
    };
  },
};

/** The value attribute of a node, as a string. */
const valueOf = (attrs: Record<string, unknown> | undefined): string =>
  typeof attrs?.['value'] === 'string' ? attrs['value'] : '';

/** The chip element, drawn fresh so its relative label is current. */
const chipElement = (value: string): HTMLElement => {
  const element = document.createElement('time');
  element.className = 'rich-date-chip';
  element.dateTime = value;
  element.title = dateChipTitle(value);
  element.textContent = dateChipLabel(value);
  element.setAttribute('data-date-chip', value);
  element.setAttribute('contenteditable', 'false');
  return element;
};

/** The date chip node. */
export const DateChip = Node.create({
  name: DATE_CHIP,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      value: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-date-chip') ?? '',
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-date-chip': valueOf(attributes),
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'time[data-date-chip]',
        getAttrs: (element) =>
          isChipDate(element.getAttribute('data-date-chip') ?? '')
            ? null
            : false,
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const value = valueOf(node.attrs);
    return [
      'time',
      { ...HTMLAttributes, datetime: value, title: dateChipTitle(value) },
      dateChipLabel(value),
    ];
  },

  renderText: ({ node }) => dateToken(valueOf(node.attrs)),

  parseMarkdown: (token, helpers) =>
    helpers.createNode(DATE_CHIP, { value: (token as DateChipToken).value }),

  renderMarkdown: (node) => dateToken(valueOf(node.attrs)),

  addNodeView() {
    return ({ node }) => ({ dom: chipElement(valueOf(node.attrs)) });
  },

  addCommands() {
    return {
      insertDateChip:
        (value, range) =>
        ({ chain }) =>
          isChipDate(value) &&
          chain()
            .insertContentAt(range, [
              { type: DATE_CHIP, attrs: { value } },
              { type: 'text', text: ' ' },
            ])
            .run(),
    };
  },
});
