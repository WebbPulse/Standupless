/**
 * The ways of signing in a workspace's authentication policy can allow, and the
 * names they go by, shared by the security settings and the policy gate.
 */

import type { SignInMethod } from '../types/Api';

/** Every sign-in method in the order the settings and the gate list them. */
export const SIGN_IN_METHODS: readonly SignInMethod[] = [
  'password',
  'google',
  'github',
  'passkey',
];

/** The name each sign-in method goes by in the interface. */
export const SIGN_IN_METHOD_NAMES: Record<SignInMethod, string> = {
  password: 'Password',
  google: 'Google',
  github: 'GitHub',
  passkey: 'Passkey',
};

/**
 * The methods as a phrase in the listed order: "Google", "Google or GitHub",
 * "Password, Google or GitHub".
 */
export function listSignInMethods(methods: readonly SignInMethod[]): string {
  const names: string[] = [];
  for (const method of SIGN_IN_METHODS) {
    if (methods.includes(method)) {
      names.push(SIGN_IN_METHOD_NAMES[method]);
    }
  }
  if (names.length <= 1) {
    return names.join('');
  }
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}
