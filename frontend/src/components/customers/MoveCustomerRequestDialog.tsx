/**
 * The move customer request dialog: search the workspace for the issue or
 * project the request belongs on, and pick one to move it there. The quote,
 * customer and important flag travel with it.
 */

import React, { useMemo, useState } from 'react';
import { LuBox, LuSquareDot } from 'react-icons/lu';
import { updateCustomerRequest } from '../../api/customers';
import { useReferenceResults } from '../../hooks/useReferenceResults';
import { errorMessage } from '../../lib/errors';
import type { CustomerRequestRead, CustomerTargetKind } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Combobox, { type ComboboxOption } from '../ui/combobox';
import Dialog from '../ui/dialog';

/** Props for MoveCustomerRequestDialog. */
export interface MoveCustomerRequestDialogProps {
  workspaceId: string;
  request: CustomerRequestRead;
  onClose: () => void;
  onMoved: (request: CustomerRequestRead) => void;
}

/** The value one option carries: its kind and id together. */
const optionValue = (kind: CustomerTargetKind, id: string): string =>
  `${kind}:${id}`;

/** The dialog that moves a request to another issue or project. */
export const MoveCustomerRequestDialog: React.FC<
  MoveCustomerRequestDialogProps
> = ({ workspaceId, request, onClose, onMoved }) => {
  const [query, setQuery] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const results = useReferenceResults(workspaceId, query);
  const current = optionValue(request.target_kind, request.target_id);

  const options = useMemo<ComboboxOption[]>(
    () =>
      results.items.flatMap((item): ComboboxOption[] => {
        const keywords = [query];
        if (item.kind === 'issue') {
          return [
            {
              value: optionValue('issue', item.id),
              label: item.title,
              detail: item.key,
              group: 'Issues',
              icon: <LuSquareDot aria-hidden="true" className="h-3.5 w-3.5" />,
              keywords,
            },
          ];
        }
        if (item.kind === 'project') {
          return [
            {
              value: optionValue('project', item.id),
              label: item.name,
              group: 'Projects',
              icon: <LuBox aria-hidden="true" className="h-3.5 w-3.5" />,
              keywords,
            },
          ];
        }
        return [];
      }),
    [results.items, query]
  );

  const move = (value: string): void => {
    if (isSaving || value === current) return;
    const [kind, targetId] = value.split(':') as [CustomerTargetKind, string];
    setIsSaving(true);
    setError(null);
    updateCustomerRequest(
      workspaceId,
      request.customer_id,
      request.request_id,
      { target_kind: kind, target_id: targetId }
    ).then(
      (moved) => {
        setIsSaving(false);
        onMoved(moved);
      },
      (failure: unknown) => {
        setIsSaving(false);
        setError(failure);
      }
    );
  };

  const where =
    request.target_kind === 'issue'
      ? `${request.target_key} ${request.target_title}`
      : request.target_title;

  return (
    <Dialog
      open
      title="Move customer request"
      description={`Move the request from ${request.customer_name}, now on ${where}, to another issue or project.`}
      size="md"
      onClose={onClose}
    >
      <div className="space-y-3">
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not move that request.')}
          />
        )}
        <Combobox
          label="Issue or project"
          options={options}
          selected={[current]}
          onSelect={move}
          onQueryChange={setQuery}
          placeholder="Search issues and projects..."
          emptyMessage={
            results.loading
              ? 'Searching...'
              : query.trim() === ''
                ? 'Type an issue key or a few letters of a title.'
                : 'No issue or project matches that search.'
          }
        />
      </div>
    </Dialog>
  );
};

export default MoveCustomerRequestDialog;
