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
  FileAttachmentCreate,
  MediaTokensRead,
  ReactionGroup,
  ReactionListRead,
  ReactionTarget,
  ReactionWrite,
  SubscribersRead,
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

/** The route a root comment's thread is resolved and unresolved through. */
export const threadResolutionPath = (
  workspaceId: string,
  issueId: string,
  commentId: string
): string =>
  `${issueCommentsPath(workspaceId, issueId)}/${commentId}/resolution`;

/** The route one document's comment thread is read from and posted to. */
export const documentCommentsPath = (
  workspaceId: string,
  documentId: string
): string => `/workspaces/${workspaceId}/documents/${documentId}/comments`;

/** The route one comment on a document is edited and deleted through. */
export const documentCommentPath = (
  workspaceId: string,
  documentId: string,
  commentId: string
): string => `${documentCommentsPath(workspaceId, documentId)}/${commentId}`;

/** The route one document's subscribers are read from. */
export const documentSubscribersPath = (
  workspaceId: string,
  documentId: string
): string => `/workspaces/${workspaceId}/documents/${documentId}/subscribers`;

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

/** The route an issue's media tokens are minted on. */
export const mediaTokensPath = (workspaceId: string): string =>
  `${attachmentsPath(workspaceId)}/media`;

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

/** Resolves a thread by its root comment. Resolving twice is a no-op. */
export const resolveThread = async (
  workspaceId: string,
  issueId: string,
  commentId: string
): Promise<CommentRead> => {
  const response = await apiClient.put<CommentRead>(
    threadResolutionPath(workspaceId, issueId, commentId)
  );
  return response.data;
};

/** Reopens a resolved thread, whoever resolved it. */
export const unresolveThread = async (
  workspaceId: string,
  issueId: string,
  commentId: string
): Promise<CommentRead> => {
  const response = await apiClient.delete<CommentRead>(
    threadResolutionPath(workspaceId, issueId, commentId)
  );
  return response.data;
};

