/**
 * The team standup routes: the digest for one date, the team's digest
 * settings, and the caller's own note for the next digest.
 */

import type { QueryValue } from '@webbpulse/api-client';
import apiClient from './client';
import { teamPath } from './teams';
import type {
  DigestCadence,
  StandupDigest,
  StandupNoteRead,
  StandupNoteWrite,
  StandupSettingsRead,
  StandupSettingsUpdate,
} from '../types/Api';

/** The route a team's digest is read from. */
export const standupPath = (workspaceId: string, teamId: string): string =>
  `${teamPath(workspaceId, teamId)}/standup`;

/** The route a team's digest settings are read and changed at. */
export const standupSettingsPath = (
  workspaceId: string,
  teamId: string
): string => `${standupPath(workspaceId, teamId)}/settings`;

/** The route the caller's digest note is read, written and removed at. */
export const standupNotePath = (workspaceId: string, teamId: string): string =>
  `${standupPath(workspaceId, teamId)}/note`;

/** What one digest read asks for: a date, a window shape, or both. */
export interface StandupQuery {
  date?: string | undefined;
  cadence?: DigestCadence | undefined;
}

const options = (
  query: Record<string, QueryValue>,
  signal?: AbortSignal
): { query: Record<string, QueryValue>; signal?: AbortSignal } =>
  signal === undefined ? { query } : { query, signal };

const compact = (query: StandupQuery): Record<string, QueryValue> => {
  const out: Record<string, QueryValue> = {};
  if (query.date !== undefined) out['date'] = query.date;
  if (query.cadence !== undefined) out['cadence'] = query.cadence;
  return out;
};

/** Reads a team's digest, the next one when no date is given. */
export const getStandup = async (
  workspaceId: string,
  teamId: string,
  query: StandupQuery = {},
  signal?: AbortSignal
): Promise<StandupDigest> => {
  const response = await apiClient.get<StandupDigest>(
    standupPath(workspaceId, teamId),
    options(compact(query), signal)
  );
  return response.data;
};

/** Reads a team's digest settings. */
export const getStandupSettings = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<StandupSettingsRead> => {
  const response = await apiClient.get<StandupSettingsRead>(
    standupSettingsPath(workspaceId, teamId),
    signal === undefined ? undefined : { signal }
  );
  return response.data;
};

/** Changes a team's digest settings. Team admin only. */
export const updateStandupSettings = async (
  workspaceId: string,
  teamId: string,
  body: StandupSettingsUpdate
): Promise<StandupSettingsRead> => {
  const response = await apiClient.patch<StandupSettingsRead>(
    standupSettingsPath(workspaceId, teamId),
    body
  );
  return response.data;
};

/** Reads the caller's note for one digest date, the next one by default. */
export const getStandupNote = async (
  workspaceId: string,
  teamId: string,
  date?: string,
  signal?: AbortSignal
): Promise<StandupNoteRead> => {
  const response = await apiClient.get<StandupNoteRead>(
    standupNotePath(workspaceId, teamId),
    options(compact({ date }), signal)
  );
  return response.data;
};

/** Writes the caller's note, replacing an earlier one for the same date. */
export const putStandupNote = async (
  workspaceId: string,
  teamId: string,
  body: StandupNoteWrite
): Promise<StandupNoteRead> => {
  const response = await apiClient.put<StandupNoteRead>(
    standupNotePath(workspaceId, teamId),
    body
  );
  return response.data;
};

/** Removes the caller's note for one digest date. */
export const deleteStandupNote = async (
  workspaceId: string,
  teamId: string,
  date?: string
): Promise<void> => {
  await apiClient.delete(
    standupNotePath(workspaceId, teamId),
    options(compact({ date }))
  );
};
