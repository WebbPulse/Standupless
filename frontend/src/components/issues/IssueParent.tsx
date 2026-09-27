/**
 * The issue this one is a sub-issue of, as a rail section: a linked row for
 * the parent with its status, and a picker on the header to set or change it.
 * The parent is found among the team's candidate parents the page already
 * holds, and read on its own only when it is not one of them.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { Link } from 'react-router-dom';
import { getIssue } from '../../api/issues';
import { issuePath } from '../../lib/paths';
import { issueKey } from '../../lib/queryKeys';
import type { IssueRead, StatusRead } from '../../types/Api';
import { StatusGlyph } from '../ui/glyphs';
import { ParentPicker } from './PropertyPickers';
import RailSection from './RailSection';

/** Props for IssueParent. */
export interface IssueParentProps {
  workspaceId: string;
  slug: string;
  issue: IssueRead;
  /** Issues this one may sit under, already narrowed to the same team. */
  candidates: IssueRead[];
  statuses: StatusRead[];
  canEdit: boolean;
  onChange: (parentId: string | null) => void;
}

/** How often a parent read on its own is re-read. */
const POLL_MS = 60000;

/** The parent section of the rail. */
export const IssueParent: React.FC<IssueParentProps> = ({
  workspaceId,
  slug,
  issue,
  candidates,
  statuses,
  canEdit,
  onChange,
}) => {
  const auth = useQueryAuth();
  const parentId = issue.parent_id;
  const known =
    parentId === null
      ? undefined
      : candidates.find((candidate) => candidate.id === parentId);

  const { data: fetched } = usePolledQuery(
    ({ signal }) => getIssue(workspaceId, parentId ?? '', signal),
    {
      intervalMs: POLL_MS,
      enabled: parentId !== null && known === undefined && workspaceId !== '',
      queryKey: issueKey(workspaceId, parentId ?? ''),
      auth,
    }
  );

  const parent =
    known ??
    (fetched !== null && fetched.id === parentId ? fetched : undefined);
  const status = statuses.find((item) => item.id === parent?.status_id);

  if (parentId === null && !canEdit) return null;

  return (
    <RailSection
      title="Parent"
      actions={
        canEdit ? (
          <ParentPicker
            variant="icon"
            align="end"
            className="h-5 w-5"
            candidates={candidates}
            value={parentId}
            onChange={onChange}
          />
        ) : undefined
      }
    >
      {parentId === null ? (
        <p className="py-1 text-xs text-text-faint">Not a sub-issue</p>
      ) : parent === undefined ? (
        <p className="py-1 text-xs text-text-faint">Loading parent</p>
      ) : (
        <Link
          to={issuePath(slug, parent.key)}
          title={parent.title}
          aria-label={`Sub-issue of ${parent.key} ${parent.title}`}
          className="-mx-1 flex h-7 items-center gap-1.5 rounded-sm px-1 text-xs transition-colors duration-100 hover:bg-raised"
        >
          <StatusGlyph
            category={status?.category}
            {...(status === undefined ? {} : { name: status.name })}
          />
          <span className="shrink-0 font-mono text-text-faint">
            {parent.key}
          </span>
          <span className="min-w-0 truncate text-text">{parent.title}</span>
        </Link>
      )}
    </RailSection>
  );
};

export default IssueParent;