/** Lists one document's comments, oldest first so a thread reads in order. */
export const listDocumentComments = async (
  workspaceId: string,
  documentId: string,
  query: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<CommentListRead> => {
  const response = await apiClient.get<CommentListRead>(
    documentCommentsPath(workspaceId, documentId),
    listOptions({ ...query }, signal)
  );
  const body = response.data;
  return {
    comments: Array.isArray(body?.comments) ? body.comments : [],
    next_cursor: body?.next_cursor ?? null,
  };
};

/** Posts a comment or a reply on a document; mentions are read server side. */
export const createDocumentComment = async (
  workspaceId: string,
  documentId: string,
  body: { body: string; parent_comment_id?: string | null }
): Promise<CommentRead> => {
  const response = await apiClient.post<CommentRead>(
    documentCommentsPath(workspaceId, documentId),
    body
  );
  return response.data;
};

/** Edits one's own comment on a document. */
export const updateDocumentComment = async (
  workspaceId: string,
  documentId: string,
  commentId: string,
  body: string
): Promise<CommentRead> => {
  const response = await apiClient.patch<CommentRead>(
    documentCommentPath(workspaceId, documentId, commentId),
    { body }
  );
  return response.data;
};

/** Deletes a comment on a document, reparenting its replies. */
export const deleteDocumentComment = async (
  workspaceId: string,
  documentId: string,
  commentId: string
): Promise<void> => {
  await apiClient.delete<void>(
    documentCommentPath(workspaceId, documentId, commentId)
  );
};

/** Resolves or reopens a thread on a document by its root comment. */
export const setDocumentThreadResolved = async (
  workspaceId: string,
  documentId: string,
  commentId: string,
  resolved: boolean
): Promise<CommentRead> => {
  const path = `${documentCommentPath(workspaceId, documentId, commentId)}/resolution`;
  const response = resolved
    ? await apiClient.put<CommentRead>(path)
    : await apiClient.delete<CommentRead>(path);
  return response.data;
};

/** Reads who follows a document, and whether the caller does. */
export const listDocumentSubscribers = async (
  workspaceId: string,
  documentId: string,
  signal?: AbortSignal
): Promise<SubscribersRead> => {
  const response = await apiClient.get<SubscribersRead>(
    documentSubscribersPath(workspaceId, documentId),
    signal === undefined ? undefined : { signal }
  );
  const body = response.data;
  return {
    subscribers: Array.isArray(body?.subscribers) ? body.subscribers : [],
    subscribed: body?.subscribed ?? false,
  };
};

/** Follows or leaves a document as the caller, answering its subscribers. */
export const setDocumentSubscribed = async (
  workspaceId: string,
  documentId: string,
  subscribed: boolean
): Promise<SubscribersRead> => {
  const path = `${documentSubscribersPath(workspaceId, documentId)}/me`;
  const response = subscribed
    ? await apiClient.put<SubscribersRead>(path)
    : await apiClient.delete<SubscribersRead>(path);
  return response.data;
};

/**
 * Lists the reaction groups on one issue or comment. A comment needs the issue
 * it was written on, which partitions it.
 */
export const listReactions = async (
  workspaceId: string,
  targetId: string,
  targetKind: ReactionTarget,
  signal?: AbortSignal,
  issueId?: string
): Promise<ReactionGroup[]> => {
  const response = await apiClient.get<ReactionListRead>(
    reactionsPath(workspaceId),
    listOptions(
      { target_id: targetId, target_kind: targetKind, issue_id: issueId },
      signal
    )
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
      issue_id: target.issue_id,
      document_id: target.document_id,
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

/** How far an upload has got, in bytes sent and the total to send. */
export interface UploadProgress {
  loaded: number;
  total: number;
}

/**
 * Sends the bytes straight to S3 with exactly the headers the ticket names.
 * The content type and the length are signed into the URL, so a PUT that
 * changes either is refused by the bucket rather than by this application.
 *
 * It deliberately does not go through the shared API client: the target is the
 * bucket, and attaching the caller's bearer token to it would leak the session
 * to an origin that neither needs nor checks it. It uses XMLHttpRequest rather
 * than fetch because only XHR reports upload progress. `Content-Length` is left
 * to the browser, which sets it from the body and refuses a script setting it.
 */
export const putUploadBytes = (
  ticket: Pick<UploadTicketRead, 'url' | 'headers'>,
  file: Blob,
  onProgress?: (progress: UploadProgress) => void
): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', ticket.url);
    for (const [name, value] of Object.entries(ticket.headers)) {
      if (name.toLowerCase() === 'content-length') continue;
      request.setRequestHeader(name, value);
    }
    if (onProgress !== undefined) {
      request.upload.onprogress = (event) => {
        onProgress({
          loaded: event.loaded,
          total: event.lengthComputable ? event.total : file.size,
        });
      };
    }
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      reject(
        new Error(`The upload was refused with status ${request.status}.`)
      );
    };
    request.onerror = () => {
      reject(new Error('The upload could not reach storage.'));
    };
    request.send(file);
  });

/**
 * Records the uploaded object on the issue. This is the call that makes an
 * upload visible, and the server checks the ticket was minted for this caller
 * on this issue rather than trusting a key from the body.
 */
export const commitUpload = async (
  workspaceId: string,
  issueId: string,
  ticket: Pick<UploadTicketRead, 'upload_id' | 'ticket'>,
  title?: string
): Promise<AttachmentRead> => {
  const body: FileAttachmentCreate = {
    issue_id: issueId,
    upload_id: ticket.upload_id,
    ticket: ticket.ticket,
    ...(title === undefined || title === '' ? {} : { title }),
  };
  const response = await apiClient.post<AttachmentRead>(
    attachmentsPath(workspaceId),
    body
  );
  return response.data;
};

/**
 * Mints media tokens for every file on one issue. Held briefly and appended
 * to embed URLs at render time; a stored body never carries one.
 */
export const getMediaTokens = async (
  workspaceId: string,
  issueId: string,
  signal?: AbortSignal
): Promise<MediaTokensRead> => {
  const response = await apiClient.get<MediaTokensRead>(
    mediaTokensPath(workspaceId),
    listOptions({ issue_id: issueId }, signal)
  );
  const body = response.data as Partial<MediaTokensRead> | undefined;
  return {
    tokens: body?.tokens ?? {},
    expires_at: body?.expires_at ?? '',
  };
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
  title?: string,
  onProgress?: (progress: UploadProgress) => void
): Promise<AttachmentRead> => {
  const ticket = await createUploadTicket(workspaceId, {
    issue_id: issueId,
    filename: file.name,
    content_type: file.type,
    size_bytes: file.size,
  });
  await putUploadBytes(ticket, file, onProgress);
  return commitUpload(workspaceId, issueId, ticket, title);
};
