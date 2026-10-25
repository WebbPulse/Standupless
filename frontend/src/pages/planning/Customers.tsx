/**
 * Every customer of the workspace as a dense list: name and domains, status,
 * tier, owner, size, revenue and how many requests each has made, with how
 * many of those are important. A column header sorts the list, the search box
 * narrows it by name or domain, the status menu filters it, grouping splits it
 * by status, and a row opens the customer's page with its requests.
 *
 * The keyboard works it the way the issue list is worked: J, K and the arrow
 * keys move a highlight, Enter opens the customer, X selects it, Escape lets
 * go, S, A and T open the focused row's status, owner and tier pickers, and
 * Cmd or Ctrl and Backspace deletes the focused or selected customers once
 * confirmed. The row menu lists the same keys.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import {
  LuArrowDown,
  LuArrowUp,
  LuBuilding2,
  LuCheck,
  LuArrowUpRight,
  LuCircleAlert,
  LuCircleDashed,
  LuEllipsis,
  LuLayers,
  LuPlus,
  LuSearch,
  LuTag,
  LuTrash2,
  LuUserRound,
} from 'react-icons/lu';
import { Link, useNavigate } from 'react-router-dom';
import { deleteCustomer, updateCustomer } from '../../api/customers';
import CustomerDialog from '../../components/customers/CustomerDialog';
import {
  CustomerStatusDot,
  CustomerStatusPicker,
} from '../../components/customers/CustomerStatusPicker';
import { CustomerTierPicker } from '../../components/customers/CustomerTierPicker';
import { LeadPicker } from '../../components/planning/ProjectPickers';
import { openPropertyChip } from '../../components/planning/ProjectPropertyKeys';
import { ErrorAlert } from '../../components/ui/alert';
import Button, { IconButton } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import Menu, {
  MenuItem,
  MenuSeparator,
  MenuShortcut,
} from '../../components/ui/menu';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useCustomerFields } from '../../hooks/useCustomerFields';
import { useCustomers } from '../../hooks/useCustomers';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { useProjectSelection } from '../../hooks/useProjectSelection';
import { useShortcut, type ShortcutDefinition } from '../../hooks/useShortcuts';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { canManageMembers } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import {
  customerFieldLabel,
  customerFieldOf,
  revenueLabel,
  sizeLabel,
} from '../../lib/customerDisplay';
import { errorMessage } from '../../lib/errors';
import type { Assignable } from '../../lib/issuePeople';
import { customerPath, settingsPath } from '../../lib/paths';
import { showErrorToast, showToast } from '../../lib/toast';
import type {
  CustomerFieldRead,
  CustomerPatch,
  CustomerRead,
} from '../../types/Api';

/** The grid every header and row lines up on. */
const GRID =
  'grid grid-cols-[minmax(0,1fr)_6rem_1.75rem] items-center gap-3 md:grid-cols-[minmax(0,1fr)_5.5rem_7rem_4rem_4.5rem_5.5rem_6rem_1.75rem]';

/** One property a key opens on the focused customer, and the picker it opens. */
interface CustomerPropertyKey {
  keys: string;
  label: string;
  field: string;
}

/**
 * The property keys of the customers list, the letters the issue list uses
 * where they apply: S status and A owner, with T for tier, which issues have
 * no counterpart for. Each opens the row's own picker, found by its
 * "Field: value" name, so a key, the row menu and a click share one picker.
 */
/** S opens the focused customer's status picker. */
const STATUS_KEY: CustomerPropertyKey = {
  keys: 's',
  label: 'Change status',
  field: 'Status',
};
/** A opens the focused customer's owner picker. */
const OWNER_KEY: CustomerPropertyKey = {
  keys: 'a',
  label: 'Change owner',
  field: 'Owner',
};
/** T opens the focused customer's tier picker. */
const TIER_KEY: CustomerPropertyKey = {
  keys: 't',
  label: 'Change tier',
  field: 'Tier',
};

