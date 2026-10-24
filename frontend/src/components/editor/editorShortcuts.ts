/**
 * Keyboard chords the stock extensions leave out but Linear's editor has, so
 * someone used to it finds the same keys here. Bold, italic, strikethrough,
 * inline code on Mod-E, headings on Mod-Alt-1 to 3, the lists, the quote and
 * the code block on Mod-Alt-C already come with StarterKit and the task list.
 * Mod-K for a link is handled by the surface, since it opens the link field.
 */

import { Extension } from '@tiptap/core';

/** The extra chords: a code block on Mod-Shift-Backslash. */
export const EditorShortcuts = Extension.create({
  name: 'editorShortcuts',
  addKeyboardShortcuts() {
    const toggleCodeBlock = (): boolean =>
      this.editor.commands.toggleCodeBlock();
    return {
      'Mod-Shift-\\': toggleCodeBlock,
      'Mod-Shift-|': toggleCodeBlock,
    };
  },
});
