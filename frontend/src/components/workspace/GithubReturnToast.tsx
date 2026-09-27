/**
 * The toast shown when GitHub sends an admin back to settings after an install.
 *
 * The callback has no session to attach a message to, so the outcome arrives as
 * `?github=<code>` on the settings URL. This reads it once, says what happened in
 * plain words, and strips it from the URL so a reload does not say it again.
 */

import React, { useEffect, useState } from 'react';
import { LuCircleAlert, LuCircleCheck, LuInfo, LuX } from 'react-icons/lu';
import { useSearchParams } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { IconButton } from '../ui/button';
import { githubOutcome, type GithubOutcome } from './githubOutcomes';

/** How long a toast stays before it dismisses itself. */
const DISMISS_MS = 8000;

const TONE_CLASS: Record<GithubOutcome['tone'], string> = {
  success: 'text-success',
  info: 'text-accent',
  danger: 'text-danger',
};

const TONE_ICON: Record<
  GithubOutcome['tone'],
  React.ComponentType<{ className?: string }>
> = {
  success: LuCircleCheck,
  info: LuInfo,
  danger: LuCircleAlert,
};

/** Props for GithubReturnToast: what to do once an outcome has been read. */
export interface GithubReturnToastProps {
  /** Called with the outcome code, so the section can re-read the installation. */
  onOutcome?: (code: string) => void;
}

/** Reads `?github=` once, shows it as a toast, and removes it from the URL. */
export const GithubReturnToast: React.FC<GithubReturnToastProps> = ({
  onOutcome,
}) => {
  const [params, setParams] = useSearchParams();
  const [outcome, setOutcome] = useState<GithubOutcome | null>(null);
  const [seen, setSeen] = useState<string | null>(null);
  const code = params.get('github');

  if (code !== null && code !== seen) {
    setSeen(code);
    setOutcome(githubOutcome(code));
  }

  useEffect(() => {
    if (code === null) return;
    onOutcome?.(code);
    const next = new URLSearchParams(params);
    next.delete('github');
    setParams(next, { replace: true });
  }, [code, params, setParams, onOutcome]);

  useEffect(() => {
    if (outcome === null) return undefined;
    const timer = globalThis.setTimeout(() => {
      setOutcome(null);
    }, DISMISS_MS);
    return () => {
      globalThis.clearTimeout(timer);
    };
  }, [outcome]);

  if (outcome === null) return null;
  const Icon = TONE_ICON[outcome.tone];

  return (
    <div
      role={outcome.tone === 'danger' ? 'alert' : 'status'}
      className="fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] items-start gap-3 rounded-lg border border-line bg-overlay p-3 shadow-overlay"
    >
      <Icon
        className={cn('mt-0.5 h-4 w-4 shrink-0', TONE_CLASS[outcome.tone])}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{outcome.title}</p>
        <p className="mt-0.5 text-xs text-text-muted">{outcome.message}</p>
      </div>
      <IconButton
        label="Dismiss"
        size="sm"
        onClick={() => {
          setOutcome(null);
        }}
      >
        <LuX className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  );
};

export default GithubReturnToast;
