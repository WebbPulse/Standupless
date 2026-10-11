/**
 * The documents that mention an issue, in the issue rail: each links to the
 * document page with the project or initiative it sits under. Renders nothing
 * while no document names the issue, or when the read fails, because the list
 * is a pointer and not a control.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuFileText } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { listIssueDocuments } from '../../api/documents';
import { documentPath } from '../../lib/paths';
import { issueDocumentsKey } from '../../lib/queryKeys';
import RailSection from './RailSection';

/** How often the list re-reads. Mentions change rarely, so this is slow. */
const POLL_MS = 120000;

/** Props for IssueDocumentsSection: the issue and the workspace it is in. */
export interface IssueDocumentsSectionProps {
  workspaceId: string;
  issueId: string;
  slug: string;
}

/** Lists the documents that mention one issue. */
export const IssueDocumentsSection: React.FC<IssueDocumentsSectionProps> = ({
  workspaceId,
  issueId,
  slug,
}) => {
  const auth = useQueryAuth();
  const { data, error } = usePolledQuery(
    ({ signal }) => listIssueDocuments(workspaceId, issueId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: issueDocumentsKey(workspaceId, issueId),
      auth,
    }
  );

  const documents = data ?? [];
  if (error !== null || documents.length === 0) return null;

  return (
    <RailSection title="Documents" count={String(documents.length)}>
      <ul className="space-y-1">
        {documents.map((row) => (
          <li key={row.document_id}>
            <Link
              to={documentPath(slug, row.document_id)}
              className="flex min-w-0 items-center gap-1.5 rounded-xs text-xs text-text hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
            >
              <LuFileText
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-text-faint"
              />
              <span className="truncate">{row.title}</span>
              <span className="shrink-0 truncate text-text-faint">
                {row.parent_name}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </RailSection>
  );
};

export default IssueDocumentsSection;
