/**
 * The public contact page at `/contact`: one address for every question, and
 * the kinds of question it answers, so a buyer, a member and a security
 * researcher each know where to write.
 */

import React, { useEffect } from 'react';
import {
  LuCreditCard,
  LuLifeBuoy,
  LuMail,
  LuShieldCheck,
} from 'react-icons/lu';
import PublicShell from '../../components/layout/PublicShell';
import { PUBLIC_CONTAINER } from '../../components/layout/publicStyles';
import TextLink from '../../components/ui/link';
import { cn } from '../../lib/cn';
import { LEGAL_CONTACT_EMAIL } from '../../lib/legal';
import { PRIVACY_PATH, REFUNDS_PATH } from '../../lib/paths';

/** The document title while this page is showing. */
export const CONTACT_TITLE = 'Contact | Standupless';

/** One kind of question the address answers. */
interface Topic {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
}

const ICON = 'h-4 w-4';

const TOPICS: Topic[] = [
  {
    icon: <LuLifeBuoy className={ICON} />,
    title: 'Support',
    body: 'Something not working, a question about a feature, or an idea for one. Include your workspace URL and what you expected to happen.',
  },
  {
    icon: <LuCreditCard className={ICON} />,
    title: 'Billing',
    body: (
      <>
        Plans, invoices, seat counts and cancellations. The{' '}
        <TextLink to={REFUNDS_PATH}>refund policy</TextLink> covers what happens
        when you cancel.
      </>
    ),
  },
  {
    icon: <LuShieldCheck className={ICON} />,
    title: 'Privacy and security',
    body: (
      <>
        Data requests, account deletion questions and vulnerability reports. The{' '}
        <TextLink to={PRIVACY_PATH}>privacy policy</TextLink> says what is
        collected and how to have it removed.
      </>
    ),
  },
];

/** The contact page. */
const Contact: React.FC = () => {
  useEffect(() => {
    const previous = document.title;
    document.title = CONTACT_TITLE;
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <PublicShell>
      <section
        aria-labelledby="contact-title"
        className={cn(
          PUBLIC_CONTAINER,
          'space-y-14 pt-20 pb-24 sm:pt-28 sm:pb-32'
        )}
      >
        <div className="grid gap-10 lg:grid-cols-2 lg:items-end lg:gap-20">
          <div className="space-y-5">
            <h1
              id="contact-title"
              className="text-[40px] leading-[1.05] font-semibold tracking-[-0.045em] text-text sm:text-[56px]"
            >
              Contact
            </h1>
            <p className="max-w-md text-[17px] leading-relaxed text-text-muted">
              Standupless is built and run by an individual software engineer.
              Every message reaches that person directly.
            </p>
          </div>
          <a
            href={`mailto:${LEGAL_CONTACT_EMAIL}`}
            className="group flex items-center gap-4 rounded-xl border border-line-strong bg-surface p-5 transition-colors hover:bg-raised lg:justify-self-end"
          >
            <span
              aria-hidden="true"
              className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-soft text-accent"
            >
              <LuMail className="h-5 w-5" />
            </span>
            <span className="space-y-0.5">
              <span className="block text-[13px] text-text-muted">Email</span>
              <span className="block text-[17px] font-medium text-text">
                {LEGAL_CONTACT_EMAIL}
              </span>
            </span>
          </a>
        </div>
        <ul className="grid gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-3">
          {TOPICS.map((topic) => (
            <li
              key={topic.title}
              className="flex flex-col gap-2 bg-bg p-6 sm:p-7"
            >
              <span aria-hidden="true" className="flex text-text-muted">
                {topic.icon}
              </span>
              <h2 className="pt-3 text-[15px] font-medium text-text">
                {topic.title}
              </h2>
              <p className="text-sm leading-relaxed text-text-muted">
                {topic.body}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </PublicShell>
  );
};

export default Contact;
