/**
 * The project page's property shortcuts: s status, p priority, a lead,
 * m members, h health, Shift+S start date and Shift+D target date. Each key
 * opens the same chip picker a click opens, found in the properties row by the
 * chip's "Field: value" name, so the keyboard and the mouse share one picker
 * and one save path.
 */

import React from 'react';
import { useShortcut } from '../../hooks/useShortcuts';

/** One property shortcut: its keys, palette label and the chip it opens. */
export interface ProjectPropertyKey {
  keys: string;
  label: string;
  field: string;
}

/** The property shortcuts the project page binds, in palette order. */
export const PROJECT_PROPERTY_KEYS: ProjectPropertyKey[] = [
  { keys: 's', label: 'Change status', field: 'Status' },
  { keys: 'p', label: 'Change priority', field: 'Priority' },
  { keys: 'a', label: 'Change lead', field: 'Lead' },
  { keys: 'm', label: 'Change members', field: 'Members' },
  { keys: 'h', label: 'Change health', field: 'Health' },
  { keys: 'shift+s', label: 'Set start date', field: 'Start date' },
  { keys: 'shift+d', label: 'Set target date', field: 'Target date' },
];

/**
 * Opens the chip picker named `field` inside `container`, then moves focus
 * into the panel it opened when the picker did not take focus itself.
 */
export const openPropertyChip = (
  container: HTMLElement | null,
  field: string
): boolean => {
  const trigger = container?.querySelector<HTMLButtonElement>(
    `button[aria-label^="${field}: "]:not([disabled])`
  );
  if (trigger === null || trigger === undefined) return false;
  trigger.focus();
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
  setTimeout(() => {
    const panelId = trigger.getAttribute('aria-controls');
    const panel = panelId === null ? null : document.getElementById(panelId);
    if (panel !== null && !panel.contains(document.activeElement)) {
      panel
        .querySelector<HTMLElement>('input, button, [tabindex="0"]')
        ?.focus();
    }
  }, 0);
  return true;
};

interface PropertyShortcutProps {
  shortcut: ProjectPropertyKey;
  container: React.RefObject<HTMLElement | null>;
  enabled: boolean;
}

/** Binds one property shortcut to the chip it opens. */
const PropertyShortcut: React.FC<PropertyShortcutProps> = ({
  shortcut,
  container,
  enabled,
}) => {
  useShortcut({
    keys: shortcut.keys,
    label: shortcut.label,
    scope: 'page',
    group: 'Project',
    enabled,
    handler: (event) => {
      if (openPropertyChip(container.current, shortcut.field)) {
        event?.preventDefault();
      }
    },
  });
  return null;
};

/** Props for ProjectPropertyKeys. */
export interface ProjectPropertyKeysProps {
  /** The properties row holding the chips the keys open. */
  container: React.RefObject<HTMLElement | null>;
  /** False for a reader who may not edit the project. */
  enabled: boolean;
}

/** Binds the project page's property shortcuts while it is mounted. */
const ProjectPropertyKeys: React.FC<ProjectPropertyKeysProps> = ({
  container,
  enabled,
}) => (
  <>
    {PROJECT_PROPERTY_KEYS.map((shortcut) => (
      <PropertyShortcut
        key={shortcut.keys}
        shortcut={shortcut}
        container={container}
        enabled={enabled}
      />
    ))}
  </>
);

export default ProjectPropertyKeys;
