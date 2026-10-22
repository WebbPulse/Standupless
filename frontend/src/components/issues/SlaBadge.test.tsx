/**
 * The SLA badge: a quiet countdown while on track, the same countdown in
 * amber once at risk, "Breached" in red after the deadline, nothing without
 * an SLA, a move from at risk to breached while it stays on screen, and a
 * paused timer that holds its time left instead of ticking.
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlaFields } from '../../lib/sla';
import SlaBadge from './SlaBadge';

const NOW = new Date('2026-10-07T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SlaBadge', () => {
  it('counts down quietly while on track', () => {
    render(
      <SlaBadge
        issue={{
          sla_started_at: '2026-10-07T00:00:00Z',
          sla_breaches_at: '2026-10-09T16:00:00Z',
          sla_status: 'on_track',
        }}
      />
    );

    const badge = screen.getByText('Breaches in 2d 4h').closest('span[title]');
    expect(badge).toHaveAttribute('data-sla-status', 'on_track');
    expect(badge).toHaveClass('text-text-muted');
    expect(badge?.getAttribute('title')).toMatch(/^SLA breaches /);
  });

  it('turns amber at risk and red once breached', () => {
    const issue: SlaFields = {
      sla_started_at: '2026-10-07T00:00:00Z',
      sla_breaches_at: '2026-10-07T12:30:00Z',
      sla_status: 'at_risk',
    };
    render(<SlaBadge issue={issue} />);

    const atRisk = screen.getByText('Breaches in 30m').closest('span[title]');
    expect(atRisk).toHaveClass('text-warning');

    act(() => {
      vi.advanceTimersByTime(31 * 60000);
    });

    const breached = screen.getByText('Breached 1m ago').closest('span[title]');
    expect(breached).toHaveAttribute('data-sla-status', 'breached');
    expect(breached).toHaveClass('text-danger');
  });

  it('holds a paused timer at the time it had left', () => {
    render(
      <SlaBadge
        issue={{
          sla_started_at: '2026-10-07T00:00:00Z',
          sla_breaches_at: '2026-10-07T12:30:00Z',
          sla_paused_at: '2026-10-07T11:00:00Z',
          sla_status: 'on_track',
        }}
      />
    );

    const held = screen.getByText('Paused, 1h 30m left').closest('span[title]');
    expect(held).toHaveAttribute('data-sla-paused', 'true');
    expect(held).toHaveAttribute('data-sla-status', 'on_track');

    act(() => {
      vi.advanceTimersByTime(3 * 60 * 60000);
    });

    expect(screen.getByText('Paused, 1h 30m left')).toBeInTheDocument();
  });

  it('draws nothing without an SLA', () => {
    const { container } = render(
      <SlaBadge
        issue={{
          sla_started_at: null,
          sla_breaches_at: null,
          sla_status: 'none',
        }}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });
});
