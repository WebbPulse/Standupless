/**
 * The public pricing page at `/pricing`: the three plans side by side with
 * both billing intervals printed on each card, then the billing questions a
 * buyer asks before paying. Both prices are always in the markup rather than
 * behind a toggle, so the prerendered HTML a crawler reads carries every
 * number the plans are sold at.
 */

import React, { useEffect } from 'react';
import { LuCheck } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import PublicShell from '../../components/layout/PublicShell';
import {
  PILL_PRIMARY,
  PILL_SECONDARY,
  PUBLIC_CONTAINER,
} from '../../components/layout/publicStyles';
import TextLink from '../../components/ui/link';
import { cn } from '../../lib/cn';
import { CONTACT_PATH, REFUNDS_PATH, TERMS_PATH } from '../../lib/paths';
import { formatPrice, PLANS, type PricedPlan } from '../../lib/pricing';

/** The document title while this page is showing. */
export const PRICING_TITLE = 'Pricing | Standupless';

/** The meta description while this page is showing. */
export const PRICING_DESCRIPTION =
  'Standupless plans: Free at $0, Standard at $6 per seat a month billed annually or $8 monthly, and Business at $10 annually or $12 monthly.';

/** Plans shown with a notice instead of a sign up, because they are not on sale yet. */
const COMING_SOON: ReadonlySet<PricedPlan['id']> = new Set(['business']);

