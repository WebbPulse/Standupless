/**
 * What a member's activity rows need to read as sentences: the statuses,
 * people, labels, projects and cycles of the teams they touched, and the one
 * phrase each row leads with. Shared by the member feed and the My issues
 * Activity list, so both word an action the same.
 */

import { useMemo } from 'react';
import { describeActivity, type ActivityContext } from '../lib/activityDisplay';
import type { MemberActivityRead } from '../types/Api';
import { useIssueContext } from './useIssueContext';

/** The action a row records, such as "commented" or "changed the status". */
export const memberAction = (
  row: MemberActivityRead,
  context: ActivityContext
): string =>
  row.type === 'comment' || row.activity === null || row.activity === undefined
    ? 'commented'
    : describeActivity(row.activity, context).text;

/** The lists the rows' teams resolve names from, read once per set of teams. */
export const useMemberActivityContext = (
  workspaceId: string,
  rows: readonly MemberActivityRead[]
): ActivityContext => {
  const teamIds = useMemo(
    () => [...new Set(rows.map((row) => row.team_id))],
    [rows]
  );
  const { context: lists } = useIssueContext(workspaceId, teamIds);
  return useMemo<ActivityContext>(
    () => ({
      statuses: lists.statuses,
      people: lists.people,
      labels: lists.labels.map((label) => ({ id: label.id, name: label.name })),
      issues: rows.map((row) => ({ id: row.issue_id, key: row.issue_key })),
      projects: lists.projects.map((project) => ({
        id: project.project_id,
        name: project.name,
      })),
      cycles: lists.cycles.map((cycle) => ({
        id: cycle.cycle_id,
        name: cycle.name,
      })),
    }),
    [lists, rows]
  );
};

export default useMemberActivityContext;
