/**
 * The issues this one blocks, is blocked by, relates to or duplicates, grouped
 * by how they relate in a rail section. Each row links to the other issue and
 * shows its status, which the links route carries for every target in any team
 * the caller can see; adding one opens the relation
 * dialog, so the rail stays a list rather than a form.
 */

import React from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { LuX } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { deleteLink } from '../../api/issues';
import { errorMessage } from '../../lib/errors';
import { issuePath } from '../../lib/paths';
import { activityKey, linksKey } from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import type { LinkRead, LinkTypeRead } from '../../types/Api';
import { IconButton } from '../ui/button';
import { StatusGlyph } from '../ui/glyphs';
import RailSection from './RailSection';

/** Props for IssueRelations. */
export interface IssueRelationsProps {
  workspaceId: string;
  issueId: string;
  slug: string;
  links: LinkRead[];
  canEdit: boolean;
  /** Opens the add relation dialog. */
  onAdd: () => void;
}

/** The groups in the order they read, each with its heading. */
const GROUPS: { type: LinkTypeRead; heading: string }[] = [
  { type: 'blocked_by', heading: 'Blocked by' },
  { type: 'blocks', heading: 'Blocking' },
  { type: 'relates_to', heading: 'Related' },
  { type: 'duplicate_of', heading: 'Duplicate of' },
  { type: 'duplicated_by', heading: 'Duplicates' },
];

/** The relations section of the rail. */
export const IssueRelations: React.FC<IssueRelationsProps> = ({
  workspaceId,
  issueId,
  slug,
  links,
  canEdit,
  onAdd,
}) => {
  const remove = (link: LinkRead): void => {
    deleteLink(workspaceId, issueId, link.link_id)
      .then(() => {
        invalidateQueries([linksKey(issueId), activityKey(issueId)]);
        showToast('Relation removed');
      })
      .catch((failure: unknown) => {
        showErrorToast(
          errorMessage(failure, 'Could not remove that relation.')
        );
      });
  };

  if (links.length === 0 && !canEdit) return null;

  const groups = GROUPS.map((group) => ({
    ...group,
    rows: links.filter((link) => link.type === group.type),
  })).filter((group) => group.rows.length > 0);

  return (
    <RailSection
      title="Relations"
      {...(links.length > 0 ? { count: String(links.length) } : {})}
      {...(canEdit ? { add: { label: 'Add relation', onClick: onAdd } } : {})}
    >
      {groups.length === 0 ? (
        <p className="py-1 text-xs text-text-faint">No related issues</p>
      ) : (
        <div className="space-y-2">
          {groups.map((group) => (
            <div key={group.type}>
              <h4 className="py-0.5 text-2xs font-medium text-text-faint">
                {group.heading}
              </h4>
              <ul aria-label={group.heading}>
                {group.rows.map((link) => {
                  const status = link.target_status ?? undefined;
                  return (
                    <li
                      key={link.link_id}
                      className="group/relation -mx-1 flex h-7 items-center gap-1.5 rounded-sm px-1 text-xs hover:bg-raised"
                    >
                      <StatusGlyph
                        category={status?.category}
                        {...(status === undefined ? {} : { name: status.name })}
                      />
                      <Link
                        to={issuePath(slug, link.target_key)}
                        title={link.target_title}
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xs"
                      >
                        <span className="shrink-0 font-mono text-text-faint">
                          {link.target_key}
                        </span>
                        <span className="min-w-0 truncate text-text">
                          {link.target_title}
                        </span>
                      </Link>
                      {canEdit && (
                        <IconButton
                          label={`Remove relation to ${link.target_key}`}
                          size="sm"
                          className="h-5 w-5 shrink-0 opacity-0 group-focus-within/relation:opacity-100 group-hover/relation:opacity-100"
                          onClick={() => {
                            remove(link);
                          }}
                        >
                          <LuX className="h-3 w-3" />
                        </IconButton>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </RailSection>
  );
};

export default IssueRelations;
