/**
 * Who asked for an issue that came in through Slack or email, as Linear Asks
 * shows it: their avatar, name and handle or masked address, and a badge for
 * the source. A requester whose verified address is a member's reads as that
 * member and links to their page, since the member is who to follow up with.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../ui/avatar';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/cn';
import type { Assignable } from '../../lib/issuePeople';
import { personAvatar, personLabel } from '../../lib/issuePeople';
import { memberPath } from '../../lib/paths';
import type { IssueRequester } from '../../types/Api';

/** The words a source badge carries. */
const SOURCE_LABEL: Record<IssueRequester['source'], string> = {
  slack: 'Slack',
  email: 'Email',
};

/** The name, secondary line, avatar and member link a requester reads as. */
export interface RequesterDisplay {
  name: string;
  detail: string | null;
  avatar: string | null;
  memberId: string | null;
}

/**
 * How a requester reads, preferring the member behind them when the page
 * knows that member, and otherwise what the intake kept.
 */
export const requesterDisplay = (
  requester: IssueRequester,
  people: Assignable[] = []
): RequesterDisplay => {
  const memberId = requester.user_id ?? null;
  const member =
    memberId === null
      ? undefined
      : people.find((person) => person.user_id === memberId);
  const handle = requester.handle ? `@${requester.handle}` : null;
  const detail = handle ?? requester.masked_email ?? null;
  if (member !== undefined) {
    return {
      name: personLabel(member),
      detail: null,
      avatar: personAvatar(member),
      memberId,
    };
  }
  const name = requester.name.trim() || detail || 'Unknown requester';
  return {
    name,
    detail: detail === name ? null : detail,
    avatar: requester.avatar_url ?? null,
    memberId,
  };
};

/** Props for RequesterBadge. */
export interface RequesterBadgeProps {
  requester: IssueRequester;
  /** The workspace slug, for the link to a linked member's page. */
  slug?: string;
  /** The people the page knows, to show a linked member by their own name. */
  people?: Assignable[];
  /** A one-line form for list rows, without the member link. */
  compact?: boolean;
  className?: string;
}

/** The requester of an issue with its source badge. */
export const RequesterBadge: React.FC<RequesterBadgeProps> = ({
  requester,
  slug,
  people,
  compact = false,
  className,
}) => {
  const shown = requesterDisplay(requester, people);
  const source = SOURCE_LABEL[requester.source];
  const name =
    !compact && shown.memberId !== null && slug ? (
      <Link
        to={memberPath(slug, shown.memberId)}
        className="truncate text-text hover:underline"
      >
        {shown.name}
      </Link>
    ) : (
      <span className={cn('truncate', compact ? '' : 'text-text')}>
        {shown.name}
      </span>
    );
  return (
    <span
      data-testid="issue-requester"
      aria-label={`Requested by ${shown.name} via ${source}`}
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-xs',
        className
      )}
    >
      <Avatar name={shown.name} src={shown.avatar} size="xs" />
      {name}
      {shown.detail !== null && (
        <span className="truncate text-text-faint">{shown.detail}</span>
      )}
      <Badge className="shrink-0">{source}</Badge>
    </span>
  );
};

export default RequesterBadge;
