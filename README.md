# Gia Desktop Notetaker

Gia Desktop App for meeting recording using the Recall.ai Desktop SDK.
Detects active meetings (Zoom, MS Teams, Google Meet), records with user confirmation, and uploads to Recall.ai for
transcription.

Supports **macOS** (Apple Silicon) and **Windows**.

## Setup

```shell
# Install dependencies
npm install

# Run in development mode (starts Express server + Electron concurrently)
npm start
```

## Build & Package

```shell
# Package the app (without creating an installer)
npm run package

# Build distributable installer
# macOS: creates .dmg
# Windows: creates Squirrel Setup.exe
npm run make
```

## Platform Notes

### macOS

Requires system permissions (prompted during onboarding):

- **Microphone** - for audio capture
- **Screen Recording** – for screen capture
- **Accessibility** – for meeting window detection

Code signing: set `GIA_MAC_SIGN=1` to enable macOS code signing during build.

```shell
# Reset Desktop Recording Permissions
sudo tccutil reset All com.gia.desktop-recording

# Reset WebStorm Permissions
sudo tccutil reset All com.jetbrains.WebStorm

# Reset VSCode Permissions
sudo tccutil reset All com.microsoft.VSCode

# Remove auth tokens
rm "$HOME/Library/Application Support/Gia/auth.tokens.json"
```

### Windows

No system permission prompts are needed – the Recall SDK handles permissions internally. The app uses Squirrel for
installation and auto-updates.

```shell
# Remove auth tokens (PowerShell)
Remove-Item "$env:APPDATA\Gia\auth.tokens.json"
```

## Environment Variables

Optional:

- `DEBUG=true` - Enables debug tray menu items and debug controls window
- `GIA_MAC_SIGN=1` - Enable macOS code signing
- `START_ON_LOGIN=false` - Disable launching Gia automatically when the user logs in

## Release Packaging for macOS

```shell 

# Build DMG file
rm -rf out .webpack && GIA_MAC_SIGN=1 npm run make

# Notarize DMG
xcrun notarytool submit ./out/make/Gia-*.dmg --keychain-profile "gia-notarize" --wait
xcrun stapler staple ./out/make/Gia-*.dmg
xcrun stapler validate ./out/make/Gia-*.dmg
```

## Release Packaging for Windows

```shell

# Zip folder for Windows release
zip -r gia-desktop-recording.zip . -x "node_modules/*" "build/*" "out/*" ".git/*" ".DS_Store" ".env*"
```
