/**
 * The form that adds or edits one dashboard widget: what it reads, how it
 * groups and measures the issues, and how it is drawn. A widget's own filter
 * comes from the list it was added from and is kept as it is here.
 */

import React, { useState } from 'react';
import type { SavedViewDisplayRead } from '../../api/views';
import { WIDGET_KINDS, WIDGET_SIZES } from '../../lib/dashboards';
import { INSIGHT_DIMENSIONS, INSIGHT_MEASURES } from '../../lib/insights';
import type {
  DashboardWidgetCreate,
  DashboardWidgetKind,
  DashboardWidgetSize,
  DashboardWidgetSource,
  InsightDimension,
  InsightMeasure,
  TeamRead,
} from '../../types/Api';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import { Select } from '../ui/select';

/** Props for WidgetDialog. */
export interface WidgetDialogProps {
  title: string;
  submitLabel: string;
  initial: DashboardWidgetCreate;
  teams: TeamRead[];
  views: SavedViewDisplayRead[];
  onClose: () => void;
  onSave: (body: DashboardWidgetCreate) => Promise<void>;
}

const SOURCES: { value: DashboardWidgetSource; label: string }[] = [
  { value: 'workspace', label: 'All teams' },
  { value: 'team', label: 'One team' },
  { value: 'view', label: 'A saved view' },
];

/** The labelled select every picker here shares. */
const Picker: React.FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}> = ({ label, value, onChange, children }) => (
  <label className="flex min-w-0 flex-col gap-1 text-xs text-text-muted">
    {label}
    <Select
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    >
      {children}
    </Select>
  </label>
);

/** The widget form in a dialog. */
export const WidgetDialog: React.FC<WidgetDialogProps> = ({
  title,
  submitLabel,
  initial,
  teams,
  views,
  onClose,
  onSave,
}) => {
  const [name, setName] = useState(initial.title ?? '');
  const [kind, setKind] = useState<DashboardWidgetKind>(
    initial.kind ?? 'chart'
  );
  const [source, setSource] = useState<DashboardWidgetSource>(
    initial.source ?? 'workspace'
  );
  const [teamId, setTeamId] = useState(initial.team_id ?? teams[0]?.id ?? '');
  const [viewId, setViewId] = useState(
    initial.view_id ?? views[0]?.view_id ?? ''
  );
  const [subTeams, setSubTeams] = useState(initial.include_sub_teams === true);
  const [groupBy, setGroupBy] = useState<InsightDimension>(
    initial.group_by ?? 'status'
  );
  const [segmentBy, setSegmentBy] = useState<InsightDimension | ''>(
    initial.segment_by ?? ''
  );
  const [measure, setMeasure] = useState<InsightMeasure>(
    initial.measure ?? 'count'
  );
  const [size, setSize] = useState<DashboardWidgetSize>(initial.size ?? 'half');
  const [saving, setSaving] = useState(false);

  const missing =
    (source === 'team' && teamId === '') ||
    (source === 'view' && viewId === '');

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (missing) return;
    setSaving(true);
    try {
      await onSave({
        title: name.trim() === '' ? null : name.trim(),
        kind,
        source,
        team_id: source === 'team' ? teamId : null,
        view_id: source === 'view' ? viewId : null,
        include_sub_teams: source === 'team' && subTeams,
        group_by: groupBy,
        segment_by:
          segmentBy === '' || segmentBy === groupBy ? null : segmentBy,
        measure,
        size,
        ...(initial.filter === undefined ? {} : { filter: initial.filter }),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={title} size="md">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => void submit(event)}
      >
        <Field
          id="widget-title"
          label="Title"
          value={name}
          maxLength={80}
          placeholder="Named after what it measures when left empty"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <div className="grid grid-cols-2 gap-3">
          <Picker
            label="Show as"
            value={kind}
            onChange={(value) => {
              setKind(value as DashboardWidgetKind);
            }}
          >
            {WIDGET_KINDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Picker>
          <Picker
            label="Size"
            value={size}
            onChange={(value) => {
              setSize(value as DashboardWidgetSize);
            }}
          >
            {WIDGET_SIZES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Picker>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Picker
            label="Issues from"
            value={source}
            onChange={(value) => {
              setSource(value as DashboardWidgetSource);
            }}
          >
            {SOURCES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Picker>
          {source === 'team' && (
            <Picker label="Team" value={teamId} onChange={setTeamId}>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Picker>
          )}
          {source === 'view' && (
            <Picker label="View" value={viewId} onChange={setViewId}>
              {views.map((view) => (
                <option key={view.view_id} value={view.view_id}>
                  {view.name}
                </option>
              ))}
            </Picker>
          )}
        </div>
        {source === 'team' && (
          <Checkbox
            label="Include sub-teams"
            checked={subTeams}
            onChange={(event) => {
              setSubTeams(event.target.checked);
            }}
          />
        )}
        <div className="grid grid-cols-3 gap-3">
          <Picker
            label="Measure"
            value={measure}
            onChange={(value) => {
              setMeasure(value as InsightMeasure);
            }}
          >
            {INSIGHT_MEASURES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Picker>
          <Picker
            label="Group by"
            value={groupBy}
            onChange={(value) => {
              setGroupBy(value as InsightDimension);
            }}
          >
            {INSIGHT_DIMENSIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Picker>
          <Picker
            label="Segment by"
            value={segmentBy === groupBy ? '' : segmentBy}
            onChange={(value) => {
              setSegmentBy(value as InsightDimension | '');
            }}
          >
            <option value="">None</option>
            {INSIGHT_DIMENSIONS.filter(
              (option) => option.value !== groupBy
            ).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Picker>
        </div>
        {initial.filter !== undefined &&
          Object.keys(initial.filter).length > 0 && (
            <p className="text-xs text-text-muted">
              Keeps the filter of the list it was added from.
            </p>
          )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={saving || missing}
          >
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export default WidgetDialog;
