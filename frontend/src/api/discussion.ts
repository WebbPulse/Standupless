/**
 * The discussion routes: comments on an issue, reactions on an issue or a
 * comment, and attachments. The single-comment and attachment routes take
 * `issue_id` as a query parameter because their tables partition by the issue,
 * so a read without it would be a scan; keeping it out of the path leaves a
 * comment id stable in a permalink built from the issue route.
 */

import apiClient from './client';
import type {
  AttachmentDownloadRead,
  AttachmentListRead,
  AttachmentRead,
  CommentCreate,
  CommentListRead,
  CommentRead,
  ReactionGroup,
  ReactionListRead,
  ReactionTarget,
  ReactionWrite,
  UploadTicketCreate,
  UploadTicketRead,
  UrlAttachmentCreate,
} from '../types/Api';

/** The route one issue's comment thread is read from. */
export const issueCommentsPath = (
  workspaceId: string,
  issueId: string
): string => `/workspaces/${workspaceId}/issues/${issueId}/comments`;

/** The route one comment is read, edited and deleted through. */
export const commentPath = (workspaceId: string, commentId: string): string =>
  `/workspaces/${workspaceId}/comments/${commentId}`;

/** The route every reaction read and write goes through. */
export const reactionsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/reactions`;

/** The route attachments are listed and committed on. */
export const attachmentsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/attachments`;

/** The route a URL attachment is created on. */
export const urlAttachmentsPath = (workspaceId: string): string =>
  `${attachmentsPath(workspaceId)}/url`;

/** The route an upload ticket is minted on. */
export const uploadTicketsPath = (workspaceId: string): string =>
  `${attachmentsPath(workspaceId)}/uploads`;

/** The route one attachment is deleted through. */
export const attachmentPath = (
  workspaceId: string,
  attachmentId: string
): string => `${attachmentsPath(workspaceId)}/${attachmentId}`;

/** The route a presigned download is minted on. */
export const attachmentDownloadPath = (
  workspaceId: string,
  attachmentId: string
): string => `${attachmentPath(workspaceId, attachmentId)}/download`;

const listOptions = (
  query: Record<string, string | number | boolean | undefined>,
  signal?: AbortSignal
): {
  query: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
} => (signal === undefined ? { query } : { query, signal });

