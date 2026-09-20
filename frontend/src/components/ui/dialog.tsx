/**
 * A modal dialog with no library behind it: a backdrop, a titled panel, focus
 * moved inside on open and returned on close, and Escape or a backdrop click
 * to close.
 */

import React, { useEffect, useId, useRef } from 'react';
import { LuX } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { IconButton } from './button';

/** Props for Dialog: whether it is open, how to close it, and its content. */
export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** A sentence under the title, when the title alone is not enough. */
  description?: string;
  children: React.ReactNode;
  /** The panel width. */
  size?: 'sm' | 'md' | 'lg';
  /** Hides the title visually while keeping it as the dialog's name. */
  hideTitle?: boolean;
}

const SIZES: Record<NonNullable<DialogProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A centred modal panel over a dimmed backdrop. */
export const Dialog: React.FC<DialogProps> = ({
  open,
  onClose,
  title,
  description,
  children,
  size = 'md',
  hideTitle = false,
}) => {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || panel.current === null) return;
      const items = Array.from(
        panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)
      );
      if (items.length === 0) return;
      const head = items[0];
      const tail = items[items.length - 1];
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail?.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = bodyOverflow;
      previous?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-[10vh] dark:bg-black/60"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          'w-full rounded-lg border border-line bg-overlay shadow-overlay outline-none',
          SIZES[size]
        )}
      >
        <div
          className={cn(
            'flex items-start justify-between gap-4 px-4 pt-3',
            hideTitle ? '' : 'pb-2'
          )}
        >
          <div className={hideTitle ? 'sr-only' : 'min-w-0'}>
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {description !== undefined && (
              <p className="mt-0.5 text-sm text-text-muted">{description}</p>
            )}
          </div>
          <IconButton label="Close" size="sm" onClick={onClose}>
            <LuX className="h-3.5 w-3.5" />
          </IconButton>
        </div>
        <div className="px-4 pt-1 pb-4">{children}</div>
      </div>
    </div>
  );
};

export default Dialog;
