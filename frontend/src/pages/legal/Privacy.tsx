/**
 * The privacy policy, in plain language: what Standupless stores, where it
 * runs, who else touches the data, how long it is kept, how to delete it, and
 * why the site shows no cookie banner.
 */

import React from 'react';
import TextLink from '../../components/ui/link';
import LegalPage, { ContactLink, LegalList, LegalSection } from './LegalPage';
import { TERMS_PATH } from '../../lib/paths';

/** The privacy policy page. */
const Privacy: React.FC = () => (
  <LegalPage
    title="Privacy Policy"
    summary="What Standupless collects, why, where it is kept, and how to get it deleted."
  >
    <LegalSection heading="1. Who runs Standupless">
      <p>
        Standupless is a personal project run by an individual software
        engineer, not a company. It is in active development. This policy has
        not been reviewed by a lawyer; it is an honest description of how the
        service handles data. Questions go to <ContactLink />.
      </p>
    </LegalSection>

    <LegalSection heading="2. What we collect">
      <LegalList>
        <li>
          <strong className="text-text">Account details:</strong> your email
          address, an optional display name, whether your email is verified, and
          a hash of your password. If you add a passkey, a second factor or an
          API key, the public key, the encrypted second factor secret or a hash
          of the key is stored with your account.
        </li>
        <li>
          <strong className="text-text">Sign in with a provider:</strong> if you
          sign in with Google or GitHub, we receive your email address and name
          from that provider and store a link between the two accounts.
        </li>
        <li>
          <strong className="text-text">Workspace content:</strong> the
          workspaces, teams, issues, comments, projects, cycles, views, labels
          and share links you and your teammates create, and who created or
          changed them.
        </li>
        <li>
          <strong className="text-text">Attachments:</strong> files you upload
          to an issue or comment.
        </li>
        <li>
          <strong className="text-text">Operational logs:</strong> request logs,
          error reports and traces, which include IP addresses and account
          identifiers, used to keep the service running and secure.
        </li>
      </LegalList>
      <p>
        We do not use analytics, advertising or tracking tools, and we do not
        sell or share your data for marketing.
      </p>
    </LegalSection>

    <LegalSection heading="3. The GitHub App">
      <p>
        A workspace admin can install the Standupless GitHub App on a GitHub
        account or organization. It links pull requests and commits to issues.
        With it installed, Standupless receives events for pull requests, pushes
        and the installation itself, and can read issues, pull requests,
        repository metadata, branch names and commit messages in the
        repositories you choose. It stores the pull request number, title, state
        and author login for linked issues. It writes only its own pull request
        comment and its own check run, and asks for no organization or account
        permissions. The GitHub sign in used during installation only proves who
        you are; that token is revoked straight away. You can remove the app
        from GitHub at any time.
      </p>
    </LegalSection>

    <LegalSection heading="4. Where it lives and who else touches it">
      <p>
        Standupless runs on Amazon Web Services in the US West (Oregon) region,
        us-west-2. Data is encrypted in transit and at rest. The services
        involved are:
      </p>
      <LegalList>
        <li>
          <strong className="text-text">Amazon Web Services:</strong> hosting,
          the database, attachment storage in Amazon S3, and email through
          Amazon SES for verification, password reset, invitation and
          notification messages.
        </li>
        <li>
          <strong className="text-text">GitHub:</strong> only when you connect
          the GitHub App or sign in with GitHub. Connected installations show
          their GitHub avatar, which your browser loads from GitHub.
        </li>
        <li>
          <strong className="text-text">Google:</strong> only when you sign in
          with Google.
        </li>
      </LegalList>
      <p>No other third party receives your data.</p>
    </LegalSection>

    <LegalSection heading="5. Cookies and browser storage">
      <p>
        Standupless shows no cookie banner because everything it stores in your
        browser is strictly necessary for the service or remembers a choice you
        made:
      </p>
      <LegalList>
        <li>
          One cookie, <code className="text-text">wp_refresh</code>, keeps you
          signed in. It is HttpOnly, Secure, limited to the sign in endpoints,
          and removed when you sign out.
        </li>
        <li>
          Local storage remembers your light or dark theme and which teams you
          expanded in the sidebar.
        </li>
        <li>
          Session storage remembers that you dismissed the development notice,
          until you next sign in.
        </li>
      </LegalList>
      <p>
        There are no analytics, advertising or third party cookies, and fonts
        are served from Standupless itself.
      </p>
    </LegalSection>

    <LegalSection heading="6. How long we keep it">
      <LegalList>
        <li>Account and workspace data: until you or an admin delete it.</li>
        <li>Operational logs and traces: 7 days.</li>
        <li>Replaced or deleted versions of attachments: 7 days.</li>
        <li>Database backups: up to 35 days.</li>
      </LegalList>
    </LegalSection>

    <LegalSection heading="7. Deleting your data">
      <p>
        A workspace owner or admin can delete a team from its settings, which
        permanently removes its issues, comments, attachments, cycles, views and
        GitHub links. To delete a whole workspace or your account, email{' '}
        <ContactLink /> from the address on the account and we will erase it and
        confirm. Deleted data leaves the backups as they age out.
      </p>
    </LegalSection>

    <LegalSection heading="8. Your rights">
      <p>
        You can ask for a copy of your data, a correction, or deletion at any
        time, wherever you live. Email <ContactLink /> and expect a reply within
        30 days.
      </p>
    </LegalSection>

    <LegalSection heading="9. Children">
      <p>
        Standupless is not meant for anyone under 16, and we do not knowingly
        collect data from them.
      </p>
    </LegalSection>

    <LegalSection heading="10. Security">
      <p>
        If you find a security issue, please report it privately to{' '}
        <ContactLink /> with enough detail to reproduce it, and give us a
        reasonable chance to fix it before sharing it. Please do not access
        other people&apos;s data or disrupt the service while testing.
      </p>
    </LegalSection>

    <LegalSection heading="11. Changes">
      <p>
        When this policy changes, the effective date above changes with it. See
        also the <TextLink to={TERMS_PATH}>Terms of Service</TextLink>.
      </p>
    </LegalSection>
  </LegalPage>
);

export default Privacy;
