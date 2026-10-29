/**
 * The editor schema behind every rich Markdown surface, and the Markdown
 * dialect it reads and writes. Storage stays plain Markdown, so the API, the
 * share view, GitHub sync and email never learn the editor exists; this module
 * is where the editor is held to that promise.
 *
 * Tiptap's Markdown serializer is tuned for documents that only it reads back.
 * Standupless Markdown is also read by the small parser in `lib/markdown.ts`,
 * by GitHub and by email, so four behaviours are adjusted here:
 *
 * - Raw HTML is never interpreted. `<div>` in a description stays the text
 *   `<div>`, as the static renderer shows it, instead of being parsed into the
 *   document or dropped.
 * - Text is escaped only when it would otherwise read as formatting, so
 *   `snake_case` and `2 * 3` survive a save untouched rather than gaining
 *   backslashes and `&lt;` entities.
 * - A single newline is a line break, matching the static renderer.
 * - An empty paragraph writes nothing, rather than the `&nbsp;` Tiptap uses to
 *   keep blank lines, so repeated blank lines collapse as they do in Linear
 *   and no entity reaches a reader that shows it as text.
 *
 * Code blocks are highlighted, with a language picker and a copy button on
 * each, and keep the fence language they were read with.
 *
 * Images and videos are the one image node, shown through the page's media
 * tokens, and a link may point at an attachment's content path as well as the
 * web. A YouTube, Loom, Vimeo or Descript link alone in its paragraph reads as
 * that provider's player and writes back as the bare link. A date chip reads
 * and writes as its ISO day in angle brackets, such as `<2026-10-01>`. An
 * equation reads and writes as `$...$` inside a line and a `$$` fence on lines
 * of its own, and plain text that would read as one has its `$` escaped.
 */

import type { AnyExtension, JSONContent } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import HardBreak from '@tiptap/extension-hard-break';
import Link from '@tiptap/extension-link';
import Paragraph from '@tiptap/extension-paragraph';
import { TaskItem } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Markdown, type MarkdownManager } from '@tiptap/markdown';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import {
  Decoration,
  DecorationSet,
  type EditorView,
} from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { Marked, type Token } from 'marked';
import { codeSpanIssueKey } from '../../lib/issueDisplay';
import { isLinkTarget } from '../../lib/markdown';
import { escapeInlineMath } from '../../lib/math';
import { BlockHandle } from './blockHandle';
import { Callout } from './Callout';
import { HighlightedCodeBlock } from './codeBlock';
import { CollapsibleSectionKit } from './CollapsibleSection';
import { CustomEmojiChips } from './customEmojiChips';
import { DateChip, dateChipTokenizer } from './dateChip';
import {
  EditorShortcuts,
  LinearOrderedList,
  LinearTaskList,
} from './editorShortcuts';
import { DocumentLinkSuggestion } from './DocumentLinkSuggestion';
import { EmojiSuggestion } from './EmojiSuggestion';
import { EmoticonConversion } from './emoticons';
import { BlockMath, InlineMath, inlineMathTokenizer } from './mathNodes';
import { MediaImage, MediaUpload } from './mediaNodes';
import { SpreadsheetPaste } from './tablePaste';
import { TableShortcut } from './tableShortcut';
import { VideoEmbed, VideoEmbedPaste, videoEmbedTokenizer } from './videoEmbed';

/** What {@link markdownExtensions} can be asked to vary per surface. */
export interface MarkdownExtensionOptions {
  /** Shown in an empty document. Omitted for read-only surfaces. */
  placeholder?: string;
  /**
   * Whether text shaped like an issue key names one of the workspace's teams,
   * so it is drawn as a chip while editing. Unset draws no key chips.
   */
  isIssueKey?: (key: string) => boolean;
  /**
   * Whether a link points at a project or document of the workspace, so it is
   * drawn as a chip while editing. Unset draws no link chips.
   */
  isReferenceLink?: (href: string) => boolean;
  /**
   * How a mentioned issue looks once it is read, or undefined while it is read
   * and when it names nothing the reader can see. Set, a key is drawn as a
   * chip only once it resolves, and inline code holding nothing but a key is
   * drawn as one too; unset, every key naming a team is marked.
   */
  issueLook?: (key: string) => IssueLook | undefined;
}

