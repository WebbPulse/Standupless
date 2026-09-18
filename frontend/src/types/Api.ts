/**
 * Shapes the Standupless API returns, hand written against the backend's
 * schemas until a generated client exists.
 */

/** The signed in user, as the identity service reports it. */
export interface UserRead {
  id: string;
  email: string;
  display_name: string | null;
  email_verified: boolean;
}

/** One workspace the signed in user belongs to. */
export interface WorkspaceRead {
  id: string;
  name: string;
  slug: string;
  plan: string;
  created_at: string;
}

/**
 * The body `GET /api/workspaces` answers with. Every list route answers an
 * object rather than a bare array, so a cursor can arrive beside the items
 * without breaking this type.
 */
export interface WorkspaceListRead {
  workspaces: WorkspaceRead[];
}
