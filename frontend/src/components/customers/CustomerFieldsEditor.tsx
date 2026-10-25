/**
 * One of the two customer lists a workspace keeps, statuses or tiers, as
 * workspace settings shows it. Any member reads each entry with how many
 * customers hold it; a workspace admin adds, renames, recolours, reorders and
 * deletes them. Deleting an entry customers hold asks which entry they move
 * to, and one held entry with nothing else in the list cannot go.
 */

import React, { useState } from 'react';
import {
  LuArrowDown,
  LuArrowUp,
  LuEllipsis,
  LuPlus,
  LuTrash2,
} from 'react-icons/lu';
import { useMutationWithRefetch } from '@webbpulse/api-client/react';
import {
  createCustomerField,
  deleteCustomerField,
  updateCustomerField,
  type CustomerFieldKind,
} from '../../api/customers';
import { useCustomerFields } from '../../hooks/useCustomerFields';
import { errorMessage } from '../../lib/errors';
import { customersKey } from '../../lib/queryKeys';
import { STATUS_COLOR_VALUES } from '../../lib/statusAppearance';
import type {
  CustomerFieldCreate,
  CustomerFieldRead,
  CustomerFieldUpdate,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button, { IconButton } from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import Menu, { MenuItem } from '../ui/menu';
import { SelectField } from '../ui/select';
import { SkeletonRows } from '../ui/skeleton';
import LabelColorPicker from '../workflow/LabelColorPicker';

/** How each list names itself and its entries. */
const COPY: Record<
  CustomerFieldKind,
  { title: string; hint: string; one: string; empty: string }
> = {
  statuses: {
    title: 'Statuses',
    hint: 'Where a customer stands with you, such as a lead or an active account.',
    one: 'status',
    empty: 'No statuses yet. Add one to start tracking where customers stand.',
  },
  tiers: {
    title: 'Tiers',
    hint: 'How big an account a customer is, such as Startup or Enterprise.',
    one: 'tier',
    empty: 'No tiers yet. Add one to sort customers by account size.',
  },
};

/** How an entry's customer count reads. */
const countText = (count: number): string =>
  count === 1 ? '1 customer' : `${String(count)} customers`;

/** An entry about to be deleted and the one its customers move to. */
interface Deleting {
  field: CustomerFieldRead;
  replacementId: string;
}

/** Props for CustomerFieldsEditor. */
export interface CustomerFieldsEditorProps {
  workspaceId: string;
  kind: CustomerFieldKind;
  /** Whether the caller edits the list: a workspace owner or admin. */
  canEdit: boolean;
}

/** Lists and edits the workspace's customer statuses or tiers. */
const CustomerFieldsEditor: React.FC<CustomerFieldsEditorProps> = ({
  workspaceId,
  kind,
  canEdit,
}) => {
  const fields = useCustomerFields(workspaceId);
  const rows = kind === 'statuses' ? fields.statuses : fields.tiers;
  const listKey = kind === 'statuses' ? fields.statusesKey : fields.tiersKey;
  const keys = [listKey, customersKey(workspaceId)];
  const copy = COPY[kind];
  const [writeError, setWriteError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(STATUS_COLOR_VALUES.blue);
  const [isAdding, setIsAdding] = useState(false);
  const [deleting, setDeleting] = useState<Deleting | null>(null);

  const { mutate: create } = useMutationWithRefetch(
    (body: CustomerFieldCreate) => createCustomerField(workspaceId, kind, body),
    keys
  );
  const { mutate: update } = useMutationWithRefetch(
    (field: CustomerFieldRead, body: CustomerFieldUpdate) =>
      updateCustomerField(workspaceId, kind, field.id, body),
    keys
  );
  const { mutate: remove } = useMutationWithRefetch(
    (field: CustomerFieldRead, replacementId?: string) =>
      deleteCustomerField(workspaceId, kind, field.id, replacementId),
    keys
  );

  const run = (write: Promise<unknown>, fallback: string): void => {
    setWriteError(null);
    void write.catch((cause: unknown) => {
      setWriteError(errorMessage(cause, fallback));
    });
  };

  const onAdd = (event: React.FormEvent): void => {
    event.preventDefault();
    if (name.trim() === '' || isAdding) return;
    setWriteError(null);
    setIsAdding(true);
    void create({ name: name.trim(), color })
      .then(() => {
        setAdding(false);
        setName('');
      })
      .catch((cause: unknown) => {
        setWriteError(errorMessage(cause, `Could not add that ${copy.one}.`));
      })
      .finally(() => {
        setIsAdding(false);
      });
  };

  const onRename = (field: CustomerFieldRead, value: string): void => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === field.name) return;
    run(update(field, { name: trimmed }), `Could not rename that ${copy.one}.`);
  };

  const others = (field: CustomerFieldRead): CustomerFieldRead[] =>
    rows.filter((row) => row.id !== field.id);

  const askDelete = (field: CustomerFieldRead): void => {
    const replacement = others(field)[0];
    if (field.customer_count > 0 && replacement === undefined) return;
    setDeleting({ field, replacementId: replacement?.id ?? '' });
  };

  const rowClass =
    'flex min-h-row flex-wrap items-center gap-3 border-b border-line py-1 pl-3 pr-3 transition-colors duration-100 last:border-b-0 hover:bg-surface';

  const renderRow = (field: CustomerFieldRead, index: number) => {
    if (!canEdit) {
      return (
        <li key={field.id} className={rowClass}>
          <span className="flex items-center gap-2 text-sm text-text">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-full bg-text-faint"
              style={
                field.color === null
                  ? undefined
                  : { backgroundColor: field.color }
              }
            />
            {field.name}
          </span>
          <span className="text-xs text-text-muted">
            {countText(field.customer_count)}
          </span>
        </li>
      );
    }
    const stuck = field.customer_count > 0 && others(field).length === 0;
    return (
      <li key={field.id} className={rowClass}>
        <LabelColorPicker
          name={field.name}
          value={field.color ?? STATUS_COLOR_VALUES.gray}
          onChange={(next) => {
            if (next === field.color) return;
            run(
              update(field, { color: next }),
              `Could not recolour that ${copy.one}.`
            );
          }}
        />
        <Field
          key={`${field.id}-${field.name}`}
          id={`customer-${kind}-name-${field.id}`}
          label={`Name of ${field.name}`}
          hideLabel
          className="w-48"
          maxLength={40}
          defaultValue={field.name}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          onBlur={(event) => {
            onRename(field, event.target.value);
          }}
        />
        <span className="text-xs text-text-muted">
          {countText(field.customer_count)}
        </span>
        <div className="ml-auto">
          <Menu
            label={`${field.name} actions`}
            align="end"
            trigger={(props) => (
              <IconButton
                label={`Actions for ${field.name}`}
                size="sm"
                {...props}
              >
                <LuEllipsis className="h-3.5 w-3.5" />
              </IconButton>
            )}
          >
            <MenuItem
              disabled={index === 0}
              onSelect={() => {
                run(
                  update(field, { position: index - 1 }),
                  `Could not move that ${copy.one}.`
                );
              }}
            >
              <LuArrowUp aria-hidden="true" className="h-3.5 w-3.5" />
              Move up
            </MenuItem>
            <MenuItem
              disabled={index === rows.length - 1}
              onSelect={() => {
                run(
                  update(field, { position: index + 1 }),
                  `Could not move that ${copy.one}.`
                );
              }}
            >
              <LuArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
              Move down
            </MenuItem>
            <MenuItem
              danger
              disabled={stuck}
              textValue="Delete"
              onSelect={() => {
                askDelete(field);
              }}
            >
              <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
              {stuck ? 'Delete (add another first)' : 'Delete'}
            </MenuItem>
          </Menu>
        </div>
      </li>
    );
  };

  const held = deleting !== null && deleting.field.customer_count > 0;

  return (
    <section
      aria-label={copy.title}
      className="space-y-2 rounded-md border border-line"
    >
      <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-text">{copy.title}</h3>
          <p className="text-xs text-text-muted">{copy.hint}</p>
        </div>
        {canEdit && (
          <IconButton
            label={`Add a ${copy.one}`}
            size="sm"
            onClick={() => {
              setAdding(true);
              setName('');
            }}
          >
            <LuPlus className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      {fields.error !== null && fields.error !== undefined && (
        <div className="px-3">
          <ErrorAlert
            message={errorMessage(
              fields.error,
              `Could not load the customer ${copy.title.toLowerCase()}.`
            )}
          />
        </div>
      )}
      {writeError !== null && (
        <div className="px-3">
          <ErrorAlert message={writeError} />
        </div>
      )}
      {fields.isLoading && rows.length === 0 ? (
        <SkeletonRows
          count={3}
          label={`Loading customer ${copy.title.toLowerCase()}`}
        />
      ) : rows.length === 0 ? (
        <p className="px-3 py-2 text-sm text-text-muted">{copy.empty}</p>
      ) : (
        <ul>{rows.map(renderRow)}</ul>
      )}
      {canEdit && adding && (
        <form
          aria-label={`Add a ${copy.one}`}
          className="flex flex-wrap items-center gap-3 border-t border-line px-3 py-2"
          onSubmit={onAdd}
        >
          <LabelColorPicker
            name={name.trim()}
            value={color}
            onChange={setColor}
          />
          <Field
            id={`new-customer-${kind}`}
            label={`New ${copy.one}`}
            hideLabel
            placeholder={`${copy.one[0]?.toUpperCase() ?? ''}${copy.one.slice(1)} name`}
            className="w-48"
            maxLength={40}
            value={name}
            autoComplete="off"
            autoFocus
            onChange={(event) => {
              setName(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setAdding(false);
            }}
          />
          <div className="ml-auto flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setAdding(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={name.trim() === '' || isAdding}
            >
              {isAdding ? 'Adding' : `Add ${copy.one}`}
            </Button>
          </div>
        </form>
      )}

      <Dialog
        open={deleting !== null}
        onClose={() => {
          setDeleting(null);
        }}
        title={`Delete ${deleting?.field.name ?? copy.one}?`}
        description={
          held
            ? `${countText(deleting.field.customer_count)} will move to the ${copy.one} you pick.`
            : `No customer holds this ${copy.one}.`
        }
        size="sm"
      >
        <div className="space-y-4">
          {held && (
            <SelectField
              id={`customer-${kind}-replacement`}
              label="Move customers to"
              value={deleting.replacementId}
              onChange={(event) => {
                const replacementId = event.target.value;
                setDeleting((current) =>
                  current === null ? null : { ...current, replacementId }
                );
              }}
            >
              {others(deleting.field).map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </SelectField>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDeleting(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                const target = deleting;
                setDeleting(null);
                if (target !== null) {
                  run(
                    remove(
                      target.field,
                      target.field.customer_count > 0
                        ? target.replacementId
                        : undefined
                    ),
                    `Could not delete that ${copy.one}.`
                  );
                }
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
};

export default CustomerFieldsEditor;
