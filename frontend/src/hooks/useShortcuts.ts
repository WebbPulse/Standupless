/**
 * The keyboard shortcut layer: one registry per workspace, one document
 * listener, and a small hook any component uses to add a shortcut while it is
 * mounted.
 *
 * Why a registry rather than a listener per component: sequences such as
 * `g i` need one place that holds the pending first key, the help overlay and
 * the command palette need one place to list what is bound right now, and two
 * components binding the same key need one rule for who wins.
 *
 * ## Registering a shortcut
 *
 * ```tsx
 * useShortcut({
 *   keys: 's',
 *   label: 'Change status',
 *   scope: 'issue',
 *   group: 'Issue',
 *   handler: () => { setStatusOpen(true); },
 * });
 * ```
 *
 * - `keys` is one key or a space separated sequence (`'c'`, `'g i'`, `'?'`,
 *   `'/'`, `'escape'`). A token may carry `shift+` or `mod+` (Ctrl, or Cmd on
 *   a Mac). Letters are matched case-insensitively and never match while Shift
 *   is held unless the token says `shift+`; punctuation such as `?` ignores
 *   Shift, because producing it needs Shift on most layouts.
 * - `scope` is `'global'` (the default) for shortcuts that work anywhere in a
 *   workspace, or `'issue'` for shortcuts that act on the issue in focus: the
 *   issue page, a peeked issue, or a highlighted row. The command palette lists
 *   every enabled `'issue'` shortcut as an action on the current issue, so a
 *   control that registers `S` for status is also reachable by name.
 * - `handler` receives the keyboard event, or nothing when the palette runs the
 *   shortcut. It is read through a ref, so passing a new closure each render
 *   does not re-register.
 * - `enabled: false` keeps the registration but stops it firing and hides it,
 *   for a shortcut that only applies in some states.
 *
 * The reserved focused-issue keys are `s` status, `p` priority, `a` assignee,
 * `l` labels and `x` select, all in the `'issue'` scope. When more than one
 * mounted component binds the same keys, the most recently registered one
 * wins, so a peek opened over the issue page takes the keys while it is open
 * and hands them back when it closes.
 *
 * ## When shortcuts stand down
 *
 * Nothing fires while focus is in an input, a textarea, a select or anything
 * contenteditable, while Ctrl, Cmd or Alt is held (unless the token asks for
 * `mod+`), while a modal dialog is open, or when another handler already
 * claimed the event. Outside a {@link ShortcutRegistryContext} provider the
 * hooks do nothing, so a page renders the same in a test without the shell.
 */

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
} from 'react';
import { modKeyLabel, shiftKeyLabel } from '../lib/platform';
import { isModalOpen, isTypingTarget } from './useCommandPalette';

/** Where a shortcut applies: anywhere in the workspace, or to the issue in focus. */
export type ShortcutScope = 'global' | 'issue';

/** What a component hands to {@link useShortcut}. */
export interface ShortcutDefinition {
  /** One key or a space separated sequence, such as `'c'` or `'g i'`. */
  keys: string;
  /** What the shortcut does, as the help overlay and the palette show it. */
  label: string;
  /** Runs the shortcut. The event is absent when the palette runs it. */
  handler: (event?: KeyboardEvent) => void;
  /** Where it applies. Defaults to `'global'`. */
  scope?: ShortcutScope;
  /** The heading it is listed under in the help overlay. */
  group?: string;
  /** False to keep the registration but stop it firing. Defaults to true. */
  enabled?: boolean;
}

/** One registration as the registry holds it. */
export interface RegisteredShortcut {
  /** Unique per mounted registration. */
  id: string;
  keys: string;
  label: string;
  scope: ShortcutScope;
  group: string;
  /** Runs the registration's current handler. */
  run: (event?: KeyboardEvent) => void;
  /** Registration order, so the latest binding of the same keys wins. */
  order: number;
}

/** The registry the provider owns and the hooks talk to. */
export interface ShortcutRegistry {
  /** Adds or replaces a registration. Returns the function that removes it. */
  register: (shortcut: RegisteredShortcut) => () => void;
  /** Every enabled registration, the winner for each key sequence only. */
  list: () => RegisteredShortcut[];
  /** Listens for registrations changing. Returns the unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
  /** A number that changes whenever the registrations do. */
  version: () => number;
  /**
   * Feeds one key event through the sequence matcher and runs the shortcut it
   * completes. Returns true when the event was consumed.
   */
  handleKey: (event: KeyboardEvent) => boolean;
}

