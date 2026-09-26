/**
 * One team's board: the team's issues in columns, dragged between them to
 * change the grouped property and within them to set a manual order.
 */

import React from 'react';
import TeamIssuesPage from '../../components/issues/view/TeamIssuesPage';

/** The board for the team named by the route's key prefix. */
export const Board: React.FC = () => <TeamIssuesPage layout="board" />;

export default Board;
