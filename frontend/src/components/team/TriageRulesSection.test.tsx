/**
 * The triage rules list. Covers that a new rule saves with its filter and
 * actions appended to the list, that reordering, switching off and deleting
 * each send the whole list as it now stands, that a rule whose target was
 * deleted shows its warning, and that a move rule cannot continue.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LabelRead,
  TeamRead,
  TriageRuleBody,
  TriageRuleRead,
} from '../../types/Api';
import TriageRulesSection, { type RulePerson } from './TriageRulesSection';

const LABELS: LabelRead[] = [
  { id: 'l-bug', name: 'Bug', color: '#ff0000' },
  { id: 'l-ios', name: 'iOS', color: '#00ff00' },
];

vi.mock('../../api/teams', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/teams')>('../../api/teams');
  return {
    ...actual,
    listLabels: () => Promise.resolve(LABELS),
  };
});

vi.mock('../../api/planning', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/planning')>(
      '../../api/planning'
    );
  return {
    ...actual,
    listProjects: () => Promise.resolve({ projects: [], next_cursor: null }),
  };
});

vi.mock('../../hooks/useTeams', () => ({
  useTeamsFor: (workspaceId: string) => ({
    data: [
      { id: 'team-1', name: 'Product' },
      { id: 'team-2', name: 'Infra' },
    ] as TeamRead[],
    isLoading: false,
    error: null,
    refetch: () => Promise.resolve(),
    workspaceId,
  }),
}));

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

const PEOPLE: RulePerson[] = [
  { user_id: 'u-ada', email: 'ada@example.com', display_name: 'ada' },
];

const onSave =
  vi.fn<(rules: TriageRuleBody[], done: string) => Promise<void>>();

/** A saved rule in the shape the contract answers with. */
const rule = (
  ruleId: string,
  name: string,
  extra: Partial<TriageRuleRead> = {}
): TriageRuleRead => ({
  rule_id: ruleId,
  name,
  enabled: true,
  continue_after: false,
  filter: { label_ids: [], priorities: [], creator_ids: [], sources: [] },
  actions: { add_label_ids: [], priority: 'high' },
  warning: null,
  ...extra,
});

/** Renders the list with `rules` saved. */
const renderRules = (rules: TriageRuleRead[]) =>
  render(
    <MemoryRouter>
      <TriageRulesSection
        workspaceId="ws-1"
        teamId="team-1"
        canEdit={true}
        rules={rules}
        assignees={PEOPLE}
        creators={PEOPLE}
        saving={false}
        onSave={onSave}
      />
    </MemoryRouter>
  );

/** The rule ids a save sent, in order. */
const savedIds = (): (string | null | undefined)[] =>
  (onSave.mock.calls.at(-1)?.[0] ?? []).map((row) => row.rule_id);

beforeEach(() => {
  onSave.mockReset();
  onSave.mockResolvedValue(undefined);
});

describe('TriageRulesSection', () => {
  it('adds a rule with its filter and actions to the end of the list', async () => {
    const user = userEvent.setup();
    renderRules([rule('r-1', 'First')]);

    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Crashes');
    await user.type(
      within(dialog).getByLabelText('Title or description contains'),
      'crash'
    );
    const bug = await within(dialog).findAllByRole('checkbox', {
      name: 'Bug',
    });
    await user.click(bug[1]);
    await user.selectOptions(
      within(dialog).getByLabelText('Set priority'),
      'urgent'
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save rule' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    const [rules, done] = onSave.mock.calls[0];
    expect(done).toBe('Triage rule saved.');
    expect(rules[0].rule_id).toBe('r-1');
    expect(rules[1]).toMatchObject({
      rule_id: null,
      name: 'Crashes',
      continue_after: false,
      filter: { text: 'crash', label_ids: [] },
      actions: {
        add_label_ids: ['l-bug'],
        priority: 'urgent',
        team_id: null,
      },
    });
  });

  it('keeps Save off until the rule has a name and an action', async () => {
    const user = userEvent.setup();
    renderRules([]);

    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog');
    const saveButton = within(dialog).getByRole('button', {
      name: 'Save rule',
    });
    await user.type(within(dialog).getByLabelText('Name'), 'Anything');
    expect(saveButton).toBeDisabled();
    await user.selectOptions(
      within(dialog).getByLabelText('Assign to'),
      'u-ada'
    );
    expect(saveButton).toBeEnabled();
  });

  it('turns off continuing for a rule that moves the issue', async () => {
    const user = userEvent.setup();
    renderRules([]);

    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(
      within(dialog).getByLabelText('Move to team'),
      'team-2'
    );

    expect(
      within(dialog).getByRole('checkbox', {
        name: 'Keep running later rules after this one applies',
      })
    ).toBeDisabled();
    expect(
      within(dialog).queryByRole('option', { name: 'Product' })
    ).toBeNull();
  });

  it('moves a rule down', async () => {
    const user = userEvent.setup();
    renderRules([rule('r-1', 'First'), rule('r-2', 'Second')]);

    await user.click(screen.getByRole('button', { name: 'Move First down' }));

    await waitFor(() => {
      expect(savedIds()).toEqual(['r-2', 'r-1']);
    });
  });

  it('switches a rule off', async () => {
    const user = userEvent.setup();
    renderRules([rule('r-1', 'First')]);

    await user.click(screen.getByRole('button', { name: 'Turn off First' }));

    await waitFor(() => {
      expect(onSave.mock.calls.at(-1)?.[0][0].enabled).toBe(false);
    });
  });

  it('deletes a rule after confirming', async () => {
    const user = userEvent.setup();
    renderRules([rule('r-1', 'First'), rule('r-2', 'Second')]);

    await user.click(screen.getByRole('button', { name: 'Delete First' }));
    const confirm = screen.getByRole('alertdialog', {
      name: 'Delete the First rule?',
    });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(savedIds()).toEqual(['r-2']);
    });
  });

  it('shows why a rule whose target was deleted is off', () => {
    renderRules([
      rule('r-1', 'Broken', {
        enabled: false,
        warning: 'The team this rule moves issues to was deleted',
      }),
    ]);

    expect(
      screen.getByText(/The team this rule moves issues to was deleted/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on Broken' })).toBeNull();
  });
});
