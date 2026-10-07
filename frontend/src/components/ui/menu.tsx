/**
 * A dropdown menu with no library behind it: a trigger, a floating list of
 * actions, arrow keys to move between them, Escape and outside clicks to
 * close. Typing while it is open filters the items, focusing the first match
 * so Enter picks it, and Backspace edits the filter. Items are buttons or
 * links; a link item closes the menu on click too.
 * {@link ContextMenu} is the same list opened at the pointer by a right click.
 *
 * The list is placed with fixed coordinates by the placement hook the popover uses too,
 * so it escapes a clipped sidebar, flips above the trigger near the bottom of
 * the screen and shifts back inside the viewport near either edge.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router-dom';
import { displayKeys } from '../../hooks/useShortcuts';
import { cn } from '../../lib/cn';
import { UNPLACED, useAnchoredPlacement } from './anchoredPlacement';
import { Kbd } from './badge';

interface MenuState {
  open: boolean;
  close: () => void;
  listId: string;
}

const MenuContext = createContext<MenuState>({
  open: false,
  close: () => undefined,
  listId: '',
});

/** Props for Menu: the trigger renderer, the alignment and the items. */
export interface MenuProps {
  /** Renders the button that opens the menu, given the props it needs. */
  trigger: (props: {
    onClick: () => void;
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    'aria-controls': string;
  }) => React.ReactNode;
  /** Which edge of the trigger the list lines up with. */
  align?: 'start' | 'end';
  /** The name assistive technology announces for the list. */
  label: string;
  children: React.ReactNode;
  className?: string;
}

const ITEM_SELECTOR =
  '[role="menuitem"]:not([aria-disabled="true"]):not([hidden])';

/** The list's own classes, shared by the dropdown and the context menu. */
const LIST_CLASS =
  'fixed z-[60] w-max max-w-80 min-w-44 rounded-md border border-line bg-overlay p-1 shadow-overlay';

/** Moves focus one item up or down the list on an arrow key, wrapping round. */
const moveFocus = (list: HTMLElement | null, event: KeyboardEvent): void => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const items = Array.from(
    list?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []
  );
  if (items.length === 0) return;
  event.preventDefault();
  const index = items.indexOf(document.activeElement as HTMLElement);
  const step = event.key === 'ArrowDown' ? 1 : -1;
  const next = (index + step + items.length) % items.length;
  items[next]?.focus();
};

/** The text an item is matched by: its textValue, else its visible text. */
const itemText = (item: HTMLElement): string => {
  const given = item.dataset['textValue'];
  if (given !== undefined) return given.toLowerCase();
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (
      node instanceof HTMLElement &&
      node.getAttribute('aria-hidden') === 'true'
    ) {
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(item);
  return parts.join('').replace(/\s+/g, ' ').trim().toLowerCase();
};

/** Whether a key press should edit the filter rather than reach the item. */
const filterEdit = (event: KeyboardEvent, query: string): string | null => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
    return null;
  }
  if (event.key === 'Backspace') {
    return query === '' ? null : query.slice(0, -1);
  }
  if (event.key.length !== 1) return null;
  if (event.key === ' ' && query === '') return null;
  return query + event.key;
};

/**
 * Filters a menu list as the user types. Keys are caught on the capture phase
 * so a letter edits the filter instead of firing a page shortcut, items that
 * do not match are hidden along with headings and rules, and focus moves to
 * the first match, preferring one whose text starts with the filter.
 */
const useMenuFilter = (
  list: React.RefObject<HTMLDivElement | null>,
  active: boolean
): string => {
  const [query, setQuery] = useState('');
  const current = useRef('');

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      const node = list.current;
      if (node === null || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        !node.contains(target) &&
        target !== document.body
      ) {
        return;
      }
      const next = filterEdit(event, current.current);
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      current.current = next;
      setQuery(next);
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      current.current = '';
      setQuery('');
    };
  }, [active, list]);

  useLayoutEffect(() => {
    const node = list.current;
    if (node === null) return;
    const needle = query.trim().toLowerCase();
    const filtering = needle !== '';
    const items = Array.from(
      node.querySelectorAll<HTMLElement>('[role="menuitem"]')
    );
    let visible = 0;
    for (const item of items) {
      const match = !filtering || itemText(item).includes(needle);
      item.hidden = !match;
      if (match) visible += 1;
    }
    node
      .querySelectorAll<HTMLElement>('[role="separator"], [data-menu-label]')
      .forEach((element) => {
        element.hidden = filtering;
      });
    const empty = node.querySelector<HTMLElement>('[data-menu-empty]');
    if (empty !== null) empty.hidden = !filtering || visible > 0;
  });

  useLayoutEffect(() => {
    const node = list.current;
    if (node === null || query.trim() === '') return;
    const needle = query.trim().toLowerCase();
    const candidates = Array.from(
      node.querySelectorAll<HTMLElement>(ITEM_SELECTOR)
    );
    const target =
      candidates.find((item) => itemText(item).startsWith(needle)) ??
      candidates[0];
    target?.focus();
  }, [query, list]);

  return query;
};

