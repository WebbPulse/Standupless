/**
 * The open workspace's custom emoji, held where every surface can read them:
 * the reaction picker and groups, the static Markdown renderer, and the
 * editor's plugins, which run outside React. The workspace layout reads the
 * list and publishes it here; a component subscribes with
 * {@link useCustomEmoji}, and a plugin reads {@link customEmojiSnapshot} and
 * listens with {@link subscribeCustomEmoji}.
 *
 * Text and reactions hold a custom emoji as its `:name:` shortcode, so one
 * that is not in the set, because it was deleted or belongs to another
 * workspace, simply reads as that text.
 */

import { useSyncExternalStore } from 'react';
import type { CustomEmojiRead } from '../types/Api';

/** The custom emoji of the open workspace, by name. */
export type CustomEmojiSet = ReadonlyMap<string, CustomEmojiRead>;

const EMPTY: CustomEmojiSet = new Map();

let current: CustomEmojiSet = EMPTY;

const listeners = new Set<() => void>();

/** A `:name:` custom shortcode anywhere in text, the name captured. */
export const CUSTOM_SHORTCODE = /:([a-z0-9][a-z0-9_-]{1,31}):/g;

/** The name a reaction value carries when it is a custom `:name:`, or null. */
export const customReactionName = (value: string): string | null => {
  const match = /^:([a-z0-9][a-z0-9_-]{1,31}):$/.exec(value);
  return match?.[1] ?? null;
};

/** Replaces the published set, telling every subscriber. */
export const publishCustomEmoji = (rows: CustomEmojiRead[]): void => {
  const next = new Map(rows.map((row) => [row.name, row]));
  const same =
    next.size === current.size &&
    rows.every((row) => current.get(row.name)?.url === row.url);
  if (same) return;
  current = next.size === 0 ? EMPTY : next;
  listeners.forEach((listener) => {
    listener();
  });
};

/** The published set as it stands. */
export const customEmojiSnapshot = (): CustomEmojiSet => current;

/** Calls `listener` whenever the set changes, answering how to stop. */
export const subscribeCustomEmoji = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The open workspace's custom emoji, re-rendering when the set changes. */
export const useCustomEmoji = (): CustomEmojiSet =>
  useSyncExternalStore(subscribeCustomEmoji, customEmojiSnapshot);

/** One run of text split into plain text and the custom emoji it names. */
export type CustomEmojiPart = string | CustomEmojiRead;

/**
 * Splits text at each `:name:` the set holds, leaving any other colon run as
 * text, so a deleted emoji reads as its shortcode.
 */
export const splitCustomEmoji = (
  text: string,
  set: CustomEmojiSet
): CustomEmojiPart[] => {
  if (set.size === 0 || !text.includes(':')) return [text];
  const parts: CustomEmojiPart[] = [];
  let last = 0;
  for (const match of text.matchAll(CUSTOM_SHORTCODE)) {
    const emoji = set.get(match[1] ?? '');
    if (emoji === undefined) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(emoji);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
};
