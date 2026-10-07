/**
 * The team switch between open and private.
 *
 * A private team is invite only: people outside it cannot see the team, its
 * issues or its search results. Workspace owners and admins still find it in
 * settings so they can manage it. Making a team private cuts off everyone who
 * is not a member, so that direction asks first; making it open again saves at
 * once. The plan check is the server's, and its refusal is shown as sent.
 */

import React, { useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { updateTeam } from '../../api/teams';
import { errorMessage } from '../../lib/errors';
import { teamsKey } from '../../lib/queryKeys';
import type { TeamRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';

/** Props for TeamPrivacySection. */
export interface TeamPrivacySectionProps {
  workspaceId: string;
  team: TeamRead;
  /** Whether the caller administers the team. */
  canEdit: boolean;
}

/** Shows whether a team is private and lets a team admin change it. */
export const TeamPrivacySection: React.FC<TeamPrivacySectionProps> = ({
  workspaceId,
  team,
  canEdit,
}) => {
  const isPrivate = team.private ?? false;
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = async (next: boolean): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await updateTeam(workspaceId, team.id, { private: next });
      invalidateQueries(teamsKey(workspaceId));
      setConfirming(false);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Privacy</h3>
        <p className="text-sm text-text-muted">
          {isPrivate
            ? 'This team is private. Only its members can see it and its issues, and new people join by invite.'
            : 'This team is open. Everyone in the workspace except guests can see it and join it.'}
        </p>
      </div>
      {error !== null && !confirming && (
        <ErrorAlert
          message={errorMessage(error, 'Could not change the team privacy.')}
        />
      )}
      {canEdit && (
        <div className="flex items-center justify-between gap-4 rounded-md border border-line px-3 py-3">
          <p className="text-sm text-text-muted">
            {isPrivate
              ? 'Open the team to everyone in the workspace.'
              : 'Make the team private. Needs the Business plan.'}
          </p>
          <Button
            type="button"
            variant="secondary"
            disabled={saving}
            onClick={() => {
              if (isPrivate) {
                void save(false);
              } else {
                setError(null);
                setConfirming(true);
              }
            }}
          >
            {isPrivate ? 'Make open' : 'Make private'}
          </Button>
        </div>
      )}
      {confirming && (
        <Dialog
          open
          onClose={() => {
            setConfirming(false);
          }}
          title={`Make ${team.name} private`}
          description="Anyone who is not a member of this team loses access to it, its issues, views and share links straight away. Add people to the team first if they still need it."
          size="sm"
        >
          <div className="space-y-4">
            {error !== null && (
              <ErrorAlert
                message={errorMessage(
                  error,
                  'Could not change the team privacy.'
                )}
              />
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={saving}
                onClick={() => {
                  void save(true);
                }}
              >
                {saving ? 'Saving' : 'Make private'}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
};

export default TeamPrivacySection;
