# Signing the desktop builds

The desktop builds ship unsigned. `electron-builder.config.cjs` turns signing on
per platform only when that platform's variables are all set, and
`release-desktop.yml` passes none of them today, so every release is unsigned
until the steps below are done.

## What unsigned costs

- **macOS:** Gatekeeper blocks the first launch. Users right-click the app and
  choose Open, or allow it under System Settings, Privacy and Security.
  Auto-update does not work on macOS for unsigned apps, because Squirrel.Mac
  checks the signature of the update against the running app. Users update by
  downloading the new dmg.
- **Windows:** SmartScreen shows "Windows protected your PC" until users choose
  More info, then Run anyway. Auto-update works.
- **Linux:** nothing. AppImage and deb are not signed by convention, and
  auto-update works for the AppImage.
- Signed builds are also what OS-level https link capture needs (macOS
  associated domains, Windows app URI handlers). Until then only the
  `standupless://` scheme opens the app.

## macOS

Needs an Apple Developer Program membership, at $99 a year, for the WebbPulse
organisation. Enrolling as an organisation needs a D-U-N-S number.

1. Create a **Developer ID Application** certificate in the Apple developer
   portal and export it with its private key as a `.p12` file.
2. Create an app-specific password for the Apple ID that will notarise.
3. Add these GitHub Actions secrets on the repository:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | the `.p12` file, base64 encoded |
| `CSC_KEY_PASSWORD` | the `.p12` export password |
| `APPLE_ID` | the Apple ID that notarises |
| `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password |
| `APPLE_TEAM_ID` | the ten-character team id |

`CSC_LINK` and `CSC_KEY_PASSWORD` turn on signing, and the three `APPLE_`
values also turn on notarisation. The config already sets the hardened runtime.

## Windows

Two options. Either one turns on signing.

**Azure Trusted Signing** (recommended): about $9.99 a month on the Basic tier.
It needs an Azure subscription, a Trusted Signing account, identity validation
of the organisation, and a certificate profile. Builds get SmartScreen
reputation from the shared Microsoft certificate. Add an app registration with
the Trusted Signing Certificate Profile Signer role, then these secrets:

| Secret | Value |
| --- | --- |
| `AZURE_TENANT_ID` | the tenant of the app registration |
| `AZURE_CLIENT_ID` | the app registration's client id |
| `AZURE_CLIENT_SECRET` | a client secret for it |
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | the account's regional endpoint, such as `https://wus2.codesigning.azure.net` |
| `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME` | the Trusted Signing account name |
| `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME` | the certificate profile name |
| `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME` | the subject common name on the certificate, such as `WebbPulse` |

**An Authenticode certificate** from a certificate authority: an OV
certificate costs roughly $200 to $400 a year and an EV certificate roughly
$300 to $600 a year. Since 2023 both come on a hardware token or a cloud HSM, so
a plain `.pfx` in CI is only possible with a CA's cloud signing service. With a
`.pfx`, add `WIN_CSC_LINK` (base64) and `WIN_CSC_KEY_PASSWORD`.

## Linux

Nothing to buy or set.

## Turning it on in CI

Once the secrets exist, add them to the `env` of the "Package the installers"
step in `.github/workflows/release-desktop.yml`, each read from
`secrets.`, and drop `CSC_IDENTITY_AUTO_DISCOVERY: "false"` from the macOS job.
Pass the macOS values only to the macOS job, because electron-builder falls back
to `CSC_LINK` on Windows when `WIN_CSC_LINK` is absent.
Then tag a new `desktop-v*` release. No builder config change is needed, but
once macOS builds are signed, set `ANNOUNCE_ONLY` in `src/updater.ts` to false
so Macs install updates themselves instead of linking to the download.

## Where releases go

Each `desktop-v*` tag publishes a versioned release, and the workflow then moves
the fixed `desktop-latest` release to the same version and replaces its files.
Neither is ever marked as GitHub's latest release, because the backend marks the
product's own deploy releases in this repository as latest. The apps read
`latest.yml`, `latest-mac.yml` and `latest-linux.yml` from
`https://github.com/WebbPulse/Standupless/releases/download/desktop-latest`
through the generic provider, and the download links point at the
`desktop-latest` release page. Signing changes none of this.
