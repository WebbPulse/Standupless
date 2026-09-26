/**
 * The frame the privacy policy and the terms render in: the public shell, a
 * heading with the effective date, and a readable column of numbered sections.
 */

import React, { useEffect } from 'react';
import PublicShell from '../../components/layout/PublicShell';
import { LEGAL_CONTACT_EMAIL, LEGAL_EFFECTIVE_DATE } from '../../lib/legal';

/** Props for LegalPage: the page heading, its tab title and its sections. */
export interface LegalPageProps {
  title: string;
  /** A sentence under the heading that says what the page covers. */
  summary: string;
  children: React.ReactNode;
}

/** A heading, the effective date and the body in a narrow column. */
export const LegalPage: React.FC<LegalPageProps> = ({
  title,
  summary,
  children,
}) => {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} | Standupless`;
    return () => {
      document.title = previous;
    };
  }, [title]);

  return (
    <PublicShell className="flex justify-center px-4 pt-16 pb-24">
      <article className="w-full max-w-2xl space-y-10">
        <header className="space-y-3">
          <h1 className="text-[32px] leading-[1.15] font-semibold tracking-[-0.03em] text-text">
            {title}
          </h1>
          <p className="text-sm text-text-muted">{summary}</p>
          <p className="text-xs text-text-faint">
            Effective {LEGAL_EFFECTIVE_DATE}
          </p>
        </header>
        <div className="space-y-8 text-sm leading-relaxed text-text-muted">
          {children}
        </div>
      </article>
    </PublicShell>
  );
};

/** Props for LegalSection: its heading and its paragraphs or lists. */
export interface LegalSectionProps {
  heading: string;
  children: React.ReactNode;
}

/** One titled section of a legal page. */
export const LegalSection: React.FC<LegalSectionProps> = ({
  heading,
  children,
}) => (
  <section className="space-y-3">
    <h2 className="text-base font-semibold text-text">{heading}</h2>
    {children}
  </section>
);

/** A bulleted list inside a legal section. */
export const LegalList: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => <ul className="list-disc space-y-2 pl-5">{children}</ul>;

/** The contact address as a mail link in the accent colour. */
export const ContactLink: React.FC = () => (
  <a
    href={`mailto:${LEGAL_CONTACT_EMAIL}`}
    className="rounded-xs text-accent underline-offset-2 hover:underline"
  >
    {LEGAL_CONTACT_EMAIL}
  </a>
);

export default LegalPage;
