/**
 * Milestones for a list outside a project's own page. Only a project's list
 * carries its milestones in the issue context, so a list elsewhere that needs
 * their names, for a filter or for the milestone property, reads them from
 * each project it knows. Reads are shared for a short window, so a filter
 * picker and the rows asking at once cost one request per project.
 */

import { useEffect, useMemo, useState } from 'react';
import { listMilestones } from '../api/planning';
import type { IssueContext } from '../lib/issueView';
import type { MilestoneRead, ProjectRead } from '../types/Api';

/** How long a project's milestones stay fresh once read. */
const MILESTONE_READ_TTL_MS = 60000;

/** The most projects a list outside a project reads the milestones of. */
export const MILESTONE_PROJECT_LIMIT = 50;

const milestoneReads = new Map<
  string,
  { at: number; read: Promise<MilestoneRead[]> }
>();

/** One project's milestones, shared by every reader within the freshness window. */
export const readMilestones = (
  project: ProjectRead
): Promise<MilestoneRead[]> => {
  const key = `${project.workspace_id}/${project.project_id}`;
  const held = milestoneReads.get(key);
  if (held !== undefined && Date.now() - held.at < MILESTONE_READ_TTL_MS) {
    return held.read;
  }
  const read = listMilestones(project.workspace_id, project.project_id).catch(
    () => {
      milestoneReads.delete(key);
      return [];
    }
  );
  milestoneReads.set(key, { at: Date.now(), read });
  return read;
};

/**
 * The context with milestones filled in when `wanted` and the context has
 * none of its own, and the context as it is otherwise.
 */
export const useMilestoneContext = <T extends IssueContext>(
  context: T,
  wanted: boolean
): T => {
  const needed = wanted && context.milestones === undefined;
  const [loaded, setLoaded] = useState<MilestoneRead[]>([]);
  useEffect(() => {
    if (!needed) return undefined;
    let live = true;
    void Promise.all(
      context.projects.slice(0, MILESTONE_PROJECT_LIMIT).map(readMilestones)
    ).then((lists) => {
      if (live) setLoaded(lists.flat());
    });
    return () => {
      live = false;
    };
  }, [needed, context.projects]);
  return useMemo(
    () => (needed ? { ...context, milestones: loaded } : context),
    [needed, context, loaded]
  );
};