/** Lists one issue's comments, oldest first so a thread reads in order. */
export const listComments = async (
  workspaceId: string,
  issueId: string,
  query: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<CommentListRead> => {
  const response = await apiClient.get<CommentListRead>(
    issueCommentsPath(workspaceId, issueId),
    listOptions({ ...query }, signal)
  );
  const body = response.data;
  return {
    comments: Array.isArray(body?.comments) ? body.comments : [],
    next_cursor: body?.next_cursor ?? null,
  };
};

/**
 * Posts a comment. Mentions are extracted server side, so the caller sends the
 * markdown and never a recipient list.
 */
export const createComment = async (
  workspaceId: string,
  issueId: string,
  body: CommentCreate
): Promise<CommentRead> => {
  const response = await apiClient.post<CommentRead>(
    issueCommentsPath(workspaceId, issueId),
    body
  );
  return response.data;
};

/** Reads one comment, which needs its issue to locate the partition. */
export const getComment = async (
  workspaceId: string,
  commentId: string,
  issueId: string,
  signal?: AbortSignal
): Promise<CommentRead> => {
  const response = await apiClient.get<CommentRead>(
    commentPath(workspaceId, commentId),
    listOptions({ issue_id: issueId }, signal)
  );
  return response.data;
};

/** Edits a comment, which the contract reserves to its author. */
export const updateComment = async (
  workspaceId: string,
  commentId: string,
  issueId: string,
  body: string
): Promise<CommentRead> => {
  const response = await apiClient.patch<CommentRead>(
    commentPath(workspaceId, commentId),
    { issue_id: issueId, body }
  );
  return response.data;
};

/**
 * Deletes a comment. The row goes, replies are reparented to null and the
 * reactions on it are removed, so nothing is left pointing at it.
 */
export const deleteComment = async (
  workspaceId: string,
  commentId: string,
  issueId: string
): Promise<void> => {
  await apiClient.delete<void>(commentPath(workspaceId, commentId), {
    query: { issue_id: issueId },
  });
};

/** Lists the reaction groups on one issue or comment. */
export const listReactions = async (
  workspaceId: string,
  targetId: string,
  targetKind: ReactionTarget,
  signal?: AbortSignal
): Promise<ReactionGroup[]> => {
  const response = await apiClient.get<ReactionListRead>(
    reactionsPath(workspaceId),
    listOptions({ target_id: targetId, target_kind: targetKind }, signal)
  );
  const body = response.data;
  return Array.isArray(body?.reactions) ? body.reactions : [];
};

/**
 * Adds the caller's reaction. It is a PUT rather than a create because the
 * row's key is the emoji and the user, which the caller already knows, so a
 * second call by the same person is the same answer rather than a duplicate.
 */
export const addReaction = async (
  workspaceId: string,
  body: ReactionWrite
): Promise<ReactionGroup> => {
  const response = await apiClient.put<ReactionGroup>(
    reactionsPath(workspaceId),
    body
  );
  return response.data;
};

/** Removes the caller's reaction, which is still 204 when it was not there. */
export const removeReaction = async (
  workspaceId: string,
  target: ReactionWrite
): Promise<void> => {
  await apiClient.delete<void>(reactionsPath(workspaceId), {
    query: {
      target_id: target.target_id,
      target_kind: target.target_kind,
      emoji: target.emoji,
    },
  });
};

/** Lists one issue's attachments, oldest first. */
export const listAttachments = async (
  workspaceId: string,
  issueId: string,
  query: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<AttachmentListRead> => {
  const response = await apiClient.get<AttachmentListRead>(
    attachmentsPath(workspaceId),
    listOptions({ issue_id: issueId, ...query }, signal)
  );
  const body = response.data;
  return {
    attachments: Array.isArray(body?.attachments) ? body.attachments : [],
    next_cursor: body?.next_cursor ?? null,
  };
};

/**
 * Attaches a URL. The favicon is derived from the host server side without a
 * fetch, so nothing here crawls the target.
 */
export const createUrlAttachment = async (
  workspaceId: string,
  body: UrlAttachmentCreate
): Promise<AttachmentRead> => {
  const response = await apiClient.post<AttachmentRead>(
    urlAttachmentsPath(workspaceId),
    body
  );
  return response.data;
};

/**
 * Mints a presigned PUT. Nothing lands on the issue yet: an upload abandoned
 * after this call is an orphaned object the bucket lifecycle rule collects,
 * never a half-attached row.
 */
export const createUploadTicket = async (
  workspaceId: string,
  body: UploadTicketCreate
): Promise<UploadTicketRead> => {
  const response = await apiClient.post<UploadTicketRead>(
    uploadTicketsPath(workspaceId),
    body
  );
  return response.data;
};

/**
 * Sends the bytes straight to S3 with exactly the headers the ticket names.
 * The content type and the length are signed into the URL, so a PUT that
 * changes either is refused by the bucket rather than by this application.
 *
 * It deliberately does not go through the shared API client: the target is the
 * bucket, and attaching the caller's bearer token to it would leak the session
 * to an origin that neither needs nor checks it.
 */
export const putUploadBytes = async (
  ticket: UploadTicketRead,
  file: Blob
): Promise<void> => {
  const response = await fetch(ticket.url, {
    method: 'PUT',
    headers: ticket.headers,
    body: file,
  });
  if (!response.ok) {
    throw new Error(`The upload was refused with status ${response.status}.`);
  }
};

/**
 * Records the uploaded object on the issue. This is the call that makes an
 * upload visible, and the server checks the ticket was minted for this caller
 * on this issue rather than trusting a key from the body.
 */
export const commitUpload = async (
  workspaceId: string,
  issueId: string,
  uploadId: string,
  title?: string
): Promise<AttachmentRead> => {
  const response = await apiClient.post<AttachmentRead>(
    attachmentsPath(workspaceId),
    {
      issue_id: issueId,
      upload_id: uploadId,
      ...(title === undefined || title === '' ? {} : { title }),
    }
  );
  return response.data;
};

/**
 * Mints a presigned GET valid for 300 seconds. It is read per click rather
 * than held on the row, so a link never outlives the caller's access.
 */
export const getAttachmentDownload = async (
  workspaceId: string,
  attachmentId: string,
  issueId: string
): Promise<AttachmentDownloadRead> => {
  const response = await apiClient.get<AttachmentDownloadRead>(
    attachmentDownloadPath(workspaceId, attachmentId),
    { query: { issue_id: issueId } }
  );
  return response.data;
};

/**
 * Deletes an attachment. The row goes immediately and the stored object is
 * left to the bucket lifecycle rule, which the contract accepts.
 */
export const deleteAttachment = async (
  workspaceId: string,
  attachmentId: string,
  issueId: string
): Promise<void> => {
  await apiClient.delete<void>(attachmentPath(workspaceId, attachmentId), {
    query: { issue_id: issueId },
  });
};

/** An empty comment page, for a query disabled before its ids are known. */
export const emptyCommentPage = (): CommentListRead => ({
  comments: [],
  next_cursor: null,
});

/** An empty attachment page, used the same way as {@link emptyCommentPage}. */
export const emptyAttachmentPage = (): AttachmentListRead => ({
  attachments: [],
  next_cursor: null,
});

/** Appends a cursor page of comments, dropping a row the cursor repeated. */
export const appendComments = (
  held: CommentRead[],
  incoming: CommentRead[]
): CommentRead[] => {
  const seen = new Set(held.map((comment) => comment.comment_id));
  return [
    ...held,
    ...incoming.filter((comment) => !seen.has(comment.comment_id)),
  ];
};

/** Appends a cursor page of attachments, dropping a repeated row. */
export const appendAttachments = (
  held: AttachmentRead[],
  incoming: AttachmentRead[]
): AttachmentRead[] => {
  const seen = new Set(held.map((item) => item.attachment_id));
  return [...held, ...incoming.filter((item) => !seen.has(item.attachment_id))];
};

/**
 * Runs the whole three-call upload: mint, PUT, commit. It lives here rather
 * than in the component so the ordering is tested once and no call site can
 * commit before the bytes have landed.
 */
export const uploadAttachment = async (
  workspaceId: string,
  issueId: string,
  file: File,
  title?: string
): Promise<AttachmentRead> => {
  const ticket = await createUploadTicket(workspaceId, {
    issue_id: issueId,
    filename: file.name,
    content_type: file.type,
    size_bytes: file.size,
  });
  await putUploadBytes(ticket, file);
  return commitUpload(workspaceId, issueId, ticket.upload_id, title);
};
