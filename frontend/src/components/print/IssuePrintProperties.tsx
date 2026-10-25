/**
 * An issue's key properties as the one line a printed issue carries under
 * its bar-less page: key, team, status, priority, assignee, estimate, due
 * date and labels.
 */

import React from 'react';
import type { Assignable } from '../../lib/issuePeople';
import { personLabel } from '../../lib/issuePeople';
import { PRIORITY_LABELS } from '../../lib/issueDisplay';
import type { IssueRead, LabelRead, StatusRead } from '../../types/Api';
import PrintProperties from './PrintProperties';

/** Props for IssuePrintProperties. */
export interface IssuePrintPropertiesProps {
  issue: IssueRead;
  teamName?: string | undefined;
  statuses: readonly StatusRead[];
  labels: readonly LabelRead[];
  people: readonly Assignable[];
}

/** The properties, in print order, each as it reads. */
export const issuePrintItems = ({
  issue,
  teamName,
  statuses,
  labels,
  people,
}: IssuePrintPropertiesProps): (string | null)[] => {
  const assignee =
    issue.assignee_id === null
      ? 'Unassigned'
      : personLabel(
          people.find((person) => person.user_id === issue.assignee_id)
        );
  const labelNames = issue.label_ids
    .map((id) => labels.find((label) => label.id === id)?.name)
    .filter((name): name is string => name !== undefined);
  return [
    issue.key,
    teamName ?? null,
    statuses.find((status) => status.id === issue.status_id)?.name ?? null,
    issue.priority === 'none' ? null : PRIORITY_LABELS[issue.priority],
    assignee,
    issue.estimate === null ? null : `Estimate ${issue.estimate}`,
    issue.due_date === null ? null : `Due ${issue.due_date}`,
    labelNames.length === 0 ? null : labelNames.join(', '),
  ];
};

/** Renders the line, shown only in print. */
export const IssuePrintProperties: React.FC<IssuePrintPropertiesProps> = (
  props
) => <PrintProperties items={issuePrintItems(props)} />;

export default IssuePrintProperties;
