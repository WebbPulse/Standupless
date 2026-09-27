/**
 * One team's issue list. The board, the cycles and the team's settings are
 * separate routes rather than tabs on this page, so each is a place a person
 * can link to and return to.
 */

import React from 'react';
import TeamIssuesPage from '../../components/issues/view/TeamIssuesPage';

/** The issue list of the team named by the route's key prefix. */
const Team: React.FC = () => <TeamIssuesPage layout="list" />;

export default Team;
