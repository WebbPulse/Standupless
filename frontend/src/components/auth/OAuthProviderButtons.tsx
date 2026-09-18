/**
 * The "Continue with X" buttons, one per provider the deployment reports.
 * Rendered as anchors because the start route redirects to a host that sends no
 * CORS headers, so it must be a real navigation.
 */

import React from 'react';
import { GITHUB_PROVIDER, GOOGLE_PROVIDER } from '@webbpulse/auth';
import { useOAuthProviders } from '@webbpulse/discovery/react';
import { FaGithub, FaGoogle, FaSignInAlt } from 'react-icons/fa';
import { getIdentityClient, identityOrigin } from '../../api/identityClient';

/** Props for OAuthProviderButtons: where to land after the callback. */
export interface OAuthProviderButtonsProps {
  /** Where to land after the callback, as a path on this frontend. */
  returnTo?: string;
  disabled?: boolean;
}

/** The provider's mark, where this build has one. */
const ProviderIcon: React.FC<{ provider: string }> = ({ provider }) => {
  if (provider === GOOGLE_PROVIDER) return <FaGoogle />;
  if (provider === GITHUB_PROVIDER) return <FaGithub />;
  return <FaSignInAlt />;
};

/** One anchor per provider, or nothing when the deployment offers none. */
const OAuthProviderButtons: React.FC<OAuthProviderButtonsProps> = ({
  returnTo,
  disabled = false,
}) => {
  const providers = useOAuthProviders({ identityOrigin: identityOrigin() });
  const client = getIdentityClient();

  if (client === null || providers.length === 0) return null;

  return (
    <div className="space-y-2">
      {providers.map((provider) => {
        const href = client.oauthStartUrl(
          provider.id,
          returnTo === undefined ? {} : { returnTo }
        );
        return (
          <a
            key={provider.id}
            href={disabled ? undefined : href}
            aria-disabled={disabled ? 'true' : undefined}
            className={`inline-flex w-full items-center justify-center gap-2 rounded-md border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-700 ${
              disabled ? 'pointer-events-none opacity-50' : ''
            }`}
          >
            <ProviderIcon provider={provider.id} />
            <span>Continue with {provider.displayName}</span>
          </a>
        );
      })}
    </div>
  );
};

export default OAuthProviderButtons;
