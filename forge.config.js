const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");

const SHOULD_SIGN_MAC = process.env.GIA_MAC_SIGN === "1";

module.exports = {
    packagerConfig: {
        name: "Gia",
        asar: {
            unpackDir: "node_modules/@recallai",
        },
        // Ensure the tray icon and popup HTML are available at runtime when packaged.
        extraResource: [
            "./src/assets/gia-tray.png",
            "./src/meeting-popup.html",
            "./src/debug-controls.html",
            "./src/debug-controls-renderer.js",
        ],
        // Local packaging/dev: don't require code signing unless explicitly enabled.
        // Enable signing by running with: GIA_MAC_SIGN=1 npm run package
        osxSign: SHOULD_SIGN_MAC
            ? {
                  continueOnError: false,
                  optionsForFile: (_) => {
                      // Here, we keep it simple and return a single entitlements.plist file.
                      // You can use this callback to map different sets of entitlements
                      // to specific files in your packaged app.
                      return {
                          entitlements: "./Entitlements.plist",
                      };
                  },
              }
            : false,
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
