const path = require('node:path');
module.exports = {
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
      optionsForFile: (file) => ({
        hardenedRuntime: true,
        timestamp: 'none',
        entitlements: file.endsWith('/desktop-runtime/node')
          ? ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.disable-library-validation']
          : ['com.apple.security.cs.allow-jit'],
      }),
    },
    extraResource: [path.resolve(__dirname, '../../.artifacts/desktop-runtime')],
    ignore: (file) => file !== '' && !/^\/(dist|package\.json)(\/|$)/.test(file),
    prune: false,
  },
  rebuildConfig: { onlyModules: [] },
  makers: [
    { name: '@electron-forge/maker-dmg', config: { format: 'ULFO' } },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
  ],
};
