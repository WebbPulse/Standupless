/**
 * The "Continue with X" buttons, one per provider the deployment reports.
 * Rendered as anchors because the start route redirects to a host that sends no
 * CORS headers, so it must be a real navigation.
 */

import React from 'react';
import { GITHUB_PROVIDER, GOOGLE_PROVIDER } from '@webbpulse/auth';
import { useOAuthProviders } from '@webbpulse/discovery/react';
import { FaGithub, FaGoogle } from 'react-icons/fa';
import { LuLogIn } from 'react-icons/lu';
import { getIdentityClient, identityOrigin } from '../../api/identityClient';
import { cn } from '../../lib/cn';

/** Props for OAuthProviderButtons: where to land after the callback. */
export interface OAuthProviderButtonsProps {
  /** Where to land after the callback, as a path on this frontend. */
  returnTo?: string;
  disabled?: boolean;
}

/** The provider's mark, where this build has one. */
const ProviderIcon: React.FC<{ provider: string }> = ({ provider }) => {
  const className = 'h-3.5 w-3.5';
  if (provider === GOOGLE_PROVIDER)
    return <FaGoogle className={className} aria-hidden="true" />;
  if (provider === GITHUB_PROVIDER)
    return <FaGithub className={className} aria-hidden="true" />;
  return <LuLogIn className={className} aria-hidden="true" />;
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
            className={cn(
              'inline-flex h-8 w-full items-center justify-center gap-2 rounded-sm border border-line-strong bg-bg px-3 text-sm font-medium text-text transition-colors duration-100 hover:bg-raised',
              disabled ? 'pointer-events-none opacity-50' : ''
            )}
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