/** The property keys in the order the row menu lists them. */
const PROPERTY_KEYS: CustomerPropertyKey[] = [STATUS_KEY, OWNER_KEY, TIER_KEY];

/** The keys that delete the focused or selected customers. */
const DELETE_KEYS = 'mod+backspace';

/** The icon of each property item in the row menu. */
const PROPERTY_ICONS: Record<string, React.ReactNode> = {
  Status: <LuCircleDashed aria-hidden="true" className="h-3.5 w-3.5" />,
  Owner: <LuUserRound aria-hidden="true" className="h-3.5 w-3.5" />,
  Tier: <LuTag aria-hidden="true" className="h-3.5 w-3.5" />,
};

/** The row element of a customer, found by the id it carries. */
const rowElement = (customerId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    `[data-customer-id="${CSS.escape(customerId)}"]`
  );

/**
 * Opens one picker on a customer's row. Run after the current event settles,
 * so a menu that just closed hands focus back before the picker takes it.
 */
const openRowPicker = (customerId: string, field: string): void => {
  setTimeout(() => {
    openPropertyChip(rowElement(customerId), field);
  }, 0);
};

/** The status filter: one status id, customers with none, or every customer. */
type StatusFilter = string;

/** Whether a customer passes the status filter. */
const statusMatches = (row: CustomerRead, filter: StatusFilter): boolean =>
  filter === 'all' ||
  (filter === 'none' ? row.status_id === null : row.status_id === filter);

/** How the status filter reads on its button. */
const statusFilterLabel = (
  filter: StatusFilter,
  statuses: readonly CustomerFieldRead[]
): string =>
  filter === 'all'
    ? 'All statuses'
    : filter === 'none'
      ? 'No status'
      : customerFieldLabel(customerFieldOf(statuses, filter), 'No status');

/** The status a filter option draws its dot from, none for every customer. */
const filterStatus = (
  filter: StatusFilter,
  statuses: readonly CustomerFieldRead[]
): CustomerFieldRead | null =>
  filter === 'all' || filter === 'none'
    ? null
    : customerFieldOf(statuses, filter);

/** The columns the list sorts by. */
type SortKey = 'name' | 'size' | 'revenue' | 'requests';

/** How the list is sorted: the column and its direction. */
interface Sort {
  key: SortKey;
  descending: boolean;
}

/** Orders two customers by the chosen column, unset values last, then by name. */
const compare = (
  left: CustomerRead,
  right: CustomerRead,
  sort: Sort
): number => {
  const byName = left.name.localeCompare(right.name);
  if (sort.key === 'name') return sort.descending ? -byName : byName;
  const pick = (row: CustomerRead): number | null =>
    sort.key === 'size'
      ? row.size
      : sort.key === 'revenue'
        ? row.revenue
        : row.request_count;
  const a = pick(left);
  const b = pick(right);
  if (a === b) return byName;
  if (a === null) return 1;
  if (b === null) return -1;
  return sort.descending ? b - a : a - b;
};

/** Whether a customer matches the search text by name or domain. */
const matches = (row: CustomerRead, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return (
    row.name.toLowerCase().includes(needle) ||
    row.domains.some((domain) => domain.includes(needle))
  );
};

/** A header cell that sorts the list by its column. */
const SortHeader: React.FC<{
  label: string;
  column: SortKey;
  sort: Sort;
  onSort: (column: SortKey) => void;
  className?: string;
}> = ({ label, column, sort, onSort, className = '' }) => {
  const active = sort.key === column;
  const Arrow = sort.descending ? LuArrowDown : LuArrowUp;
  return (
    <button
      type="button"
      aria-label={`Sort by ${label.toLowerCase()}`}
      aria-pressed={active}
      onClick={() => {
        onSort(column);
      }}
      className={cn(
        'flex min-w-0 items-center gap-1 rounded-xs uppercase hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
        active && 'text-text-muted',
        className
      )}
    >
      <span className="truncate">{label}</span>
      {active && <Arrow aria-hidden="true" className="h-3 w-3 shrink-0" />}
    </button>
  );
};

