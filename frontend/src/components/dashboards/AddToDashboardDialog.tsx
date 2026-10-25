/**
 * Adds the insights panel's current breakdown to a dashboard as a widget:
 * one the caller may change, or a new personal one named here.
 */

import React, { useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  addDashboardWidget,
  createDashboard,
  listDashboards,
} from '../../api/dashboards';
import { useWorkspace } from '../../hooks/useWorkspace';
import { DASHBOARD_WIDGETS_MAX } from '../../lib/dashboards';
import { errorMessage } from '../../lib/errors';
import { dashboardPath } from '../../lib/paths';
import { LOOKUP_POLL_MS } from '../../lib/polling';
import { dashboardKey, dashboardsKey } from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import type { DashboardWidgetCreate } from '../../types/Api';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import { Select } from '../ui/select';

/** Props for AddToDashboardDialog. */
export interface AddToDashboardDialogProps {
  workspaceId: string;
  widget: DashboardWidgetCreate;
  onClose: () => void;
}

const NEW = '';

/** The dialog. */
export const AddToDashboardDialog: React.FC<AddToDashboardDialogProps> = ({
  workspaceId,
  widget,
  onClose,
}) => {
  const auth = useQueryAuth();
  const { workspace } = useWorkspace();
  const slug = workspace?.slug ?? '';
  const { data } = usePolledQuery(
    ({ signal }) => listDashboards(workspaceId, {}, signal),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: workspaceId !== '',
      queryKey: dashboardsKey(workspaceId, 'all', ''),
      auth,
    }
  );
  const editable = useMemo(
    () =>
      (data ?? []).filter(
        (dashboard) =>
          dashboard.can_edit && dashboard.widgets.length < DASHBOARD_WIDGETS_MAX
      ),
    [data]
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const target = chosen ?? editable[0]?.id ?? NEW;
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const ready = target !== NEW || name.trim() !== '';

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) return;
    const body: DashboardWidgetCreate = {
      ...widget,
      ...(title.trim() === '' ? {} : { title: title.trim() }),
    };
    setSaving(true);
    try {
      const saved =
        target === NEW
          ? await createDashboard(workspaceId, {
              name: name.trim(),
              widgets: [body],
            })
          : await addDashboardWidget(workspaceId, target, body);
      invalidateQueries([
        dashboardsKey(workspaceId, 'all', ''),
        dashboardKey(workspaceId, saved.id),
      ]);
      showToast(`Added to ${saved.name}.`, 'info', {
        action: { label: 'Open', to: dashboardPath(slug, saved.id) },
      });
      onClose();
    } catch (failure) {
      showErrorToast(errorMessage(failure, 'Could not add to the dashboard.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add to dashboard"
      description="Adds this breakdown, with the list's filter, as a widget."
      size="sm"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => void submit(event)}
      >
        <label className="flex min-w-0 flex-col gap-1 text-xs text-text-muted">
          Dashboard
          <Select
            value={target}
            onChange={(event) => {
              setChosen(event.target.value);
            }}
          >
            {editable.map((dashboard) => (
              <option key={dashboard.id} value={dashboard.id}>
                {dashboard.name}
              </option>
            ))}
            <option value={NEW}>New dashboard</option>
          </Select>
        </label>
        {target === NEW && (
          <Field
            id="new-dashboard-name"
            label="Dashboard name"
            value={name}
            maxLength={80}
            required
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        )}
        <Field
          id="widget-title"
          label="Widget title"
          value={title}
          maxLength={80}
          placeholder="Named after what it measures when left empty"
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={saving || !ready}
          >
            Add widget
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export default AddToDashboardDialog;
