/**
 * The shortcut registry: that it stands down while a person types or a
 * dialog is open, that it matches two-key sequences and forgets a stale first
 * key, that modifiers are respected, and how it picks between two bindings of
 * the same keys.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createShortcutRegistry,
  displayKeys,
  parseKeys,
  SEQUENCE_TIMEOUT_MS,
  type RegisteredShortcut,
  type ShortcutRegistry,
} from './useShortcuts';

let order = 0;

/** Registers a shortcut with a spy handler and returns the spy. */
const bind = (
  registry: ShortcutRegistry,
  keys: string,
  scope: RegisteredShortcut['scope'] = 'global'
) => {
  const run = vi.fn();
  order += 1;
  registry.register({
    id: `${keys}-${String(order)}`,
    keys,
    label: keys,
    scope,
    group: 'General',
    run,
    order,
  });
  return run;
};

/** Dispatches a keydown at `target` and feeds it to the registry. */
const press = (
  registry: ShortcutRegistry,
  key: string,
  init: KeyboardEventInit = {},
  target: EventTarget = document.body
): boolean => {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  Object.defineProperty(event, 'target', { value: target });
  return registry.handleKey(event);
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('when shortcuts stand down', () => {
  it('fires on a plain key press', () => {
    const registry = createShortcutRegistry();
    const run = bind(registry, 'c');

    expect(press(registry, 'c')).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never fires while focus is in a text field', () => {
    const registry = createShortcutRegistry();
    const run = bind(registry, 'c');
    const input = document.createElement('input');
    document.body.append(input);

    expect(press(registry, 'c', {}, input)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('never fires inside a textarea or contenteditable', () => {
    const registry = createShortcutRegistry();
    const run = bind(registry, 'c');
    const area = document.createElement('textarea');
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const inner = document.createElement('span');
    editor.append(inner);
    document.body.append(area, editor);

    press(registry, 'c', {}, area);
    press(registry, 'c', {}, inner);

    expect(run).not.toHaveBeenCalled();
  });

  it('never fires while a modal dialog is open', () => {
    const registry = createShortcutRegistry();
    const run = bind(registry, 'c');
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);

    press(registry, 'c');

    expect(run).not.toHaveBeenCalled();
  });

  it('leaves an event another handler already claimed', () => {
    const registry = createShortcutRegistry();
    const run = bind(registry, 'c');
    const event = new KeyboardEvent('keydown', { key: 'c', cancelable: true });
    event.preventDefault();

    expect(registry.handleKey(event)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('modifiers', () => {
  it('ignores a letter pressed with Ctrl, Cmd or Alt', () => {
    const registry = createShortcutRegistry();
    const run = bind(registry, 'c');

    press(registry, 'c', { ctrlKey: true });
    press(registry, 'c', { metaKey: true });
    press(registry, 'c', { altKey: true });

    expect(run).not.toHaveBeenCalled();
  });

  it('ignores a letter pressed with Shift unless the binding asks for it', () => {
    const registry = createShortcutRegistry();
    const plain = bind(registry, 'c');
    const shifted = bind(registry, 'shift+c');

    press(registry, 'C', { shiftKey: true });

    expect(plain).not.toHaveBeenCalled();
    expect(shifted).toHaveBeenCalledTimes(1);
  });

  it('matches punctuation that needs Shift to type', () => {
    const registry = createShortcutRegistry();
    const run = bind(registry, '?');

    press(registry, '?', { shiftKey: true });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('matches a mod binding on either Ctrl or Cmd', () => {
    const registry = createShortcutRegistry();
    const run = bind(registry, 'mod+k');

    press(registry, 'k');
    press(registry, 'k', { ctrlKey: true });
    press(registry, 'k', { metaKey: true });

    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('sequences', () => {
  it('runs a two key sequence and not the single key it starts with', () => {
    const registry = createShortcutRegistry();
    const inbox = bind(registry, 'g i');

    expect(press(registry, 'g')).toBe(true);
    expect(inbox).not.toHaveBeenCalled();
    press(registry, 'i');

    expect(inbox).toHaveBeenCalledTimes(1);
  });

  it('tells G then C apart from C alone', () => {
    const registry = createShortcutRegistry();
    const create = bind(registry, 'c');
    const cycles = bind(registry, 'g c');

    press(registry, 'g');
    press(registry, 'c');
    expect(cycles).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();

    press(registry, 'c');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('forgets the first key once the sequence times out', () => {
    let clock = 0;
    const registry = createShortcutRegistry(() => clock);
    const inbox = bind(registry, 'g i');

    press(registry, 'g');
    clock += SEQUENCE_TIMEOUT_MS + 1;
    press(registry, 'i');

    expect(inbox).not.toHaveBeenCalled();
  });

  it('drops a pending first key when focus moves into a field', () => {
    const registry = createShortcutRegistry();
    const inbox = bind(registry, 'g i');
    const input = document.createElement('input');
    document.body.append(input);

    press(registry, 'g');
    press(registry, 'x', {}, input);
    press(registry, 'i');

    expect(inbox).not.toHaveBeenCalled();
  });

  it('starts over on a key that does not continue the sequence', () => {
    const registry = createShortcutRegistry();
    const inbox = bind(registry, 'g i');
    const create = bind(registry, 'c');

    press(registry, 'g');
    press(registry, 'c');

    expect(inbox).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('choosing between bindings', () => {
  it('lets the focused issue take a key a global shortcut also binds', () => {
    const registry = createShortcutRegistry();
    const issue = bind(registry, 's', 'issue');
    const global = bind(registry, 's');

    press(registry, 's');

    expect(issue).toHaveBeenCalledTimes(1);
    expect(global).not.toHaveBeenCalled();
  });

  it('lets the latest registration of the same keys win, and hands back on removal', () => {
    const registry = createShortcutRegistry();
    const page = bind(registry, 's', 'issue');
    const peek = vi.fn();
    const remove = registry.register({
      id: 'peek',
      keys: 's',
      label: 'Status',
      scope: 'issue',
      group: 'Issue',
      run: peek,
      order: 1000,
    });

    press(registry, 's');
    expect(peek).toHaveBeenCalledTimes(1);
    expect(page).not.toHaveBeenCalled();

    remove();
    press(registry, 's');
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('lists one winner per key sequence and scope', () => {
    const registry = createShortcutRegistry();
    bind(registry, 's', 'issue');
    bind(registry, 's', 'issue');
    bind(registry, 'c');

    expect(registry.list()).toHaveLength(2);
  });
});

describe('parsing and display', () => {
  it('parses modifiers off each token', () => {
    expect(parseKeys('mod+k')).toEqual([{ key: 'k', shift: false, mod: true }]);
    expect(parseKeys('g i')).toHaveLength(2);
  });

  it('shows keys the way the help overlay prints them', () => {
    expect(displayKeys('g i')).toEqual(['G', 'I']);
  });
});
