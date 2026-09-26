/**
 * The editor schema behind every rich Markdown surface, and the Markdown
 * dialect it reads and writes. Storage stays plain Markdown, so the API, the
 * share view, GitHub sync and email never learn the editor exists; this module
 * is where the editor is held to that promise.
 *
 * Tiptap's Markdown serializer is tuned for documents that only it reads back.
 * Standupless Markdown is also read by the small parser in `lib/markdown.ts`,
 * by GitHub and by email, so three behaviours are adjusted here:
 *
 * - Raw HTML is never interpreted. `<div>` in a description stays the text
 *   `<div>`, as the static renderer shows it, instead of being parsed into the
 *   document or dropped.
 * - Text is escaped only when it would otherwise read as formatting, so
 *   `snake_case` and `2 * 3` survive a save untouched rather than gaining
 *   backslashes and `&lt;` entities.
 * - A single newline is a line break, matching the static renderer.
 */

import type { AnyExtension, JSONContent } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import HardBreak from '@tiptap/extension-hard-break';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Markdown, type MarkdownManager } from '@tiptap/markdown';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { Marked, type Token } from 'marked';
import { isSafeUrl } from '../../lib/markdown';

/** What {@link markdownExtensions} can be asked to vary per surface. */
export interface MarkdownExtensionOptions {
  /** Shown in an empty document. Omitted for read-only surfaces. */
  placeholder?: string;
}

/** The @mention shape the server resolves, as `lib/markdown.ts` reads it. */
const MENTION = /(?<![\w@/])@([A-Za-z0-9][A-Za-z0-9_-]{0,38})(?![\w-])/g;

/**
 * A marked instance of our own, so registering Tiptap's tokenizers never
 * touches the global one, with raw HTML switched off and single newlines read
 * as breaks.
 */
const createMarked = (): Marked => {
  const instance = new Marked({ gfm: true, breaks: true });
  const refuse = (): undefined => undefined;
  instance.use({
    tokenizer: {
      html: refuse,
      tag: refuse,
    },
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
 */
const preferVerbatimText = (
  manager: MarkdownManager,
  instance: Marked
): void => {
  const encoder = manager as unknown as Encoder;
  const escape = encoder.encodeTextForMarkdown.bind(manager);
  encoder.encodeTextForMarkdown = (text, node, parent) => {
    const escaped = escape(text, node, parent);
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
      heading: { levels: [1, 2, 3, 4, 5, 6] },
    }),
    NewlineBreak,
    BoundedLink.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: 'https',
      isAllowedUri: (url) => isSafeUrl(url),
      HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Image.configure({ inline: false, allowBase64: false }),
    MentionChips,
    StanduplessMarkdown.configure({ marked: createMarked() as never }),
  ] as AnyExtension[];
  if (options.placeholder !== undefined) {
    extensions.push(
      Placeholder.configure({ placeholder: options.placeholder })
    );
  }
  return extensions;
};
