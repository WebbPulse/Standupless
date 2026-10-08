/**
 * The triage section. Covers that flipping the switch saves at once, that a
 * plan without triage locks the switch while off and links to the plans, and
 * that after a downgrade an admin can still turn triage off.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriageSettingsRead, TriageSettingsUpdate } from '../../types/Api';
import TriageSection from './TriageSection';

const getTriageSettings = vi.fn<() => Promise<TriageSettingsRead>>();
const updateTriageSettings =
  vi.fn<(body: TriageSettingsUpdate) => Promise<TriageSettingsRead>>();

vi.mock('../../api/triage', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/triage')>(
      '../../api/triage'
    );
  return {
    ...actual,
    getTriageSettings: () => getTriageSettings(),
    updateTriageSettings: (
      _w: string,
      _t: string,
      body: TriageSettingsUpdate
    ) => updateTriageSettings(body),
  };
});

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

/** A triage setting in the shape the contract answers with. */
const setting = (enabled: boolean): TriageSettingsRead => ({
  team_id: 'team-1',
  enabled,
  updated_at: null,
});

/** Renders the section inside a router, on or off the plan. */
const renderSection = (planIncluded: boolean) =>
  render(
    <MemoryRouter>
      <TriageSection
        workspaceId="ws-1"
        teamId="team-1"
        canEdit={true}
        planIncluded={planIncluded}
        slug="acme"
      />
    </MemoryRouter>
  );

beforeEach(() => {
  getTriageSettings.mockReset();
  updateTriageSettings.mockReset();
  getTriageSettings.mockResolvedValue(setting(false));
  updateTriageSettings.mockImplementation((body) =>
    Promise.resolve(setting(body.enabled ?? false))
  );
});

describe('TriageSection', () => {
  it('on a plan with triage turns it on at once', async () => {
    const user = userEvent.setup();
    renderSection(true);

    const toggle = await screen.findByRole('switch', {
      name: 'Use a triage inbox',
    });
    expect(screen.queryByText(/needs the Standard plan/)).toBeNull();
    await user.click(toggle);

    await waitFor(() => {
      expect(updateTriageSettings).toHaveBeenCalledWith({ enabled: true });
    });
  });

  it('on a plan without triage locks the switch and links to the plans', async () => {
    renderSection(false);

    const toggle = await screen.findByRole('switch', {
      name: 'Use a triage inbox',
    });
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText(/Triage needs the Standard plan/)
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View plans' })).toHaveAttribute(
      'href',
      '/w/acme/settings/billing'
    );
  });

  it('after a downgrade still lets an admin turn triage off', async () => {
    getTriageSettings.mockResolvedValue(setting(true));
    const user = userEvent.setup();
    renderSection(false);

    const toggle = await screen.findByRole('switch', {
      name: 'Use a triage inbox',
    });
    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });
    expect(toggle).toBeEnabled();
    await user.click(toggle);

    await waitFor(() => {
      expect(updateTriageSettings).toHaveBeenCalledWith({ enabled: false });
    });
  });
});
