/**
 * The glyph a group of projects is headed with: the status, health or
 * priority glyph, the initiative mark, the team key, the lead's or member's
 * avatar, a label's colour dot or a calendar for a date period, matching
 * what the group is by. Shared by the projects list, its board and
 * the roadmap so their group headers read alike.
 */

import React from 'react';
import { LuCalendar, LuGoal } from 'react-icons/lu';
import { useProjectStatuses } from '../../hooks/useProjectStatuses';
import { groupValue, type ProjectGroup } from '../../lib/projectList';
import type {
  IssuePriority,
  ProjectHealth,
  ProjectStatus,
  TeamRead,
} from '../../types/Api';
import Avatar from '../ui/avatar';
import { PriorityGlyph } from '../ui/glyphs';
import ProjectHealthGlyph from './ProjectHealthGlyph';
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
  const value = groupValue(group);
  const { byId } = useProjectStatuses();
  switch (group.kind) {
    case 'status': {
      const status = byId.get(value);
      return (
        <ProjectStatusGlyph
          status={
            group.category ?? status?.category ?? (value as ProjectStatus)
          }
          color={status?.color ?? null}
        />
      );
    }
    case 'health':
      return (
        <ProjectHealthGlyph
          health={value === 'none' ? null : (value as ProjectHealth)}
        />
      );
    case 'priority':
      return <PriorityGlyph priority={value as IssuePriority} />;
    case 'initiative':
      return (
        <LuGoal
          aria-hidden="true"
          className={
            value === 'none'
              ? 'h-3.5 w-3.5 shrink-0 text-text-faint'
              : 'h-3.5 w-3.5 shrink-0 text-text-muted'
          }
        />
      );
    case 'team': {
      const team = teams.find((item) => item.id === value);
      return team === undefined ? null : (
        <TeamKey keyPrefix={team.key_prefix} />
      );
    }
    case 'lead':
    case 'member':
      return value === 'none' ? null : <Avatar name={group.label} size="xs" />;
    case 'label':
      return value === 'none' ? null : (
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full bg-text-faint"
          style={
            group.color === undefined
              ? undefined
              : { backgroundColor: group.color }
          }
        />
      );
    case 'start_date':
    case 'target_date':
      return (
        <LuCalendar
          aria-hidden="true"
          className={
            value === 'none'
              ? 'h-3.5 w-3.5 shrink-0 text-text-faint'
              : 'h-3.5 w-3.5 shrink-0 text-text-muted'
          }
        />
      );
    case 'none':
      return null;
  }
};

export default ProjectGroupGlyph;
