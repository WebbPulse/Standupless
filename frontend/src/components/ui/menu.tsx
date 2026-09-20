/**
 * A dropdown menu with no library behind it: a trigger, a floating list of
 * actions, arrow keys to move between them, Escape and outside clicks to
 * close. Items are buttons or links; a link item closes the menu on click too.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';

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
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = Array.from(
        list.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []
      );
      if (items.length === 0) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = (index + step + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className={cn('relative inline-flex', className)}>
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
          className={cn(
            'absolute top-full z-40 mt-1 min-w-44 rounded-md border border-line bg-overlay p-1 shadow-overlay',
            align === 'end' ? 'right-0' : 'left-0'
          )}
        >
          <MenuContext.Provider value={{ open, close, listId }}>
            {children}
          </MenuContext.Provider>
        </div>
      )}
    </div>
  );
};

const ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-text outline-none hover:bg-raised focus-visible:bg-raised aria-disabled:opacity-50';

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
