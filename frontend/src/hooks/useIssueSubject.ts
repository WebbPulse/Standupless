/**
 * The issue or issues the keyboard is pointed at, published so the command
 * palette can name what its issue actions will act on. A list publishes the
 * focused or selected issues and an issue page publishes its issue; the most
 * recent publisher that is still mounted wins, the same rule the shortcut
 * registry follows.
 */

import { useEffect, useSyncExternalStore } from 'react';

/** What the palette's chip names: one issue by key and title, or a count. */
export interface IssueSubject {
  /** The issue key, or null when the subject is several issues. */
  key: string | null;
  /** The issue title, or a phrase such as "3 issues". */
  title: string;
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

/** Publishes a subject while the caller is mounted and the subject is not null. */
export const usePublishIssueSubject = (subject: IssueSubject | null): void => {
  const key = subject?.key ?? null;
  const title = subject?.title ?? null;
  useEffect(() => {
    if (title === null) return;
    const entry: Entry = { id: nextId, subject: { key, title } };
    nextId += 1;
    entries = [...entries, entry];
    emit();
    return () => {
      entries = entries.filter((held) => held.id !== entry.id);
      emit();
    };
  }, [key, title]);
};

/** The subject the palette should name, or null when nothing is in focus. */
export const useIssueSubject = (): IssueSubject | null =>
  useSyncExternalStore(subscribe, snapshot, snapshot);

export default useIssueSubject;
