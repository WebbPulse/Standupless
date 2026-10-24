/**
 * The error boundary every route renders inside. Without one, a page that
 * throws while rendering, or a lazy chunk that fails to load, unmounts the
 * whole React root and leaves an empty screen that never recovers.
 *
 * A chunk that fails to load is almost always a tab holding a build that a
 * deploy has since pruned, so the boundary reloads once to pick up the current
 * one, and shows the cold start screen while it does. Any other error, and a
 * chunk that still fails after that reload, shows an error state with a way to
 * try again. Moving to another address clears the error, so the sidebar and
 * the back button still lead somewhere that works.
 */

import React from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import {
  isChunkLoadError,
  reloadOnceForChunkError,
} from '../../lib/chunkReload';
import BootSplash from '../layout/BootSplash';
import Button from '../ui/button';

/** What a fallback is handed: the error and how to recover from it. */
export interface RouteErrorFallbackProps {
  error: unknown;
  /** Renders the page again, or reloads when the failure was a chunk. */
  retry: () => void;
}

/** Props for RouteErrorBoundary: the page and an optional fallback. */
export interface RouteErrorBoundaryProps {
  children: ReactNode;
  /** Draws the error state. Defaults to {@link RouteErrorState}. */
  fallback?: React.ComponentType<RouteErrorFallbackProps>;
  /** Started for a chunk error. Defaults to reloading at most once a minute. */
  reloadForChunk?: () => boolean;
}

/** Props for the class that does the catching. */
interface BoundaryProps extends RouteErrorBoundaryProps {
  resetKey: string;
}

/** What the boundary holds: the caught error, and whether a reload is on. */
interface BoundaryState {
  error: unknown;
  reloading: boolean;
  resetKey: string;
}

/** The message and actions shown in place of a page that failed. */
export const RouteErrorState: React.FC<RouteErrorFallbackProps> = ({
  error,
  retry,
}) => (
  <div
    role="alert"
    className="mx-auto flex max-w-md flex-col items-start gap-3 px-4 py-16"
  >
    <h1 className="text-lg font-semibold text-text">
      This page could not be shown
    </h1>
    <p className="text-sm text-text-muted">
      {isChunkLoadError(error)
        ? 'Standupless was updated while this tab was open. Reload to get the latest version.'
        : 'Something went wrong while showing this page. Try again, or reload if it keeps happening.'}
    </p>
    <div className="flex items-center gap-2">
      <Button size="sm" variant="primary" onClick={retry}>
        {isChunkLoadError(error) ? 'Reload' : 'Try again'}
      </Button>
      {!isChunkLoadError(error) && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            globalThis.location.reload();
          }}
        >
          Reload page
        </Button>
      )}
    </div>
  </div>
);

/** Catches what the page throws and draws the fallback in its place. */
class Boundary extends React.Component<BoundaryProps, BoundaryState> {
  /** Starts with nothing caught. */
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { error: null, reloading: false, resetKey: props.resetKey };
  }

  /** Holds the error so the next render draws the fallback. */
  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: error ?? new Error('Unknown render error') };
  }

  /** Clears a caught error once the address moves on. */
  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState
  ): Partial<BoundaryState> | null {
    if (props.resetKey === state.resetKey) return null;
    return { error: null, reloading: false, resetKey: props.resetKey };
  }

  /** Reloads once for a chunk that failed to load. */
  componentDidCatch(error: unknown): void {
    if (!isChunkLoadError(error)) return;
    const reload = this.props.reloadForChunk ?? reloadOnceForChunkError;
    if (reload()) this.setState({ reloading: true });
  }

  /** Renders the page again, or reloads when a chunk is what failed. */
  retry = (): void => {
    if (isChunkLoadError(this.state.error)) {
      globalThis.location.reload();
      return;
    }
    this.setState({ error: null, reloading: false });
  };

  /** The page, the reload screen or the fallback. */
  render(): ReactNode {
    const { error, reloading } = this.state;
    if (error === null) return this.props.children;
    if (reloading) return <BootSplash label="Loading the latest version" />;
    const Fallback = this.props.fallback ?? RouteErrorState;
    return <Fallback error={error} retry={this.retry} />;
  }
}

/** Keys the boundary on the address, so navigating away recovers. */
export const RouteErrorBoundary: React.FC<RouteErrorBoundaryProps> = (
  props
) => {
  const { pathname } = useLocation();
  return <Boundary {...props} resetKey={pathname} />;
};

export default RouteErrorBoundary;
