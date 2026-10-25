/**
 * The project page's property shortcuts: s status, p priority, a lead,
 * m members, h health, Shift+S start date and Shift+D target date. Each key
 * opens the same chip picker a click opens, found in the properties row by the
 * chip's "Field: value" name, so the keyboard and the mouse share one picker
 * and one save path. The initiative page binds its own subset of the same keys
 * through the same component, listed under its own heading.
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
 * The property shortcuts the initiative page binds, in palette order. They
 * reuse the project page's keys, with A opening the owner because an
 * initiative has an owner where a project has a lead.
 */
export const INITIATIVE_PROPERTY_KEYS: ProjectPropertyKey[] = [
  { keys: 's', label: 'Change status', field: 'Status' },
  { keys: 'a', label: 'Change owner', field: 'Owner' },
  { keys: 'h', label: 'Change health', field: 'Health' },
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
  group: string;
}

/** Binds one property shortcut to the chip it opens. */
const PropertyShortcut: React.FC<PropertyShortcutProps> = ({
  shortcut,
  container,
  enabled,
  group,
}) => {
  useShortcut({
    keys: shortcut.keys,
    label: shortcut.label,
    scope: 'page',
    group,
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
  /** The shortcuts to bind. Defaults to the project page's. */
  shortcuts?: ProjectPropertyKey[];
  /** The help and palette heading they are listed under. */
  group?: string;
}

/** Binds a page's property shortcuts while it is mounted. */
const ProjectPropertyKeys: React.FC<ProjectPropertyKeysProps> = ({
  container,
  enabled,
  shortcuts = PROJECT_PROPERTY_KEYS,
  group = 'Project',
}) => (
  <>
    {shortcuts.map((shortcut) => (
      <PropertyShortcut
        key={shortcut.keys}
        shortcut={shortcut}
        container={container}
        enabled={enabled}
        group={group}
      />
    ))}
  </>
);

export default ProjectPropertyKeys;
