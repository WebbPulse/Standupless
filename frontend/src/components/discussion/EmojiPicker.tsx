/**
 * The reaction picker: a search box, the quick picks, and every Unicode emoji
 * in its groups, the way Linear's picker reads. Any single emoji is a valid
 * reaction, so the full list is offered, and the quick picks keep the common
 * ones one tap away while the rest of the list loads.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { cn } from '../../lib/cn';
import {
  loadEmojiCatalog,
  searchEmoji,
  sectionsOf,
  type EmojiEntry,
} from '../../lib/emojiCatalog';
import {
  REACTION_EMOJI,
  normalizeReaction,
  reactionName,
} from '../../lib/reactions';
import { Input } from '../ui/input';

/** Props for EmojiPicker: what to do with a pick and which the reader holds. */
export interface EmojiPickerProps {
  onPick: (emoji: string) => void;
  /** The emoji the reader has already reacted with, normalised. */
  held?: ReadonlySet<string>;
}

/** How a dataset label reads as a button name: "thumbs up" as "Thumbs up". */
const sentenceCase = (label: string): string =>
  label.charAt(0).toUpperCase() + label.slice(1);

/** One tappable emoji. */
const EmojiButton: React.FC<{
  emoji: string;
  name: string;
  held: boolean;
  onPick: (emoji: string) => void;
}> = ({ emoji, name, held, onPick }) => (
  <button
    type="button"
    aria-label={name}
    aria-pressed={held}
    title={name}
    className={cn(
      'inline-flex h-8 w-8 items-center justify-center rounded-sm text-lg transition-colors duration-100 hover:bg-raised focus-visible:bg-raised focus-visible:outline-none',
      held && 'bg-accent-soft'
    )}
    onClick={() => {
      onPick(emoji);
    }}
  >
    <span aria-hidden="true">{emoji}</span>
  </button>
);

/** A titled grid of emoji. */
const Section: React.FC<{
  title: string;
  entries: { emoji: string; name: string }[];
  held: ReadonlySet<string>;
  onPick: (emoji: string) => void;
}> = ({ title, entries, held, onPick }) => (
  <section role="group" aria-label={title} className="px-1.5 pb-1.5">
    <h3 className="px-0.5 pt-1.5 pb-1 text-2xs font-medium text-text-faint">
      {title}
    </h3>
    <div className="grid grid-cols-8">
      {entries.map((entry) => (
        <EmojiButton
          key={entry.emoji}
          emoji={entry.emoji}
          name={entry.name}
          held={held.has(normalizeReaction(entry.emoji))}
          onPick={onPick}
        />
      ))}
    </div>
  </section>
);

const NOTHING_HELD: ReadonlySet<string> = new Set();

/** Search, quick picks and the full list, calling `onPick` with the emoji chosen. */
export const EmojiPicker: React.FC<EmojiPickerProps> = ({
  onPick,
  held = NOTHING_HELD,
}) => {
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<EmojiEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    loadEmojiCatalog()
      .then((entries) => {
        if (live) setCatalog(entries);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const labels = useMemo(() => {
    const names = new Map<string, string>();
    for (const entry of catalog ?? []) {
      names.set(normalizeReaction(entry.emoji), sentenceCase(entry.label));
    }
    return names;
  }, [catalog]);

  const nameOf = (emoji: string): string =>
    reactionName(emoji) ?? labels.get(normalizeReaction(emoji)) ?? emoji;

  const quickPicks = REACTION_EMOJI.map((emoji) => ({
    emoji,
    name: nameOf(emoji),
  }));

  const searching = query.trim() !== '';
  const results = useMemo(
    () => (searching && catalog !== null ? searchEmoji(catalog, query) : []),
    [catalog, query, searching]
  );
  const sections = useMemo(
    () => (catalog === null ? [] : sectionsOf(catalog)),
    [catalog]
  );

  return (
    <div className="w-72">
      <div className="border-b border-line p-1.5">
        <Input
          aria-label="Search emoji"
          placeholder="Search emoji..."
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            const first = results[0];
            if (event.key === 'Enter' && first !== undefined) {
              event.preventDefault();
              onPick(first.emoji);
            }
          }}
        />
      </div>
      <div className="max-h-72 overflow-y-auto">
        {searching ? (
          results.length > 0 ? (
            <Section
              title="Results"
              entries={results.map((entry) => ({
                emoji: entry.emoji,
                name: sentenceCase(entry.label),
              }))}
              held={held}
              onPick={onPick}
            />
          ) : (
            <p className="px-3 py-4 text-center text-xs text-text-faint">
              {catalog === null && !failed
                ? 'Loading emoji...'
                : 'No emoji match that search.'}
            </p>
          )
        ) : (
          <>
            <Section
              title="Quick picks"
              entries={quickPicks}
              held={held}
              onPick={onPick}
            />
            {sections.map((section) => (
              <Section
                key={section.group}
                title={section.name}
                entries={section.entries.map((entry) => ({
                  emoji: entry.emoji,
                  name: sentenceCase(entry.label),
                }))}
                held={held}
                onPick={onPick}
              />
            ))}
            {catalog === null && (
              <p className="px-3 py-2 text-xs text-text-faint">
                {failed
                  ? 'Could not load the full emoji list.'
                  : 'Loading emoji...'}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default EmojiPicker;
