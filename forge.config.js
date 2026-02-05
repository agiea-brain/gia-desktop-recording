const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");

const SHOULD_SIGN_MAC = process.env.GIA_MAC_SIGN === "1";
const SHOULD_NOTARIZE_MAC = process.env.GIA_MAC_NOTARIZE === "1";
const MAC_BUNDLE_ID =
    process.env.GIA_MAC_BUNDLE_ID || "com.gia.desktop-recording";

module.exports = {
    packagerConfig: {
        name: "Gia",
        appBundleId: MAC_BUNDLE_ID,
        asar: {
            unpackDir: "node_modules/@recallai",
        },
        // Ensure the tray icon and popup HTML are available at runtime when packaged.
        extraResource: [
            "./src/assets/gia-tray.png",
            "./src/meeting-popup.html",
            "./src/onboarding-popup.html",
            "./src/debug-controls.html",
            "./src/debug-controls-renderer.js",
        ],
        // Local packaging/dev: don't require code signing unless explicitly enabled.
        // Enable signing by running with: GIA_MAC_SIGN=1 npm run package
        osxSign: SHOULD_SIGN_MAC
            ? {
                  continueOnError: false,
                  identity:
                      process.env.GIA_MAC_SIGN_IDENTITY ||
                      undefined /* auto-detect if omitted */,
                  keychain: process.env.GIA_MAC_KEYCHAIN || undefined,
                  optionsForFile: (_) => {
                      return {
                          entitlements: "./Entitlements.plist",
                          "entitlements-inherit": "./Entitlements.plist",
                          "hardened-runtime": true,
                          hardenedRuntime: true,
                      };
                  },
              }
            : false,
        // osxNotarize:
        //     SHOULD_SIGN_MAC && SHOULD_NOTARIZE_MAC
        //         ? {
        //               tool: "notarytool",
        //               appBundleId: MAC_BUNDLE_ID,
        //               appleApiKey: process.env.APPLE_API_KEY_PATH,
        //               appleApiKeyId: process.env.APPLE_API_KEY_ID,
        //               appleApiIssuer: process.env.APPLE_API_ISSUER_ID,
        //           }
        //         : false,
        // App icon (macOS .icns). Forge expects the path WITHOUT the extension.
        icon: "./src/assets/gia-app",
        extendInfo: {
            NSUserNotificationAlertStyle: "alert",
            CFBundleName: "Gia",
            CFBundleDisplayName: "Gia",
        },
    },
    rebuildConfig: {},
    makers: [
        {
            name: "@electron-forge/maker-dmg",
            config: {
                icon: "./src/assets/gia-app.icns",
            },
        },
        {
            name: "@electron-forge/maker-zip",
            platforms: ["darwin"],
        },
        // {
        //   name: '@electron-forge/maker-squirrel',
        //   config: {},
        // },
        // {
        //   name: '@electron-forge/maker-deb',
        //   config: {},
        // },
        // {
        //   name: '@electron-forge/maker-rpm',
        //   config: {},
        // },
    ],
    plugins: [
        {
            name: "@electron-forge/plugin-auto-unpack-natives",
            config: {},
        },
        {
            name: "@electron-forge/plugin-webpack",
            config: {
                devContentSecurityPolicy:
                    "default-src * 'unsafe-inline' 'unsafe-eval' data: blob: filesystem: mediastream: file:;",
                mainConfig: "./webpack.main.config.js",
                renderer: {
                    config: "./webpack.renderer.config.js",
                    entryPoints: [
                        {
                            html: "./src/index.html",
                            js: "./src/renderer.js",
                            name: "main_window",
                            preload: {
                                js: "./src/preload.js",
                            },
                        },
                    ],
                },
            },
        },
        {
            name: "@timfish/forge-externals-plugin",
            config: {
                externals: ["@recallai/desktop-sdk"],
                includeDeps: true,
            },
        },
        // Fuses are used to enable/disable various Electron functionality
        // at package time, before code signing the application
        new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true,
        }),
    ],
};
