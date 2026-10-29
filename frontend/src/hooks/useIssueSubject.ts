/**
 * The issue or issues the keyboard is pointed at, published so the command
 * palette can name what its issue actions will act on. A list publishes the
 * focused or selected issues and an issue page publishes its issue; the most
 * recent publisher that is still mounted wins, the same rule the shortcut
 * registry follows.
 *
 * A publisher that can write to its issues also hands over the values its
 * properties can take, so typing "urgent" or a teammate's name in the palette
 * offers "Set priority to Urgent" or "Assign to Alex" on the subject. They are
 * read only when the palette asks, so a list does not rebuild them on every
 * render.
 */

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';

/** What the palette's chip names: one issue by key and title, or a count. */
export interface IssueSubject {
  /** The issue key, or null when the subject is several issues. */
  key: string | null;
  /** The issue title, or a phrase such as "3 issues". */
  title: string;
  /**
   * The property values the subject can be set to, built on demand. Given the
   * typed term, a property may lead with a value read from it, such as the day
   * "nov 3" names.
   */
  values?: (query?: string) => SubjectValue[];
}

/** One property value offered as a palette command on the subject. */
export interface SubjectValue {
  /** Stable among the subject's values, such as "priority-urgent". */
  id: string;
  /** The command as it reads, such as "Set priority to Urgent". */
  label: string;
  /** The value's own name, such as "Urgent", which ranks a match on it first. */
  name: string;
  /** Extra words the row matches on, such as the property's name. */
  keywords: string;
  icon: ReactNode;
  /** The property the value belongs to, such as "priority". */
  property?: string;
  /** Whether every issue of the subject already has the value. */
  checked?: boolean;
  /** Whether running the value would change nothing, as for the current status. */
  inert?: boolean;
  /** Whether the value toggles on a property holding several, as a label does. */
  toggles?: boolean;
  /** Whether the value was read from the typed term and leads its list. */
  lead?: boolean;
  /** A short note drawn at the end of the row, such as a preset's date. */
  detail?: string;
  /** Writes the value to every issue of the subject. */
  run: () => void;
}

interface Entry {
  id: number;
  subject: IssueSubject;
}

let entries: Entry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

/** Tells every reader the current subject may have changed. */
const emit = (): void => {
  for (const listener of listeners) listener();
};

/** Subscribes a reader to subject changes. */
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Gives a publisher's subject a new identity so readers rebuild its values. */
const refresh = (id: number): void => {
  let changed = false;
  entries = entries.map((entry) => {
    if (entry.id !== id) return entry;
    changed = true;
    return { id, subject: { ...entry.subject } };
  });
  if (changed) emit();
};

/** The subject the latest mounted publisher set, or null. */
const snapshot = (): IssueSubject | null =>
  entries[entries.length - 1]?.subject ?? null;

/** The subject one or more issues make: a single issue's key and title, or a count. */
export const subjectOf = (
  issues: readonly { key: string; title: string }[]
): IssueSubject | null => {
  const [first] = issues;
  if (first === undefined) return null;
  if (issues.length === 1) return { key: first.key, title: first.title };
  return { key: null, title: `${String(issues.length)} issues` };
};

/**
 * Publishes a subject while the caller is mounted and the subject is not null,
 * with the values its properties can take when the caller can write them.
 * When the values change, as after a write to the subject, readers are told,
 * so a list the palette holds open redraws its check marks.
 */
export const usePublishIssueSubject = (
  subject: IssueSubject | null,
  values?: ((query?: string) => SubjectValue[]) | null
): void => {
  const key = subject?.key ?? null;
  const title = subject?.title ?? null;
  const latest = useRef(values ?? null);
  const published = useRef<number | null>(null);
  useEffect(() => {
    const changed = latest.current !== (values ?? null);
    latest.current = values ?? null;
    if (changed && published.current !== null) refresh(published.current);
  });
  const offers = values !== undefined && values !== null;
  useEffect(() => {
    if (title === null) return;
    const entry: Entry = {
      id: nextId,
      subject: offers
        ? {
            key,
            title,
            values: (query) => latest.current?.(query) ?? [],
          }
        : { key, title },
    };
    nextId += 1;
    entries = [...entries, entry];
    published.current = entry.id;
    emit();
    return () => {
      entries = entries.filter((held) => held.id !== entry.id);
      if (published.current === entry.id) published.current = null;
      emit();
    };
  }, [key, title, offers]);
};

/** The subject the palette should name, or null when nothing is in focus. */
export const useIssueSubject = (): IssueSubject | null =>
  useSyncExternalStore(subscribe, snapshot, snapshot);

export default useIssueSubject;
