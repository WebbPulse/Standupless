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
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { Marked, type Token } from 'marked';
import { isLinkTarget } from '../../lib/markdown';
import { escapeInlineMath } from '../../lib/math';
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
}

/**
 * The meta a transaction carries to redraw the reference chips when what
 * counts as a reference changed, such as the team list arriving, while the
 * document itself did not.
 */
export const referenceChipsKey = new PluginKey<DecorationSet>('referenceChips');

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
}

/**
 * Finds each issue key naming a team, and each link to a project or document,
 * and marks it for the chip style. Code is skipped, as the renderer skips it.
 */
const referenceDecorations = (
  doc: ProseMirrorNode,
  options: ReferenceChipOptions
): DecorationSet => {
  const { isIssueKey, isReferenceLink } = options;
  const found: Decoration[] = [];
  doc.descendants((node, position) => {
    if (!node.isText || node.text === undefined) return;
    if (node.marks.some((mark) => mark.type.name === 'code')) return;
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
 * Shows issue keys and project and document links as chips while editing,
 * without making them nodes, so the stored text is exactly what was written.
 * A transaction carrying {@link referenceChipsKey} redraws them in place.
 */
const ReferenceChips = Extension.create<ReferenceChipOptions>({
  name: 'referenceChips',
  addOptions() {
    return {};
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        key: referenceChipsKey,
        state: {
          init: (_, state) => referenceDecorations(state.doc, options),
          apply: (transaction, held) =>
            transaction.docChanged ||
            transaction.getMeta(referenceChipsKey) !== undefined
              ? referenceDecorations(transaction.doc, options)
              : held,
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
