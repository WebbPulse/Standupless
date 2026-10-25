/**
 * The issue templates section's two defaults. Covers the non-member picker
 * reading what the team saved, offering the members' default as its fallback,
 * and saving a pick on its own field.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TemplateListRead,
  TemplateRead,
  TemplateSettingsRead,
  TemplateSettingsUpdate,
} from '../../types/Api';
import TemplatesSection from './TemplatesSection';

const listTeamTemplates = vi.fn<() => Promise<TemplateListRead>>();
const getTemplateSettings = vi.fn<() => Promise<TemplateSettingsRead>>();
const updateTemplateSettings =
  vi.fn<(body: TemplateSettingsUpdate) => Promise<TemplateSettingsRead>>();

vi.mock('../../api/templates', () => ({
  listTeamTemplates: () => listTeamTemplates(),
  getTemplateSettings: () => getTemplateSettings(),
  updateTemplateSettings: (
    _w: string,
    _t: string,
    body: TemplateSettingsUpdate
  ) => updateTemplateSettings(body),
  createTeamTemplate: vi.fn(),
  updateTeamTemplate: vi.fn(),
  deleteTeamTemplate: vi.fn(),
}));

vi.mock('../../hooks/useTeamOptions', () => ({
  useTeamOptions: () => ({
    statuses: [],
    labels: [],
    people: [],
    projects: [],
    cycles: [],
  }),
}));

vi.mock('../templates/TemplateEditor', () => ({
  default: () => null,
}));

vi.mock('./ProjectTemplatesSection', () => ({ default: () => null }));

vi.mock('./DocumentTemplatesSection', () => ({ default: () => null }));

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

/** A team template with nothing filled but its name. */
const template = (id: string, name: string): TemplateRead => ({
  id,
  name,
  team_id: 'team-1',
  scope: 'team',
  title: null,
  body: null,
  status_id: null,
  priority: null,
  assignee_id: null,
  label_ids: [],
  estimate: null,
  project_id: null,
  project_milestone_id: null,
  cycle_id: null,
  position: 0,
  created_by: 'user-1',
  created_at: '2026-10-25T00:00:00Z',
  updated_at: '2026-10-25T00:00:00Z',
});

/** Template settings in the contract's shape, the members' default set. */
const settings = (
  over: Partial<TemplateSettingsRead> = {}
): TemplateSettingsRead => ({
  team_id: 'team-1',
  default_template_id: 'tp-1',
  effective_default_template_id: 'tp-1',
  non_member_default_template_id: null,
  effective_non_member_default_template_id: 'tp-1',
  ...over,
});

const renderSection = (canSetDefault = true) =>
  render(
    <TemplatesSection
      workspaceId="ws-1"
      teamId="team-1"
      estimateScale="off"
      canEdit
      canSetDefault={canSetDefault}
    />
  );

beforeEach(() => {
  listTeamTemplates.mockReset();
  getTemplateSettings.mockReset();
  updateTemplateSettings.mockReset();
  listTeamTemplates.mockResolvedValue({
    templates: [template('tp-1', 'Bug'), template('tp-2', 'Request')],
    default_template_id: 'tp-1',
    non_member_default_template_id: 'tp-1',
  });
  getTemplateSettings.mockResolvedValue(settings());
  updateTemplateSettings.mockImplementation((body) =>
    Promise.resolve(
      settings({
        non_member_default_template_id:
          body.non_member_default_template_id ?? null,
      })
    )
  );
});

describe('the default template for non-members', () => {
  it('falls back to the members default until one is picked', async () => {
    renderSection();

    const select = await screen.findByLabelText(
      'Default template for non-members'
    );
    expect(select).toHaveValue('');
    await waitFor(() => {
      expect(
        screen.getByRole('option', { name: 'Same as members (Bug)' })
      ).toBeInTheDocument();
    });
  });

  it('saves a pick on its own field', async () => {
    const user = userEvent.setup();
    renderSection();

    const select = await screen.findByLabelText(
      'Default template for non-members'
    );
    await user.selectOptions(select, 'tp-2');

    await waitFor(() => {
      expect(updateTemplateSettings).toHaveBeenCalledWith({
        non_member_default_template_id: 'tp-2',
      });
    });
  });

  it('shows what the team saved', async () => {
    getTemplateSettings.mockResolvedValue(
      settings({
        non_member_default_template_id: 'tp-2',
        effective_non_member_default_template_id: 'tp-2',
      })
    );
    renderSection();

    const select = await screen.findByLabelText(
      'Default template for non-members'
    );
    await waitFor(() => {
      expect(select).toHaveValue('tp-2');
    });
  });

  it('is read only without the team admin role', async () => {
    renderSection(false);

    expect(
      await screen.findByLabelText('Default template for non-members')
    ).toBeDisabled();
  });
});
