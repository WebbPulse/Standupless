/**
 * The overflow menu on a Pulse entry, like Linear's: open what the entry is
 * about, copy its link, and follow or unfollow it without leaving the feed.
 *
 * Whether the caller follows the subject, and why, is read when the menu opens
 * rather than for every entry up front, so a long feed costs one read per menu
 * actually opened. An explicit unfollow wins over leading, membership and
 * ownership on the server, so Unfollow stays on offer for a role follow and the
 * menu says where that follow came from. When the caller does not follow the
 * subject at all, unfollowing could not take the entry away, so the menu says
 * why it shows and offers Follow instead.
 */

import React, { useRef, useState } from 'react';
import {
  LuArrowUpRight,
  LuBell,
  LuBellOff,
  LuEllipsis,
  LuLink,
} from 'react-icons/lu';
import { getFollow, type FollowSubject } from '../../api/pulse';
import { IconButton } from '../../components/ui/button';
import {
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
} from '../../components/ui/menu';
import { copyText } from '../../lib/copyIssue';
import type { PulseFollowRead, PulseItemRead } from '../../types/Api';
import { entryHref, subjectName } from './pulseDisplay';

/** The attribute the menu's trigger carries, so the feed can open it from the keyboard. */
export const ENTRY_MENU_ATTRIBUTE = 'data-pulse-entry-menu';

/** What an entry is about, as the follow routes name it, or null when it names nothing. */
export const entrySubject = (
  item: PulseItemRead
): { subject: FollowSubject; subjectId: string } | null => {
  if (item.subject_type === 'initiative') {
    return item.initiative_id === null
      ? null
      : { subject: 'initiative', subjectId: item.initiative_id };
  }
  return item.project_id === null
    ? null
    : { subject: 'project', subjectId: item.project_id };
};

/** Why the caller follows a subject they never chose to follow. */
const ROLE_REASONS: Record<FollowSubject, string> = {
  project:
    'You follow this project because you lead it, are a member or follow its initiative.',
  initiative: 'You follow this initiative because you own it.',
};

/** Why an entry shows when the caller does not follow its subject. */
const UNFOLLOWED_REASONS: Record<FollowSubject, string> = {
  project:
    'You do not follow this project. It shows here because you can see it.',
  initiative:
    'You do not follow this initiative. It shows here because you can see it.',
};

/** Props for PulseEntryMenu. */
export interface PulseEntryMenuProps {
  workspaceId: string;
  slug: string;
  item: PulseItemRead;
  /** Stops following the entry's subject. */
  onUnfollow: (item: PulseItemRead) => void;
  /** Starts following the entry's subject. */
  onFollow: (item: PulseItemRead) => void;
  /** Hears the menu open and close, so the feed's own keys stand down meanwhile. */
  onOpenChange?: (open: boolean) => void;
}

/** The follow part of the menu, once the state is known. */
const FollowItems: React.FC<{
  subject: FollowSubject;
  state: PulseFollowRead | null;
  failed: boolean;
  onUnfollow: () => void;
  onFollow: () => void;
}> = ({ subject, state, failed, onUnfollow, onFollow }) => {
  if (failed) {
    return (
      <MenuLabel>Could not read whether you follow this {subject}.</MenuLabel>
    );
  }
  if (state === null) {
    return (
      <MenuItem disabled textValue={`Unfollow ${subject}`}>
        <LuBellOff aria-hidden="true" className="h-3.5 w-3.5" />
        Checking follow
      </MenuItem>
    );
  }
  if (!state.following) {
    return (
      <>
        <MenuLabel>{UNFOLLOWED_REASONS[subject]}</MenuLabel>
        <MenuItem onSelect={onFollow}>
          <LuBell aria-hidden="true" className="h-3.5 w-3.5" />
          Follow {subject}
        </MenuItem>
      </>
    );
  }
  return (
    <>
      {!state.explicit && <MenuLabel>{ROLE_REASONS[subject]}</MenuLabel>}
      <MenuItem onSelect={onUnfollow}>
        <LuBellOff aria-hidden="true" className="h-3.5 w-3.5" />
        Unfollow {subject}
      </MenuItem>
    </>
  );
};

/** The overflow button on one Pulse entry and the menu it opens. */
export const PulseEntryMenu: React.FC<PulseEntryMenuProps> = ({
  workspaceId,
  slug,
  item,
  onUnfollow,
  onFollow,
  onOpenChange,
}) => {
  const target = entrySubject(item);
  const href = entryHref(slug, item);
  const name = subjectName(item);
  const [state, setState] = useState<PulseFollowRead | null>(null);
  const [failed, setFailed] = useState(false);
  const reading = useRef(false);

  const readState = (): void => {
    if (target === null || reading.current) return;
    reading.current = true;
    setState(null);
    setFailed(false);
    getFollow(workspaceId, target.subject, target.subjectId).then(
      (read) => {
        reading.current = false;
        setState(read);
      },
      () => {
        reading.current = false;
        setFailed(true);
      }
    );
  };

  const noun = target?.subject ?? item.subject_type;
  return (
    <Menu
      label={`${name} actions`}
      align="end"
      onOpenChange={onOpenChange}
      trigger={(props) => (
        <IconButton
          {...props}
          data-pulse-entry-menu=""
          label={`Actions for ${name}`}
          size="sm"
          className="-my-1 -mr-1.5"
          onClick={() => {
            if (!props['aria-expanded']) readState();
            props.onClick();
          }}
        >
          <LuEllipsis className="h-3.5 w-3.5" />
        </IconButton>
      )}
    >
      {href !== '' && (
        <>
          <MenuItem to={href}>
            <LuArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
            Open {noun}
          </MenuItem>
          <MenuItem
            onSelect={() => {
              copyText(
                new URL(href, globalThis.location.origin).toString(),
                `Link to the ${noun} copied`
              );
            }}
          >
            <LuLink aria-hidden="true" className="h-3.5 w-3.5" />
            Copy link
          </MenuItem>
        </>
      )}
      {target !== null && (
        <>
          {href !== '' && <MenuSeparator />}
          <FollowItems
            subject={target.subject}
            state={state}
            failed={failed}
            onUnfollow={() => {
              onUnfollow(item);
            }}
            onFollow={() => {
              onFollow(item);
            }}
          />
        </>
      )}
    </Menu>
  );
};

export default PulseEntryMenu;
