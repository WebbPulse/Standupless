/**
 * The menu a project card opens on a right click or from its hover button:
 * open the project, copy its link, and change any of its properties. A
 * property item hands its field back to the board, which opens that card's
 * own picker, so the menu and the card share one picker and one save path.
 */

import React from 'react';
import { LuArrowUpRight, LuLink } from 'react-icons/lu';
import { ContextMenu, MenuItem, MenuSeparator } from '../ui/menu';
import { copyText } from '../../lib/copyIssue';
import { projectPath } from '../../lib/paths';
import type { ProjectRead } from '../../types/Api';
import { PROJECT_PROPERTY_KEYS } from './ProjectPropertyKeys';

/** Props for ProjectCardMenu: the project, where it opens and what it may do. */
export interface ProjectCardMenuProps {
  project: ProjectRead;
  slug: string;
  x: number;
  y: number;
  /** Whether the viewer may change the project, which offers the property items. */
  editable: boolean;
  /** Opens the card's picker for one field, named as the picker names it. */
  onEdit: (field: string) => void;
  onClose: () => void;
}

/** The context menu of one project card. */
export const ProjectCardMenu: React.FC<ProjectCardMenuProps> = ({
  project,
  slug,
  x,
  y,
  editable,
  onEdit,
  onClose,
}) => {
  const path = projectPath(slug, project);
  return (
    <ContextMenu
      x={x}
      y={y}
      label={`${project.name} actions`}
      onClose={onClose}
    >
      <MenuItem to={path}>
        <LuArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
        Open project
      </MenuItem>
      <MenuItem
        onSelect={() => {
          copyText(
            new URL(path, globalThis.location.origin).toString(),
            'Link to the project copied'
          );
        }}
      >
        <LuLink aria-hidden="true" className="h-3.5 w-3.5" />
        Copy link
      </MenuItem>
      {editable && (
        <>
          <MenuSeparator />
          {PROJECT_PROPERTY_KEYS.map((property) => (
            <MenuItem
              key={property.field}
              onSelect={() => {
                onEdit(property.field);
              }}
            >
              {property.label}
            </MenuItem>
          ))}
        </>
      )}
    </ContextMenu>
  );
};

export default ProjectCardMenu;
