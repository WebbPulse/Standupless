# The Slack App behind the integrations domain

The Slack App lets a workspace admin connect Slack with one click, then pick the
channel each team's notifications go to. Once installed it also previews pasted
issue links, answers the `/standupless` command, and offers a "Create issue"
shortcut on any message. A pasted incoming webhook URL still works as the fallback
for a workspace that does not install the App.

One App per environment, each created from a manifest committed in this repository:

| Environment | Manifest | App name | Command |
|---|---|---|---|
| staging | `slack/manifest.staging.json` | Standupless Staging | `/standupless-staging` |
| production | `slack/manifest.production.json` | Standupless | `/standupless` |

`backend/tests/domains/integrations/test_slack_manifest.py` holds each manifest
to the routes, scopes and callback ids the backend uses, so change a manifest and
the code together.

The feature is off until the three keys below are in the environment's `app`
secret. Without them the public Slack routes answer 404, the install link answers
409 `NOT_CONFIGURED`, and the settings page offers only the webhook form.

## How it works

- **Install.** Add to Slack on a team's settings page asks
  `GET /api/workspaces/{id}/slack/install-url` (workspace admins only) for Slack's
  authorize URL with a signed, single use state. Slack sends the browser back to
  `/api/slack/oauth/callback`, which redeems the state, exchanges the code with the
  client secret, seals the bot token under `WEBHOOK_SIGNING_KEY` and lands the
  admin on the settings page they started from with `?slack=installed`. One Slack
  workspace binds to one Standupless workspace.
- **Channels.** The team's add channel dialog lists the bot's channels from
  `GET .../webhooks/slack-channels` and stores the channel id, never a URL.
  Delivery calls `chat.postMessage` and maps Slack's answers onto the webhook
  rules, so a removed bot or a revoked token turns the channel off the same way a
  dead webhook does.
- **Receivers.** `/api/slack/events`, `/api/slack/commands` and
  `/api/slack/interactions` verify Slack's `v0` signature with the signing secret
  and a five minute window before reading the body.
- **People.** A command, shortcut or form runs as the Standupless member whose
  account email matches the Slack user's confirmed email, with that member's role
  and teams. Anyone else is told their account is not linked.
- **Unfurls.** Links to issues on this environment's host get a card, except
  issues in private teams, since everyone in the Slack channel would see it.
- **Uninstall.** `app_uninstalled`, or `tokens_revoked` for the bot token, forgets
  the installation and turns off its channels with an inbox notice to team admins.
  Disconnect on the settings page revokes the token first.

## Creating the App (once per environment)

1. Sign in to https://api.slack.com/apps with the WebbPulse Slack account and
   choose **Create New App**, then **From a manifest**.
2. Pick the WebbPulse Slack workspace as the development workspace.
3. Paste the environment's manifest file (JSON tab), review, and **Create**.
4. On **Basic Information**, under **Display Information**, upload the app icon
   (`frontend/public/github-app-logo.png` works, Slack wants 512x512 to 2000x2000,
   so scale it up) and keep the background colour `#141518`.
5. Still on **Basic Information**, copy the three credentials below from **App
   Credentials** straight into the secret (next section). Do not paste them
   anywhere else.
6. Set the keys and redeploy (next two sections), then come back to **Event
   Subscriptions** and press **Retry** next to the request URL until it shows
   Verified. Slack checks it by sending a signed challenge, which the backend can
   only answer once it holds the signing secret.
7. Open **Manage Distribution**, tick the checklist (the manifest already removes
   hard coded data and sets the redirect URL), and press **Activate Public
   Distribution**, so workspaces other than WebbPulse's can install it. Listing in
   the Slack Marketplace is a separate review and not needed for installs.

## The secret keys

Each environment's `app` secret holds the keys. Terraform does not declare them:
`terraform/secretsmanager.tf` sets `json_preserve_unmanaged`, so every Terraform
write keeps them as they are.

| Secret key | Where it comes from |
|---|---|
| `SLACK_CLIENT_ID` | Basic Information, App Credentials, Client ID |
| `SLACK_CLIENT_SECRET` | Basic Information, App Credentials, Client Secret (Show) |
| `SLACK_SIGNING_SECRET` | Basic Information, App Credentials, Signing Secret (Show) |

Run these from `backend/` with the environment account's AdministratorAccess
profile (for example `assume Standupless-Staging/AdministratorAccess`). Each
`secret set` reads the value from a hidden prompt, so it never lands in shell
history, and `secret keys` lists names only.

```sh
uv run webbpulse-config --prefix standupless-staging secret set SLACK_CLIENT_ID
uv run webbpulse-config --prefix standupless-staging secret set SLACK_CLIENT_SECRET
uv run webbpulse-config --prefix standupless-staging secret set SLACK_SIGNING_SECRET
uv run webbpulse-config --prefix standupless-staging secret keys
```

For production, assume `Standupless-Production/AdministratorAccess` and run the
same four commands with `--prefix standupless-production`.

To rotate the client secret or signing secret, press **Regenerate** next to it in
Slack and set the new value the same way, then redeploy.

## Redeploying

A running function caches the `app` secret for its lifetime, so the keys take
effect only in new containers. Dispatch **Deploy backend** on the environment's
branch (`staging` or `main`) from the Actions tab, or with
`gh workflow run deploy-backend.yml --ref staging`. A manual dispatch redeploys
every domain.

## Verifying

1. An unsigned `POST https://api.<host>/api/slack/events` answers 401 once the
   keys are live, and 404 while they are not.
2. Event Subscriptions on api.slack.com shows the request URL as Verified.
3. As a workspace admin, open a team's settings, **Add to Slack**, approve, and
   check you land back on the same page with a success notice and the Slack
   workspace name shown.
4. Add a channel through the App, pick a channel, and use **Send test** on it.
5. In Slack, run `/standupless help` (`/standupless-staging help` on staging), then
   `/standupless ABC-1` with a real key, paste an issue link into a channel to see
   the preview, and use **Create issue** from a message's More actions menu.
6. Disconnect from the settings page and check the App's channels show as turned
   off.

The local stack in CI runs with placeholder keys, and the `TestSlackApp` e2e
class sends signed requests to it, so the signature path is proven on every pull
request without a real Slack App.
