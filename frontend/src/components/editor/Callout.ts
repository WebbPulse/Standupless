/**
 * Callouts, Linear's highlighted note blocks: any block content set off in a
 * tinted box with an icon for its kind, note, tip, important, warning or
 * danger. The slash command makes one around the current line, a small kind
 * switcher shows while the pointer is over it, and Backspace at the start of
 * its first line takes the box away and keeps the text.
 *
 * The stored form is GitHub's alert syntax, a quote opened by `> [!NOTE]` or
 * one of its siblings, so GitHub sync, the API, MCP, exports and the static
 * renderer all read a callout of the same kind rather than editor markup. An
 * alert pasted from a GitHub page arrives as a callout as well.
 */

import type { Editor, JSONContent, MarkdownToken } from '@tiptap/core';
import { Node } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection, type Transaction } from '@tiptap/pm/state';
import {
  CALLOUT_KINDS,
  CALLOUT_LABELS,
  DEFAULT_CALLOUT_KIND,
  calloutFromQuote,
  isCalloutKind,
  writeCallout,
  type CalloutKind,
} from '../../lib/callouts';
import { calloutIconElement } from '../ui/calloutIcons';
import '../ui/callout.css';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /**
       * Wraps the block at the caret in a callout of a kind, or changes the
       * kind of the callout the caret is already in.
       */
      setCallout: (kind?: CalloutKind) => ReturnType;
      /** Changes the kind of the callout at a position. */
      setCalloutKind: (position: number, kind: CalloutKind) => ReturnType;
      /** Takes the callout around the caret away, keeping its blocks. */
      unsetCallout: () => ReturnType;
    };
  }
}

/** The node name a callout is stored under. */
const CALLOUT = 'callout';

/** A quote line, and the text after its marker. */
const QUOTE_LINE = /^ {0,3}>[ \t]?(.*)$/;

/** Where a callout's marker line can start in a run of source. */
const MARKER_START =
  /^ {0,3}>[ \t]?\[!(?:note|tip|important|warning|caution)\]/im;

/** The kind GitHub's rendered alert class names. */
const ALERT_CLASS = /\bmarkdown-alert-(note|tip|important|warning|caution)\b/;

/** A node's kind, reading anything unknown as the default. */
const kindOf = (node: ProseMirrorNode): CalloutKind => {
  const kind: unknown = node.attrs['kind'];
  return isCalloutKind(kind) ? kind : DEFAULT_CALLOUT_KIND;
};

/** The kind of a GitHub alert element, by its class. */
const alertKind = (element: HTMLElement): CalloutKind => {
  const found = ALERT_CLASS.exec(element.className)?.[1];
  if (found === 'caution') return 'danger';
  return isCalloutKind(found) ? found : DEFAULT_CALLOUT_KIND;
};

/** The callout the caret sits directly in, and where it starts. */
const calloutAround = (
  tr: Transaction
): { node: ProseMirrorNode; pos: number } | null => {
  const { $from } = tr.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === CALLOUT) return { node, pos: $from.before(depth) };
  }
  return null;
};

/** Replaces a callout with the blocks it holds, keeping the caret's place. */
const unwrap = (tr: Transaction, node: ProseMirrorNode, pos: number): void => {
  const offset = tr.selection.from - pos - 1;
  tr.replaceWith(pos, pos + node.nodeSize, node.content);
  const target = Math.max(0, Math.min(pos + offset, tr.doc.content.size));
  tr.setSelection(TextSelection.near(tr.doc.resolve(target)));
};

