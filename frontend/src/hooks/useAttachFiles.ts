/**
 * Attaches files to the issue itself, rather than to a comment: what dropping a
 * file on the description or picking one from the rail does. Each file uploads
 * on its own so one refusal does not hold the rest back, and the rail's list is
 * re-read as each one lands.
 */

import { useCallback } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { uploadAttachment } from '../api/discussion';
import { errorMessage } from '../lib/errors';
import { attachmentsKey } from '../lib/queryKeys';
import { showErrorToast, showToast } from '../lib/toast';
import { describeUploadRefusal } from '../lib/uploads';

/** Returns a function that uploads files to one issue. */
export const useAttachFiles = (
  workspaceId: string,
  issueId: string
): ((files: File[]) => void) =>
  useCallback(
    (files: File[]) => {
      for (const file of files) {
        const refusal = describeUploadRefusal(file);
        if (refusal !== null) {
          showErrorToast(`${file.name}: ${refusal}`);
          continue;
        }
        uploadAttachment(workspaceId, issueId, file)
          .then(() => {
            invalidateQueries(attachmentsKey(issueId));
            showToast(`Attached ${file.name}`);
          })
          .catch((failure: unknown) => {
            showErrorToast(
              errorMessage(failure, `Could not upload ${file.name}.`)
            );
          });
      }
    },
    [workspaceId, issueId]
  );

export default useAttachFiles;
