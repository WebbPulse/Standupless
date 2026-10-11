# The Discord App behind the integrations domain

The Discord App lets a workspace admin connect a Discord server with one click,
then pick the channel each team's notifications go to. Once installed it also
answers the `/standupless` command (`help`, `show` and `create`) and offers a
"Create issue" command on any message. A pasted Discord channel webhook URL still
works as the fallback for a workspace that does not install the App.

One App per environment, each described by a file committed in this repository:

| Environment | Settings file | App name |
|---|---|---|
| staging | `discord/application.staging.json` | Standupless Staging |
| production | `discord/application.production.json` | Standupless |

Discord has no manifest import, so these files are the record of what to set by
hand in the Developer Portal. The commands themselves are in
`discord/commands.json`, and the backend registers them on every install, so
nobody edits commands in the portal. Commands belong to one App, so both
environments use `/standupless`.
`backend/tests/domains/integrations/test_discord_manifest.py` holds the files to
the routes, scopes, permissions and command handlers the backend uses, so change
a file and the code together.

The feature is off until the four keys below are in the environment's `app`
secret. Without them the public Discord routes answer 404, the install link
answers 409 `NOT_CONFIGURED`, and the settings page offers only the webhook form.

## How it works

- **Install.** Add to Discord on a team's settings page asks
  `GET /api/workspaces/{id}/discord/install-url` (workspace admins only) for
  Discord's authorize URL with the `bot` and `applications.commands` scopes, the
  bot permissions and a signed, single use state. The admin picks a server, and
  Discord sends the browser back to `/api/discord/oauth/callback`, which redeems
  the state, exchanges the code, records the server, registers the commands and
  lands the admin on the settings page they started from with
  `?discord=installed`. One Discord server binds to one Standupless workspace.
- **One bot token.** Unlike Slack, Discord gives one bot token for the whole App
  rather than one per install. It lives in the `app` secret as
  `DISCORD_BOT_TOKEN`, so the installation row holds no credential and the
  installer's own access token is thrown away.
- **Channels.** The team's add channel dialog lists the server's text and
  announcement channels from `GET .../webhooks/discord-channels` and stores the
  channel id, never a URL. Delivery posts as the bot and maps Discord's answers
  onto the webhook rules, so a channel the bot cannot reach turns off the same way
  a dead webhook does.
- **Interactions.** `/api/discord/interactions` checks Discord's Ed25519
  signature over the timestamp and body with the App's public key, inside a five
  minute window, before reading anything.
- **People.** Discord never shows a bot anyone's email, so the first command a
  person runs answers privately with a link through Discord's consent screen
  (`identify` and `email`). The link is accepted only when Discord says the email
  is verified and it belongs to a member of the bound workspace. From then on
  commands run as that member, with their role and teams, and the link is checked
  again every time, so a member who leaves or changes their email is unlinked.
- **Uninstall.** Discord sends no event when the bot is removed from a server, so
  the installation is forgotten the first time a call as the bot finds the server
  gone, and its channels turn off with an inbox notice to team admins. Disconnect
  on the settings page makes the bot leave the server first.
- **No unfurls.** Discord gives bots no hook to preview links, so pasted issue
  links get Discord's own preview, not a Standupless card.

## Creating the App (once per environment)

1. Sign in to https://discord.com/developers/applications with the WebbPulse
   Discord account and press **New Application**. Name it as in the table above.
2. On **General Information**, set the description, Terms of Service URL and
   Privacy Policy URL from the settings file, upload the app icon
   (`frontend/public/github-app-logo.png`), and set **Interactions Endpoint URL**
   to the file's `interactions_endpoint_url` only after the keys are set and the
   backend is redeployed (step 6). Copy the **Application ID** and **Public Key**
   straight into the secret (next section).
3. On **Installation**, untick **User Install** so only **Guild Install** is on,
   and set **Install Link** to **None**. Installs start from Standupless, which
   adds the state the callback needs.
4. On **OAuth2**, add the file's redirect under **Redirects**, then press **Reset
   Secret** and copy the **Client Secret** straight into the secret.
5. On **Bot**, keep **Public Bot** on and **Requires OAuth2 Code Grant** on, leave
   every privileged gateway intent off, press **Reset Token** and copy the token
   straight into the secret. Do not paste any of these values anywhere else.
6. Set the keys and redeploy (next two sections), then come back to **General
   Information** and save the **Interactions Endpoint URL**. Discord checks it by
   sending a signed ping, which the backend can only answer once it holds the
   public key, so saving fails until then.

The bot permissions (`19456`: View Channels, Send Messages and Embed Links) are
part of the install link the backend builds, so nothing is set for them in the
portal.

## The secret keys

Each environment's `app` secret holds the keys. Terraform does not declare them:
`terraform/secretsmanager.tf` sets `json_preserve_unmanaged`, so every Terraform
write keeps them as they are.

| Secret key | Where it comes from |
|---|---|
| `DISCORD_APPLICATION_ID` | General Information, Application ID |
| `DISCORD_PUBLIC_KEY` | General Information, Public Key |
| `DISCORD_CLIENT_SECRET` | OAuth2, Client Secret (Reset Secret) |
| `DISCORD_BOT_TOKEN` | Bot, Token (Reset Token) |

Run these from `backend/` with the environment account's AdministratorAccess
profile (for example `assume Standupless-Staging/AdministratorAccess`). Each
`secret set` reads the value from a hidden prompt, so it never lands in shell
history, and `secret keys` lists names only.

```sh
uv run webbpulse-config --prefix standupless-staging secret set DISCORD_APPLICATION_ID
uv run webbpulse-config --prefix standupless-staging secret set DISCORD_PUBLIC_KEY
uv run webbpulse-config --prefix standupless-staging secret set DISCORD_CLIENT_SECRET
uv run webbpulse-config --prefix standupless-staging secret set DISCORD_BOT_TOKEN
uv run webbpulse-config --prefix standupless-staging secret keys
```

For production, assume `Standupless-Production/AdministratorAccess` and run the
same five commands with `--prefix standupless-production`.

To rotate the client secret or bot token, reset it in the portal and set the new
value the same way, then redeploy. Resetting the bot token takes effect at once
in Discord, so channel posts fail until the new token is live.

## Redeploying

A running function caches the `app` secret for its lifetime, so the keys take
effect only in new containers. Dispatch **Deploy backend** on the environment's
branch (`staging` or `main`) from the Actions tab, or with
`gh workflow run deploy-backend.yml --ref staging`. A manual dispatch redeploys
every domain.

## Verifying

1. An unsigned `POST https://api.<host>/api/discord/interactions` answers 401 once
   the keys are live, and 404 while they are not.
2. The Interactions Endpoint URL saves in the portal.
3. As a workspace admin, open a team's settings, **Add to Discord**, pick a
   server, approve, and check you land back on the same page with a success
   notice and the server name shown.
4. Add a channel through the App, pick a channel, and use **Send test** on it.
5. In Discord, run `/standupless help`, follow the link it gives to link your
   account, then run `/standupless show` with a real key and
   `/standupless create`, and use **Create issue** from a message's Apps menu.
6. Disconnect from the settings page and check the bot left the server and the
   App's channels show as turned off.

The local stack in CI runs with a placeholder application id, client secret and
bot token, and a public key from a fixed local seed, and the `TestDiscordApp` e2e
class sends signed interactions to it, so the signature path is proven on every
pull request without a real Discord App.