/** Backspace at the start of a callout's first block takes the callout away. */
const backspace = (editor: Editor): boolean => {
  const { state, view } = editor;
  const { selection } = state;
  if (!selection.empty) return false;
  const { $from } = selection;
  if ($from.parentOffset !== 0 || $from.depth < 2) return false;
  const holder = $from.node($from.depth - 1);
  if (holder.type.name !== CALLOUT || $from.index($from.depth - 1) !== 0) {
    return false;
  }
  const tr = state.tr;
  unwrap(tr, holder, $from.before($from.depth - 1));
  view.dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Enter on an empty last line of a callout leaves it, onto the empty line
 * after it when there is one, so a callout ends the way a list does.
 */
const enter = (editor: Editor): boolean => {
  const { state, view } = editor;
  const { selection, schema } = state;
  const paragraph = schema.nodes['paragraph'];
  if (!selection.empty || paragraph === undefined) return false;
  const { $from } = selection;
  if ($from.parent.type !== paragraph || $from.parent.content.size > 0) {
    return false;
  }
  if ($from.depth < 2) return false;
  const holder = $from.node($from.depth - 1);
  const index = $from.index($from.depth - 1);
  if (
    holder.type.name !== CALLOUT ||
    holder.childCount < 2 ||
    index !== holder.childCount - 1
  ) {
    return false;
  }
  const calloutPos = $from.before($from.depth - 1);
  const tr = state.tr.delete($from.before(), $from.after());
  const after = tr.mapping.map(calloutPos + holder.nodeSize);
  const next = tr.doc.nodeAt(after);
  if (next?.type !== paragraph || next.content.size > 0) {
    tr.insert(after, paragraph.create());
  }
  tr.setSelection(TextSelection.create(tr.doc, after + 1));
  view.dispatch(tr.scrollIntoView());
  return true;
};

/** The marked token a callout reads from. */
interface CalloutToken extends MarkdownToken {
  kind: CalloutKind;
  tokens: MarkdownToken[];
}

/** The callout node: its kind, its blocks, the switcher and the stored form. */
export const Callout = Node.create({
  name: CALLOUT,
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: DEFAULT_CALLOUT_KIND,
        parseHTML: (element) => {
          const kind = element.getAttribute('data-kind');
          return isCalloutKind(kind) ? kind : alertKind(element);
        },
        renderHTML: (attributes) => ({
          'data-kind': isCalloutKind(attributes['kind'])
            ? attributes['kind']
            : DEFAULT_CALLOUT_KIND,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: `div[data-type="${CALLOUT}"]`,
        contentElement: (element) =>
          (element as HTMLElement).querySelector<HTMLElement>(
            ':scope > .callout-body'
          ) ?? (element as HTMLElement),
      },
      {
        tag: 'div.markdown-alert',
        contentElement: (element) => {
          const body = (element as HTMLElement).cloneNode(true) as HTMLElement;
          body.querySelector('.markdown-alert-title')?.remove();
          return body;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      { ...HTMLAttributes, 'data-type': CALLOUT, class: 'callout' },
      ['div', { class: 'callout-body' }, 0],
    ];
  },

  markdownTokenizer: {
    name: CALLOUT,
    level: 'block',
    start: (src) => {
      const found = MARKER_START.exec(src);
      return found === null ? -1 : found.index;
    },
    tokenize: (src, _tokens, lexer) => {
      const lines = src.split('\n');
      const body: string[] = [];
      for (const line of lines) {
        const quoted = QUOTE_LINE.exec(line);
        if (quoted === null) break;
        body.push(quoted[1] ?? '');
      }
      const callout = calloutFromQuote(body);
      if (callout === null) return undefined;
      const consumed = lines.slice(0, body.length).join('\n');
      const raw =
        src.length > consumed.length && src[consumed.length] === '\n'
          ? `${consumed}\n`
          : consumed;
      const token: CalloutToken = {
        type: CALLOUT,
        raw,
        kind: callout.kind,
        tokens: callout.body === '' ? [] : lexer.blockTokens(callout.body),
      };
      return token;
    },
  },

  parseMarkdown: (token, helpers) => {
    const { kind, tokens } = token as CalloutToken;
    const parse = helpers.parseBlockChildren ?? helpers.parseChildren;
    const body = parse(tokens);
    return helpers.createNode(
      CALLOUT,
      { kind },
      body.length === 0 ? [helpers.createNode('paragraph')] : body
    );
  },

  renderMarkdown: (node, helpers) => {
    const kind: unknown = node.attrs?.['kind'];
    return writeCallout(
      isCalloutKind(kind) ? kind : DEFAULT_CALLOUT_KIND,
      helpers.renderChildren(
        (node.content ?? []).filter(
          (child: JSONContent) =>
            child.type !== 'paragraph' || (child.content ?? []).length > 0
        ),
        '\n\n'
      )
    );
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'callout';
      dom.dataset['type'] = CALLOUT;
      const icon = document.createElement('span');
      icon.className = 'callout-icon';
      icon.contentEditable = 'false';
      const content = document.createElement('div');
      content.className = 'callout-body';
      const switcher = document.createElement('div');
      switcher.className = 'callout-switcher';
      switcher.contentEditable = 'false';
      switcher.setAttribute('role', 'toolbar');
      switcher.setAttribute('aria-label', 'Callout kind');
      const options = CALLOUT_KINDS.map((kind) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'callout-switcher-option';
        option.dataset['kind'] = kind;
        option.title = CALLOUT_LABELS[kind];
        option.setAttribute('aria-label', CALLOUT_LABELS[kind]);
        option.append(calloutIconElement(kind));
        option.addEventListener('mousedown', (event) => {
          event.preventDefault();
        });
        option.addEventListener('click', (event) => {
          event.preventDefault();
          const pos = getPos();
          if (typeof pos !== 'number') return;
          editor.commands.setCalloutKind(pos, kind);
        });
        return option;
      });
      switcher.append(...options);
      dom.append(icon, content, switcher);

      let drawn: CalloutKind | null = null;
      const draw = (): void => {
        switcher.hidden = !editor.isEditable;
        const kind = kindOf(current);
        if (kind === drawn) return;
        drawn = kind;
        dom.dataset['kind'] = kind;
        dom.setAttribute('aria-label', CALLOUT_LABELS[kind]);
        icon.replaceChildren(calloutIconElement(kind));
        for (const option of options) {
          option.setAttribute(
            'aria-pressed',
            option.dataset['kind'] === kind ? 'true' : 'false'
          );
        }
      };
      draw();

      const outside = (target: EventTarget | null): boolean =>
        target instanceof globalThis.Node &&
        (switcher.contains(target) || icon.contains(target));

      return {
        dom,
        contentDOM: content,
        stopEvent: (event) => outside(event.target),
        ignoreMutation: (mutation) =>
          mutation.type !== 'selection' &&
          (outside(mutation.target) ||
            (mutation.type === 'attributes' && mutation.target === dom)),
        update: (updated) => {
          if (updated.type !== current.type) return false;
          current = updated;
          draw();
          return true;
        },
      };
    };
  },

  addCommands() {
    return {
      setCallout:
        (kind = DEFAULT_CALLOUT_KIND) =>
        ({ tr, dispatch, commands }) => {
          const found = calloutAround(tr);
          if (found === null) return commands.wrapIn(CALLOUT, { kind });
          if (dispatch !== undefined) {
            tr.setNodeMarkup(found.pos, undefined, {
              ...found.node.attrs,
              kind,
            });
          }
          return true;
        },
      setCalloutKind:
        (position, kind) =>
        ({ tr, dispatch }) => {
          const callout = tr.doc.nodeAt(position);
          if (callout?.type.name !== CALLOUT) return false;
          if (dispatch !== undefined) {
            tr.setNodeMarkup(position, undefined, { ...callout.attrs, kind });
          }
          return true;
        },
      unsetCallout:
        () =>
        ({ tr, dispatch }) => {
          const found = calloutAround(tr);
          if (found === null) return false;
          if (dispatch !== undefined) unwrap(tr, found.node, found.pos);
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => backspace(editor),
      Enter: ({ editor }) => enter(editor),
    };
  },
});
