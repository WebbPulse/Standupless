/**
 * electron-builder configuration. `STANDUPLESS_DESKTOP_ENV=staging` builds the
 * staging variant, with its own app id, name and URL scheme so it installs
 * beside the production app, and with no publish target.
 *
 * Production updates come from the fixed `desktop-latest` release through the
 * generic provider, never from GitHub's latest release, because the backend
 * marks the product's own deploy releases in this repository as latest.
 * release-desktop.yml builds with `--publish never` and uploads the files.
 *
 * Signing is off unless its credentials are in the environment. With none set
 * Windows and Linux builds are unsigned and macOS builds are ad-hoc signed,
 * because Apple Silicon kills any binary whose code signature does not match
 * its pages, and flipping the Electron fuses rewrites the framework binary.
 * SIGNING.md lists what turns full signing on for each platform.
 *
 * @type {import('electron-builder').Configuration}
 */

const staging = process.env.STANDUPLESS_DESKTOP_ENV === 'staging';

const has = (...names) =>
  names.every((name) => (process.env[name] ?? '').trim() !== '');

const macSigning = has('CSC_LINK', 'CSC_KEY_PASSWORD');
const macNotarize =
  macSigning && has('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID');
const azureSigning = has(
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_TRUSTED_SIGNING_ENDPOINT',
  'AZURE_TRUSTED_SIGNING_ACCOUNT_NAME',
  'AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME',
  'AZURE_TRUSTED_SIGNING_PUBLISHER_NAME'
);

const scheme = staging ? 'standupless-staging' : 'standupless';
const productName = staging ? 'Standupless Staging' : 'Standupless';

module.exports = {
  appId: staging
    ? 'dev.standupless.desktop.staging'
    : 'dev.standupless.desktop',
  productName,
  copyright: 'Copyright (c) 2026 WebbPulse',
  directories: {
    output: staging ? 'release/staging' : 'release/production',
    buildResources: 'resources',
  },
  files: ['dist/**/*.js', 'resources/icon.png', 'package.json', 'LICENSE'],
  extraMetadata: {
    standupless: { environment: staging ? 'staging' : 'production' },
  },
  asar: true,
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  },
  protocols: [{ name: productName, schemes: [scheme] }],
  publish: staging
    ? null
    : [
        {
          provider: 'generic',
          url: 'https://github.com/WebbPulse/Standupless/releases/download/desktop-latest',
        },
      ],
  mac: {
    category: 'public.app-category.productivity',
    target: [
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: ['universal'] },
    ],
    icon: 'resources/icon.png',
    hardenedRuntime: macSigning,
    identity: macSigning ? undefined : '-',
    notarize: macNotarize,
  },
  dmg: {
    artifactName: '${productName}-${version}-mac.${ext}',
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    icon: 'resources/icon.png',
    ...(azureSigning
      ? {
          azureSignOptions: {
            endpoint: process.env.AZURE_TRUSTED_SIGNING_ENDPOINT,
            codeSigningAccountName:
              process.env.AZURE_TRUSTED_SIGNING_ACCOUNT_NAME,
            certificateProfileName:
              process.env.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME,
            publisherName: process.env.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME,
          },
        }
      : {}),
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    artifactName: '${productName}-Setup-${version}.${ext}',
  },
  linux: {
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
    icon: 'resources/icon.png',
    category: 'Office',
    maintainer: 'WebbPulse <support@standupless.dev>',
    synopsis: 'The Standupless issue tracker',
    executableName: staging ? 'standupless-staging' : 'standupless',
  },
  deb: {
    artifactName: '${name}_${version}_${arch}.${ext}',
  },
};
