/**
 * The release contract the frontend depends on: every release route under its
 * team, a pipeline replaced whole with `PUT`, cursor paging on the list, and
 * issue references encoded into the removal path. Each is pinned because a
 * wrong path or verb type-checks identically and fails only against a live
 * backend.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addReleaseIssues,
  advanceRelease,
  createRelease,
  deleteRelease,
  getRelease,
  getReleasePipeline,
  issueReleasesPath,
  listIssueReleases,
  listReleases,
  releaseApiPath,
  releaseIssuePath,
  releaseIssuesPath,
  releasePipelinePath,
  releaseStagesPath,
  removeReleaseIssue,
  teamReleasesApiPath,
  updateRelease,
  updateReleasePipeline,
} from './releases';
import type { ReleaseDetailRead } from '../types/Api';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const post =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const put =
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
    put: (path: string, body?: unknown, options?: unknown) =>
      put(path, body, options),
    patch: (path: string, body?: unknown, options?: unknown) =>
      patch(path, body, options),
    delete: (path: string, options?: unknown) => del(path, options),
  },
}));

const WS = 'ws-mine';
const TEAM = 'team-1';
const REL = 'rel-1';

/** One release detail in the shape the backend serialises. */
const detail: ReleaseDetailRead = {
  release_id: REL,
  team_id: TEAM,
  workspace_id: WS,
  name: 'v1.2.0',
  version: '1.2.0',
  description: null,
  source: 'manual',
  repository_id: null,
  repository: 'WebbPulse/Standupless',
  sha: 'abcdef1234567890',
  previous_sha: null,
  url: null,
  issue_count: 1,
  stages: [],
  current_stage: null,
  created_by: 'user-1',
  created_at: '2026-10-07T10:00:00Z',
  updated_at: '2026-10-07T10:00:00Z',
  issues: [
    {
      issue_id: 'iss-1',
      key: 'ENG-1',
      title: 'Ship it',
      status_id: 'st-1',
      status_category: 'completed',
    },
  ],
  notes: 'ENG-1 Ship it',
  skipped_issues: [],
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
  patch.mockReset();
  del.mockReset();
});

describe('release paths', () => {
  it('files every release route under its team', () => {
    expect(releasePipelinePath(WS, TEAM)).toBe(
      '/workspaces/ws-mine/teams/team-1/release-pipeline'
    );
    expect(teamReleasesApiPath(WS, TEAM)).toBe(
      '/workspaces/ws-mine/teams/team-1/releases'
    );
    expect(releaseApiPath(WS, TEAM, REL)).toBe(
      '/workspaces/ws-mine/teams/team-1/releases/rel-1'
    );
    expect(releaseStagesPath(WS, TEAM, REL)).toBe(
      '/workspaces/ws-mine/teams/team-1/releases/rel-1/stages'
    );
    expect(releaseIssuesPath(WS, TEAM, REL)).toBe(
      '/workspaces/ws-mine/teams/team-1/releases/rel-1/issues'
    );
    expect(issueReleasesPath(WS, 'iss-1')).toBe(
      '/workspaces/ws-mine/issues/iss-1/releases'
    );
  });

  it('encodes the issue reference it removes', () => {
    expect(releaseIssuePath(WS, TEAM, REL, 'ENG 1/x')).toBe(
      '/workspaces/ws-mine/teams/team-1/releases/rel-1/issues/ENG%201%2Fx'
    );
  });
});

describe('release pipeline', () => {
  it('reads the pipeline and defaults a missing stage list', async () => {
    get.mockResolvedValue({ data: { team_id: TEAM, configured: false } });
    const pipeline = await getReleasePipeline(WS, TEAM);
    expect(get).toHaveBeenCalledWith(releasePipelinePath(WS, TEAM), {});
    expect(pipeline).toEqual({ team_id: TEAM, configured: false, stages: [] });
  });

  it('replaces the pipeline with a PUT', async () => {
    const body = {
      stages: [
        { stage_id: 'stg-1', name: 'Staging', github_environments: ['stg'] },
        { name: 'Production', github_environments: [] },
      ],
    };
    put.mockResolvedValue({
      data: { team_id: TEAM, configured: true, stages: [] },
    });
    await updateReleasePipeline(WS, TEAM, body);
    expect(put).toHaveBeenCalledWith(
      releasePipelinePath(WS, TEAM),
      body,
      undefined
    );
  });
});

