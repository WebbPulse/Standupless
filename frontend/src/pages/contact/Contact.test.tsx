/**
 * The contact page gives one email address and says what it answers.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { LEGAL_CONTACT_EMAIL } from '../../lib/legal';
import Contact, { CONTACT_TITLE } from './Contact';

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: false,
    isLoading: false,
    isBusy: false,
    user: null,
    login: vi.fn(),
    logout: vi.fn(() => Promise.resolve()),
    checkAuthStatus: vi.fn(() => Promise.resolve()),
  }),
}));

describe('Contact', () => {
  it('links the contact address and names each kind of question', () => {
    render(
      <MemoryRouter>
        <Contact />
      </MemoryRouter>
    );

    expect(
      screen.getByRole('heading', { level: 1, name: 'Contact' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: new RegExp(LEGAL_CONTACT_EMAIL) })
    ).toHaveAttribute('href', `mailto:${LEGAL_CONTACT_EMAIL}`);
    for (const topic of ['Support', 'Billing', 'Privacy and security']) {
      expect(screen.getByRole('heading', { name: topic })).toBeInTheDocument();
    }
    expect(document.title).toBe(CONTACT_TITLE);
  });
});
