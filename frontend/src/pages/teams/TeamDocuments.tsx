/**
 * One team's documents: the runbooks, specs and notes filed under the team
 * rather than a project or an initiative. It lists them the way a project's
 * overview does, and the palette's "Create document" starts one here.
 */

import React from 'react';
import { useParams } from 'react-router-dom';
import DocumentsSection from '../../components/planning/DocumentsSection';
import { ErrorAlert } from '../../components/ui/alert';
import EmptyState from '../../components/ui/empty-state';
import { SkeletonRows } from '../../components/ui/skeleton';
import TeamTabs from '../../components/workspace/TeamTabs';
import TeamTitle from '../../components/workspace/TeamTitle';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import useCreateDocumentCommand from '../../hooks/useCreateDocumentCommand';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { errorMessage } from '../../lib/errors';

/** The documents of the team named by the route's key prefix. */
const TeamDocuments: React.FC = () => {
  const { keyPrefix } = useParams<{ keyPrefix: string }>();
  const { workspace } = useWorkspace();
  const { team, workspaceId, isLoading, notFound, error } = useTeam(keyPrefix);
  const slug = workspace?.slug ?? '';
  const isMember = workspace !== null && workspace.role !== 'guest';
  const people = useWorkspaceMembers(workspaceId, isMember);
  const canCreate = team !== null && team.role !== undefined;

  useCreateDocumentCommand({
    workspaceId,
    slug,
    parentKind: 'team',
    parentId: team?.id ?? '',
    group: 'Team',
    enabled: canCreate,
  });

  if (notFound || (team === null && !isLoading)) {
    return (
      <WorkspaceShell title="Documents">
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load this team.')}
          />
        )}
        <EmptyState message="That team does not exist, or you are not a member of it." />
      </WorkspaceShell>
    );
  }

  if (team === null) {
    return (
      <WorkspaceShell title="Documents">
        <SkeletonRows label="Loading documents" />
      </WorkspaceShell>
    );
  }

  return (
    <WorkspaceShell
      title={<TeamTitle name={team.name} keyPrefix={team.key_prefix} />}
      toolbar={
        <TeamTabs
          slug={slug}
          keyPrefix={team.key_prefix}
          teamId={team.id}
          current="documents"
        />
      }
    >
      <div className="mx-auto max-w-3xl px-4 py-6 lg:px-8">
        <DocumentsSection
          workspaceId={workspaceId}
          slug={slug}
          parentKind="team"
          parentId={team.id}
          canCreate={canCreate}
          people={people}
        />
      </div>
    </WorkspaceShell>
  );
};

export default TeamDocuments;