describe('releases', () => {
  it('pages the list with a cursor and normalises the body', async () => {
    get.mockResolvedValue({ data: { releases: null } });
    const page = await listReleases(WS, TEAM, { cursor: 'c1', limit: 50 });
    expect(get).toHaveBeenCalledWith(teamReleasesApiPath(WS, TEAM), {
      query: { cursor: 'c1', limit: 50 },
    });
    expect(page).toEqual({ releases: [], next_cursor: null });
  });

  it('creates a release and keeps the skipped references', async () => {
    post.mockResolvedValue({
      data: { ...detail, skipped_issues: ['NOPE-9'] },
    });
    const body = { name: 'v1.2.0', issues: ['ENG-1', 'NOPE-9'] };
    const created = await createRelease(WS, TEAM, body);
    expect(post).toHaveBeenCalledWith(
      teamReleasesApiPath(WS, TEAM),
      body,
      undefined
    );
    expect(created.skipped_issues).toEqual(['NOPE-9']);
  });

  it('reads one release and defaults the optional lists', async () => {
    get.mockResolvedValue({
      data: { ...detail, issues: undefined, skipped_issues: undefined },
    });
    const release = await getRelease(WS, TEAM, REL);
    expect(get).toHaveBeenCalledWith(releaseApiPath(WS, TEAM, REL), {});
    expect(release.issues).toEqual([]);
    expect(release.skipped_issues).toEqual([]);
  });

  it('patches the fields named, sending null to clear', async () => {
    patch.mockResolvedValue({ data: detail });
    await updateRelease(WS, TEAM, REL, { version: null, name: 'Renamed' });
    expect(patch).toHaveBeenCalledWith(
      releaseApiPath(WS, TEAM, REL),
      { version: null, name: 'Renamed' },
      undefined
    );
  });

  it('deletes a release', async () => {
    del.mockResolvedValue({ data: undefined });
    await deleteRelease(WS, TEAM, REL);
    expect(del).toHaveBeenCalledWith(releaseApiPath(WS, TEAM, REL), undefined);
  });

  it('advances a release to a stage', async () => {
    post.mockResolvedValue({ data: detail });
    await advanceRelease(WS, TEAM, REL, { stage: 'stg-2' });
    expect(post).toHaveBeenCalledWith(
      releaseStagesPath(WS, TEAM, REL),
      { stage: 'stg-2' },
      undefined
    );
  });

  it('adds issues by reference', async () => {
    post.mockResolvedValue({ data: detail });
    await addReleaseIssues(WS, TEAM, REL, ['ENG-1', 'ENG-2']);
    expect(post).toHaveBeenCalledWith(
      releaseIssuesPath(WS, TEAM, REL),
      { issues: ['ENG-1', 'ENG-2'] },
      undefined
    );
  });

  it('removes one issue and returns the release', async () => {
    del.mockResolvedValue({ data: { ...detail, issues: [] } });
    const release = await removeReleaseIssue(WS, TEAM, REL, 'ENG-1');
    expect(del).toHaveBeenCalledWith(
      releaseIssuePath(WS, TEAM, REL, 'ENG-1'),
      undefined
    );
    expect(release.issues).toEqual([]);
  });
});

describe('issue releases', () => {
  it('reads the releases one issue shipped in', async () => {
    get.mockResolvedValue({ data: {} });
    const list = await listIssueReleases(WS, 'iss-1');
    expect(get).toHaveBeenCalledWith(issueReleasesPath(WS, 'iss-1'), {});
    expect(list).toEqual({ releases: [] });
  });
});
