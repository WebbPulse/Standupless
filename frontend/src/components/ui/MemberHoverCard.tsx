/**
 * The card a mention of a person opens on hover: their avatar, name, handle
 * and the status they set, with the away note while they are away. It reads
 * the workspace member list the pickers share, so it costs no request of its
 * own. The server leaves out a status the viewer may not see, so a guest
 * reads only the statuses of people on their teams.
 */

import React from 'react';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import { mentionHandle } from '../../lib/mentions';
import {
  awayNote,
  statusInForce,
  statusUntilLabel,
} from '../../lib/userStatus';
import Avatar from './avatar';
import {
  HoverCardPanel,
  hoverCardTriggerProps,
  useHoverCard,
  type HoverCardTriggerProps,
} from './hover-card';

/** The card's body for one person. */
export const MemberCard: React.FC<{ person: Assignable }> = ({ person }) => {
  const status = statusInForce(person.user_status);
  const away = awayNote(status);
  const name = personLabel(person);
  return (
    <div className="flex flex-col gap-2 p-3" data-testid="member-card">
      <div className="flex items-center gap-2.5">
        <Avatar
          name={name}
          src={person.avatar_url ?? null}
          size="md"
          away={status?.away === true}
        />
        <div className="min-w-0">
          <p className="truncate font-medium text-text">{name}</p>
          <p className="truncate text-xs text-text-muted">
            @{mentionHandle(person)}
          </p>
        </div>
      </div>
      {status !== null && (
        <div className="flex items-start gap-1.5 text-xs text-text">
          {status.emoji !== '' && (
            <span aria-hidden="true">{status.emoji}</span>
          )}
          <span className="min-w-0 break-words">
            {status.text || (status.away ? 'Away' : '')}
            {status.until && !status.away && (
              <span className="text-text-faint">
                {' '}
                until {statusUntilLabel(status.until)}
              </span>
            )}
          </span>
        </div>
      )}
      {away !== null && <p className="text-xs text-warning">{away}</p>}
    </div>
  );
};

/** Props for MemberHoverTrigger: the person and the element the card hangs off. */
export interface MemberHoverTriggerProps {
  person: Assignable | undefined;
  children: (trigger: Partial<HoverCardTriggerProps>) => React.ReactElement;
}

/** Wraps a trigger so resting on it opens the person's card, or draws it plain when the person is unknown. */
export const MemberHoverTrigger: React.FC<MemberHoverTriggerProps> = ({
  person,
  children,
}) => {
  const controller = useHoverCard();
  if (person === undefined) return children({});
  return (
    <>
      {children(hoverCardTriggerProps(controller))}
      <HoverCardPanel controller={controller} className="w-64">
        {() => <MemberCard person={person} />}
      </HoverCardPanel>
    </>
  );
};

export default MemberHoverTrigger;
