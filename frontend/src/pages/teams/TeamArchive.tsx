/**
 * One team's archive: its archived issues and nothing else, the way Linear's
 * archive view lists them. A restore from here takes the issue off the page
 * and back to the team's lists and board.
 */

import React from 'react';
import TeamIssuesPage from '../../components/issues/view/TeamIssuesPage';

/** The archived issues of the team named by the route's key prefix. */
const TeamArchive: React.FC = () => <TeamIssuesPage layout="list" archive />;

export default TeamArchive;
