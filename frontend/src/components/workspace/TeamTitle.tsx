/**
 * A team's name with its key prefix beside it, for the page header. The prefix
 * is shown because it is what a person types when they search for an issue, so
 * seeing it next to the name is how they learn the two go together.
 */

import React from 'react';

/** Props for TeamTitle: the name and the key prefix beside it. */
export interface TeamTitleProps {
  name: string;
  keyPrefix: string;
}

/** The team name with its mono key prefix, for the shell's title. */
export const TeamTitle: React.FC<TeamTitleProps> = ({ name, keyPrefix }) => (
  <span className="flex items-baseline gap-2">
    <span>{name}</span>
    <span className="font-mono text-xs font-normal text-text-faint">
      {keyPrefix}
    </span>
  </span>
);

export default TeamTitle;
