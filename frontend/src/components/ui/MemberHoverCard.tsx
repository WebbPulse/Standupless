/**
 * The card a person opens on hover, after Linear's member card: their avatar,
 * name, handle and workspace role, the status they set with the away note
 * while they are away, their local time and teams, and links to their page and
 * the issues assigned to them.
 *
 * The header comes from the workspace member list the pickers share, so it
 * draws at once. The teams and the timezone come from the member's profile,
 * read only once a card opens and cached after, so a page full of avatars
 * costs nothing until someone rests on one. The server leaves out a status and
 * a timezone the viewer may not see, so a guest reads only those of people on
 * their teams.
 *
 * The details sit in a list of {@link MemberCardRow}s, so a later fact such as
 * when the person was last active is one more row.
 */

import React, { useContext } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import { useMemberProfile } from '../../hooks/useMemberActivity';
import { useTeamsFor } from '../../hooks/useTeams';
import { roleLabel } from '../../lib/capabilities';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import { localTimeIn, type LocalTime } from '../../lib/localTime';
import { mentionHandle } from '../../lib/mentions';
import { memberPath, teamPath } from '../../lib/paths';
import {
  awayNote,
  statusInForce,
  statusUntilLabel,
} from '../../lib/userStatus';
import type { WorkspaceRead, WorkspaceRole } from '../../types/Api';
import Avatar from './avatar';
import { HoverCard, type HoverCardTriggerProps } from './hover-card';

/** A person the card can describe: the picker shape, with a role when the list carries one. */
export type MemberCardPerson = Assignable & { role?: WorkspaceRole };

/** A team the person is on, linked when the card knows where teams live. */
export interface MemberCardTeam {
  id: string;
  name: string;
  href?: string;
}

/** Where the card's links go, when it is drawn inside a routed workspace. */
export interface MemberCardLinks {
  profile: string;
  assigned: string;
}

/** Props for MemberCard: the person and what the profile read added. */
export interface MemberCardProps {
  person: MemberCardPerson;
  role?: WorkspaceRole | undefined;
  teams?: MemberCardTeam[];
  localTime?: LocalTime | null;
  links?: MemberCardLinks | null;
}

/** One labelled fact under the header, such as the local time. */
export const MemberCardRow: React.FC<{
  label: string;
  children: React.ReactNode;
}> = ({ label, children }) => (
  <div className="flex items-baseline gap-2 text-xs">
    <dt className="w-16 shrink-0 text-text-faint">{label}</dt>
    <dd className="min-w-0 text-text">{children}</dd>
  </div>
);

/** The teams row's chips, linked when each team has an address. */
const TeamChips: React.FC<{ teams: MemberCardTeam[] }> = ({ teams }) => (
  <ul aria-label="Teams" className="flex flex-wrap gap-1">
    {teams.map((team) => (
      <li key={team.id}>
        {team.href === undefined ? (
          <span className="inline-flex h-5 items-center rounded-full border border-line px-1.5 text-2xs text-text-muted">
            {team.name}
          </span>
        ) : (
          <Link
            to={team.href}
            className="inline-flex h-5 items-center rounded-full border border-line px-1.5 text-2xs text-text-muted hover:bg-raised hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            {team.name}
          </Link>
        )}
      </li>
    ))}
  </ul>
);

/** The card's body for one person. */
export const MemberCard: React.FC<MemberCardProps> = ({
  person,
  role,
  teams = [],
  localTime = null,
  links = null,
}) => {
  const status = statusInForce(person.user_status);
  const away = awayNote(status);
  const name = personLabel(person);
  const shownRole = role ?? person.role;
  const hasRows = localTime !== null || teams.length > 0;
  return (
    <div className="flex flex-col gap-2.5 p-3" data-testid="member-card">
      <div className="flex items-center gap-2.5">
        <Avatar
          name={name}
          src={person.avatar_url ?? null}
          size="lg"
          away={status?.away === true}
        />
        <div className="min-w-0">
          {links === null ? (
            <p className="truncate font-medium text-text">{name}</p>
          ) : (
            <Link
              to={links.profile}
              className="block truncate rounded-sm font-medium text-text hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
            >
              {name}
            </Link>
          )}
          <p className="truncate text-xs text-text-muted">
            @{mentionHandle(person)}
            {shownRole !== undefined && (
              <span className="text-text-faint">
                {' · '}
                {roleLabel(shownRole)}
              </span>
            )}
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
      {hasRows && (
        <dl className="flex flex-col gap-1.5">
          {localTime !== null && (
            <MemberCardRow label="Local time">
              <span data-testid="member-local-time">{localTime.time}</span>
              <span className="text-text-faint"> · {localTime.offset}</span>
            </MemberCardRow>
          )}
          {teams.length > 0 && (
            <MemberCardRow label="Teams">
              <TeamChips teams={teams} />
            </MemberCardRow>
          )}
        </dl>
      )}
      {links !== null && (
        <div className="flex items-center gap-3 border-t border-line pt-2 text-xs">
          <Link
            to={links.assigned}
            className="rounded-sm text-text-muted hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            Assigned issues
          </Link>
          <Link
            to={links.profile}
            className="rounded-sm text-text-muted hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            View profile
          </Link>
        </div>
      )}
    </div>
  );
};

/** The card inside a workspace, filled in from the member's profile and the team list. */
const WorkspaceMemberCard: React.FC<{
  person: MemberCardPerson;
  workspace: WorkspaceRead;
  routed: boolean;
}> = ({ person, workspace, routed }) => {
  const { profile } = useMemberProfile(workspace.id, person.user_id);
  const { data } = useTeamsFor(workspace.id);
  const ids = new Set(profile?.team_ids ?? []);
  const teams = (data ?? [])
    .filter((team) => ids.has(team.id))
    .map((team) => ({
      id: team.id,
      name: team.name,
      ...(routed ? { href: teamPath(workspace.slug, team.key_prefix) } : {}),
    }));
  return (
    <MemberCard
      person={person}
      role={profile?.role}
      teams={teams}
      localTime={localTimeIn(profile?.timezone)}
      links={
        routed
          ? {
              profile: memberPath(workspace.slug, person.user_id),
              assigned: memberPath(workspace.slug, person.user_id, 'assigned'),
            }
          : null
      }
    />
  );
};

/** The card's body: filled in inside a workspace, the list's header alone anywhere else. */
export const MemberCardBody: React.FC<{ person: MemberCardPerson }> = ({
  person,
}) => {
  const workspace = useContext(WorkspaceContext)?.workspace ?? null;
  const routed = useInRouterContext();
  if (workspace === null) return <MemberCard person={person} />;
  return (
    <WorkspaceMemberCard
      person={person}
      workspace={workspace}
      routed={routed}
    />
  );
};

/** Props for MemberHoverTrigger: the person and the element the card hangs off. */
export interface MemberHoverTriggerProps {
  person: MemberCardPerson | undefined;
  children: (trigger: Partial<HoverCardTriggerProps>) => React.ReactElement;
}

/** Wraps a trigger so resting on it opens the person's card, or draws it plain when the person is unknown. */
export const MemberHoverTrigger: React.FC<MemberHoverTriggerProps> = ({
  person,
  children,
}) => (
  <HoverCard
    disabled={person === undefined}
    className="w-72"
    content={() =>
      person === undefined ? null : <MemberCardBody person={person} />
    }
  >
    {children}
  </HoverCard>
);

export default MemberHoverTrigger;