/** Props for CustomerRow: the customer, how it is drawn and what it may do. */
interface CustomerRowProps {
  customer: CustomerRead;
  slug: string;
  people: Assignable[];
  /** The statuses the status picker offers. */
  statuses: CustomerFieldRead[];
  /** The tiers the tier picker offers. */
  tiers: CustomerFieldRead[];
  isActive: boolean;
  selected: boolean;
  /** Whether any customer is selected, which keeps every checkbox showing. */
  selecting: boolean;
  rowRef: (node: HTMLElement | null) => void;
  onPointerEnter: () => void;
  /** Picks or drops the customer, or takes the run to it with `range`. */
  onSelect: (range: boolean) => void;
  onChange: (patch: CustomerPatch) => void;
  /** Opens the settings page where tiers are added, for an admin. */
  onManageTiers?: () => void;
  onDelete: () => void;
}

/**
 * One customer as a row linking to its page. Its status, tier and owner are
 * pickers a member who may edit it can change in place, and its menu offers
 * the same changes beside their keys.
 */
const CustomerRow: React.FC<CustomerRowProps> = ({
  customer,
  slug,
  people,
  statuses,
  tiers,
  isActive,
  selected,
  selecting,
  rowRef,
  onPointerEnter,
  onSelect,
  onChange,
  onManageTiers,
  onDelete,
}) => {
  const revenue = revenueLabel(customer.revenue);
  const size = sizeLabel(customer.size);
  const requests = customer.request_count;
  const important = customer.important_count;
  const path = customerPath(slug, customer.customer_id);
  return (
    <li
      ref={rowRef}
      data-customer-id={customer.customer_id}
      aria-current={isActive ? 'true' : undefined}
      aria-selected={selected}
      onPointerEnter={onPointerEnter}
      className={cn(
        GRID,
        'group/row relative h-11 border-b border-line px-4 text-sm transition-colors duration-100 hover:bg-surface has-[a:active]:bg-raised lg:px-6',
        isActive &&
          'bg-surface before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent',
        selected && 'bg-accent-soft hover:bg-accent-soft'
      )}
    >
      <Link
        to={path}
        aria-label={customer.name}
        data-hover="parent"
        onClick={(event) => {
          if (event.shiftKey) {
            event.preventDefault();
            onSelect(true);
          }
        }}
        className="absolute inset-0 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset"
      />
      <div className="pointer-events-none flex min-w-0 items-center gap-2.5">
        <span className="relative flex shrink-0 items-center justify-center">
          <LuBuilding2
            aria-hidden="true"
            className={cn(
              'h-3.5 w-3.5 text-text-muted',
              selecting || selected
                ? 'invisible'
                : 'group-hover/row:invisible pointer-coarse:visible!'
            )}
          />
          <input
            type="checkbox"
            aria-label={`Select ${customer.name}`}
            checked={selected}
            onChange={(event) => {
              onSelect((event.nativeEvent as MouseEvent).shiftKey);
            }}
            onKeyDown={(event) => {
              if (event.key === ' ') event.stopPropagation();
            }}
            className={cn(
              'pointer-events-auto absolute inset-0 z-10 m-auto h-3.5 w-3.5 cursor-pointer accent-accent',
              !selecting &&
                !selected &&
                'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 pointer-coarse:hidden'
            )}
          />
        </span>
        <span className="truncate font-medium text-text">{customer.name}</span>
        {customer.domains.length > 0 && (
          <span className="hidden min-w-0 truncate text-xs text-text-faint sm:block">
            {customer.domains.join(', ')}
          </span>
        )}
      </div>
      <span className="relative z-10 hidden min-w-0 -translate-x-1 md:flex">
        <CustomerStatusPicker
          value={customer.status_id}
          valueName={customer.status_name}
          statuses={statuses}
          onChange={(statusId) => {
            onChange({ status_id: statusId });
          }}
          disabled={!customer.can_edit}
          variant="cell"
        />
      </span>
      <span className="relative z-10 hidden min-w-0 -translate-x-1 md:flex">
        <CustomerTierPicker
          value={customer.tier_id}
          valueName={customer.tier}
          tiers={tiers}
          onChange={(tierId) => {
            onChange({ tier_id: tierId });
          }}
          {...(onManageTiers === undefined ? {} : { onManage: onManageTiers })}
          disabled={!customer.can_edit}
        />
      </span>
      <span className="relative z-10 hidden justify-center md:flex">
        <LeadPicker
          field="Owner"
          value={customer.owner_id}
          people={people}
          onChange={(ownerId) => {
            onChange({ owner_id: ownerId });
          }}
          disabled={!customer.can_edit}
          variant="icon"
          align="end"
        />
      </span>
      <span
        className={cn(
          'pointer-events-none hidden text-xs tabular-nums md:block',
          size === null ? 'text-text-faint' : 'text-text-muted'
        )}
      >
        {size ?? 'None'}
      </span>
      <span
        className={cn(
          'pointer-events-none hidden text-xs tabular-nums md:block',
          revenue === null ? 'text-text-faint' : 'text-text-muted'
        )}
      >
        {revenue ?? 'None'}
      </span>
      <span className="pointer-events-none flex items-center justify-end gap-1.5 text-xs whitespace-nowrap text-text-muted tabular-nums">
        {important > 0 && (
          <span
            title={`${String(important)} important`}
            className="flex items-center gap-0.5 text-warning"
          >
            <LuCircleAlert aria-hidden="true" className="h-3 w-3" />
            <span aria-hidden="true">{String(important)}</span>
            <span className="sr-only">{`${String(important)} important`}</span>
          </span>
        )}
        <span>
          {`${String(requests)} ${requests === 1 ? 'request' : 'requests'}`}
        </span>
      </span>
      <span className="relative z-10 flex justify-end">
        <Menu
          label={`Actions for ${customer.name}`}
          align="end"
          trigger={(props) => (
            <IconButton
              {...props}
              label={`Actions for ${customer.name}`}
              size="sm"
              className="opacity-60 group-hover/row:opacity-100 focus-visible:opacity-100"
            >
              <LuEllipsis aria-hidden="true" className="h-3.5 w-3.5" />
            </IconButton>
          )}
        >
          <MenuItem to={path}>
            <LuArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
            Open customer
            <MenuShortcut keys="enter" />
          </MenuItem>
          {customer.can_edit &&
            PROPERTY_KEYS.map((property) => (
              <MenuItem
                key={property.field}
                onSelect={() => {
                  openRowPicker(customer.customer_id, property.field);
                }}
              >
                {PROPERTY_ICONS[property.field]}
                {property.label}
                <MenuShortcut keys={property.keys} />
              </MenuItem>
            ))}
          {customer.can_delete && (
            <>
              <MenuSeparator />
              <MenuItem danger onSelect={onDelete}>
                <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
                Delete
                <MenuShortcut keys={DELETE_KEYS} />
              </MenuItem>
            </>
          )}
        </Menu>
      </span>
    </li>
  );
};

