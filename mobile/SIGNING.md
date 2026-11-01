# Signing the mobile builds

CI builds an iOS simulator app and an Android debug APK for production and
staging on every pull request that changes `mobile/`. A `mobile-v<version>` tag
runs `.github/workflows/release-mobile.yml`, which builds a signed `.ipa` per
environment and uploads the production one to TestFlight. Android stays an
unsigned debug APK until its secrets below exist, and the `standupless.dev` link
and passkey associations stay off until the frontend has their identifiers.

## What each environment is

| Environment | App id | Scheme | Loads |
| --- | --- | --- | --- |
| production | `dev.standupless.app` | `standupless://` | `https://standupless.dev` |
| staging | `dev.standupless.app.staging` | `standupless-staging://` | `https://staging.standupless.dev` |

`STANDUPLESS_MOBILE_ENV=staging npx cap sync` syncs the staging config. On iOS
the staging build also passes `-xcconfig App/Staging.xcconfig`, which swaps the
bundle id, scheme, display name and associated domain host. On Android the
Gradle build reads those values back out of the synced Capacitor config, so a
sync is all it takes.

## iOS

Needs the Apple Developer Program membership, team `PFHGG295DL`, the same one
the desktop macOS signing uses (STUP-229). It is an individual enrolment today.

1. Register both app ids in the developer portal with the **Associated
   Domains** capability.
2. Create an **Apple Distribution** certificate and export it with its private
   key as a `.p12` file.
3. Create an **App Store** provisioning profile for each app id.
4. Add these GitHub Actions secrets on the repository:

| Secret | Value |
| --- | --- |
| `IOS_DISTRIBUTION_CERT_P12` | the `.p12` file, base64 encoded |
| `IOS_DISTRIBUTION_CERT_PASSWORD` | the `.p12` export password |
| `IOS_PROFILE_PRODUCTION` | the `dev.standupless.app` profile, base64 encoded |
| `IOS_PROFILE_STAGING` | the `dev.standupless.app.staging` profile, base64 encoded |
| `APPLE_TEAM_ID` | the ten-character team id |
| `APPLE_API_KEY` | the App Store Connect team key `.p8`, raw or base64 encoded |
| `APPLE_API_KEY_ID` | the key id |
| `APPLE_API_ISSUER` | the issuer id |

`IOS_DISTRIBUTION_CERT_P12` turns on the signed archive step, which attaches an
`.ipa` per environment to the GitHub release. The production `.ipa` then goes to
TestFlight through the API key, whose App Manager role is enough for this. Only
`dev.standupless.app` has an App Store Connect record, so the staging `.ipa` is
not uploaded. The build number is the workflow run number and the version is the
tag.

Builds are exported with `testFlightInternalTestingOnly`, so App Store Connect
accepts them for internal testers only and they cannot be submitted for public
review. Remove that key from the export options once STUP-736 is done and a
public submission is due.

The Info.plist sets `ITSAppUsesNonExemptEncryption` to false because the app
only uses the system's HTTPS. Revisit that if native code adds its own
encryption.

5. Set the repository variable `APPLE_TEAM_ID` too. The frontend build reads it
   and only then publishes `/.well-known/apple-app-site-association`, with
   `applinks` for `/w/*/issues/*` and `webcredentials` for managing passkeys
   and confirming sensitive actions while signed in. Sign-in itself happens in
   an `ASWebAuthenticationSession`.

### When a profile goes Invalid

Changing a capability on an app id invalidates its profiles, and a signed build
fails until they are regenerated. The `.p8` exists only in the GitHub secret, so
the API calls have to run in CI. The API has no regenerate call and refuses a
name in use, so delete the invalid profile (`DELETE /v1/profiles/{id}`), create
it again with the same name, bundle id and certificate (`POST /v1/profiles`),
and update `IOS_PROFILE_PRODUCTION` or `IOS_PROFILE_STAGING`. The repository is
public, so encrypt the profile before it leaves the runner as an artifact. The
developer portal's Edit, Save and Download does the same by hand.

## Android

Needs a Google Play developer account for the WebbPulse organisation
(STUP-229).

1. Create an upload keystore:
   `keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`.
2. Add these GitHub Actions secrets on the repository:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `upload.jks`, base64 encoded |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `upload` |
| `ANDROID_KEY_PASSWORD` | the key password |

`ANDROID_KEYSTORE_BASE64` turns on the signed release step, which builds an
`.aab` per environment and attaches it to the GitHub release. The Gradle build
signs the release only when `STANDUPLESS_ANDROID_KEYSTORE_PATH` is set, so a
local release build without it stays unsigned.

3. Once Play App Signing is on, copy the **app signing key** SHA-256
   fingerprint from Play Console, plus the upload key fingerprint
   (`keytool -list -v -keystore upload.jks`), into the repository variable
   `ANDROID_CERT_SHA256` as a comma separated list. The frontend build reads it
   and only then publishes `/.well-known/assetlinks.json`, which verifies the
   App Links for `/w/*/issues/*` and lets the web view use the site's passkeys
   for managing them and confirming sensitive actions while signed in. Sign-in
   itself happens in a Custom Tab.

## Serving the association files

`assetlinks.json` is served like any static file. The extensionless
`apple-app-site-association` needs the shared SPA frontend to serve it as
`application/json` without the index rewrite in production, tracked as PLAT-63. On
staging both files are in the access gate's `public_paths`, so Apple's and
Google's crawlers reach them.
