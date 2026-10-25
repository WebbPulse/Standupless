/**
 * "Remind me" on a project, an initiative and a document. Covers that each
 * kind lists "Remind me about this {noun}…" in the palette and that only a
 * document binds H, that the dialog sets the reminder on the right kind of
 * subject, that a pending reminder shows as a banner which reschedules or
 * cancels it, and that "Cancel reminder" is listed only while one is set.
 */

import type { FC } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import { useRegisteredShortcuts } from '../../hooks/useShortcuts';
import BoundKeys from '../../test/BoundKeys';
import { keysBound } from '../../test/shortcuts';
import type { ReminderRead } from '../../types/Api';
import { useRemindMe, type RemindMeEntity } from './RemindMe';

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

const api = vi.hoisted(() => ({
  listEntityReminders: vi.fn(),
  setEntityReminder: vi.fn(),
  cancelEntityReminder: vi.fn(),
}));

vi.mock('../../api/views', async () => ({
  ...(await vi.importActual<typeof import('../../api/views')>(
    '../../api/views'
  )),
  ...api,
}));

const { listEntityReminders, setEntityReminder, cancelEntityReminder } = api;

/** A pending reminder on `entityType`, two hours out. */
const pending = (entityType: RemindMeEntity): ReminderRead => ({
  entity_type: entityType,
  entity_id: 'sub-1',
  title: 'Launch',
  issue_key: null,
  team_id: '',
  remind_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  created_at: new Date().toISOString(),
});

/** Publishes the palette labels bound right now. */
const Labels: FC = () => {
  const bound = useRegisteredShortcuts();
  return (
    <output
      data-testid="labels"
      data-labels={bound.map((shortcut) => shortcut.label).join('|')}
    />
  );
};

/** The labels the palette lists. */
const labels = (): string[] =>
  (screen.getByTestId('labels').getAttribute('data-labels') ?? '').split('|');

/** A page that binds "Remind me" the way the project, initiative and document pages do. */
const Host: FC<{ entityType: RemindMeEntity; keys: string }> = ({
  entityType,
  keys,
}) => {
  const remindMe = useRemindMe({
    workspaceId: 'ws-1',
    entityType,
    entityId: 'sub-1',
    subject: 'Launch',
    group: 'Page',
    keys,
  });
  return (
    <>
      <button type="button" onClick={remindMe.open}>
        Remind me…
      </button>
      {remindMe.banner}
      {remindMe.dialog}
    </>
  );
};

const renderHost = (entityType: RemindMeEntity, keys = '') =>
  render(
    <ShortcutProvider>
      <Host entityType={entityType} keys={keys} />
      <BoundKeys />
      <Labels />
    </ShortcutProvider>
  );

beforeEach(() => {
  listEntityReminders.mockReset();
  setEntityReminder.mockReset();
  cancelEntityReminder.mockReset();
  listEntityReminders.mockResolvedValue([]);
});

describe.each<RemindMeEntity>(['project', 'initiative', 'document'])(
  'Remind me on a %s',
  (entityType) => {
    it('lists the command and sets the reminder on that kind', async () => {
      setEntityReminder.mockResolvedValue(pending(entityType));
      const user = userEvent.setup();
      renderHost(entityType);

      await waitFor(() => {
        expect(labels()).toContain(`Remind me about this ${entityType}…`);
      });
      expect(labels()).not.toContain('Cancel reminder');
      await user.click(screen.getByRole('button', { name: 'Remind me…' }));
      expect(
        await screen.findByText(
          'Launch comes back to your inbox at the time you pick.'
        )
      ).toBeInTheDocument();
      await user.click(
        screen.getByRole('button', { name: /Tomorrow morning/ })
      );

      await waitFor(() => {
        expect(setEntityReminder).toHaveBeenCalledTimes(1);
      });
      const call = setEntityReminder.mock.calls[0] ?? [];
      expect(call.slice(0, 3)).toEqual(['ws-1', entityType, 'sub-1']);
      expect(new Date(call[3] as string).getTime()).toBeGreaterThan(Date.now());
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    });

    it('shows a pending reminder that reschedules and cancels', async () => {
      listEntityReminders.mockResolvedValue([pending(entityType)]);
      cancelEntityReminder.mockResolvedValue(undefined);
      const user = userEvent.setup();
      renderHost(entityType);

      expect(await screen.findByText(/Reminder set for/)).toBeInTheDocument();
      await waitFor(() => {
        expect(labels()).toContain('Cancel reminder');
      });
      await user.click(screen.getByRole('button', { name: 'Change' }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      await user.keyboard('{Escape}');
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      await user.click(
        screen.getByRole('button', { name: /^Cancel reminder$/ })
      );

      await waitFor(() => {
        expect(cancelEntityReminder).toHaveBeenCalledWith(
          'ws-1',
          entityType,
          'sub-1'
        );
      });
    });
  }
);

describe('Remind me keys', () => {
  it('binds H when the page asks for it', async () => {
    const user = userEvent.setup();
    renderHost('document', 'h');

    await keysBound('h');
    await user.keyboard('h');

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
