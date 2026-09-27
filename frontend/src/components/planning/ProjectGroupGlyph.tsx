/**
 * The glyph a group of projects is headed with: the status glyph, the team
 * key or the lead's avatar, matching what the group is by. Shared by the
 * projects list and the roadmap so their group headers read alike.
 */

import React from 'react';
import type { ProjectGroup } from '../../lib/projectList';
import type { ProjectStatus, TeamRead } from '../../types/Api';
import Avatar from '../ui/avatar';
import { TeamKey } from './ProjectPickers';
import ProjectStatusGlyph from './ProjectStatusGlyph';

/** Props for ProjectGroupGlyph: the group and the teams it may name. */
export interface ProjectGroupGlyphProps {
  group: ProjectGroup;
  teams: TeamRead[];
}

/** The leading glyph of one project group header. */
export const ProjectGroupGlyph: React.FC<ProjectGroupGlyphProps> = ({
  group,
  teams,
}) => {
  if (group.kind === 'status') {
    const status = group.key.slice('status:'.length) as ProjectStatus;
    return <ProjectStatusGlyph status={status} />;
  }
  if (group.kind === 'team') {
    const team = teams.find((item) => `team:${item.id}` === group.key);
    return team === undefined ? null : <TeamKey keyPrefix={team.key_prefix} />;
  }
  if (group.kind === 'lead') return <Avatar name={group.label} size="xs" />;
  return null;
};

export default ProjectGroupGlyph;