/** What the editor draws a resolved issue mention from. */
export interface IssueLook {
  /** The issue's title, shown truncated after the key. */
  title: string;
  /** The status glyph, cloned in front of the key, or null when not yet drawn. */
  icon: Element | null;
  /** Changes whenever the title or glyph does, so an unchanged chip is reused. */
  signature: string;
}

/** What the reference chips plugin holds between transactions. */
interface ReferenceChipState {
  /** The chips as drawn. */
  decorations: DecorationSet;
  /**
   * The caret while text is being typed at it, so a key still being written
   * there stays text rather than closing into a chip, or null.
   */
  typing: number | null;
}

/**
 * The meta a transaction carries to redraw the reference chips when what
 * counts as a reference changed, such as the team list arriving, while the
 * document itself did not.
 */
export const referenceChipsKey = new PluginKey<ReferenceChipState>(
  'referenceChips'
);

/** The @mention shape the server resolves, as `lib/markdown.ts` reads it. */
const MENTION = /(?<![\w@/])@([A-Za-z0-9][A-Za-z0-9_-]{0,38})(?![\w-])/g;

/** The issue key shape `lib/markdown.ts` reads as a reference. */
const ISSUE_KEY = /(?<![\w/-])([A-Z][A-Z0-9]{1,5}-\d{1,9})(?![\w-])/g;

/**
 * A marked instance of our own, so registering Tiptap's tokenizers never
 * touches the global one, with raw HTML switched off, single newlines read
 * as breaks, a bare video link alone in its paragraph read as an embed,
 * `<2026-10-01>` read as a date chip and `$x^2$` read as an equation.
 */
const createMarked = (): Marked => {
  const instance = new Marked({ gfm: true, breaks: true });
  const refuse = (): undefined => undefined;
  instance.use({
    tokenizer: {
      html: refuse,
      tag: refuse,
    },
    extensions: [videoEmbedTokenizer, dateChipTokenizer, inlineMathTokenizer],
  });
  return instance;
};

/** Whether every token is plain text, so the source can be kept verbatim. */
const onlyText = (tokens: Token[]): boolean =>
  tokens.every((token) => token.type === 'text');

/** The private hook the manager escapes each text run through. */
interface Encoder {
  encodeTextForMarkdown: (
    text: string,
    node: JSONContent,
    parent?: JSONContent
  ) => string;
}

/**
 * Makes the manager write a text run verbatim whenever marked would read it
 * back as the same plain text, and fall back to its own escaping otherwise.
 * Outside code, a `$` that would open an equation is escaped.
 */
const preferVerbatimText = (
  manager: MarkdownManager,
  instance: Marked
): void => {
  const encoder = manager as unknown as Encoder;
  const escape = encoder.encodeTextForMarkdown.bind(manager);
  encoder.encodeTextForMarkdown = (text, node, parent) => {
    const inCode = escape('\\', node, parent) === '\\';
    const escaped = inCode
      ? escape(text, node, parent)
      : escapeInlineMath(escape(text, node, parent));
    if (escaped === text || text.includes('\\')) return escaped;
    const tokens = new instance.Lexer(instance.defaults).inlineTokens(text);
    const verbatim =
      onlyText(tokens) && tokens.map((token) => token.raw).join('') === text;
    return verbatim ? text : escaped;
  };
};

/** The Markdown extension with the Standupless dialect applied. */
const StanduplessMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    this.parent?.(event);
    const manager = this.editor.markdown;
    if (manager !== undefined) {
      preferVerbatimText(manager, manager.instance as unknown as Marked);
    }
  },
});

