/**
 * Copying text with a confirmation that shows in place for a moment, for
 * copy buttons that swap their icon or label rather than raising a toast. A
 * refused clipboard still raises the shared error toast.
 */

import { useEffect, useState } from 'react';
import { showErrorToast } from '../lib/toast';

/** How long a copy stays confirmed before the control returns to normal. */
const COPIED_MS = 1500;

/**
 * Copies `text`, answering whether the clipboard took it, and raising the
 * shared error toast when it did not.
 */
export const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await globalThis.navigator.clipboard.writeText(text);
    return true;
  } catch {
    showErrorToast('Could not copy to the clipboard.');
    return false;
  }
};

/**
 * Tracks a copy's confirmation: `copy` writes the text and sets `copied` for
 * a moment when it took.
 */
export const useCopy = (): {
  copied: boolean;
  copy: (text: string) => void;
} => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = globalThis.setTimeout(() => {
      setCopied(false);
    }, COPIED_MS);
    return () => {
      globalThis.clearTimeout(timer);
    };
  }, [copied]);

  return {
    copied,
    copy: (text: string) => {
      void copyToClipboard(text).then((took) => {
        if (took) setCopied(true);
      });
    },
  };
};
