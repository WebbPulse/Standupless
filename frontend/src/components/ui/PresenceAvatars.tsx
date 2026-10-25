/**
 * The small stack of faces in an issue or document header naming the other
 * people who have it open right now. Up to {@link PRESENCE_AVATARS_SHOWN}
 * avatars show, then a "+n" for the rest, and one tooltip names everyone. A
 * person typing in the description wears an accent ring.
 *
 * The viewer is never in the list, since the server leaves each person out of
 * their own, and with no socket the list is empty and nothing renders.
 */

import React, { useMemo } from 'react';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { memberName } from '../../lib/memberDirectory';
import { cn } from '../../lib/cn';
import { usePresence, type PresenceKind } from '../../lib/presence';
import type { MemberRead } from '../../types/Api';
import { Avatar } from './avatar';
import { Tooltip } from './tooltip';

/** How many faces show before the rest fold into "+n". */
export const PRESENCE_AVATARS_SHOWN = 4;

/** One viewer as the stack draws them. */
export interface PresencePerson {
  userId: string;
  name: string;
  avatarUrl: string | null;
  editing: boolean;
}

/** Props for PresenceStack: the people to draw. */
export interface PresenceStackProps {
  people: readonly PresencePerson[];
  className?: string;
}

/** The tooltip text: one line per person, editors marked. */
export const presenceLabel = (people: readonly PresencePerson[]): string =>
  people
    .map((person) =>
      person.editing ? `${person.name} (editing)` : person.name
    )
    .join('\n');

/** The stack itself, drawn from people already resolved to names. */
export const PresenceStack: React.FC<PresenceStackProps> = ({
  people,
  className = '',
}) => {
  if (people.length === 0) return null;
  const shown = people.slice(0, PRESENCE_AVATARS_SHOWN);
  const rest = people.length - shown.length;
  const label = presenceLabel(people);
  const spoken = `Also here: ${people
    .map((person) => (person.editing ? `${person.name}, editing` : person.name))
    .join('; ')}`;
  return (
    <Tooltip text={label} className={className}>
      <span
        role="group"
        aria-label={spoken}
        tabIndex={0}
        data-testid="presence-avatars"
        className="flex items-center -space-x-1 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {shown.map((person) => (
          <span
            key={person.userId}
            data-editing={person.editing ? '' : undefined}
            className={cn(
              'inline-flex rounded-full ring-1 ring-surface',
              person.editing && 'ring-2 ring-accent'
            )}
          >
            <Avatar name={person.name} src={person.avatarUrl} size="sm" />
          </span>
        ))}
        {rest > 0 ? (
          <span
            aria-hidden="true"
            className="z-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-raised px-1 text-[9px] font-semibold text-text-muted ring-1 ring-surface"
          >
            +{rest}
          </span>
        ) : null}
      </span>
    </Tooltip>
  );
};

/** Resolves viewer ids to members, keeping ones the list does not know yet under a neutral name. */
export const presencePeople = (
  viewers: readonly { userId: string; editing: boolean }[],
  members: readonly MemberRead[]
): PresencePerson[] => {
  const byId = new Map(members.map((member) => [member.user_id, member]));
  return viewers.map((viewer) => {
    const member = byId.get(viewer.userId);
    return {
      userId: viewer.userId,
      name: member === undefined ? 'Someone' : memberName(member),
      avatarUrl: member?.avatar_url ?? null,
      editing: viewer.editing,
    };
  });
};

/** Props for PresenceAvatars: the entity, its workspace, and whether the viewer is editing it. */
export interface PresenceAvatarsProps {
  workspaceId: string;
  kind: PresenceKind;
  id: string | null | undefined;
  editing?: boolean;
  className?: string;
}

/** Reports the page as viewing the entity and draws the others viewing it. */
export const PresenceAvatars: React.FC<PresenceAvatarsProps> = ({
  workspaceId,
  kind,
  id,
  editing = false,
  className = '',
}) => {
  const viewers = usePresence(kind, id, editing);
  const { workspace } = useWorkspace();
  const canList = workspace !== null && workspace.role !== 'guest';
  const members = useWorkspaceMembers(
    workspaceId,
    canList && viewers.length > 0
  );
  const people = useMemo(
    () => presencePeople(viewers, members),
    [viewers, members]
  );
  return <PresenceStack people={people} className={className} />;
};

export default PresenceAvatars;
