# Signing the desktop builds

macOS builds are signed with a Developer ID, notarized and stapled.
Windows and Linux builds are unsigned. `electron-builder.config.cjs` turns
signing on per platform only when that platform's variables are all set, and
`release-desktop.yml` passes them only to the macOS packaging step. A build
still succeeds without them.

Without a Developer ID the macOS builds are ad-hoc signed (`identity: '-'`),
never left unsigned. Apple Silicon kills a binary whose code signature does not
match its pages, and flipping the Electron fuses rewrites the Electron Framework
binary after the universal merge, so an unsigned build crashes on launch. That
is what broke 0.1.1. The hardened runtime is on only with a real identity.
`scripts/verify-mac.sh` runs `codesign --verify --deep --strict` on the packaged
app and launches each slice, in `release-desktop.yml` and in the CI
`desktop-mac` job.

## What unsigned costs

- **macOS, ad-hoc signed:** only builds without the secrets, such as CI.
  Gatekeeper blocks the first launch, and Squirrel.Mac cannot update the app, so
  the app links to the download instead (`standupless.signed` in the packaged
  package.json, read by `src/updater.ts`).
- **Windows:** SmartScreen shows "Windows protected your PC" until users choose
  More info, then Run anyway. Auto-update works.
- **Linux:** nothing. AppImage and deb are not signed by convention, and
  auto-update works for the AppImage.
- Signed builds are also what OS-level https link capture needs (macOS
  associated domains, Windows app URI handlers). Today only the `standupless://`
  scheme opens the app.

## macOS

The Apple Developer Program enrolment is individual, not a WebbPulse
organisation, so the publisher users see is Tyler Webb (team `V6RBVPC989`).
Notarization uses an App Store Connect API key, not an Apple ID. These GitHub
Actions secrets are set on the repository:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | the Developer ID Application `.p12`, base64 encoded |
| `CSC_KEY_PASSWORD` | the `.p12` export password |
| `APPLE_TEAM_ID` | the ten-character team id |
| `APPLE_API_KEY` | the `.p8` key contents, raw or base64 encoded |
| `APPLE_API_KEY_ID` | the key id |
| `APPLE_API_ISSUER` | the issuer id |

electron-builder reads `APPLE_API_KEY` as a file path, so the workflow writes the
contents to a temporary file and points the variable at it. It also unsets empty
variables, because electron-builder treats an empty `CSC_LINK` as a certificate.

`CSC_LINK` and `CSC_KEY_PASSWORD` turn on signing and the hardened runtime, and
the three API key values also turn on notarization. The `.app` is notarized and
stapled, and the zip and dmg are built from it. The dmg itself is not notarized.
`scripts/verify-mac.sh` fails a signed build that has no ticket, so setting the
signing secrets without the API key fails the release.

## Windows

Unsigned by owner decision, 2026-10-15. Two options if that is revisited. Either
one turns on signing.

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

## Trying a build

Dispatching `release-desktop.yml` builds and verifies every platform and uploads
the installers as workflow artifacts without publishing anything. Set `unsigned`
to build as if the secrets were absent. Dispatch from `staging` or `main`,
because the CodeArtifact role trusts only those branches and `desktop-v*` tags.
Windows signing secrets must go only to a Windows step, because electron-builder
falls back to `CSC_LINK` on Windows when `WIN_CSC_LINK` is absent.

## Where releases go

Each `desktop-v*` tag publishes a versioned release, and the workflow then moves
the fixed `desktop-latest` release to the same version and replaces its files.
Neither is ever marked as GitHub's latest release, because the backend marks the
product's own deploy releases in this repository as latest. The apps read
`latest.yml`, `latest-mac.yml` and `latest-linux.yml` from
`https://github.com/WebbPulse/Standupless/releases/download/desktop-latest`
through the generic provider, and the download links point at the
`desktop-latest` release page. Signing changes none of this.
