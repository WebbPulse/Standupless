/**
 * The two banners the pages render: one for a refusal and one for a
 * confirmation. Refusal copy is always the server's own sentence.
 */

import React from 'react';

/** Props for the message alerts: the sentence, or null to render nothing. */
export interface MessageAlertProps {
  message: string | null | undefined;
}

/** A refusal banner, or nothing when there is no message. */
export const ErrorAlert: React.FC<MessageAlertProps> = ({ message }) => {
  if (message === null || message === undefined || message === '') return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
    >
      {message}
    </p>
  );
};

/** A confirmation banner, or nothing when there is no message. */
export const ConfirmationAlert: React.FC<MessageAlertProps> = ({ message }) => {
  if (message === null || message === undefined || message === '') return null;
  return (
    <p
      role="status"
      className="rounded-md border border-success/30 bg-success-soft px-3 py-2 text-sm text-success"
    >
      {message}
    </p>
  );
};
