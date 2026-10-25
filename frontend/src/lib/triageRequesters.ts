/**
 * Who asked, as the triage inbox narrows and groups by it. The filter runs on
 * the server, so a choice here is turned into the triage list's requester
 * query and every page holds only matching issues. Grouping runs over the
 * rows already read, putting each person's asks together in the order their
 * newest one arrived, with the issues nobody asked for through an intake last.
 */

import type { TriageListQuery } from '../api/triage';
import type { Assignable } from './issuePeople';
import { requesterDisplay } from '../components/issues/RequesterBadge';
import type { IssueRead, IssueRequester } from '../types/Api';

/** The requester filter value that keeps every issue. */
export const ANY_REQUESTER = '';

/** The requester filter and group value for issues with no requester. */
export const NO_REQUESTER = 'source:none';

/** The fixed requester choices the filter always offers, before the people seen. */
export const SOURCE_CHOICES: { value: string; label: string }[] = [
  { value: 'source:slack', label: 'From Slack' },
  { value: 'source:email', label: 'From email' },
  { value: NO_REQUESTER, label: 'No requester' },
];

/** The heading the issues with no requester are grouped under. */
export const NO_REQUESTER_LABEL = 'No requester';

/** The requester query a filter value sends, empty for any requester or a value it does not know. */
export const requesterQuery = (
  value: string
): Pick<
  TriageListQuery,
  'requester_user_id' | 'requester_slack_user_id' | 'requester_source'
> => {
  const split = value.indexOf(':');
  if (split === -1) return {};
  const kind = value.slice(0, split);
  const id = value.slice(split + 1);
  if (id === '') return {};
  if (kind === 'member') return { requester_user_id: id };
  if (kind === 'slack') return { requester_slack_user_id: id };
  if (kind === 'source' && (id === 'slack' || id === 'email' || id === 'none'))
    return { requester_source: id };
  return {};
};

/**
 * The value naming one requester as a person: the member behind them when one
 * is linked, the Slack user otherwise, and null for an emailed-in stranger,
 * whose address is masked and so cannot be filtered on.
 */
export const requesterValue = (requester: IssueRequester): string | null => {
  if (requester.user_id) return `member:${requester.user_id}`;
  if (requester.source === 'slack' && requester.external_id)
    return `slack:${requester.external_id}`;
  return null;
};

/** The key one issue groups under: its requester as a person, or its masked sender, or no requester. */
export const requesterGroupKey = (issue: IssueRead): string => {
  const requester = issue.requester;
  if (!requester) return NO_REQUESTER;
  return (
    requesterValue(requester) ??
    `${requester.source}:${requester.masked_email ?? requester.name}`
  );
};

/** One requester's run of issues in the grouped inbox. */
export interface RequesterGroup {
  key: string;
  label: string;
  /** The requester the heading shows, null for the no-requester group. */
  requester: IssueRequester | null;
  rows: IssueRead[];
}

/**
 * The rows grouped by requester, each group in the order its first row came,
 * so the newest ask leads, and the issues with no requester always last.
 */
export const groupByRequester = (
  rows: IssueRead[],
  people: Assignable[] = []
): RequesterGroup[] => {
  const groups = new Map<string, RequesterGroup>();
  for (const row of rows) {
    const key = requesterGroupKey(row);
    const held = groups.get(key);
    if (held !== undefined) {
      held.rows.push(row);
      continue;
    }
    const requester = row.requester ?? null;
    groups.set(key, {
      key,
      label:
        requester === null
          ? NO_REQUESTER_LABEL
          : requesterDisplay(requester, people).name,
      requester,
      rows: [row],
    });
  }
  const ordered = Array.from(groups.values());
  return [
    ...ordered.filter((group) => group.key !== NO_REQUESTER),
    ...ordered.filter((group) => group.key === NO_REQUESTER),
  ];
};

/** One choice the requester filter offers. */
export interface RequesterChoice {
  value: string;
  label: string;
  detail?: string;
  group: string;
}

/**
 * The requester filter's choices: the sources, then each person seen among
 * the rows read, then the one chosen when the rows no longer show them, so a
 * narrowed list still names its own filter.
 */
export const requesterChoices = (
  rows: IssueRead[],
  people: Assignable[],
  chosen: RequesterChoice | null
): RequesterChoice[] => {
  const choices: RequesterChoice[] = SOURCE_CHOICES.map((choice) => ({
    ...choice,
    group: 'Source',
  }));
  const seen = new Set(choices.map((choice) => choice.value));
  for (const row of rows) {
    const requester = row.requester;
    if (!requester) continue;
    const value = requesterValue(requester);
    if (value === null || seen.has(value)) continue;
    seen.add(value);
    const shown = requesterDisplay(requester, people);
    choices.push({
      value,
      label: shown.name,
      ...(shown.detail === null ? {} : { detail: shown.detail }),
      group: 'Requester',
    });
  }
  if (chosen !== null && !seen.has(chosen.value)) choices.push(chosen);
  return choices;
};
