/**
 * The presence stack: up to four faces then "+n", one tooltip naming everyone
 * with editors marked, a ring on editors, nothing at all for an empty list, and
 * viewer ids resolved to member names.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MemberRead } from '../../types/Api';
import {
  PRESENCE_AVATARS_SHOWN,
  PresenceStack,
  presenceLabel,
  presencePeople,
  type PresencePerson,
} from './PresenceAvatars';

/** One resolved viewer. */
const person = (index: number, editing = false): PresencePerson => ({
  userId: `u-${String(index)}`,
  name: `Person ${String(index)}`,
  avatarUrl: null,
  editing,
});

describe('PresenceStack', () => {
  it('renders nothing for an empty list', () => {
    const { container } = render(<PresenceStack people={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows four faces, folds the rest into +n and names everyone', () => {
    const people = [person(1, true), ...[2, 3, 4, 5, 6].map((n) => person(n))];
    const { container } = render(<PresenceStack people={people} />);
    const group = screen.getByTestId('presence-avatars');
    expect(group.children).toHaveLength(PRESENCE_AVATARS_SHOWN + 1);
    expect(group).toHaveTextContent('+2');
    expect(group.getAttribute('aria-label')).toBe(
      'Also here: Person 1, editing; Person 2; Person 3; Person 4; Person 5; Person 6'
    );
    expect(container.querySelectorAll('[data-editing]')).toHaveLength(1);
  });

  it('shows no overflow at four or fewer', () => {
    render(<PresenceStack people={[person(1), person(2)]} />);
    const group = screen.getByTestId('presence-avatars');
    expect(group.children).toHaveLength(2);
    expect(group).not.toHaveTextContent('+');
  });

  it('lists one person a line in the tooltip, editors marked', () => {
    expect(presenceLabel([person(1, true), person(2)])).toBe(
      'Person 1 (editing)\nPerson 2'
    );
  });
});

describe('presencePeople', () => {
  it('names members by their written name and leaves strangers neutral', () => {
    const members = [
      {
        user_id: 'u-1',
        email: 'mel@example.com',
        display_name: 'mel',
        full_name: 'Mel Member',
        avatar_url: 'https://example.com/mel.png',
        role: 'member',
        joined_at: '2026-01-01T00:00:00Z',
      },
    ] as MemberRead[];
    expect(
      presencePeople(
        [
          { userId: 'u-1', editing: true },
          { userId: 'u-9', editing: false },
        ],
        members
      )
    ).toEqual([
      {
        userId: 'u-1',
        name: 'Mel Member',
        avatarUrl: 'https://example.com/mel.png',
        editing: true,
      },
      { userId: 'u-9', name: 'Someone', avatarUrl: null, editing: false },
    ]);
  });
});
