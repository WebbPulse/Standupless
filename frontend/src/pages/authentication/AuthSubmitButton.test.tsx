/**
 * The auth primary action must carry the brand accent and nothing from the app
 * palette. An earlier version built on a Button variant, and because Tailwind
 * emits the plain palette utilities after the arbitrary-value brand ones, the
 * app accent won and the button rendered in the wrong colour.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AuthSubmitButton from './AuthSubmitButton';

describe('AuthSubmitButton', () => {
  it('carries the brand accent and no app palette colour', () => {
    render(<AuthSubmitButton>Sign in</AuthSubmitButton>);
    const button = screen.getByRole('button', { name: 'Sign in' });
    expect(button).toHaveClass('bg-[var(--brand-accent)]');
    expect(button).toHaveClass('text-[var(--brand-accent-foreground)]');
    expect(button.className).not.toMatch(/(^|\s)bg-accent(\s|$)/);
    expect(button.className).not.toMatch(/(^|\s)text-on-accent(\s|$)/);
    expect(button.className).not.toMatch(/(^|\s)text-text-muted(\s|$)/);
  });

  it('submits when asked to and passes props through', () => {
    render(
      <AuthSubmitButton type="submit" disabled data-testid="submit">
        Create account
      </AuthSubmitButton>
    );
    const button = screen.getByTestId('submit');
    expect(button).toHaveAttribute('type', 'submit');
    expect(button).toBeDisabled();
  });

  it('keeps a caller className', () => {
    render(<AuthSubmitButton className="mt-2">Send</AuthSubmitButton>);
    expect(screen.getByRole('button', { name: 'Send' })).toHaveClass('mt-2');
  });
});
