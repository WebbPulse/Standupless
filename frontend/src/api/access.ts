/**
 * The M6 programmatic access routes: API keys, share links, and the three
 * anonymous reads a share token resolves.
 *
 * The anonymous reads go through a second client rather than the shared one.
 * `apiClient` is constructed with the identity auth provider, so every call it
 * makes attaches a bearer and refreshes once on a 401. A share must render the
 * same for everyone, so sending a signed-in reader's token would be both
 * pointless and a way for the page to depend on who is asking. The second
 * client keeps the same base URL, timeouts, retries and error envelope while
 * carrying no credential at all.
 */

import { createApiClient, type ApiClient } from '@webbpulse/api-client';
import { appConfig } from '../config/app';
import apiClient from './client';
import type {
  ApiKeyCreate,
  ApiKeyCreatedRead,
  ApiKeyListScope,
  ApiKeyRead,
  SharedIssueRead,
  SharedTargetRead,
  SharedViewPageRead,
  ShareLinkCreate,
  ShareLinkCreatedRead,
  ShareLinkListQuery,
  ShareLinkRead,
} from '../types/Api';

/**
 * The client the `/shared` reads go through. Built without `auth` so no bearer
 * is ever attached and no refresh is ever attempted, and with `credentials`
 * omitted so no cookie rides along either, which is what keeps an anonymous
 * read anonymous even in a browser that holds a session.
 */
export const anonymousClient: ApiClient = createApiClient({
  baseUrl: appConfig.apiBaseUrl,
  credentials: 'omit',
  timeoutMs: 30000,
});

/** The route API keys are listed and minted on. */
export const apiKeysPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/api-keys`;

/** The route one API key is revoked through. */
export const apiKeyPath = (workspaceId: string, keyId: string): string =>
  `${apiKeysPath(workspaceId)}/${keyId}`;

/** The route share links are listed and minted on. */
export const shareLinksPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/share-links`;

/**
 * The route one share link is revoked through. It is named by `token_hash`
 * rather than by the token, because the hash is what a listing holds and the
 * token is deliberately what it does not.
 */
export const shareLinkPath = (workspaceId: string, tokenHash: string): string =>
  `${shareLinksPath(workspaceId)}/${tokenHash}`;

/** The route a share token resolves its target on. */
export const sharedTargetPath = (token: string): string =>
  `/shared/${encodeURIComponent(token)}`;

/** The route a share token reads its one issue from. */
export const sharedIssuePath = (token: string): string =>
  `${sharedTargetPath(token)}/issue`;

/** The route a share token pages its one view from. */
export const sharedViewPath = (token: string): string =>
  `${sharedTargetPath(token)}/view`;

type QueryBag = Record<string, string | number | boolean | undefined>;

const listOptions = (
  query: QueryBag,
  signal?: AbortSignal
): { query: QueryBag; signal?: AbortSignal } =>
  signal === undefined ? { query } : { query, signal };

const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

/**
 * Lists API keys, newest first. `mine` is what any member may read; `workspace`
 * is refused to anyone who is not a workspace admin, so a page asks for it only
 * when it already knows the caller's role.
 */
export const listApiKeys = async (
  workspaceId: string,
  query: { scope?: ApiKeyListScope } = {},
  signal?: AbortSignal
): Promise<ApiKeyRead[]> => {
  const response = await apiClient.get<{ api_keys?: ApiKeyRead[] }>(
    apiKeysPath(workspaceId),
    listOptions({ ...query }, signal)
  );
  const body = response.data;
  return Array.isArray(body?.api_keys) ? body.api_keys : [];
};

/**
 * Mints an API key. This is the only response that ever carries `secret`, so a
 * caller that discards the result has lost the key rather than merely the view
 * of it.
 */
export const createApiKey = async (
  workspaceId: string,
  body: ApiKeyCreate
): Promise<ApiKeyCreatedRead> => {
  const response = await apiClient.post<ApiKeyCreatedRead>(
    apiKeysPath(workspaceId),
    body
  );
  return response.data;
};

/** Revokes an API key. Its owner or a workspace admin may do it. */
export const revokeApiKey = async (
  workspaceId: string,
  keyId: string
): Promise<void> => {
  await apiClient.delete<void>(apiKeyPath(workspaceId, keyId));
};

/**
 * Lists share links, newest first. A guest sees only links onto projects they
 * can read, which the server decides, so the page sends no filter for it.
 */
export const listShareLinks = async (
  workspaceId: string,
  query: ShareLinkListQuery = {},
  signal?: AbortSignal
): Promise<ShareLinkRead[]> => {
  const response = await apiClient.get<{ share_links?: ShareLinkRead[] }>(
    shareLinksPath(workspaceId),
    listOptions({ ...query }, signal)
  );
  const body = response.data;
  return Array.isArray(body?.share_links) ? body.share_links : [];
};

/**
 * Mints a share link. This is the only response that carries `token`, and the
 * only one whose `url` carries it too, so it is the one value worth copying.
 */
export const createShareLink = async (
  workspaceId: string,
  body: ShareLinkCreate
): Promise<ShareLinkCreatedRead> => {
  const response = await apiClient.post<ShareLinkCreatedRead>(
    shareLinksPath(workspaceId),
    body
  );
  return response.data;
};

/** Revokes a share link by the hash a listing renders it under. */
export const revokeShareLink = async (
  workspaceId: string,
  tokenHash: string
): Promise<void> => {
  await apiClient.delete<void>(shareLinkPath(workspaceId, tokenHash));
};

/**
 * Resolves a share token to what it points at. A token that does not resolve,
 * has expired or was revoked answers the same 404 in all three cases, so the
 * page cannot tell them apart and neither can a reader probing tokens.
 */
export const getSharedTarget = async (
  token: string,
  signal?: AbortSignal
): Promise<SharedTargetRead> => {
  const response = await anonymousClient.get<SharedTargetRead>(
    sharedTargetPath(token),
    signalOptions(signal)
  );
  return response.data;
};

/** Reads the one issue a share token resolves to. */
export const getSharedIssue = async (
  token: string,
  signal?: AbortSignal
): Promise<SharedIssueRead> => {
  const response = await anonymousClient.get<SharedIssueRead>(
    sharedIssuePath(token),
    signalOptions(signal)
  );
  return response.data;
};

/**
 * Pages the issues a shared view selects, bounded by the one project the view
 * is scoped to. `limit` is 1 to 100 and defaults to 50 at the server.
 */
export const listSharedViewIssues = async (
  token: string,
  query: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<SharedViewPageRead> => {
  const response = await anonymousClient.get<SharedViewPageRead>(
    sharedViewPath(token),
    listOptions({ ...query }, signal)
  );
  const body = response.data;
  return {
    issues: Array.isArray(body?.issues) ? body.issues : [],
    next_cursor: body?.next_cursor ?? null,
  };
};
