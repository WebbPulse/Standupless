/**
 * A dropdown menu with no library behind it: a trigger, a floating list of
 * actions, arrow keys to move between them, Escape and outside clicks to
 * close. Items are buttons or links; a link item closes the menu on click too.
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

const ITEM_SELECTOR = '[role="menuitem"]:not([aria-disabled="true"])';

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
          <MenuContext.Provider value={{ open, close, listId }}>
            {children}
          </MenuContext.Provider>
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
      <MenuContext.Provider value={{ open: true, close: onClose, listId }}>
        {children}
      </MenuContext.Provider>
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
  children: React.ReactNode;
  className?: string;
}

/** One action in a Menu. */
export const MenuItem: React.FC<MenuItemProps> = ({
  onSelect,
  to,
  disabled = false,
  danger = false,
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
  <div className="px-2 pt-1.5 pb-1 text-2xs font-medium text-text-faint">
    {children}
  </div>
);

export default Menu;
