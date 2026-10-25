/**
 * Binds Print to Cmd or Ctrl+P on a page that prints cleanly, which also
 * lists it in the command palette under the page's group.
 */

import { PRINT_KEYS, PRINT_LABEL, printPage } from '../lib/print';
import { useShortcut, type ShortcutScope } from './useShortcuts';

/** What a page hands to {@link usePrintCommand}. */
export interface PrintCommandOptions {
  /** The heading the palette lists it under. */
  group: string;
  /** Where it applies. Defaults to `'page'`. */
  scope?: ShortcutScope;
  /** False while the page has nothing to print. Defaults to true. */
  enabled?: boolean;
}

/** Registers the Print command while the caller is mounted. */
export const usePrintCommand = ({
  group,
  scope = 'page',
  enabled = true,
}: PrintCommandOptions): void => {
  useShortcut({
    keys: PRINT_KEYS,
    label: PRINT_LABEL,
    scope,
    group,
    enabled,
    handler: (event) => {
      event?.preventDefault();
      printPage();
    },
  });
};
