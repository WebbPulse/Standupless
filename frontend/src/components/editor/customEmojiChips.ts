/**
 * Draws each `:name:` that names one of the workspace's custom emoji as its
 * image while editing, without making it a node, so the stored Markdown is
 * exactly the shortcode that was typed. The shortcode text stays in the
 * document, shrunk out of sight beside the image, and shows again while the
 * caret is inside it so it can be edited. A deleted emoji, or one from another
 * workspace, is left as plain text. The set lives outside React, so the plugin
 * redraws when it changes.
 */

import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  CUSTOM_SHORTCODE,
  customEmojiSnapshot,
  subscribeCustomEmoji,
} from '../../lib/customEmoji';

/** The meta a transaction carries to redraw after the custom emoji set changed. */
export const customEmojiChipsKey = new PluginKey<DecorationSet>(
  'customEmojiChips'
);

/** The image drawn in front of one shortcode. */
const emojiImage = (url: string, shortcode: string): HTMLElement => {
  const image = document.createElement('img');
  image.src = url;
  image.alt = shortcode;
  image.title = shortcode;
  image.draggable = false;
  image.className = 'rich-custom-emoji';
  image.setAttribute('contenteditable', 'false');
  return image;
};

/** Finds each known `:name:` outside code and marks it, leaving the one at the caret as text. */
export const customEmojiDecorations = (
  doc: ProseMirrorNode,
  caret: number | null
): DecorationSet => {
  const set = customEmojiSnapshot();
  if (set.size === 0) return DecorationSet.empty;
  const found: Decoration[] = [];
  doc.descendants((node, position) => {
    if (!node.isText || node.text === undefined) return;
    if (!node.text.includes(':')) return;
    if (node.marks.some((mark) => mark.type.name === 'code')) return;
    if (node.marks.some((mark) => mark.type.name === 'link')) return;
    for (const match of node.text.matchAll(CUSTOM_SHORTCODE)) {
      const emoji = set.get(match[1] ?? '');
      if (emoji === undefined) continue;
      const start = position + match.index;
      const end = start + match[0].length;
      if (caret !== null && caret > start && caret < end) continue;
      found.push(
        Decoration.widget(start, () => emojiImage(emoji.url, emoji.shortcode), {
          side: -1,
          key: `${emoji.name}:${emoji.url}`,
          ignoreSelection: true,
        }),
        Decoration.inline(start, end, { class: 'rich-custom-emoji-code' })
      );
    }
  });
  return DecorationSet.create(doc, found);
};

/** The caret position when the selection is empty, else null. */
const caretOf = (state: EditorState): number | null =>
  state.selection.empty ? state.selection.from : null;

/** Custom emoji images over their shortcodes, for every rich Markdown surface. */
export const CustomEmojiChips = Extension.create({
  name: 'customEmojiChips',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: customEmojiChipsKey,
        state: {
          init: (_, state) => customEmojiDecorations(state.doc, caretOf(state)),
          apply: (transaction, held, _old, state) =>
            transaction.docChanged ||
            transaction.selectionSet ||
            transaction.getMeta(customEmojiChipsKey) !== undefined
              ? customEmojiDecorations(state.doc, caretOf(state))
              : held,
        },
        view: (view) => {
          const unsubscribe = subscribeCustomEmoji(() => {
            if (view.isDestroyed) return;
            view.dispatch(view.state.tr.setMeta(customEmojiChipsKey, true));
          });
          return { destroy: unsubscribe };
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
