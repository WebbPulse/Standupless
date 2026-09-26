/**
 * Optimistic writes over a polled record. A property change should show the
 * moment it is picked, not a round trip later, so the patch is laid over the
 * record at once, the write goes out, and a failure takes back only that
 * patch and says so in a notice.
 *
 * It sits beside `usePolledQuery` rather than replacing it: the polled read
 * stays the source of truth, a confirmed write is held only until a read at
 * least as new arrives, and the write runs through `useMutationWithRefetch`
 * so every query naming the record re-reads when it lands. Nothing here knows
 * about issues, which makes it a candidate for `@webbpulse/api-client/react`.
 */

import { useCallback, useRef, useState } from 'react';
import {
  useMutationWithRefetch,
  type QueryKey,
} from '@webbpulse/api-client/react';
import { errorMessage } from './errors';
import { showErrorToast } from './toast';

/** Options for useOptimisticRecord: how to write, merge and report. */
export interface OptimisticOptions<T, P> {
  /** Sends one patch and answers the record as the server now holds it. */
  write: (patch: P) => Promise<T>;
  /** Lays a patch over a record. Defaults to a shallow merge. */
  apply?: (value: T, patch: P) => T;
  /**
   * Whether the candidate is at least as new as the held record. Defaults to
   * comparing `updated_at`, which every record this application reads carries.
   */
  isNewer?: (candidate: T, held: T) => boolean;
  /**
   * Whether two values are the same record. Defaults to comparing `id`, so a
   * confirmed write for one record never masks the read of another.
   */
  isSame?: (left: T, right: T) => boolean;
  /** The notice raised when a write fails. */
  failureMessage?: (error: unknown) => string;
  /** Called with the record once a write lands. */
  onSaved?: (value: T) => void;
  /** Keys whose queries re-read when a write lands. */
  invalidate?: QueryKey | readonly QueryKey[];
}

/** What useOptimisticRecord answers. */
export interface OptimisticRecord<T, P> {
  /** The record with every pending patch laid over it, or null before a read. */
  value: T | null;
  /**
   * Applies a patch now and writes it. Resolves true once it lands and false
   * when it failed and was rolled back, and never rejects.
   */
  update: (patch: P) => Promise<boolean>;
  /** Takes a record some other write answered with, such as a title save. */
  receive: (value: T) => void;
  /** Whether any write is in flight. */
  isSaving: boolean;
}

interface Pending<P> {
  id: number;
  patch: P;
}

/** Lays a patch over a record as a shallow merge, leaving both untouched. */
export const applyPatch = <T extends object, P extends object>(
  value: T,
  patch: P
): T => ({ ...value, ...patch });

/** Reads a string field off an unknown record, or undefined when absent. */
const field = (value: unknown, name: string): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const held = (value as Record<string, unknown>)[name];
  return typeof held === 'string' ? held : undefined;
};

/** Whether the candidate's `updated_at` is at least the held one's. */
const newerByUpdatedAt = <T>(candidate: T, held: T): boolean =>
  (field(candidate, 'updated_at') ?? '') >= (field(held, 'updated_at') ?? '');

/** Whether both values carry the same `id`. */
const sameById = <T>(left: T, right: T): boolean =>
  field(left, 'id') === field(right, 'id');

/** The notice shown when a write fails and nothing better was supplied. */
const defaultFailure = (error: unknown): string =>
  errorMessage(error, 'Could not save that change. It has been undone.');

/**
 * Holds a polled record with optimistic patches over it. Pass the latest
 * polled value as `server`; the answer is what to render.
 */
export const useOptimisticRecord = <T extends object, P extends object>(
  server: T | null,
  options: OptimisticOptions<T, P>
): OptimisticRecord<T, P> => {
  const {
    write,
    apply = applyPatch,
    isNewer = newerByUpdatedAt,
    isSame = sameById,
    failureMessage = defaultFailure,
    onSaved,
    invalidate = [],
  } = options;
  const [confirmed, setConfirmed] = useState<T | null>(null);
  const [pending, setPending] = useState<Pending<P>[]>([]);
  const nextId = useRef(1);
  const { mutate } = useMutationWithRefetch(write, invalidate);

  const keep = useCallback(
    (value: T): void => {
      setConfirmed((held) =>
        held === null || !isSame(held, value) || isNewer(value, held)
          ? value
          : held
      );
    },
    [isNewer, isSame]
  );

  let base: T | null = server;
  if (
    confirmed !== null &&
    (server === null ||
      (isSame(confirmed, server) && !isNewer(server, confirmed)))
  ) {
    base = confirmed;
  }
  const value =
    base === null
      ? null
      : pending.reduce((held, entry) => apply(held, entry.patch), base);

  const update = useCallback(
    (patch: P): Promise<boolean> => {
      const id = nextId.current;
      nextId.current += 1;
      setPending((held) => [...held, { id, patch }]);
      const settle = (): void => {
        setPending((held) => held.filter((entry) => entry.id !== id));
      };
      return mutate(patch).then(
        (saved) => {
          keep(saved);
          settle();
          onSaved?.(saved);
          return true;
        },
        (error: unknown) => {
          settle();
          showErrorToast(failureMessage(error));
          return false;
        }
      );
    },
    [mutate, keep, onSaved, failureMessage]
  );

  return {
    value,
    update,
    receive: keep,
    isSaving: pending.length > 0,
  };
};