/** The registry the workspace shell provides, or null outside one. */
export const ShortcutRegistryContext = createContext<ShortcutRegistry | null>(
  null
);

/** How long the first key of a sequence waits for the second, in ms. */
export const SEQUENCE_TIMEOUT_MS = 1200;

/** A modifier-qualified token, parsed from a `keys` string. */
interface KeyToken {
  key: string;
  shift: boolean;
  mod: boolean;
}

/** Splits a `keys` string into its tokens. */
export const parseKeys = (keys: string): KeyToken[] =>
  keys
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '')
    .map((part) => {
      const pieces = part.toLowerCase().split('+');
      const key = pieces.pop() ?? '';
      return {
        key: key === 'esc' ? 'escape' : key,
        shift: pieces.includes('shift'),
        mod: pieces.includes('mod'),
      };
    });

/** Whether a key name is a single letter, the keys Shift changes the meaning of. */
const isLetter = (key: string): boolean => /^[a-z]$/.test(key);

/** The unshifted character on the physical keys a shifted token may name. */
const CODE_KEYS: Record<string, string> = {
  Period: '.',
  Comma: ',',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backslash: '\\',
  Backquote: '`',
};

/** The unshifted character a physical key types, when it is one of those. */
const keyFromCode = (code: string | undefined): string | undefined => {
  if (code === undefined) return undefined;
  const digit = /^Digit(\d)$/.exec(code);
  return digit?.[1] ?? CODE_KEYS[code];
};

/**
 * Whether one keyboard event is the given token. A `shift+` token on a
 * punctuation or digit key is also matched by the physical key, because Shift
 * turns `.` into `>` on most layouts and the event reports the shifted glyph.
 */
export const eventMatches = (
  event: KeyboardEvent,
  token: KeyToken
): boolean => {
  const key = event.key.toLowerCase();
  const byCode =
    token.shift &&
    !isLetter(token.key) &&
    event.shiftKey &&
    keyFromCode(event.code) === token.key;
  if (key !== token.key && !byCode) return false;
  if (event.altKey) return false;
  const mod = event.ctrlKey || event.metaKey;
  if (mod !== token.mod) return false;
  if (isLetter(token.key) && event.shiftKey !== token.shift) return false;
  if (token.shift && !event.shiftKey) return false;
  return true;
};

/**
 * Picks the winning registration for each key sequence and scope, which is the
 * one registered last.
 */
const winners = (all: Iterable<RegisteredShortcut>): RegisteredShortcut[] => {
  const byKeys = new Map<string, RegisteredShortcut>();
  for (const shortcut of all) {
    const slot = `${shortcut.scope}|${shortcut.keys}`;
    const held = byKeys.get(slot);
    if (held === undefined || held.order < shortcut.order) {
      byKeys.set(slot, shortcut);
    }
  }
  return [...byKeys.values()].sort((a, b) => a.order - b.order);
};

/**
 * Builds a registry. The provider makes one per workspace; a test can make one
 * directly and feed it events.
 */
