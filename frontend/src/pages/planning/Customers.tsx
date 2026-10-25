/**
 * Every customer of the workspace as a dense list: name and domains, status,
 * tier, owner, size, revenue and how many requests each has made, with how
 * many of those are important. A column header sorts the list, the search box
 * narrows it by name or domain, the status menu filters it, grouping splits it
 * by status, and a row opens the customer's page with its requests.
 */

import React, { useMemo, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import {
  LuArrowDown,
  LuArrowUp,
  LuBuilding2,
  LuCheck,
  LuCircleAlert,
  LuLayers,
  LuPlus,
  LuSearch,
} from 'react-icons/lu';
import { Link, useNavigate } from 'react-router-dom';
import CustomerDialog from '../../components/customers/CustomerDialog';
import { CustomerStatusDot } from '../../components/customers/CustomerStatusPicker';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import Button from '../../components/ui/button';
import EmptyState from '../../components/ui/empty-state';
import Menu, { MenuItem, MenuSeparator } from '../../components/ui/menu';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useCustomers } from '../../hooks/useCustomers';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { cn } from '../../lib/cn';
import {
  CUSTOMER_STATUSES,
  CUSTOMER_STATUS_LABELS,
  customerStatusLabel,
  revenueLabel,
  sizeLabel,
} from '../../lib/customerDisplay';
import { errorMessage } from '../../lib/errors';
import {
  personAvatar,
  personLabel,
  type Assignable,
} from '../../lib/issuePeople';
import { customerPath } from '../../lib/paths';
import type { CustomerRead, CustomerStatus } from '../../types/Api';

/** The grid every header and row lines up on. */
const GRID =
  'grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-3 md:grid-cols-[minmax(0,1fr)_5.5rem_7rem_4rem_4.5rem_5.5rem_6rem]';

/** The status filter: one status, customers with none, or every customer. */
type StatusFilter = CustomerStatus | 'none' | 'all';

/** Whether a customer passes the status filter. */
const statusMatches = (row: CustomerRead, filter: StatusFilter): boolean =>
  filter === 'all' ||
  (filter === 'none' ? row.status === null : row.status === filter);

/** How the status filter reads on its button. */
const statusFilterLabel = (filter: StatusFilter): string =>
  filter === 'all'
    ? 'All statuses'
    : filter === 'none'
      ? 'No status'
      : CUSTOMER_STATUS_LABELS[filter];

/** The groups a status grouping draws, in lifecycle order with no status last. */
const STATUS_GROUPS: (CustomerStatus | null)[] = [...CUSTOMER_STATUSES, null];

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

/** One customer as a row linking to its page. */
const CustomerRow: React.FC<{
  customer: CustomerRead;
  slug: string;
  people: Assignable[];
}> = ({ customer, slug, people }) => {
  const owner = people.find((person) => person.user_id === customer.owner_id);
  const revenue = revenueLabel(customer.revenue);
  const size = sizeLabel(customer.size);
  const requests = customer.request_count;
  const important = customer.important_count;
  return (
    <li
      className={cn(
        GRID,
        'relative h-11 border-b border-line px-4 text-sm transition-colors duration-100 hover:bg-surface has-[a:active]:bg-raised lg:px-6'
      )}
    >
      <Link
        to={customerPath(slug, customer.customer_id)}
        aria-label={customer.name}
        data-hover="parent"
        className="absolute inset-0 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset"
      />
      <div className="pointer-events-none flex min-w-0 items-center gap-2.5">
        <LuBuilding2
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-text-muted"
        />
        <span className="truncate font-medium text-text">{customer.name}</span>
        {customer.domains.length > 0 && (
          <span className="hidden min-w-0 truncate text-xs text-text-faint sm:block">
            {customer.domains.join(', ')}
          </span>
        )}
      </div>
      <span
        className={cn(
          'pointer-events-none hidden min-w-0 items-center gap-1.5 text-xs md:flex',
          customer.status === null ? 'text-text-faint' : 'text-text-muted'
        )}
      >
        <CustomerStatusDot status={customer.status} />
        <span className="truncate">{customerStatusLabel(customer.status)}</span>
      </span>
      <span
        className={cn(
          'pointer-events-none hidden truncate text-xs md:block',
          customer.tier === null ? 'text-text-faint' : 'text-text-muted'
        )}
      >
        {customer.tier ?? 'No tier'}
      </span>
      <span className="pointer-events-none hidden justify-center md:flex">
        {owner === undefined ? (
          <span className="sr-only">No owner</span>
        ) : (
          <>
            <Avatar
              name={personLabel(owner)}
              src={personAvatar(owner)}
              size="xs"
            />
            <span className="sr-only">{`Owner ${personLabel(owner)}`}</span>
          </>
        )}
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
  const [isCreating, setIsCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>({ key: 'name', descending: false });
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [grouped, setGrouped] = useState(false);

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
      STATUS_GROUPS.map((status) => ({
        status,
        rows: rows.filter((row) => row.status === status),
      })).filter((group) => group.rows.length > 0),
    [rows]
  );

  const renderRows = (list: CustomerRead[]): React.ReactNode =>
    list.map((customer) => (
      <CustomerRow
        key={customer.customer_id}
        customer={customer}
        slug={slug}
        people={members}
      />
    ));

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
                aria-label={`Status filter: ${statusFilterLabel(statusFilter)}`}
                {...trigger}
              >
                {statusFilter !== 'all' && (
                  <CustomerStatusDot
                    status={statusFilter === 'none' ? null : statusFilter}
                  />
                )}
                {statusFilterLabel(statusFilter)}
              </Button>
            )}
          >
            {(['all', ...CUSTOMER_STATUSES, 'none'] as StatusFilter[]).map(
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
                      status={option === 'none' ? null : option}
                    />
                  )}
                  <span className="flex-1">{statusFilterLabel(option)}</span>
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
              const label = customerStatusLabel(group.status);
              return (
                <section key={group.status ?? 'none'} aria-label={label}>
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
    </WorkspaceShell>
  );
};

export default Customers;
