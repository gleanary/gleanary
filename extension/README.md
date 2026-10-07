# Gleanary Clipper (browser extension)

One-click saving of the current page to your self-hosted Gleanary instance,
with optional capture of the rendered HTML for pages that resist server-side
fetching. Manifest V3, vanilla JS, no build step.

**Not published to any extension store** — you load it directly from this
directory ("unpacked"). This is intentional: the extension talks to _your_
server URL with _your_ app password, so there is nothing to distribute.

## Install (Chrome / Chromium / Edge / Brave)

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle, top right)
3. Click **Load unpacked** and select this `extension/` directory

## Install (Firefox)

Firefox only loads unsigned extensions temporarily:

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and select `extension/manifest.json`

The extension is removed when Firefox restarts; reload it the same way.

## Configure

Open the extension's **Options** page and set:

- **Gleanary URL** — e.g. `https://reader.example.com` (no trailing slash)
- **Password** — your app password (the username field can stay blank)
- **Send page HTML** (optional) — also send the rendered page HTML with each
  save, which helps with pages that resist server-side fetching

Use **Test Connection** to check the settings before saving.

## Use

- Click the toolbar icon and hit **Save**, or press **Alt+Shift+S**
- The popup confirms the save and links to the article in Gleanary
