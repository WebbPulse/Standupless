/**
 * The form element shared by the auth pages.
 */

import React from 'react';

/** Props for AuthForm: the submit handler and the form rows. */
export interface AuthFormProps {
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  children: React.ReactNode;
}

/** A form with the shared row spacing. */
const AuthForm: React.FC<AuthFormProps> = ({ onSubmit, children }) => (
  <form className="space-y-4" onSubmit={onSubmit}>
    {children}
  </form>
);

export default AuthForm;
