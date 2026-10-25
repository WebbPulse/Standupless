/**
 * How the application approvals list is drawn from two reads: the workspace's
 * approval records and its members' grants. An app members authorized before
 * approvals were required has a grant and no record, and it keeps working, so
 * it is listed as approved and can be revoked like any other.
 */

import type {
  AppApprovalRead,
  WorkspaceConnectedAppRead,
} from '../types/Api';

/** One row of the list: an approval record, or an app authorized before approvals were required. */
export interface ApprovalRow {
  approval: AppApprovalRead;
  members: number;
  legacy: boolean;
}

/**
 * Joins the approval records with the workspace's grants, so an app members
 * authorized before approvals were required shows as approved, and every row
 * knows how many members hold a grant to it.
 */
export const approvalRows = (
  approvals: AppApprovalRead[],
  grants: WorkspaceConnectedAppRead[]
): ApprovalRow[] => {
  const holders = new Map<string, { name: string; users: Set<string> }>();
  for (const grant of grants) {
    const entry = holders.get(grant.client_id) ?? {
      name: grant.client_name,
      users: new Set<string>(),
    };
    entry.users.add(grant.user.id);
    holders.set(grant.client_id, entry);
  }
  const rows: ApprovalRow[] = approvals.map((approval) => ({
    approval,
    members: holders.get(approval.client_id)?.users.size ?? 0,
    legacy: false,
  }));
  const recorded = new Set(approvals.map((approval) => approval.client_id));
  for (const [clientId, entry] of holders) {
    if (recorded.has(clientId)) continue;
    rows.push({
      approval: {
        client_id: clientId,
        client_name: entry.name,
        status: 'approved',
        updated_at: '',
      },
      members: entry.users.size,
      legacy: true,
    });
  }
  return rows.sort((a, b) =>
    a.approval.client_name.localeCompare(b.approval.client_name)
  );
};

