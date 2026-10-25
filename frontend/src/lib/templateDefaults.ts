/**
 * Which default issue template a team's create dialog opens with for the
 * caller: a team keeps one for its members and one for people outside it.
 */

import type { TemplateListRead } from '../types/Api';

/**
 * The template a team's create dialog opens with for this caller: the
 * non-member default when they are outside the team, else the members' one.
 * `isMember` unknown reads as a member.
 */
export const openingTemplateId = (
  list:
    | Pick<
        TemplateListRead,
        'default_template_id' | 'non_member_default_template_id'
      >
    | null
    | undefined,
  isMember: boolean | undefined
): string | null => {
  if (list === null || list === undefined) return null;
  if (isMember === false) {
    return list.non_member_default_template_id ?? list.default_template_id;
  }
  return list.default_template_id;
};
