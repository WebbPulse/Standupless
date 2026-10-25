/**
 * The keyboard path to a property: s, p, a, l, e, shift+m, shift+c, shift+p or
 * shift+d on the focused or selected issues opens a searchable list of that property's values, and
 * picking one writes it to every target at once. Values are offered by name across the
 * targets' teams, and each issue gets its own team's value of that name, so
 * "Done" on a selection spanning two teams lands in each team's "Done".
 */

import React, { useState } from 'react';
import type { OrderedIssueRead } from '../../../api/issues';
import { useTriageTeamIds } from '../../../hooks/useTriageTeams';
import { Combobox } from '../../ui/combobox';
import Dialog from '../../ui/dialog';
import { useIssueViewEnv } from './IssueViewContext';
import { propertyChoices } from './propertyChoices';
import type { CommandProperty } from './propertyKeys';

const TITLES: Record<CommandProperty, string> = {
  status: 'Change status',
  priority: 'Change priority',
  assignee: 'Assign to',
  labels: 'Change labels',
  estimate: 'Set estimate',
  milestone: 'Set milestone',
  cycle: 'Move to cycle',
  project: 'Move to project',
  dueDate: 'Set due date',
};

/** Props for PropertyCommand. */
export interface PropertyCommandProps {
  property: CommandProperty | null;
  issues: OrderedIssueRead[];
  onClose: () => void;
}

/** The dialog. */
export const PropertyCommand: React.FC<PropertyCommandProps> = ({
  property,
  issues,
  onClose,
}) => {
  const env = useIssueViewEnv();
  const [today] = useState(() => new Date());
  const triageTeams = useTriageTeamIds();

  if (property === null || issues.length === 0) return null;

  const { options, selected, multiple, empty, pick, footer, leadOption } =
    propertyChoices({
      property,
      issues,
      env,
      triageTeams,
      today,
      onDone: onClose,
    });

  const subject =
    issues.length === 1
      ? (issues[0]?.key ?? '')
      : `${String(issues.length)} issues`;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${TITLES[property]}, ${subject}`}
      hideTitle
      size="sm"
    >
      <div className="-mx-4 -mt-8 -mb-4">
        <p className="border-b border-line px-3 pt-2.5 pb-2 text-xs text-text-muted">
          <span className="rounded-sm bg-raised px-1.5 py-0.5 font-mono text-2xs text-text">
            {subject}
          </span>
        </p>
        <Combobox
          label={TITLES[property]}
          placeholder={`${TITLES[property]}...`}
          options={options}
          selected={selected}
          multiple={multiple}
          emptyMessage={empty}
          onSelect={pick}
          {...(footer === undefined ? {} : { footer })}
          {...(leadOption === undefined ? {} : { leadOption })}
        />
      </div>
    </Dialog>
  );
};

export default PropertyCommand;
