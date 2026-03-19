# Suno Library Downloader

A Chrome extension (Manifest V3) that bulk-downloads your entire [Suno.ai](https://suno.com) library as MP3 files — no login credentials stored, no third-party servers, everything stays local.

---

## Features

- **Bulk download** — fetch every song in your library in one click
- **Selective download** — check/uncheck individual songs before downloading
- **Search & filter** — instantly filter your library by title
- **Resume-aware** — already-downloaded songs are marked with ✓ so you only grab new ones
- **CSV export** — save your full library metadata (title, duration, model version, tags, prompt, CDN URL) as a spreadsheet
- **Concurrency control** — 3 parallel downloads with automatic rate limiting
- **Token auto-refresh** — Clerk JWTs are refreshed transparently mid-scan so large libraries never stall
- **No dependencies** — pure vanilla JS, no npm, no build step

---

## Installation

> The extension is not on the Chrome Web Store. Load it unpacked in Developer Mode.

1. Clone or download this repository
   ```
   git clone https://github.com/essremodel/suno-downloader.git
   ```
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the `suno-downloader` folder
5. The orange music-note icon will appear in your toolbar

---

## Usage

### 1. Connect

- Open **suno.com** in any tab and make sure you are logged in
- Browse around for a moment — the extension silently intercepts the auth token from the first API call the page makes
- Click the extension icon. The badge should turn green: **Connected**
- If it shows "Not connected", click **Refresh Connection** to trigger the fallback cookie-based token flow

### 2. Scan your library

- Click **Scan Library**
- The extension paginates through your full song feed (~20 songs per page, 500 ms between requests)
- Progress is shown live: `Scanning page 4… Found 73 songs`

### 3. Download

- Once scanning completes your song list loads with all songs selected by default
- Use the **search bar** to filter, or **All / None** to toggle selection
- Click **Download N MP3s**
- Files are saved to your default Downloads folder under `Suno Downloads/`
- Filenames follow the pattern: `Song Title [clipId8].mp3`

### 4. Export metadata (optional)

- Click **Export Library as CSV** to save a spreadsheet of your full library including titles, durations, model versions, tags, prompts, and direct CDN URLs

---

## How It Works

### Authentication

Suno uses [Clerk](https://clerk.com) for auth. The extension uses two complementary strategies:

**Strategy A (primary)** — `injected.js` runs in the page's MAIN world and patches `window.fetch` and `XMLHttpRequest.prototype.setRequestHeader`. The moment the Suno page makes any authenticated API call, the `Authorization: Bearer <jwt>` header is captured and passed to the background service worker via `postMessage`. This avoids storing credentials and always gives a fresh, valid token.

**Strategy B (fallback)** — If no token has been captured yet (e.g. the popup is opened before any page activity), the background worker reads the `__client` cookie Clerk stores on `suno.com`, parses the session ID from the JWT payload, and exchanges it at `https://clerk.suno.com/v1/client/sessions/{id}/tokens` for a short-lived JWT. Tokens are refreshed automatically before expiry (~55 s buffer).

### API

All API calls are made from the background service worker, which is not subject to CORS restrictions.

| Purpose | Endpoint |
|---|---|
| List songs (paginated) | `GET https://studio-api.suno.ai/api/feed/v2?page={n}` |
| Download audio | `https://cdn1.suno.ai/{clip_id}.mp3` |
| Token refresh | `POST https://clerk.suno.com/v1/client/sessions/{id}/tokens` |

### File Structure

```
suno-downloader/
├── manifest.json      MV3 manifest — permissions, host_permissions, content scripts
├── background.js      Service worker: token management, library scan, download queue
├── injected.js        Runs in page MAIN world — patches fetch/XHR to capture tokens
├── content.js         Isolated world bridge — relays postMessage tokens to background
├── popup.html         Extension popup markup
├── popup.js           Popup UI controller — all state transitions and user interactions
├── popup.css          Dark theme UI (matches Suno's aesthetic)
└── icons/             PNG icons at 16 × 16, 48 × 48, 128 × 128
```

---

## Permissions

| Permission | Why it's needed |
|---|---|
| `cookies` | Read the Clerk `__client` cookie for fallback token refresh |
| `downloads` | Save MP3 files to disk via `chrome.downloads.download()` |
| `storage` | Cache the library manifest and download history locally |
| `scripting` | Reserved for future use |
| `activeTab` | Identify the active suno.com tab |
| Host: `suno.com` | Content scripts and cookie access |
| Host: `studio-api.suno.ai` | Fetch the paginated song feed |
| Host: `cdn1/2.suno.ai` | Download MP3 audio files |
| Host: `clerk.suno.com` | Exchange Clerk session for JWT |

No data is sent to any external server. Everything runs locally in the extension.

---

## Troubleshooting

**"Not connected" after loading**
Visit suno.com, make sure you are logged in, then click **Refresh Connection** in the popup. If that fails, open the browser console on suno.com and look for `[Suno Downloader] Intercepted auth token` — if it never appears, reload the tab with the extension installed.

**Scan stops early or returns 0 songs**
Your token may have expired mid-scan. The extension retries automatically, but if the Clerk cookie is also stale you will need to log out and back into suno.com.

**Some songs show as failed (403)**
Suno occasionally expires CDN URLs for deleted or private clips. These are logged and skipped automatically.

**Downloads not appearing in the expected folder**
Chrome saves to your default Downloads directory. Check Chrome's download settings at `chrome://settings/downloads` to confirm or change the location.

**Debugging**
Open `chrome://extensions` → find Suno Library Downloader → click **Service Worker** to open the background console. All background events are prefixed `[BG]`. Popup errors appear in the popup's DevTools (right-click the popup → Inspect).

---

## Disclaimer

This extension is a personal tool for downloading your own AI-generated music from your own Suno account. It does not circumvent DRM, access other users' content, or violate Suno's public API in any way that is not already accessible through the normal web interface. Use responsibly and in accordance with [Suno's Terms of Service](https://suno.com/terms).