/** A hard break written as the single newline the static renderer reads. */
const NewlineBreak = HardBreak.extend({
  renderMarkdown: () => '\n',
});

/**
 * A paragraph whose empty form writes nothing. Tiptap writes `&nbsp;` for the
 * second and later blank paragraphs in a run, which every other reader of the
 * stored text shows literally; the blank lines left behind collapse in
 * `readMarkdown`.
 */
const CollapsingParagraph = Paragraph.extend({
  renderMarkdown: (node, helpers) =>
    Array.isArray(node.content) && node.content.length > 0
      ? helpers.renderChildren(node.content)
      : '',
});

/** Finds each @mention in the document and marks it for the chip style. */
const mentionDecorations = (doc: ProseMirrorNode): DecorationSet => {
  const found: Decoration[] = [];
  doc.descendants((node, position) => {
    if (!node.isText || node.text === undefined) return;
    if (node.marks.some((mark) => ['code', 'link'].includes(mark.type.name))) {
      return;
    }
    for (const match of node.text.matchAll(MENTION)) {
      const start = position + match.index;
      found.push(
        Decoration.inline(start, start + match[0].length, {
          class: 'rich-mention',
        })
      );
    }
  });
  return DecorationSet.create(doc, found);
};

/**
 * Shows @mentions as chips without making them nodes, so the stored text is
 * exactly what was typed and nothing has to round trip.
 */