/** The workspace's customers, with a way to add one. */
export const Customers: React.FC = () => {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const slug = workspace?.slug ?? '';
  const workspaceId = workspace?.id ?? '';
  const isMember = workspace !== null && workspace.role !== 'guest';
  const { customers, error, isLoading, queryKey } = useCustomers(
    workspaceId,
    isMember
  );
  const members = useWorkspaceMembers(workspaceId, isMember);
  const { statuses, tiers } = useCustomerFields(workspaceId, isMember);
  const isAdmin = canManageMembers(workspace?.role);
  const [isCreating, setIsCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>({ key: 'name', descending: false });
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [grouped, setGrouped] = useState(false);
  const [editing, setEditing] = useState<CustomerRead | null>(null);
  const [deleting, setDeleting] = useState<CustomerRead[] | null>(null);

  const onSort = (column: SortKey): void => {
    setSort((current) =>
      current.key === column
        ? { key: column, descending: !current.descending }
        : { key: column, descending: column !== 'name' }
    );
  };

  const rows = useMemo(
    () =>
      customers
        .filter(
          (row) => matches(row, query) && statusMatches(row, statusFilter)
        )
        .sort((left, right) => compare(left, right, sort)),
    [customers, query, sort, statusFilter]
  );

  const groups = useMemo(
    () =>
      [...statuses, null]
        .map((status) => ({
          status,
          rows: rows.filter((row) => row.status_id === (status?.id ?? null)),
        }))
        .filter((group) => group.rows.length > 0),
    [rows, statuses]
  );

  const ordered = useMemo(
    () => (grouped ? groups.flatMap((group) => group.rows) : rows),
    [grouped, groups, rows]
  );
  const positions = useMemo(
    () =>
      new Map(ordered.map((customer, index) => [customer.customer_id, index])),
    [ordered]
  );
  const onActivate = useCallback(
    (index: number) => {
      const customer = ordered[index];
      if (customer !== undefined)
        void navigate(customerPath(slug, customer.customer_id));
    },
    [ordered, navigate, slug]
  );
  const idle = !isCreating && editing === null && deleting === null;
  const { activeIndex, setActiveIndex, registerItem } = useListKeyboardNav({
    count: ordered.length,
    onActivate,
    resetKey: `${String(grouped)}:${ordered.map((customer) => customer.customer_id).join(',')}`,
    enabled: idle,
  });
  const focused = ordered[activeIndex];
  const order = useMemo(
    () => ordered.map((customer) => customer.customer_id),
    [ordered]
  );
  const {
    selected,
    toggle,
    clear: clearSelection,
  } = useProjectSelection({
    order,
    focusedId: focused?.customer_id ?? null,
    onFocus: (customerId) => {
      setActiveIndex(positions.get(customerId) ?? -1);
    },
    enabled: idle,
    label: 'Select customer',
  });

  const targets =
    selected.size > 0
      ? ordered.filter((customer) => selected.has(customer.customer_id))
      : focused === undefined
        ? []
        : [focused];
  const deletable = targets.filter((customer) => customer.can_delete);

  /** The registration of one property key, live while an editable row is focused. */
  const propertyShortcut = (
    property: CustomerPropertyKey
  ): ShortcutDefinition => ({
    keys: property.keys,
    label: property.label,
    group: 'List',
    scope: 'page',
    enabled: idle && focused?.can_edit === true,
    handler: (event) => {
      event?.preventDefault();
      if (focused !== undefined)
        openRowPicker(focused.customer_id, property.field);
    },
  });
  useShortcut(propertyShortcut(STATUS_KEY));
  useShortcut(propertyShortcut(OWNER_KEY));
  useShortcut(propertyShortcut(TIER_KEY));
  useShortcut({
    keys: DELETE_KEYS,
    label: selected.size > 0 ? 'Delete selected customers' : 'Delete customer',
    group: 'List',
    enabled: idle && deletable.length > 0,
    handler: (event) => {
      event?.preventDefault();
      setDeleting(deletable);
    },
  });

  /** Saves one change to a customer and reloads the list. */
  const change = (customer: CustomerRead, patch: CustomerPatch): void => {
    updateCustomer(workspaceId, customer.customer_id, patch).then(
      () => {
        invalidateQueries(queryKey);
      },
      (failure: unknown) => {
        showErrorToast(errorMessage(failure, 'Could not change the customer.'));
      }
    );
  };

  /** A count of customers in words. */
  const plural = (count: number): string =>
    count === 1 ? '1 customer' : `${String(count)} customers`;

  /** Deletes the confirmed customers and says how many went. */
  const remove = async (doomed: CustomerRead[]): Promise<void> => {
    setDeleting(null);
    const results = await Promise.allSettled(
      doomed.map((customer) =>
        deleteCustomer(workspaceId, customer.customer_id)
      )
    );
    const done = results.filter(
      (result) => result.status === 'fulfilled'
    ).length;
    invalidateQueries(queryKey);
    clearSelection();
    if (done > 0)
      showToast(
        doomed.length === 1 && done === 1
          ? `Deleted ${doomed[0]?.name ?? 'the customer'}`
          : `Deleted ${plural(done)}`
      );
    if (done < doomed.length)
      showErrorToast(`Could not delete ${plural(doomed.length - done)}.`);
  };

  /** Draws a run of rows, each at its place in the keyboard order. */
  const renderRows = (list: CustomerRead[]): React.ReactNode =>
    list.map((customer) => {
      const position = positions.get(customer.customer_id) ?? -1;
      return (
        <CustomerRow
          key={customer.customer_id}
          customer={customer}
          slug={slug}
          people={members}
          statuses={statuses}
          tiers={tiers}
          isActive={position === activeIndex}
          selected={selected.has(customer.customer_id)}
          selecting={selected.size > 0}
          rowRef={registerItem(position)}
          onPointerEnter={() => {
            setActiveIndex(position);
          }}
          onSelect={(range) => {
            toggle(customer.customer_id, range);
          }}
          onChange={(patch) => {
            change(customer, patch);
          }}
          {...(isAdmin
            ? {
                onManageTiers: () => {
                  void navigate(`${settingsPath(slug)}/customers`);
                },
              }
            : {})}
          onDelete={() => {
            setDeleting([customer]);
          }}
        />
      );
    });

  return (
    <WorkspaceShell
      title="Customers"
      flush
      actions={
        isMember ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setIsCreating(true);
            }}
          >
            <LuPlus aria-hidden="true" />
            New customer
          </Button>
        ) : undefined
      }
    >
      {error != null && (
        <div className="px-4 pt-3 lg:px-6">
          <ErrorAlert
            message={errorMessage(error, 'Could not load the customers.')}
          />
        </div>
      )}
      {isMember && customers.length > 0 && (
        <div className="flex h-10 items-center gap-2 border-b border-line px-4 lg:px-6">
          <LuSearch
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-text-faint"
          />
          <input
            type="search"
            aria-label="Search customers"
            placeholder="Search by name or domain"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('');
            }}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-text placeholder:text-text-faint focus:outline-none"
          />
          <Menu
            label="Filter by status"
            align="end"
            trigger={(trigger) => (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Status filter: ${statusFilterLabel(statusFilter, statuses)}`}
                {...trigger}
              >
                {statusFilter !== 'all' && (
                  <CustomerStatusDot
                    status={filterStatus(statusFilter, statuses)}
                  />
                )}
                {statusFilterLabel(statusFilter, statuses)}
              </Button>
            )}
          >
            {['all', ...statuses.map((status) => status.id), 'none'].map(
              (option) => (
                <MenuItem
                  key={option}
                  onSelect={() => {
                    setStatusFilter(option);
                  }}
                >
                  {option === 'all' ? (
                    <span aria-hidden="true" className="w-2" />
                  ) : (
                    <CustomerStatusDot
                      status={filterStatus(option, statuses)}
                    />
                  )}
                  <span className="flex-1">
                    {statusFilterLabel(option, statuses)}
                  </span>
                  {statusFilter === option && (
                    <LuCheck
                      aria-hidden="true"
                      className="h-3.5 w-3.5 text-text-muted"
                    />
                  )}
                </MenuItem>
              )
            )}
            <MenuSeparator />
            <MenuItem
              onSelect={() => {
                setGrouped((current) => !current);
              }}
            >
              <LuLayers aria-hidden="true" className="h-3.5 w-3.5" />
              <span className="flex-1">Group by status</span>
              {grouped && (
                <LuCheck
                  aria-hidden="true"
                  className="h-3.5 w-3.5 text-text-muted"
                />
              )}
            </MenuItem>
          </Menu>
          <span className="shrink-0 text-xs text-text-faint tabular-nums">
            {String(rows.length)}
          </span>
        </div>
      )}
      <div>
        <div
          role="presentation"
          className={cn(
            GRID,
            'sticky top-0 z-20 h-8 border-b border-line bg-bg px-4 text-2xs font-medium tracking-wide text-text-faint uppercase lg:px-6'
          )}
        >
          <SortHeader label="Name" column="name" sort={sort} onSort={onSort} />
          <span className="hidden truncate md:block">Status</span>
          <span className="hidden truncate md:block">Tier</span>
          <span className="hidden truncate text-center md:block">Owner</span>
          <SortHeader
            label="Size"
            column="size"
            sort={sort}
            onSort={onSort}
            className="hidden md:flex"
          />
          <SortHeader
            label="Revenue"
            column="revenue"
            sort={sort}
            onSort={onSort}
            className="hidden md:flex"
          />
          <SortHeader
            label="Requests"
            column="requests"
            sort={sort}
            onSort={onSort}
            className="justify-end"
          />
          <span aria-hidden="true" />
        </div>
        {!isMember ? (
          <EmptyState
            icon={<LuBuilding2 />}
            message="Customers are open to workspace members, not guests."
          />
        ) : isLoading && customers.length === 0 ? (
          <SkeletonRows label="Loading customers" />
        ) : customers.length === 0 && error == null ? (
          <EmptyState
            icon={<LuBuilding2 />}
            message="No customers yet. Add the companies you build for, then link their requests to issues and projects."
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<LuSearch />}
            message="No customer matches that search."
          />
        ) : grouped ? (
          <div aria-label="Customers by status" role="group">
            {groups.map((group) => {
              const label = customerFieldLabel(group.status, 'No status');
              return (
                <section key={group.status?.id ?? 'none'} aria-label={label}>
                  <h2 className="sticky top-8 z-10 flex h-8 items-center gap-2 border-b border-line bg-surface px-4 text-xs font-medium text-text lg:px-6">
                    <CustomerStatusDot status={group.status} />
                    {label}
                    <span className="font-normal text-text-faint tabular-nums">
                      {String(group.rows.length)}
                    </span>
                  </h2>
                  <ul aria-label={`${label} customers`}>
                    {renderRows(group.rows)}
                  </ul>
                </section>
              );
            })}
          </div>
        ) : (
          <ul aria-label="Customers">{renderRows(rows)}</ul>
        )}
      </div>

      {isCreating && (
        <CustomerDialog
          workspaceId={workspaceId}
          people={members}
          onClose={() => {
            setIsCreating(false);
          }}
          onSaved={(customer) => {
            setIsCreating(false);
            invalidateQueries(queryKey);
            void navigate(customerPath(slug, customer.customer_id));
          }}
        />
      )}
      {editing !== null && (
        <CustomerDialog
          workspaceId={workspaceId}
          people={members}
          customer={editing}
          onClose={() => {
            setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            invalidateQueries(queryKey);
          }}
        />
      )}
      {deleting !== null && (
        <Dialog
          open
          size="sm"
          title={
            deleting.length === 1
              ? `Delete ${deleting[0]?.name ?? 'customer'}`
              : `Delete ${plural(deleting.length)}`
          }
          description={
            deleting.length === 1
              ? 'The customer and every request it made are deleted for everyone.'
              : 'The customers and every request they made are deleted for everyone.'
          }
          onClose={() => {
            setDeleting(null);
          }}
        >
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setDeleting(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                void remove(deleting);
              }}
            >
              Delete
            </Button>
          </div>
        </Dialog>
      )}
    </WorkspaceShell>
  );
};

export default Customers;
