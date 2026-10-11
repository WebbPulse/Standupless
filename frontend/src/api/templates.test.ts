/**
 * The issue template contract the frontend depends on: the team and workspace
 * paths, the verbs, the default's own settings route, and a list answer that
 * always carries its arrays. Each is pinned because a wrong path or verb
 * type-checks identically and fails only against a live backend.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTeamTemplate,
  createWorkspaceTemplate,
  deleteTeamTemplate,
  deleteWorkspaceTemplate,
  getTemplateSettings,
  listTeamTemplates,
  listWorkspaceTemplates,
  updateTeamTemplate,
  updateTemplateSettings,
  updateWorkspaceTemplate,
} from './templates';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const post =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const patch =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const del = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
    post: (path: string, body?: unknown, options?: unknown) =>
      post(path, body, options),
    patch: (path: string, body?: unknown, options?: unknown) =>
      patch(path, body, options),
    delete: (path: string, options?: unknown) => del(path, options),
  },
}));

const WS = 'ws-1';
const TEAM = 'team-1';

const template = {
  id: 'tp-1',
  name: 'Bug report',
  team_id: TEAM,
  scope: 'team',
  title: 'Bug: ',
  body: null,
  status_id: null,
  priority: 'high',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  project_id: null,
  project_milestone_id: null,
  cycle_id: null,
  position: 0,
  created_by: 'u-1',
  created_at: '2026-10-10T00:00:00Z',
  updated_at: '2026-10-10T00:00:00Z',
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  del.mockReset();
});

describe('team templates', () => {
  it('lists the templates of a team with its default', async () => {
    get.mockResolvedValue({
      data: { templates: [template], default_template_id: 'tp-1' },
    });
    const answer = await listTeamTemplates(WS, TEAM);
    expect(get).toHaveBeenCalledWith(
      '/workspaces/ws-1/teams/team-1/templates',
      undefined
    );
    expect(answer.default_template_id).toBe('tp-1');
    expect(answer.templates).toHaveLength(1);
  });

  it('answers empty arrays when the body is missing them', async () => {
    get.mockResolvedValue({ data: {} });
    expect(await listTeamTemplates(WS, TEAM)).toEqual({
      templates: [],
      default_template_id: null,
    });
  });

  it('creates, patches and deletes under the team', async () => {
    post.mockResolvedValue({ data: template });
    patch.mockResolvedValue({ data: template });
    del.mockResolvedValue({ data: undefined });
    await createTeamTemplate(WS, TEAM, { name: 'Bug report' });
    await updateTeamTemplate(WS, TEAM, 'tp-1', { position: 2 });
    await deleteTeamTemplate(WS, TEAM, 'tp-1');
    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-1/teams/team-1/templates',
      { name: 'Bug report' },
      undefined
    );
    expect(patch).toHaveBeenCalledWith(
      '/workspaces/ws-1/teams/team-1/templates/tp-1',
      { position: 2 },
      undefined
    );
    expect(del).toHaveBeenCalledWith(
      '/workspaces/ws-1/teams/team-1/templates/tp-1',
      undefined
    );
  });

  it('reads and sets the default on the settings route', async () => {
    const settings = {
      team_id: TEAM,
      default_template_id: 'tp-1',
      effective_default_template_id: 'tp-1',
    };
    get.mockResolvedValue({ data: settings });
    patch.mockResolvedValue({ data: settings });
    await getTemplateSettings(WS, TEAM);
    await updateTemplateSettings(WS, TEAM, { default_template_id: null });
    expect(get).toHaveBeenCalledWith(
      '/workspaces/ws-1/teams/team-1/template-settings',
      undefined
    );
    expect(patch).toHaveBeenCalledWith(
      '/workspaces/ws-1/teams/team-1/template-settings',
      { default_template_id: null },
      undefined
    );
  });
});

describe('workspace templates', () => {
  it('lists, creates, patches and deletes on the workspace', async () => {
    get.mockResolvedValue({ data: { templates: [] } });
    post.mockResolvedValue({ data: template });
    patch.mockResolvedValue({ data: template });
    del.mockResolvedValue({ data: undefined });
    await listWorkspaceTemplates(WS);
    await createWorkspaceTemplate(WS, { name: 'Spike' });
    await updateWorkspaceTemplate(WS, 'tp-2', { name: 'Research' });
    await deleteWorkspaceTemplate(WS, 'tp-2');
    expect(get).toHaveBeenCalledWith('/workspaces/ws-1/templates', undefined);
    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-1/templates',
      { name: 'Spike' },
      undefined
    );
    expect(patch).toHaveBeenCalledWith(
      '/workspaces/ws-1/templates/tp-2',
      { name: 'Research' },
      undefined
    );
    expect(del).toHaveBeenCalledWith(
      '/workspaces/ws-1/templates/tp-2',
      undefined
    );
  });
});