const MentionChips = Extension.create({
  name: 'mentionChips',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('mentionChips'),
        state: {
          init: (_, state) => mentionDecorations(state.doc),
          apply: (transaction, held) =>
            transaction.docChanged ? mentionDecorations(transaction.doc) : held,
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});

/** What the reference chips are drawn from. */
interface ReferenceChipOptions {
  isIssueKey?: (key: string) => boolean;
  isReferenceLink?: (href: string) => boolean;
  issueLook?: (key: string) => IssueLook | undefined;
}

/** A part of a mention chip, as a span with `className`. */
const chipPart = (className: string): HTMLElement => {
  const element = document.createElement('span');
  element.className = className;
  return element;
};

/**
 * The one chip a resolved mention is drawn as: the status glyph, the key in
 * muted text and the truncated title, in a single box that never wraps, so
 * the text line flows around it as around a word.
 */
const issueChip = (key: string, look: IssueLook): HTMLElement => {
  const chip = chipPart('rich-issue-ref rich-issue-chip');
  chip.setAttribute('data-issue-key', key);
  chip.setAttribute('data-issue-open', '');
  chip.contentEditable = 'false';
  if (look.icon !== null) {
    const icon = chipPart('rich-issue-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.append(look.icon.cloneNode(true));
    chip.append(icon);
  }
  const label = chipPart('rich-issue-key');
  label.setAttribute('aria-hidden', 'true');
  label.textContent = key;
  const title = chipPart('rich-issue-title');
  title.textContent = look.title;
  chip.title = `${key} ${look.title}`;
  chip.append(label, title);
  return chip;
};

/**
 * The decorations drawing one mention: the chip in front of the key, and the
 * key itself shrunk out of sight behind it, so the stored text is untouched
 * while the caret steps over the pair as one atom. Nothing is drawn until the
 * mention resolves, so an unknown key stays the text it was written as.
 */
const issueChipDecorations = (
  start: number,
  key: string,
  look: IssueLook
): Decoration[] => [
  Decoration.widget(start, () => issueChip(key, look), {
    side: 1,
    marks: [],
    ignoreSelection: true,
    key: `issue-chip:${key}:${look.signature}`,
  }),
  Decoration.inline(
    start,
    start + key.length,
    { class: 'rich-issue-source' },
    { issueChip: true }
  ),
];

/**
 * Finds each issue key naming a team, and each link to a project or document,
 * and marks it for the chip style. Code is skipped, as the renderer skips it.
 */
const referenceDecorations = (
  doc: ProseMirrorNode,
  options: ReferenceChipOptions,
  typing: number | null = null
): DecorationSet => {
  const { isIssueKey, isReferenceLink, issueLook } = options;
  const found: Decoration[] = [];
  doc.descendants((node, position) => {
    if (!node.isText || node.text === undefined) return;
    if (node.marks.some((mark) => mark.type.name === 'code')) {
      const key = codeSpanIssueKey(node.text);
      const look =
        key === null || isIssueKey?.(key) !== true
          ? undefined
          : issueLook?.(key);
      const start = key === null ? -1 : position + node.text.indexOf(key);
      if (
        key !== null &&
        look !== undefined &&
        start + key.length !== typing
      ) {
        found.push(...issueChipDecorations(start, key, look));
      }
      return;
    }
    const link = node.marks.find((mark) => mark.type.name === 'link');
    if (link !== undefined) {
      const href = (link.attrs as { href?: unknown }).href;
      if (
        isReferenceLink !== undefined &&
        typeof href === 'string' &&
        isReferenceLink(href)
      ) {
        found.push(
          Decoration.inline(position, position + node.nodeSize, {
            class: 'rich-reference',
          })
        );
      }
      return;
    }
    if (isIssueKey === undefined) return;
    for (const match of node.text.matchAll(ISSUE_KEY)) {
      if (!isIssueKey(match[0])) continue;
      const start = position + match.index;
      if (issueLook !== undefined) {
        const look = issueLook(match[0]);
        if (look !== undefined && start + match[0].length !== typing) {
          found.push(...issueChipDecorations(start, match[0], look));
        }
        continue;
      }
      found.push(
        Decoration.inline(start, start + match[0].length, {
          class: 'rich-reference rich-issue-ref',
          'data-issue-key': match[0],
        })
      );
    }
  });
  return DecorationSet.create(doc, found);
};

/**
 * Every issue key in `doc` that `isIssueKey` accepts, uppercased, each once
 * and in order, counting inline code holding nothing but a key and leaving
 * out keys inside links and other code, as the chips do.
 */
export const issueKeysIn = (
  doc: ProseMirrorNode,
  isIssueKey: (key: string) => boolean
): string[] => {
  const keys = new Set<string>();
  doc.descendants((node) => {
    if (!node.isText || node.text === undefined) return;
    if (node.marks.some((mark) => mark.type.name === 'code')) {
      const key = codeSpanIssueKey(node.text);
      if (key !== null && isIssueKey(key)) keys.add(key);
      return;
    }
    if (node.marks.some((mark) => mark.type.name === 'link')) return;
    for (const match of node.text.matchAll(ISSUE_KEY)) {
      if (isIssueKey(match[0])) keys.add(match[0]);
    }
  });
  return [...keys];
};

/** The stretch of document one drawn issue chip stands over. */
interface ChipSpan {
  from: number;
  to: number;
}

/** Every drawn issue chip touching `from` to `to` in `state`. */
const chipSpans = (state: EditorState, from: number, to: number): ChipSpan[] =>
  (referenceChipsKey.getState(state)?.decorations ?? DecorationSet.empty)
    .find(from, to, (spec: { issueChip?: boolean }) => spec.issueChip === true)
    .map((found) => ({ from: found.from, to: found.to }));

/** The issue chip `position` falls strictly inside, if any. */
const chipAround = (state: EditorState, position: number): ChipSpan | null =>
  chipSpans(state, position, position).find(
    (span) => span.from < position && position < span.to
  ) ?? null;

/** The issue chip starting or ending at `position`, by `edge`. */
const chipAt = (
  state: EditorState,
  position: number,
  edge: 'from' | 'to'
): ChipSpan | null =>
  chipSpans(state, position, position).find(
    (span) => span[edge] === position
  ) ?? null;

/** Text that would run into a key beside it and stop it reading as one. */
const JOINS_KEY_AFTER = /^[\w-]/;
const JOINS_KEY_BEFORE = /[\w/-]$/;

/**
 * Moves the caret, or extends the selection, across the chip beside it with
 * the arrow keys, and removes the whole chip with Backspace or Delete.
 */
const stepOverChip = (view: EditorView, event: KeyboardEvent): boolean => {
  if (event.altKey || event.metaKey || event.ctrlKey) return false;
  const { state } = view;
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return false;
  const head = selection.head;
  const move = (chip: ChipSpan | null, target: 'from' | 'to'): boolean => {
    if (chip === null) return false;
    const anchor = event.shiftKey ? selection.anchor : chip[target];
    view.dispatch(
      state.tr
        .setSelection(TextSelection.create(state.doc, anchor, chip[target]))
        .scrollIntoView()
    );
    return true;
  };
  const remove = (chip: ChipSpan | null): boolean => {
    if (chip === null) return false;
    view.dispatch(state.tr.delete(chip.from, chip.to).scrollIntoView());
    return true;
  };
  if (!event.shiftKey && !selection.empty) return false;
  switch (event.key) {
    case 'ArrowRight':
      return move(chipAt(state, head, 'from'), 'to');
    case 'ArrowLeft':
      return move(chipAt(state, head, 'to'), 'from');
    case 'Backspace':
      return !event.shiftKey && remove(chipAt(state, head, 'to'));
    case 'Delete':
      return !event.shiftKey && remove(chipAt(state, head, 'from'));
    default:
      return false;
  }
};

/**
 * Types text beside a chip with a space between, when the text would
 * otherwise join the key and turn the chip back into plain text.
 */
const typeBesideChip = (
  view: EditorView,
  from: number,
  to: number,
  text: string
): boolean => {
  if (from !== to) return false;
  const { state } = view;
  if (chipAt(state, from, 'to') !== null && JOINS_KEY_AFTER.test(text)) {
    view.dispatch(state.tr.insertText(` ${text}`, from));
    return true;
  }
  if (chipAt(state, from, 'from') !== null && JOINS_KEY_BEFORE.test(text)) {
    const tr = state.tr.insertText(`${text} `, from);
    view.dispatch(
      tr.setSelection(TextSelection.create(tr.doc, from + text.length))
    );
    return true;
  }
  return false;
};

/**
 * The caret when `transaction` is text typed at it: a change to the caret's
 * own paragraph that is not a paste, drop or cut. Null otherwise.
 */
const typingCaret = (
  transaction: Transaction,
  state: EditorState
): number | null => {
  const { selection } = state;
  if (!transaction.docChanged || !selection.empty) return null;
  if (transaction.getMeta('uiEvent') !== undefined) return null;
  const $caret = selection.$head;
  if (!$caret.parent.isTextblock) return null;
  const blockStart = $caret.start();
  const blockEnd = $caret.end();
  let inBlock = true;
  transaction.mapping.maps.forEach((map, index) => {
    const rest = transaction.mapping.slice(index + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (rest.map(newStart) < blockStart || rest.map(newEnd) > blockEnd) {
        inBlock = false;
      }
    });
  });
  return inBlock ? selection.head : null;
};

/**
 * Keeps either end of the selection out of a chip's hidden key, moving it to
 * the edge it was travelling towards, or the nearer edge when it jumped in.
 */
const keepOutOfChips = (
  previous: EditorState,
  state: EditorState
): Transaction | null => {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return null;
  const settle = (position: number, before: number): number => {
    const chip = chipAround(state, position);
    if (chip === null) return position;
    if (before <= chip.from) return chip.to;
    if (before >= chip.to) return chip.from;
    return position - chip.from <= chip.to - position ? chip.from : chip.to;
  };
  const head = settle(selection.head, previous.selection.head);
  const anchor = settle(selection.anchor, previous.selection.anchor);
  if (head === selection.head && anchor === selection.anchor) return null;
  return state.tr.setSelection(TextSelection.create(state.doc, anchor, head));
};

/**
 * Shows issue keys and project and document links as chips while editing,
 * without making them nodes, so the stored text is exactly what was written.
 * A drawn issue chip behaves as one atom: the arrow keys step over it,
 * Backspace and Delete remove it whole, the caret never rests inside its
 * key, and a word typed against it is kept a space apart so the key still
 * reads as one. A key being typed stays text until the caret leaves its end,
 * so `ENG-1` does not close into a chip on the way to `ENG-12`. A transaction carrying {@link referenceChipsKey} redraws them
 * in place.
 */
const ReferenceChips = Extension.create<ReferenceChipOptions>({
  name: 'referenceChips',
  addOptions() {
    return {};
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<ReferenceChipState>({
        key: referenceChipsKey,
        state: {
          init: (_, state): ReferenceChipState => ({
            decorations: referenceDecorations(state.doc, options),
            typing: null,
          }),
          apply: (
            transaction,
            held,
            _previous,
            state
          ): ReferenceChipState => {
            const typing =
              transaction.docChanged || transaction.selectionSet
                ? typingCaret(transaction, state)
                : held.typing;
            return transaction.docChanged ||
              typing !== held.typing ||
              transaction.getMeta(referenceChipsKey) !== undefined
              ? {
                  decorations: referenceDecorations(
                    transaction.doc,
                    options,
                    typing
                  ),
                  typing,
                }
              : held;
          },
        },
        appendTransaction: (transactions, previous, state) =>
          transactions.some(
            (transaction) => transaction.selectionSet || transaction.docChanged
          )
            ? keepOutOfChips(previous, state)
            : null,
        props: {
          decorations(state) {
            return this.getState(state)?.decorations;
          },
          handleKeyDown: stepOverChip,
          handleTextInput: typeBesideChip,
        },
      }),
    ];
  },
});

