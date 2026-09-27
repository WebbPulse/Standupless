/**
 * How far each upload in the rich editor has got, kept outside React so the
 * placeholder node a file sits in can show its bar without the editor
 * threading progress through the document.
 */

import { useSyncExternalStore } from 'react';

/** The fraction sent for each upload in flight, by placeholder id. */
const progress = new Map<string, number>();

/** Everyone showing a progress bar, told on each change. */
const listeners = new Set<() => void>();

/** Tells every bar that something moved. */
const notify = (): void => {
  for (const listener of Array.from(listeners)) listener();
};

/** Records a new fraction for one upload. */
export const setUploadProgress = (uploadId: string, fraction: number): void => {
  if (progress.get(uploadId) === fraction) return;
  progress.set(uploadId, fraction);
  notify();
};

/** Forgets an upload once it has settled either way. */
export const clearUploadProgress = (uploadId: string): void => {
  if (progress.delete(uploadId)) notify();
};

/** Subscribes to progress changes. */
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The fraction sent for one upload, rerendering as it moves. */
export const useUploadProgress = (uploadId: string): number =>
  useSyncExternalStore(subscribe, () => progress.get(uploadId) ?? 0);
