/**
 * The corner stack the notices in `lib/toast` render into. Any surface that
 * raises notices may mount one; only the first mounted instance draws, so a
 * page level Toaster and a later application level one never show a notice
 * twice.
 */

import React, { useEffect, useId, useSyncExternalStore } from 'react';
import { LuX } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { currentToasts, dismissToast, subscribeToasts } from '../../lib/toast';

const owners: string[] = [];
const ownerListeners = new Set<() => void>();

/** Subscribes to changes in which Toaster instance draws. */
const subscribeOwners = (listener: () => void): (() => void) => {
  ownerListeners.add(listener);
  return () => {
    ownerListeners.delete(listener);
  };
};

/** Tells every instance the drawing instance may have changed. */
const emitOwners = (): void => {
  for (const listener of [...ownerListeners]) listener();
};

/** The id of the instance that draws, or null when none is mounted. */
const currentOwner = (): string | null => owners[0] ?? null;

/** The stack of notices, drawn in the bottom right corner. */
export const Toaster: React.FC = () => {
  const id = useId();
  const toasts = useSyncExternalStore(subscribeToasts, currentToasts);
  const owner = useSyncExternalStore(subscribeOwners, currentOwner);

  useEffect(() => {
    owners.push(id);
    emitOwners();
    return () => {
      const index = owners.indexOf(id);
      if (index >= 0) owners.splice(index, 1);
      emitOwners();
    };
  }, [id]);

  if (owner !== id) return null;

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[70] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'pointer-events-auto flex items-start gap-2 rounded-md border bg-overlay px-3 py-2 text-sm shadow-overlay',
            toast.tone === 'error' ? 'border-danger/40' : 'border-line'
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
              toast.tone === 'error' ? 'bg-danger' : 'bg-accent'
            )}
          />
          <p className="min-w-0 flex-1 text-text">{toast.message}</p>
          {toast.action !== undefined && (
            <Link
              to={toast.action.to}
              className="shrink-0 rounded-sm px-1 font-medium text-accent hover:underline"
              onClick={() => {
                dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </Link>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            className="-mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-text-faint hover:bg-raised hover:text-text"
            onClick={() => {
              dismissToast(toast.id);
            }}
          >
            <LuX aria-hidden="true" className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
};

export default Toaster;
