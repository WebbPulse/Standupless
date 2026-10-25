/**
 * The hover card primitive: that it opens only once a hover rests, stays open
 * while the pointer crosses into the card, closes on leave, Escape and a press,
 * opens from keyboard focus, and never opens from touch.
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOVER_CARD_CLOSE_DELAY_MS,
  HOVER_CARD_OPEN_DELAY_MS,
  HoverCardPanel,
  hoverCardTriggerProps,
  useHoverCard,
} from './hover-card';

/** A trigger and its card, as a reference renders them. */
const Harness: React.FC = () => {
  const controller = useHoverCard();
  return (
    <>
      <a href="#ENG-1" {...hoverCardTriggerProps(controller)}>
        ENG-1
      </a>
      <HoverCardPanel controller={controller}>
        {() => <p>Preview of ENG-1</p>}
      </HoverCardPanel>
    </>
  );
};

const trigger = () => screen.getByRole('link', { name: 'ENG-1' });

const card = () => screen.queryByText('Preview of ENG-1');

const wait = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

const hover = () => {
  fireEvent.pointerEnter(trigger(), { pointerType: 'mouse' });
  wait(HOVER_CARD_OPEN_DELAY_MS);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HoverCard', () => {
  it('opens only once the hover rests', () => {
    render(<Harness />);
    fireEvent.pointerEnter(trigger(), { pointerType: 'mouse' });
    wait(HOVER_CARD_OPEN_DELAY_MS - 50);
    expect(card()).toBeNull();

    wait(50);

    expect(card()).toBeInTheDocument();
  });

  it('stays open while the pointer moves into the card, and closes after it leaves', () => {
    render(<Harness />);
    hover();

    fireEvent.pointerLeave(trigger());
    const panel = card()?.parentElement;
    if (panel === null || panel === undefined) throw new Error('no panel');
    fireEvent.pointerEnter(panel);
    wait(HOVER_CARD_CLOSE_DELAY_MS * 2);
    expect(card()).toBeInTheDocument();

    fireEvent.pointerLeave(panel);
    wait(HOVER_CARD_CLOSE_DELAY_MS);

    expect(card()).toBeNull();
  });

  it('closes on Escape', () => {
    render(<Harness />);
    hover();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(card()).toBeNull();
  });

  it('closes on a press and stays shut until the pointer leaves', () => {
    render(<Harness />);
    hover();

    fireEvent.pointerDown(trigger());
    fireEvent.pointerEnter(trigger(), { pointerType: 'mouse' });
    wait(HOVER_CARD_OPEN_DELAY_MS);

    expect(card()).toBeNull();
  });

  it('never opens from touch', () => {
    render(<Harness />);
    fireEvent.pointerEnter(trigger(), { pointerType: 'touch' });
    wait(HOVER_CARD_OPEN_DELAY_MS);

    expect(card()).toBeNull();
  });

  it('opens from keyboard focus and closes on blur', () => {
    render(<Harness />);
    const link = trigger();
    vi.spyOn(link, 'matches').mockReturnValue(true);

    fireEvent.focus(link);
    wait(HOVER_CARD_OPEN_DELAY_MS);
    expect(card()).toBeInTheDocument();

    fireEvent.blur(link);
    expect(card()).toBeNull();
  });
});
