/**
 * Holds the media tokens for one issue a member is reading, so every image and
 * video in the description and the comments can load. The tokens last an hour
 * and are re-read well inside that, and an upload asks for a fresh read so the
 * new attachment gains its token.
 */

import React, { useMemo } from 'react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { getMediaTokens } from '../../api/discussion';
import { MediaContext, type MediaContextValue } from '../../lib/mediaContext';
import { mediaTokensKey } from '../../lib/queryKeys';

/** How often the tokens are re-read, well inside their hour. */
const REFRESH_MS = 30 * 60 * 1000;

/** Props for IssueMediaProvider. */
export interface IssueMediaProviderProps {
  workspaceId: string;
  issueId: string;
  children: React.ReactNode;
}

/** Provides the media tokens of one issue to everything below it. */
export const IssueMediaProvider: React.FC<IssueMediaProviderProps> = ({
  workspaceId,
  issueId,
  children,
}) => {
  const auth = useQueryAuth();
  const { data } = usePolledQuery(
    ({ signal }) => getMediaTokens(workspaceId, issueId, signal),
    {
      intervalMs: REFRESH_MS,
      enabled: workspaceId !== '' && issueId !== '',
      refetchOnFocus: false,
      queryKey: mediaTokensKey(issueId),
      auth,
    }
  );
  const tokens = data?.tokens;
  const value = useMemo<MediaContextValue>(
    () => ({
      tokens: tokens ?? {},
      refresh: () => {
        invalidateQueries(mediaTokensKey(issueId));
      },
    }),
    [tokens, issueId]
  );
  return (
    <MediaContext.Provider value={value}>{children}</MediaContext.Provider>
  );
};

export default IssueMediaProvider;
