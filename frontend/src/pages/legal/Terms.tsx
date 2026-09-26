/**
 * The terms of service, in plain language: who runs Standupless, what an
 * account holder agrees to, who owns the content, and the limits on what the
 * service promises while it is in development.
 */

import React from 'react';
import TextLink from '../../components/ui/link';
import LegalPage, { ContactLink, LegalList, LegalSection } from './LegalPage';
import { PRIVACY_PATH } from '../../lib/paths';
import { LEGAL_GOVERNING_STATE } from '../../lib/legal';

/** The terms of service page. */
const Terms: React.FC = () => (
  <LegalPage
    title="Terms of Service"
    summary="The rules for using Standupless, written to be read."
  >
    <LegalSection heading="1. Who we are">
      <p>
        Standupless is a personal project run by an individual software
        engineer, not a company. These terms have not been reviewed by a lawyer.
        By creating an account or using Standupless you agree to them. Questions
        go to <ContactLink />.
      </p>
    </LegalSection>

    <LegalSection heading="2. The service is in development">
      <p>
        Standupless is under active development. Features change, things break,
        and the service may be unavailable at times. It is offered as is,
        without any warranty, and there is no service level commitment. Keep
        your own copy of anything you cannot afford to lose.
      </p>
    </LegalSection>

    <LegalSection heading="3. Your account">
      <LegalList>
        <li>You must be at least 16 to use Standupless.</li>
        <li>
          Give a real email address and keep your password, passkeys and API
          keys to yourself. You are responsible for what happens under your
          account.
        </li>
        <li>
          Tell us at <ContactLink /> if you think someone else has access to it.
        </li>
      </LegalList>
    </LegalSection>

    <LegalSection heading="4. Your content">
      <p>
        You and your workspace own what you put into Standupless: issues,
        comments, attachments and everything else. You give us permission only
        to store, process and show it to the people you share it with, which is
        what running the service takes. Workspace owners and admins decide who
        can see a workspace and can remove its content.
      </p>
    </LegalSection>

    <LegalSection heading="5. Acceptable use">
      <p>Do not use Standupless to:</p>
      <LegalList>
        <li>break the law or infringe someone else&apos;s rights;</li>
        <li>upload malware or content you have no right to share;</li>
        <li>
          probe, overload or get around the limits and security of the service,
          other than reporting a vulnerability as the privacy policy describes;
        </li>
        <li>access workspaces or data that are not yours.</li>
      </LegalList>
      <p>
        We may suspend or close an account that does, and we will tell you why
        when we can.
      </p>
    </LegalSection>

    <LegalSection heading="6. GitHub">
      <p>
        Connecting the GitHub App is optional. When you connect it, your use of
        GitHub stays under GitHub&apos;s own terms, and you can disconnect it
        from GitHub at any time.
      </p>
    </LegalSection>

    <LegalSection heading="7. Price">
      <p>
        Standupless is free while it is in development. If that changes, we will
        say so well in advance, and nothing will be charged without your
        agreement.
      </p>
    </LegalSection>

    <LegalSection heading="8. Ending your use">
      <p>
        You can stop using Standupless at any time and ask for your account to
        be deleted, as the <TextLink to={PRIVACY_PATH}>Privacy Policy</TextLink>{' '}
        explains. We may wind the service down; if we do, we will give
        reasonable notice before it closes.
      </p>
    </LegalSection>

    <LegalSection heading="9. Limits on liability">
      <p>
        To the extent the law allows, Standupless and the person who runs it are
        not liable for indirect or consequential losses, or for lost data,
        profits or business, arising from your use of the service.
      </p>
    </LegalSection>

    <LegalSection heading="10. Governing law">
      <p>
        These terms are governed by the laws of the State of{' '}
        {LEGAL_GOVERNING_STATE}, United States.
      </p>
    </LegalSection>

    <LegalSection heading="11. Changes">
      <p>
        When these terms change, the effective date above changes with it. Using
        Standupless after a change means you accept the new terms.
      </p>
    </LegalSection>
  </LegalPage>
);

export default Terms;