/**
 * A link that stops at its last character, so text typed right after a link
 * is plain text, as in Linear, rather than growing the link.
 */
const BoundedLink = Link.extend({
  inclusive: () => false,
});

/** The extensions a rich Markdown surface is built from. */
export const markdownExtensions = (
  options: MarkdownExtensionOptions = {}
): AnyExtension[] => {
  const extensions: AnyExtension[] = [
    StarterKit.configure({
      underline: false,
      link: false,
      hardBreak: false,
      paragraph: false,
      codeBlock: false,
      orderedList: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      dropcursor: { color: false, width: 2, class: 'rich-drop-cursor' },
    }),
    CollapsingParagraph,
    NewlineBreak,
    HighlightedCodeBlock,
    LinearOrderedList,
    BoundedLink.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: 'https',
      isAllowedUri: (url) => isLinkTarget(url),
      HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
    }),
    LinearTaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    SpreadsheetPaste,
    TableShortcut,
    MediaImage.configure({ inline: false, allowBase64: false }),
    MediaUpload,
    VideoEmbed,
    VideoEmbedPaste,
    DateChip,
    InlineMath,
    BlockMath,
    CollapsibleSectionKit,
    Callout,
    EditorShortcuts,
    BlockHandle,
    MentionChips,
    EmojiSuggestion,
    EmoticonConversion,
    CustomEmojiChips,
    DocumentLinkSuggestion,
    ReferenceChips.configure({
      ...(options.isIssueKey === undefined
        ? {}
        : { isIssueKey: options.isIssueKey }),
      ...(options.isReferenceLink === undefined
        ? {}
        : { isReferenceLink: options.isReferenceLink }),
      ...(options.issueLook === undefined
        ? {}
        : { issueLook: options.issueLook }),
    }),
    StanduplessMarkdown.configure({ marked: createMarked() as never }),
  ] as AnyExtension[];
  if (options.placeholder !== undefined) {
    extensions.push(
      Placeholder.configure({ placeholder: options.placeholder })
    );
  }
  return extensions;
};