/** The price block of one card: the annual rate large, the monthly rate under it. */
const PlanPrice: React.FC<{ plan: PricedPlan }> = ({ plan }) => {
  if (plan.price.monthly === 0) {
    return (
      <div className="space-y-1">
        <p className="flex items-baseline gap-2">
          <span className="text-[40px] leading-none font-semibold tracking-[-0.04em] text-text">
            {formatPrice(0)}
          </span>
        </p>
        <p className="text-[13px] text-text-muted">Free for every workspace</p>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <p className="flex items-baseline gap-2">
        <span className="text-[40px] leading-none font-semibold tracking-[-0.04em] text-text">
          {formatPrice(plan.price.annual)}
        </span>
        <span className="text-[13px] text-text-muted">
          per seat a month, billed annually
        </span>
      </p>
      <p className="text-[13px] text-text-muted">
        or {formatPrice(plan.price.monthly)} per seat billed monthly
      </p>
    </div>
  );
};

/** One plan's card: name, price, the call to action and what it includes. */
const PlanCard: React.FC<{ plan: PricedPlan }> = ({ plan }) => {
  const comingSoon = COMING_SOON.has(plan.id);
  return (
    <li
      aria-labelledby={`plan-${plan.id}`}
      className={cn(
        'relative flex flex-col gap-8 bg-bg p-6 sm:p-8',
        plan.highlighted === true && 'bg-surface'
      )}
    >
      {plan.highlighted === true && (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,var(--accent),transparent)]"
        />
      )}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <h2
            id={`plan-${plan.id}`}
            className="text-[15px] font-medium text-text"
          >
            {plan.name}
          </h2>
          {comingSoon && (
            <span className="rounded-full border border-line-strong px-2 py-0.5 text-[11px] text-text-muted">
              Coming soon
            </span>
          )}
        </div>
        <p className="text-sm text-text-muted">{plan.summary}</p>
      </div>
      <PlanPrice plan={plan} />
      <Link
        to={comingSoon ? CONTACT_PATH : '/register'}
        className={cn(
          plan.highlighted === true ? PILL_PRIMARY : PILL_SECONDARY,
          'h-9 w-full px-4 text-[13px]'
        )}
      >
        {comingSoon ? 'Contact us' : 'Get started'}
      </Link>
      <div className="space-y-3 border-t border-line pt-6">
        <p className="text-[13px] text-text-faint">
          {plan.includesPlan === undefined
            ? 'Includes'
            : `Everything in ${plan.includesPlan}, plus`}
        </p>
        <ul className="space-y-2.5 text-sm text-text-muted">
          {plan.features.map((feature) => (
            <li key={feature} className="flex gap-2.5">
              <LuCheck
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-accent"
              />
              {feature}
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
};

/** One billing question and its answer. */
interface Question {
  question: string;
  answer: React.ReactNode;
}

const QUESTIONS: Question[] = [
  {
    question: 'What counts as a seat?',
    answer:
      'Every member of the workspace except guests. The seat count follows your members as people join and leave, and a change partway through a billing period is prorated on the next invoice.',
  },
  {
    question: 'How do I pay?',
    answer:
      'A workspace owner or admin chooses a plan and pays by card through Stripe. Standupless never sees or stores your card number. Prices are in US dollars.',
  },
  {
    question: 'Can I cancel?',
    answer: (
      <>
        Yes, at any time from the billing portal. The workspace keeps its plan
        until the end of the period you paid for, then moves to Free. Past
        charges are not refunded. The{' '}
        <TextLink to={REFUNDS_PATH}>cancellation and refund policy</TextLink>{' '}
        has the details.
      </>
    ),
  },
  {
    question: 'What happens to my data on Free?',
    answer:
      'Nothing is deleted when a workspace moves to Free. You can keep reading and editing everything; you only cannot add teams, members, webhooks or API keys past the Free limits.',
  },
  {
    question: 'Who do I ask about something else?',
    answer: (
      <>
        Write to the address on the{' '}
        <TextLink to={CONTACT_PATH}>contact</TextLink> page. Use of every plan
        is covered by the <TextLink to={TERMS_PATH}>Terms of Service</TextLink>.
      </>
    ),
  },
];

/** Sets the page title and description while the page is mounted. */
const usePricingMeta = (): void => {
  useEffect(() => {
    const previousTitle = document.title;
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]'
    );
    const previousDescription = meta?.content;
    document.title = PRICING_TITLE;
    if (meta !== null) meta.content = PRICING_DESCRIPTION;
    return () => {
      document.title = previousTitle;
      if (meta !== null && previousDescription !== undefined) {
        meta.content = previousDescription;
      }
    };
  }, []);
};

/** The pricing page. */
const Pricing: React.FC = () => {
  usePricingMeta();

  return (
    <PublicShell>
      <section
        aria-labelledby="pricing-title"
        className="relative overflow-hidden"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(40%_50%_at_50%_0%,var(--accent-soft),transparent_70%)] opacity-50"
        />
        <div
          className={cn(
            PUBLIC_CONTAINER,
            'relative space-y-5 pt-20 pb-14 text-center sm:pt-28'
          )}
        >
          <h1
            id="pricing-title"
            className="text-[40px] leading-[1.05] font-semibold tracking-[-0.045em] text-text sm:text-[56px]"
          >
            Pricing
          </h1>
          <p className="mx-auto max-w-xl text-[17px] leading-relaxed text-text-muted">
            Start free with unlimited issues. Pay per seat when your team needs
            more teams, guests or storage.
          </p>
        </div>
        <div className={cn(PUBLIC_CONTAINER, 'relative pb-24 sm:pb-32')}>
          <ul className="grid gap-px overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-3">
            {PLANS.map((plan) => (
              <PlanCard key={plan.id} plan={plan} />
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="faq-title" className="border-t border-line">
        <div
          className={cn(
            PUBLIC_CONTAINER,
            'grid gap-12 py-24 sm:py-32 lg:grid-cols-[1fr_2fr] lg:gap-20'
          )}
        >
          <h2
            id="faq-title"
            className="text-[32px] leading-[1.08] font-semibold tracking-[-0.035em] text-text sm:text-[40px]"
          >
            Billing questions
          </h2>
          <dl className="divide-y divide-line border-y border-line">
            {QUESTIONS.map((item) => (
              <div key={item.question} className="space-y-2 py-6">
                <dt className="text-[15px] font-medium text-text">
                  {item.question}
                </dt>
                <dd className="text-sm leading-relaxed text-text-muted">
                  {item.answer}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </PublicShell>
  );
};

export default Pricing;