export const createShortcutRegistry = (
  now: () => number = () => Date.now()
): ShortcutRegistry => {
  const entries = new Map<string, RegisteredShortcut>();
  const listeners = new Set<() => void>();
  let revision = 0;
  let pending: KeyToken[] = [];
  let pendingAt = 0;
  let cached: RegisteredShortcut[] | null = null;

  const changed = (): void => {
    revision += 1;
    cached = null;
    for (const listener of [...listeners]) listener();
  };

  const list = (): RegisteredShortcut[] => {
    cached ??= winners(entries.values());
    return cached;
  };

  const sequenceMatches = (
    event: KeyboardEvent,
    prefix: KeyToken[],
    tokens: KeyToken[]
  ): 'full' | 'prefix' | 'none' => {
    const length = prefix.length + 1;
    if (tokens.length < length) return 'none';
    for (let at = 0; at < prefix.length; at += 1) {
      const want = tokens[at];
      const got = prefix[at];
      if (
        want === undefined ||
        got === undefined ||
        want.key !== got.key ||
        want.shift !== got.shift ||
        want.mod !== got.mod
      ) {
        return 'none';
      }
    }
    const last = tokens[prefix.length];
    if (last === undefined || !eventMatches(event, last)) return 'none';
    return tokens.length === length ? 'full' : 'prefix';
  };

  const tokenFor = (event: KeyboardEvent): KeyToken => ({
    key: event.key.toLowerCase(),
    shift: isLetter(event.key.toLowerCase()) && event.shiftKey,
    mod: event.ctrlKey || event.metaKey,
  });

  const attempt = (event: KeyboardEvent, prefix: KeyToken[]): boolean => {
    let full: RegisteredShortcut | null = null;
    let partial = false;
    for (const shortcut of list()) {
      const outcome = sequenceMatches(event, prefix, parseKeys(shortcut.keys));
      if (outcome === 'full') {
        if (
          full === null ||
          (shortcut.scope === 'issue' && full.scope !== 'issue') ||
          (shortcut.scope === full.scope && shortcut.order > full.order)
        ) {
          full = shortcut;
        }
      } else if (outcome === 'prefix') {
        partial = true;
      }
    }
    if (full !== null) {
      pending = [];
      event.preventDefault();
      full.run(event);
      return true;
    }
    if (partial) {
      pending = [...prefix, tokenFor(event)];
      pendingAt = now();
      event.preventDefault();
      return true;
    }
    return false;
  };

  const handleKey = (event: KeyboardEvent): boolean => {
    if (event.defaultPrevented || event.isComposing) return false;
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return false;
    if (isTypingTarget(event.target) || isModalOpen()) {
      pending = [];
      return false;
    }
    if (pending.length > 0 && now() - pendingAt > SEQUENCE_TIMEOUT_MS) {
      pending = [];
    }
    if (pending.length > 0) {
      const held = pending;
      pending = [];
      if (attempt(event, held)) return true;
    }
    return attempt(event, []);
  };

  return {
    register: (shortcut) => {
      entries.set(shortcut.id, shortcut);
      changed();
      return () => {
        if (entries.get(shortcut.id) === shortcut) {
          entries.delete(shortcut.id);
          changed();
        }
      };
    },
    list,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => revision,
    handleKey,
  };
};

/** A counter shared by every registration, so later ones outrank earlier ones. */
let registrationCounter = 0;

/**
 * Binds one shortcut while the calling component is mounted. Does nothing
 * outside the workspace shell. See the module docstring for the rules.
 */
export const useShortcut = (definition: ShortcutDefinition): void => {
  const registry = useContext(ShortcutRegistryContext);
  const id = useId();
  const handler = useRef(definition.handler);

  useEffect(() => {
    handler.current = definition.handler;
  });

  const { keys, label, scope = 'global', group, enabled = true } = definition;

  useEffect(() => {
    if (registry === null || !enabled) return;
    registrationCounter += 1;
    return registry.register({
      id,
      keys: keys.trim().toLowerCase(),
      label,
      scope,
      group: group ?? (scope === 'issue' ? 'Issue' : 'General'),
      order: registrationCounter,
      run: (event) => {
        handler.current(event);
      },
    });
  }, [registry, id, keys, label, scope, group, enabled]);
};

/**
 * The registry itself, for the surfaces that list or run what is bound: the
 * help overlay and the command palette. Null outside the workspace shell.
 */
export const useShortcutRegistry = (): ShortcutRegistry | null =>
  useContext(ShortcutRegistryContext);

/** Nothing bound, for the list hook outside a provider. */
const NONE: RegisteredShortcut[] = [];

/** A subscription that never fires, for the list hook outside a provider. */
const noSubscription = (): (() => void) => () => undefined;

/**
 * Every shortcut bound right now, re-rendering when one is added or removed.
 * Empty outside the workspace shell.
 */
export const useRegisteredShortcuts = (): RegisteredShortcut[] => {
  const registry = useContext(ShortcutRegistryContext);
  return useSyncExternalStore(
    registry === null ? noSubscription : registry.subscribe,
    registry === null ? () => NONE : registry.list,
    registry === null ? () => NONE : registry.list
  );
};

/** How a `keys` string reads on screen, one entry per key cap. */
export const displayKeys = (keys: string): string[] =>
  parseKeys(keys).map((token) => {
    const caps: string[] = [];
    if (token.mod) caps.push(modKeyLabel());
    if (token.shift) caps.push(shiftKeyLabel());
    const name =
      token.key === 'escape'
        ? 'Esc'
        : token.key === 'enter'
          ? 'Enter'
          : token.key.length === 1
            ? token.key.toUpperCase()
            : token.key;
    caps.push(name);
    return caps.join(' ');
  });
