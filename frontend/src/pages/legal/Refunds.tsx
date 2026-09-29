/**
 * The cancellation and refund policy, in plain language: a paid plan can be
 * cancelled at any time, keeps working until the end of the period already
 * paid for, and past charges are not refunded.
 */

import React from 'react';
import TextLink from '../../components/ui/link';
import LegalPage, { ContactLink, LegalList, LegalSection } from './LegalPage';
import { PRICING_PATH, TERMS_PATH } from '../../lib/paths';

/** The cancellation and refund policy page. */
const Refunds: React.FC = () => (
  <LegalPage
    title="Cancellation and Refund Policy"
    summary="How to cancel a paid plan, what happens after, and when money is returned."
  >
    <LegalSection heading="1. Cancel anytime">
      <p>
        A workspace owner or admin can cancel a paid plan at any time from the
        billing portal in the workspace settings. There is no notice period and
        no cancellation fee.
      </p>
    </LegalSection>

    <LegalSection heading="2. Access until the end of the paid period">
      <p>
        After you cancel, the workspace keeps its paid plan until the end of the
        monthly or annual period you already paid for. It then moves to the Free
        plan. Nothing is deleted when that happens; the Free limits apply from
        then on.
      </p>
    </LegalSection>

    <LegalSection heading="3. No refunds">
      <p>
        Payments are not refunded, in full or in part, including for the unused
        part of a monthly or annual period, for seats removed partway through a
        period, or for a plan cancelled early.
      </p>
      <LegalList>
        <li>
          Removing seats partway through a period lowers the next invoice rather
          than returning money for the current one.
        </li>
        <li>
          If you were charged by mistake, such as a duplicate charge, write to{' '}
          <ContactLink /> and it will be corrected.
        </li>
      </LegalList>
    </LegalSection>

    <LegalSection heading="4. Failed payments">
      <p>
        If a renewal payment fails, the workspace moves to the Free plan until
        the payment goes through, then returns to its paid plan.
      </p>
    </LegalSection>

    <LegalSection heading="5. Prices and changes">
      <p>
        Current prices are on the <TextLink to={PRICING_PATH}>pricing</TextLink>{' '}
        page. A price change applies from your next billing period, and you will
        be told before it does. This policy is part of the{' '}
        <TextLink to={TERMS_PATH}>Terms of Service</TextLink>.
      </p>
    </LegalSection>

    <LegalSection heading="6. Questions">
      <p>
        Write to <ContactLink /> about anything on your bill.
      </p>
    </LegalSection>
  </LegalPage>
);

export default Refunds;
