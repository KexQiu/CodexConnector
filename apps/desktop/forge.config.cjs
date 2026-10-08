const path = require('node:path');
const buildRoot = process.env.CONNECTOR_DESKTOP_BUILD_ROOT
  ? path.resolve(process.env.CONNECTOR_DESKTOP_BUILD_ROOT)
  : null;
module.exports = {
  ...(buildRoot ? { outDir: path.join(buildRoot, 'out') } : {}),
  packagerConfig: {
    name: 'CodexConnector',
    appBundleId: 'io.codexconnector.desktop',
    asar: true,
    electronZipDir: path.resolve(__dirname, '../../.artifacts/electron-download'),
    executableName: 'CodexConnector',
    icon: path.resolve(__dirname, 'assets/app-icon.icns'),
    // Internal builds have no Developer ID. Re-sign modified Electron resources
    // and the bundled Node runtime so the bundle has a valid ad-hoc signature.
    osxSign: {
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      optionsForFile: () => ({
        hardenedRuntime: true,
        timestamp: 'none',
        // Ad-hoc signatures have no Team ID. Electron hosts and helpers must also
        // be able to load the bundled ad-hoc frameworks, not just the Node child.
        entitlements: [
          'com.apple.security.cs.allow-jit',
          'com.apple.security.cs.disable-library-validation',
        ],
      }),
    },
    extraResource: [
      buildRoot
        ? path.join(buildRoot, 'desktop-runtime')
        : path.resolve(__dirname, '../../.artifacts/desktop-runtime'),
    ],
    ignore: (file) => file !== '' && !/^\/(dist|package\.json)(\/|$)/.test(file),
    prune: false,
  },
  rebuildConfig: { onlyModules: [] },
  makers: [
    { name: '@electron-forge/maker-dmg', config: { format: 'ULFO' } },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
  ],
};
