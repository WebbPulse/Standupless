# The GitHub App behind the integrations domain

The App is owned by the WebbPulse organization and created through GitHub's App
manifest flow, which fills in the settings below from a manifest and hands back the
App's id, keys and webhook secret once. Nothing in this repository creates it:
creating an App issues a private key, and a private key that passed through a
build log would have to be treated as compromised the moment it existed.

The App is public, so a customer in any GitHub organization installs it the same
way: Connect GitHub on the workspace settings page sends them to
`https://github.com/apps/<slug>/installations/new`, they pick an organization and
repositories, authorize the App in the same step, and GitHub sends them back to the
Callback URL, which binds the installation to their workspace and lands them on
its settings page already connected.

One App per environment. Staging and production sign with different keys and
receive deliveries at different URLs, so sharing one App would mean a staging
delivery could move a production issue.

## Creating it

Use the manifest flow from the WebbPulse organization, or its settings page
afterwards, so the App ends up as below. Everything not named here is left at its
default.

| Field | Staging | Production |
|---|---|---|
| Name | `Standupless (staging)` | `Standupless` |
| Homepage URL | `https://staging.standupless.dev` | `https://standupless.dev` |
| Callback URL | `https://api.staging.standupless.dev/api/github/callback` | `https://api.standupless.dev/api/github/callback` |
| Request user authorization (OAuth) during installation | checked | checked |
| Setup URL | greyed out by the checkbox above; `https://api.staging.standupless.dev/api/github/callback` if it is ever unchecked | the same on `api.standupless.dev` |
| Redirect on update | checked | checked |
| Webhook URL | `https://api.staging.standupless.dev/api/github/webhooks` | `https://api.standupless.dev/api/github/webhooks` |
| Webhook secret | generate a random value, at least 32 characters | the same, generated separately |
| Where can this be installed | Any account | Any account |

With user authorization during installation on, GitHub ignores the Setup URL and
sends the browser to the first Callback URL with `code`, `installation_id`,
`setup_action` and the `state` the install url carried. "Redirect on update" sends
the browser back the same way when repositories are changed later, so the list on
the settings page refreshes. Unchecking the box falls back to the Setup URL, which
is the same route and binds the same way without the `code`.

The state names the workspace and the admin, works once, and expires after ten
minutes. GitHub documents that the `installation_id` on the redirect can be
spoofed, so the callback reads the installation back with the App's own JWT and
refuses one belonging to another App. It then exchanges the `code` with the client
id and secret for a user token, asks `GET /user/installations` whether the person
who came back can reach that installation, and revokes the token. Yes binds it,
even an installation that existed before this connect; no refuses it as
`not_yours`. When GitHub gives no answer, or no `code` came back, the callback
binds an installation no workspace holds only when GitHub says it was created or
updated after the state was issued.

An organization owner approving a member's install request comes back with no
state, so nothing is bound and they are told to press Connect GitHub from the
workspace, which then binds the existing installation through the path above. A
workspace still holding an installation GitHub answers 404 for, because the
uninstall webhook has not landed yet, has it cleared so a reinstall binds.

"Expire user authorization tokens" stays checked, which is the default.

### Repository permissions

| Permission | Access | Why |
|---|---|---|
| Issues | Read-only | Reading the issue an event refers to |
| Pull requests | Read and write | Posting the comment listing linked issues |
| Checks | Read and write | Setting the check run that reports the links |
| Contents | Read-only | Reading branch names and commit messages |
| Metadata | Read-only | Mandatory, granted automatically |

No organization permissions and no account permissions. The App never reads
members, never reads code content beyond what an event carries, and never writes
anything but its own comment and its own check run.

### Subscribed events

- Pull request
- Push
- Installation
- Installation repositories

Nothing else. An event that is not on this list is answered 200 and dropped by the
receiver, so subscribing to more would only spend deliveries.

## After creating it

Note the App ID and the slug from the App's settings page, generate a client
secret, and generate a private key, which downloads a `.pem` file once. Then set
these five values as workspace variables on the environment's HCP Terraform
workspace, marking every one but the id sensitive. `terraform/secretsmanager.tf`
writes them into the environment's `app` secret under the key shown:

| Variable | Secret key | Where it comes from |
|---|---|---|
| `github_app_id` | `GITHUB_APP_ID` | The numeric App ID on the App's settings page |
| `github_client_id` | `GITHUB_CLIENT_ID` | The client ID on the same page, beginning `Iv1.` or `Iv23` |
| `github_client_secret` | `GITHUB_CLIENT_SECRET` | Generate a client secret, shown once |
| `github_private_key` | `GITHUB_PRIVATE_KEY` | The full contents of the downloaded `.pem`, newlines included |
| `github_webhook_secret` | `GITHUB_WEBHOOK_SECRET` | The webhook secret entered above |

`WEBHOOK_SIGNING_KEY` is generated by Terraform rather than supplied, so it is not
on this list.

The slug is not a secret and is not stored with these. It goes in
`github_app_slug` as a Terraform variable, because it appears in the install URL a
workspace admin is sent to.

Delete the `.pem` once it is in the secret. It cannot be recovered from GitHub, but
a new one can always be generated, so keeping a copy is the larger risk.

## Display information

GitHub has no API for the App's logo or badge colour, so both are set by hand on
the App's settings page under "Display information", once per environment.

| Field | Value |
|---|---|
| Logo | `frontend/public/github-app-logo.png`, served at `/github-app-logo.png` |
| Dimensions | 200x200 PNG, the size GitHub recommends |
| Badge background color | `#141518` |

GitHub takes a PNG, JPG or GIF under 1 MB and shows it as a square inside a
circular badge. The mark sits in the brand accent `#f2703a` on the same dark
`#141518` as the favicon and social card, and the PNG is filled edge to edge with
that colour, so the square blends into the badge. The mark is scaled to leave
enough padding that the circle never clips it.

## Until it exists

Every environment whose slug or secret is unfilled answers `NOT_CONFIGURED` with a
503 on the installation read, the install routes and the webhook receiver, and the
settings page says GitHub is not set up in this environment and disables Connect. That is the intended state, not a failure: the
domain deploys and stays inert until the App is created and the secret is filled.
