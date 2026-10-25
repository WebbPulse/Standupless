/**
 * Video embeds in the rich editor, as Linear has them: a YouTube, Loom, Vimeo
 * or Descript link pasted alone on an empty line becomes the provider's
 * player, selected, with a "Keep as link" choice under it, and Escape right
 * after the paste makes the same choice.
 *
 * The stored form is the link alone on its line, so the API, MCP, email and
 * GitHub sync read a plain link and the static renderer and the editor both
 * read it back as the embed. A link kept as a link is stored in its bracketed
 * form, which neither reads as an embed, so the choice survives a save.
 *
 * Embeds only sit where a Markdown block can: the top level, quotes, callouts
 * and collapsible sections, never inside a list item or a table cell.
 */

import type { Editor, MarkdownToken } from '@tiptap/core';
import { Extension, Node } from '@tiptap/core';
import type { Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { ReactNodeViewRenderer } from '@tiptap/react';
import type { TokenizerExtension } from 'marked';
import { parseVideoEmbed, videoEmbedOfLine } from '../../lib/videoEmbeds';
import { VideoEmbedView } from './VideoEmbedView';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    videoEmbed: {
      /** Replaces the video embed at a position with a paragraph linking it. */
      convertVideoEmbedToLink: (position: number) => ReturnType;
    };
  }
}

/** The node name a video embed is stored under. */
export const VIDEO_EMBED = 'videoEmbed';

/** The containers a pasted embed may not land in. */
const INLINE_ONLY_CONTAINERS = new Set([
  'listItem',
  'taskItem',
  'tableCell',
  'tableHeader',
]);

/** The marked token a video embed reads from. */
interface VideoEmbedToken extends MarkdownToken {
  url: string;
}

/**
 * The marked block tokenizer for a bare video link alone in its paragraph.
 * It reads only where a block may stand, so a link in a list item stays a
 * link, and it never interrupts a paragraph, so a link inside running text
 * stays text.
 */
export const videoEmbedTokenizer: TokenizerExtension = {
  name: VIDEO_EMBED,
  level: 'block',
  tokenizer(src) {
    if (!this.lexer.state.top) return undefined;
    const end = src.indexOf('\n');
    const line = end === -1 ? src : src.slice(0, end);
    const embed = videoEmbedOfLine(line);
    if (embed === null) return undefined;
    const rest = end === -1 ? '' : src.slice(end + 1);
    const nextLine = rest.split('\n', 1)[0] ?? '';
    if (rest !== '' && nextLine.trim() !== '') return undefined;
    return {
      type: VIDEO_EMBED,
      raw: end === -1 ? line : `${line}\n`,
      url: embed.url,
      tokens: [],
    };
  },
};

/** The paste handler's memory of the embed it just made, by position. */
const pastedKey = new PluginKey<number | null>('videoEmbedPasted');

/** Whether a position may hold a block of its own. */
const holdsBlocks = ($from: ResolvedPos): boolean => {
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if (INLINE_ONLY_CONTAINERS.has($from.node(depth).type.name)) return false;
  }
  return true;
};

/** The paragraph a link was before it embedded. */
const linkParagraph = (
  state: EditorState,
  url: string
): ProseMirrorNode | null => {
  const { schema } = state;
  const paragraph = schema.nodes['paragraph'];
  const link = schema.marks['link'];
  if (paragraph === undefined || link === undefined) return null;
  return paragraph.create(null, schema.text(url, [link.create({ href: url })]));
};

/**
 * Turns the pasted text into an embed when it is a single video link pasted
 * on an empty line where a block may stand, and selects the new embed.
 */
const pasteEmbed = (view: EditorView, event: ClipboardEvent): boolean => {
  if (!view.editable) return false;
  const text = event.clipboardData?.getData('text/plain') ?? '';
  const embed = parseVideoEmbed(text);
  if (embed === null) return false;
  const { state } = view;
  const { selection, schema } = state;
  const type = schema.nodes[VIDEO_EMBED];
  if (type === undefined || !selection.empty) return false;
  const { $from } = selection;
  if ($from.parent.type.name !== 'paragraph' || $from.parent.content.size > 0) {
    return false;
  }
  if (!holdsBlocks($from)) return false;
  const start = $from.before();
  const tr = state.tr.replaceWith(
    start,
    $from.after(),
    type.create({ url: embed.url })
  );
  tr.setSelection(NodeSelection.create(tr.doc, start));
  tr.setMeta(pastedKey, start);
  event.preventDefault();
  view.dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Keeps the embed just pasted as the plain link instead, when it is still
 * the selection. Returns whether it did, so Escape falls through otherwise.
 */
export const keepPastedVideoAsLink = (editor: Editor): boolean => {
  const { state } = editor;
  const pasted = pastedKey.getState(state);
  const { selection } = state;
  if (
    pasted === null ||
    pasted === undefined ||
    !(selection instanceof NodeSelection) ||
    selection.from !== pasted ||
    selection.node.type.name !== VIDEO_EMBED
  ) {
    return false;
  }
  return editor.commands.convertVideoEmbedToLink(pasted);
};

/**
 * The paste side of video embeds, ahead of the link extension's own paste
 * handling, which would otherwise turn the pasted link into a link mark.
 */
export const VideoEmbedPaste = Extension.create({
  name: 'videoEmbedPaste',
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin<number | null>({
        key: pastedKey,
        state: {
          init: () => null,
          apply: (tr, held) => {
            const meta = tr.getMeta(pastedKey) as number | null | undefined;
            if (meta !== undefined) return meta;
            if (held === null || tr.docChanged || tr.selectionSet) return null;
            return held;
          },
        },
        props: {
          handlePaste: (view, event) => pasteEmbed(view, event),
        },
      }),
    ];
  },
});

/** The video embed node: its link, its player and its stored form. */
export const VideoEmbed = Node.create({
  name: VIDEO_EMBED,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      url: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-url') ?? '',
        renderHTML: (attributes) => ({ 'data-url': attributes['url'] }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-video-embed]',
        getAttrs: (element) =>
          parseVideoEmbed(element.getAttribute('data-url') ?? '') === null
            ? false
            : null,
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const url = String(node.attrs['url'] ?? '');
    return [
      'div',
      { ...HTMLAttributes, 'data-video-embed': '' },
      ['a', { href: url }, url],
    ];
  },

  renderText: ({ node }) => String(node.attrs['url'] ?? ''),

  parseMarkdown: (token, helpers) =>
    helpers.createNode(VIDEO_EMBED, { url: (token as VideoEmbedToken).url }),

  renderMarkdown: (node) => String(node.attrs?.['url'] ?? ''),

  addNodeView() {
    return ReactNodeViewRenderer(VideoEmbedView, {
      stopEvent: ({ event }) =>
        event.target instanceof Element &&
        event.target.closest('[data-video-embed-controls]') !== null,
    });
  },

  addCommands() {
    return {
      convertVideoEmbedToLink:
        (position) =>
        ({ state, tr, dispatch }) => {
          const node = tr.doc.nodeAt(position);
          if (node?.type.name !== VIDEO_EMBED) return false;
          const paragraph = linkParagraph(state, String(node.attrs['url']));
          if (paragraph === null) return false;
          if (dispatch !== undefined) {
            tr.replaceWith(position, position + node.nodeSize, paragraph);
            tr.setSelection(
              TextSelection.create(tr.doc, position + paragraph.nodeSize - 1)
            );
          }
          return true;
        },
    };
  },
});
