/**
 * Typed emoticons such as `:)` and `<3` turn into their emoji once a space or
 * punctuation follows them, while the person's emoticon preference is on.
 *
 * The emoticon must start the line or follow whitespace or an opening bracket
 * or quote, so `http://`, `a:)` and times such as `10:30` never convert.
 * Nothing converts inside inline code, a code block or a link. The conversion
 * is its own undo step, so Undo right after it brings back the typed text,
 * and Backspace right after it does the same, as for every input rule.
 */

import { Extension, InputRule, type InputRuleMatch } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { readPreferences } from '../../lib/preferences';

/** Each emoticon the editor converts and the emoji it becomes. */
export const EMOTICONS: Readonly<Record<string, string>> = {
  ':)': '\u{1F642}',
  ':-)': '\u{1F642}',
  ':(': '\u{1F641}',
  ':-(': '\u{1F641}',
  ':D': '\u{1F603}',
  ':-D': '\u{1F603}',
  ';)': '\u{1F609}',
  ';-)': '\u{1F609}',
  ':P': '\u{1F61B}',
  ':-P': '\u{1F61B}',
  ':p': '\u{1F61B}',
  ':-p': '\u{1F61B}',
  ':O': '\u{1F62E}',
  ':-O': '\u{1F62E}',
  ':o': '\u{1F62E}',
  ':-o': '\u{1F62E}',
  ":'(": '\u{1F622}',
  ':|': '\u{1F610}',
  ':-|': '\u{1F610}',
  '<3': '❤️',
  '</3': '\u{1F494}',
};

const escaped = Object.keys(EMOTICONS)
  .sort((a, b) => b.length - a.length)
  .map((emoticon) => emoticon.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/** An emoticon at the end of the typed text, followed by its trigger character. */
const EMOTICON = new RegExp(
  `(?<=^|[\\s([{"'])(${escaped.join('|')})([\\s.,!?;])$`,
  'u'
);

/**
 * The emoticon the typed text ends in with its trigger, or null when there is
 * none or the preference is off.
 */
export const emoticonAt = (text: string): InputRuleMatch | null => {
  if (!readPreferences().convertEmoticons) return null;
  const match = EMOTICON.exec(text);
  const emoticon = match?.[1];
  const trigger = match?.[2];
  if (match === null || emoticon === undefined || trigger === undefined) {
    return null;
  }
  return {
    index: match.index,
    text: match[0],
    data: { emoji: EMOTICONS[emoticon], trigger },
  };
};

/** The emoticon to emoji input rule, for every rich Markdown surface. */
export const EmoticonConversion = Extension.create({
  name: 'emoticonConversion',
  addInputRules() {
    return [
      new InputRule({
        find: emoticonAt,
        handler: ({ state, range, match }) => {
          const emoji = match.data?.['emoji'] as string | undefined;
          const trigger = match.data?.['trigger'] as string | undefined;
          if (emoji === undefined || trigger === undefined) return null;
          const link = state.schema.marks['link'];
          const $from = state.doc.resolve(range.from);
          if (
            link !== undefined &&
            (state.doc.rangeHasMark(range.from, range.to, link) ||
              link.isInSet(state.storedMarks ?? $from.marks()) !== undefined)
          ) {
            return null;
          }
          closeHistory(state.tr);
          state.tr.insertText(`${emoji}${trigger}`, range.from, range.to);
          return undefined;
        },
      }),
    ];
  },
});
