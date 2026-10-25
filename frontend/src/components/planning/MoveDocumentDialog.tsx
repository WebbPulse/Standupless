/**
 * The dialog that moves a document to another parent: a search box over the
 * workspace's teams, projects and initiatives, the current parent left out.
 * Picking one hands it to `onPick`, which files the document there; its
 * history and the issues it mentions go with it. Initiatives are left out for a guest, who cannot write
 * under one.
 */

import React, { useMemo, useState } from 'react';
import { LuGoal } from 'react-icons/lu';
import useInitiatives from '../../hooks/useInitiatives';
import { useTeamsFor } from '../../hooks/useTeams';
import useWorkspaceProjects from '../../hooks/useWorkspaceProjects';
import type { DocumentParentKind, DocumentRead } from '../../types/Api';
import Avatar from '../ui/avatar';
import Dialog from '../ui/dialog';
import { Input } from '../ui/input';
import ProjectIcon from './ProjectIcon';

/** Props for MoveDocumentDialog. */
export interface MoveDocumentDialogProps {
  workspaceId: string;
  document: DocumentRead;
  /** Whether initiatives are offered, which a guest cannot write under. */
  offerInitiatives: boolean;
  onClose: () => void;
  /** Moves the document to the destination picked. */
  onPick: (destination: Destination) => void;
}

/** One place the document can move to. */
export interface Destination {
  kind: DocumentParentKind;
  id: string;
  name: string;
  icon: React.ReactNode;
}

/** The headings the destinations are grouped under, in order. */
const GROUPS: { kind: DocumentParentKind; heading: string }[] = [
  { kind: 'team', heading: 'Teams' },
  { kind: 'project', heading: 'Projects' },
  { kind: 'initiative', heading: 'Initiatives' },
];

/** The dialog. */
export const MoveDocumentDialog: React.FC<MoveDocumentDialogProps> = ({
  workspaceId,
  document,
  offerInitiatives,
  onClose,
  onPick,
}) => {
  const teams = useTeamsFor(workspaceId);
  const { projects } = useWorkspaceProjects(workspaceId, '');
  const { initiatives } = useInitiatives(workspaceId, offerInitiatives);
  const [query, setQuery] = useState('');

  const destinations = useMemo((): Destination[] => {
    const all: Destination[] = [
      ...(teams.data ?? []).map((team) => ({
        kind: 'team' as const,
        id: team.id,
        name: team.name,
        icon: (
          <Avatar
            name={team.name}
            src={team.icon_url}
            size="xs"
            shape="square"
          />
        ),
      })),
      ...projects.map((project) => ({
        kind: 'project' as const,
        id: project.project_id,
        name: project.name,
        icon: (
          <ProjectIcon
            icon={project.icon}
            color={project.color}
            className="h-4 w-4"
          />
        ),
      })),
      ...(offerInitiatives ? initiatives : []).map((initiative) => ({
        kind: 'initiative' as const,
        id: initiative.initiative_id,
        name: initiative.name,
        icon: (
          <LuGoal
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-text-muted"
          />
        ),
      })),
    ];
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter(
      (row) =>
        !(row.kind === document.parent_kind && row.id === document.parent_id) &&
        words.every((word) => row.name.toLowerCase().includes(word))
    );
  }, [
    teams.data,
    projects,
    initiatives,
    offerInitiatives,
    query,
    document.parent_kind,
    document.parent_id,
  ]);

  const move = (destination: Destination): void => {
    onPick(destination);
  };

  return (
    <Dialog
      open
      size="md"
      title={`Move ${document.title}`}
      description={`Now in ${document.parent_name}. Its history and mentions move with it.`}
      onClose={onClose}
    >
      <div className="space-y-3">
        <Input
          aria-label="Search teams, projects and initiatives"
          placeholder="Move to..."
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            const first = destinations[0];
            if (event.key === 'Enter' && first !== undefined) {
              event.preventDefault();
              move(first);
            }
          }}
        />
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {destinations.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-text-faint">
              Nothing matches that search.
            </p>
          )}
          {GROUPS.map((group) => {
            const rows = destinations.filter((row) => row.kind === group.kind);
            if (rows.length === 0) return null;
            return (
              <section key={group.kind} role="group" aria-label={group.heading}>
                <h3 className="px-2 pt-1 pb-1 text-2xs font-medium text-text-faint">
                  {group.heading}
                </h3>
                <ul>
                  {rows.map((row) => (
                    <li key={`${row.kind}-${row.id}`}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-text hover:bg-surface focus-visible:bg-surface focus-visible:outline-none"
                        onClick={() => {
                          move(row);
                        }}
                      >
                        {row.icon}
                        <span className="min-w-0 flex-1 truncate">
                          {row.name}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
};

export default MoveDocumentDialog;
