/**
 * The menu an initiative row opens on a right click, from its more button or
 * from Shift F10 on the focused row: open the initiative, copy its link,
 * change any of its properties, star it and delete it. A property item hands
 * its field back to the list, which opens that row's own picker, so the menu,
 * the keys and a click share one picker and one save path.
 */

import React from 'react';
import {
  LuActivity,
  LuArrowUpRight,
  LuCalendar,
  LuCalendarCheck,
  LuCircleDashed,
  LuLink,
  LuStar,
  LuStarOff,
  LuTrash2,
  LuUserRound,
} from 'react-icons/lu';
import { copyText } from '../../lib/copyIssue';
import { initiativePath } from '../../lib/paths';
import type { InitiativeRead } from '../../types/Api';
import { FAVORITE_SHORTCUT } from '../ui/FavoriteButton';
import { ContextMenu, MenuItem, MenuSeparator, MenuShortcut } from '../ui/menu';
import { INITIATIVE_PROPERTY_KEYS } from './ProjectPropertyKeys';

/** The keys that delete the focused initiative from the list. */
export const DELETE_INITIATIVE_KEYS = 'mod+backspace';

/** The icon each property item draws, by the field its picker is named for. */
const PROPERTY_ICONS: Record<string, React.ReactNode> = {
  Status: <LuCircleDashed aria-hidden="true" className="h-3.5 w-3.5" />,
  Owner: <LuUserRound aria-hidden="true" className="h-3.5 w-3.5" />,
  Health: <LuActivity aria-hidden="true" className="h-3.5 w-3.5" />,
  'Start date': <LuCalendar aria-hidden="true" className="h-3.5 w-3.5" />,
  'Target date': <LuCalendarCheck aria-hidden="true" className="h-3.5 w-3.5" />,
};

/** Props for InitiativeRowMenu: the initiative, where it opens and what it may do. */
export interface InitiativeRowMenuProps {
  initiative: InitiativeRead;
  slug: string;
  x: number;
  y: number;
  /** Whether the viewer may change the initiative, which offers the property items. */
  editable: boolean;
  /** Whether the viewer may delete the initiative, which offers the delete item. */
  deletable: boolean;
  /** Whether the viewer has the initiative in their favorites. */
  favorite: boolean;
  /** Opens the row's picker for one field, named as the picker names it. */
  onEdit: (field: string) => void;
  onToggleFavorite: () => void;
  /** Asks to delete the initiative, which the list confirms first. */
  onDelete: () => void;
  onClose: () => void;
}

/** The context menu of one initiative row. */
export const InitiativeRowMenu: React.FC<InitiativeRowMenuProps> = ({
  initiative,
  slug,
  x,
  y,
  editable,
  deletable,
  favorite,
  onEdit,
  onToggleFavorite,
  onDelete,
  onClose,
}) => {
  const path = initiativePath(slug, initiative);
  return (
    <ContextMenu
      x={x}
      y={y}
      label={`${initiative.name} actions`}
      onClose={onClose}
    >
      <MenuItem to={path}>
        <LuArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
        Open initiative
        <MenuShortcut keys="enter" />
      </MenuItem>
      <MenuItem
        onSelect={() => {
          copyText(
            new URL(path, globalThis.location.origin).toString(),
            'Link to the initiative copied'
          );
        }}
      >
        <LuLink aria-hidden="true" className="h-3.5 w-3.5" />
        Copy link
      </MenuItem>
      {editable && (
        <>
          <MenuSeparator />
          {INITIATIVE_PROPERTY_KEYS.map((property) => (
            <MenuItem
              key={property.field}
              onSelect={() => {
                onEdit(property.field);
              }}
            >
              {PROPERTY_ICONS[property.field]}
              {property.label}
              <MenuShortcut keys={property.keys} />
            </MenuItem>
          ))}
        </>
      )}
      <MenuSeparator />
      <MenuItem onSelect={onToggleFavorite}>
        {favorite ? (
          <LuStarOff aria-hidden="true" className="h-3.5 w-3.5" />
        ) : (
          <LuStar aria-hidden="true" className="h-3.5 w-3.5" />
        )}
        {favorite ? 'Remove from favorites' : 'Add to favorites'}
        <MenuShortcut keys={FAVORITE_SHORTCUT} />
      </MenuItem>
      {deletable && (
        <>
          <MenuSeparator />
          <MenuItem danger onSelect={onDelete}>
            <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
            Delete
            <MenuShortcut keys={DELETE_INITIATIVE_KEYS} />
          </MenuItem>
        </>
      )}
    </ContextMenu>
  );
};

export default InitiativeRowMenu;