/** The filter line and the no match row a filtering list draws. */
const FilterChrome: React.FC<{ query: string; position: 'top' | 'bottom' }> = ({
  query,
  position,
}) =>
  position === 'top' ? (
    <div
      hidden={query.trim() === ''}
      className="mb-1 flex items-center gap-1.5 border-b border-line px-2 pt-1 pb-1.5 text-xs text-text-muted"
    >
      <span className="text-text-faint">Filter:</span>
      <span aria-live="polite" className="truncate text-text">
        {query}
      </span>
    </div>
  ) : (
    <div
      data-menu-empty=""
      hidden
      className="px-2 py-1.5 text-sm text-text-faint"
    >
      No matching items
    </div>
  );

/** A trigger and the list it opens. */
export const Menu: React.FC<MenuProps> = ({
  trigger,
  align = 'start',
  label,
  children,
  className = '',
}) => {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const close = useCallback(() => setOpen(false), []);
  useAnchoredPlacement(open, root, list, align);
  const query = useMenuFilter(list, open);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus();
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        root.current?.querySelector<HTMLElement>('button')?.focus();
        return;
      }
      moveFocus(list.current, event);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className={cn('inline-flex', className)}>
      {trigger({
        onClick: () => setOpen((value) => !value),
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': listId,
      })}
      {open && (
        <div
          ref={list}
          id={listId}
          role="menu"
          aria-label={label}
          style={UNPLACED}
          className={LIST_CLASS}
        >
          <FilterChrome query={query} position="top" />
          <MenuContext.Provider value={{ open, close, listId }}>
            {children}
          </MenuContext.Provider>
          <FilterChrome query={query} position="bottom" />
        </div>
      )}
    </div>
  );
};

/** The margin a context menu keeps from the viewport edge, in pixels. */
const CONTEXT_EDGE = 8;

/** Props for ContextMenu: where it opens, its name, and how it closes. */
export interface ContextMenuProps {
  /** The pointer's position in viewport coordinates. */
  x: number;
  y: number;
  /** The name assistive technology announces for the list. */
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * A menu opened at the pointer, for a right click on a row or a card. It
 * shifts back inside the viewport near an edge, and closes on Escape, an
 * outside click, a scroll or a resize.
 */
export const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  label,
  onClose,
  children,
}) => {
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const query = useMenuFilter(list, true);

  useLayoutEffect(() => {
    const node = list.current;
    if (node === null) return;
    const box = node.getBoundingClientRect();
    const left = Math.max(
      CONTEXT_EDGE,
      Math.min(x, window.innerWidth - box.width - CONTEXT_EDGE)
    );
    const top = Math.max(
      CONTEXT_EDGE,
      Math.min(y, window.innerHeight - box.height - CONTEXT_EDGE)
    );
    node.style.left = `${String(left)}px`;
    node.style.top = `${String(top)}px`;
    node.style.visibility = 'visible';
  }, [x, y]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus();
    const onPointer = (event: MouseEvent) => {
      if (!list.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      moveFocus(list.current, event);
    };
    const onViewport = () => {
      onClose();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onViewport);
    window.addEventListener('scroll', onViewport, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('scroll', onViewport, true);
    };
  }, [onClose]);

  return (
    <div
      ref={list}
      id={listId}
      role="menu"
      aria-label={label}
      style={UNPLACED}
      className={LIST_CLASS}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
    >
      <FilterChrome query={query} position="top" />
      <MenuContext.Provider value={{ open: true, close: onClose, listId }}>
        {children}
      </MenuContext.Provider>
      <FilterChrome query={query} position="bottom" />
    </div>
  );
};

const ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-text hover:bg-raised focus-visible:bg-raised aria-disabled:opacity-50';

/** Props for MenuItem: the action and its content. */
export interface MenuItemProps {
  onSelect?: () => void;
  /** A route to go to instead of an action. */
  to?: string;
  disabled?: boolean;
  /** Draws the item in the danger colour. */
  danger?: boolean;
  /** The text typing matches, when the visible text is not enough. */
  textValue?: string;
  children: React.ReactNode;
  className?: string;
}

/** One action in a Menu. */
export const MenuItem: React.FC<MenuItemProps> = ({
  onSelect,
  to,
  disabled = false,
  danger = false,
  textValue,
  children,
  className = '',
}) => {
  const { close } = useContext(MenuContext);
  const classes = cn(ITEM_CLASS, danger ? 'text-danger' : '', className);
  if (to !== undefined) {
    return (
      <Link
        to={to}
        role="menuitem"
        tabIndex={-1}
        data-text-value={textValue}
        className={classes}
        onClick={close}
      >
        {children}
      </Link>
    );
  }
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      data-text-value={textValue}
      aria-disabled={disabled ? 'true' : undefined}
      className={classes}
      onClick={() => {
        if (disabled) return;
        close();
        onSelect?.();
      }}
    >
      {children}
    </button>
  );
};

/** The shortcut keys at the end of a menu item, one cap per key. */
export const MenuShortcut: React.FC<{ keys: string }> = ({ keys }) => (
  <span aria-hidden="true" className="ml-auto flex gap-0.5 pl-4">
    {displayKeys(keys)
      .flatMap((token) => token.split(' '))
      .map((cap, index) => (
        <Kbd key={`${cap}-${String(index)}`}>{cap}</Kbd>
      ))}
  </span>
);

/** A thin rule between groups of items. */
export const MenuSeparator: React.FC = () => (
  <div role="separator" className="my-1 h-px bg-line" />
);

/** A small heading over a group of items. */
export const MenuLabel: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div
    data-menu-label=""
    className="px-2 pt-1.5 pb-1 text-2xs font-medium text-text-faint"
  >
    {children}
  </div>
);

export default Menu;
