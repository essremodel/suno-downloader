# Claude Code Prompt: Suno Library Bulk Downloader Chrome Extension

## Goal
Build a Chrome extension (MV3) that bulk-downloads ALL songs from my Suno.ai library as MP3 files. This is my own account (`essremodel`) with my own AI-generated music.

## Architecture Overview

### How Suno Auth Works
- Suno uses **Clerk** for authentication
- The session token is in a cookie named `__client` on `suno.com`
- Clerk exposes a session token endpoint: `https://clerk.suno.com/v1/client/sessions/{session_id}/tokens?__clerk_api_version=2021-02-05`
- The JWT from that endpoint is used as `Authorization: Bearer {jwt}` on API calls
- The extension should intercept/extract the Clerk JWT automatically from the active suno.com tab (via `webRequest` or by reading cookies + hitting the Clerk token endpoint)

### Suno Internal API Endpoints
The internal API base is `https://studio-api.suno.ai`

**List songs (paginated):**
```
GET https://studio-api.suno.ai/api/feed/v2?page={page_number}
Authorization: Bearer {clerk_jwt}
```
- Returns JSON with array of clip objects
- Each clip has: `id`, `title`, `audio_url`, `image_url`, `metadata` (tags, prompt), `created_at`, `status`, `display_name`
- Page size is ~20 items per page
- Paginate until you get an empty array or fewer results than page size

**Alternative endpoint for all songs:**
```
GET https://studio-api.suno.ai/api/feed/v2?page=0
```
Keep incrementing page until exhausted.

### MP3 Download URL Pattern
```
https://cdn1.suno.ai/{clip_id}.mp3
```
CDN URLs are **publicly accessible** (no auth needed for the audio file itself). The `audio_url` field in the API response also contains the direct CDN link.

## Implementation Plan

### Phase 1: Core Extension Structure
Create a standard MV3 Chrome extension with:

**manifest.json:**
- `permissions`: `cookies`, `activeTab`, `downloads`, `storage`
- `host_permissions`: `*://suno.com/*`, `*://studio-api.suno.ai/*`, `*://cdn1.suno.ai/*`, `*://cdn2.suno.ai/*`, `*://clerk.suno.com/*`
- Background service worker
- Popup UI
- Content script for suno.com (optional, for token extraction)

**File structure:**
```
suno-downloader/
├── manifest.json
├── background.js        # Service worker: API calls, download orchestration
├── popup.html           # UI: scan library, show progress, start download
├── popup.js             # Popup logic
├── popup.css            # Dark theme matching Suno's UI
├── content.js           # Content script to extract auth token from page
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

### Phase 2: Authentication Token Extraction
Two strategies (implement both, prefer A):

**Strategy A – Intercept from page context:**
- Content script on `suno.com` pages intercepts `fetch`/`XHR` requests via a page-level script injection
- Capture any request to `studio-api.suno.ai` and extract the `Authorization` header
- Send token to background via `chrome.runtime.sendMessage`
- Store in `chrome.storage.local`

**Strategy B – Cookie-based Clerk flow:**
- Read `__client` cookie from `suno.com` via `chrome.cookies.get`
- Parse the Clerk client payload to find the active session ID
- Hit `https://clerk.suno.com/v1/client/sessions/{session_id}/tokens` to get a fresh JWT
- Refresh token every ~55 seconds (Clerk JWTs expire in ~60s)

### Phase 3: Library Scanning
When user clicks "Scan Library" in popup:

1. Fetch `https://studio-api.suno.ai/api/feed/v2?page=0` with Bearer token
2. Parse response, collect all clip objects into an array
3. Increment page, repeat until empty response
4. Store full library manifest in `chrome.storage.local`
5. Update popup UI with total count, song list with checkboxes

**Important edge cases:**
- Token refresh mid-scan (if library is huge, the JWT may expire during pagination)
- Rate limiting: add 500ms delay between page fetches
- Handle API errors gracefully with retry logic (3 retries, exponential backoff)

### Phase 4: Bulk Download Engine
When user clicks "Download All" (or selected songs):

1. Create download queue from selected clips
2. For each clip, use `chrome.downloads.download()`:
   - URL: `https://cdn1.suno.ai/{clip.id}.mp3` (or use `clip.audio_url` if present)
   - Filename: sanitize to `{title} - {clip_id_short}.mp3`
     - Sanitize: replace `/\:*?"<>|` with `_`, trim whitespace, max 200 chars
   - Save to subfolder: `Suno Downloads/`
3. **Concurrency control**: max 3 simultaneous downloads to avoid throttling
4. Track progress: completed/total count
5. Skip files that error with 403 (some clips may have been deleted)
6. Save download manifest to storage so user can resume/skip already-downloaded songs

### Phase 5: Popup UI
Dark-themed popup (matches Suno's dark UI):

**States:**
1. **Not connected** – "Visit suno.com and log in, then click Refresh"
2. **Connected** – Shows username, credits, "Scan Library" button
3. **Scanning** – Progress bar: "Scanning page 5... Found 87 songs"
4. **Library loaded** – Song count, select all/none, search filter, "Download Selected MP3" button
5. **Downloading** – Progress bar: "Downloading 23/87... Current: VIV vs Danny"

**UI elements:**
- Song list with checkboxes (scrollable, max-height)
- Each row: checkbox, title, duration, version tag (v5/v6), date
- Select All / Deselect All buttons
- Download progress bar with percentage
- Status text area for logs
- "Download as CSV" button to export library metadata

## Key Technical Details

### Token Refresh Pattern
```javascript
// In background.js
let currentToken = null;
let tokenExpiry = 0;

async function getValidToken() {
  if (currentToken && Date.now() < tokenExpiry - 5000) {
    return currentToken;
  }
  // Re-extract from stored cookie or request fresh from Clerk
  const cookie = await chrome.cookies.get({ url: 'https://suno.com', name: '__client' });
  // Parse cookie, get session, refresh JWT...
  return currentToken;
}
```

### Filename Sanitization
```javascript
function sanitizeFilename(title, clipId) {
  const clean = title
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 180);
  const shortId = clipId.substring(0, 8);
  return `${clean} [${shortId}].mp3`;
}
```

### Download Queue with Concurrency
```javascript
async function downloadQueue(clips, maxConcurrent = 3) {
  let index = 0;
  let completed = 0;
  const total = clips.length;

  async function next() {
    if (index >= clips.length) return;
    const clip = clips[index++];
    const url = clip.audio_url || `https://cdn1.suno.ai/${clip.id}.mp3`;
    const filename = `Suno Downloads/${sanitizeFilename(clip.title, clip.id)}`;
    
    try {
      await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
      completed++;
      updateProgress(completed, total, clip.title);
    } catch (e) {
      console.error(`Failed: ${clip.title}`, e);
    }
    return next();
  }

  const workers = Array(maxConcurrent).fill(null).map(() => next());
  await Promise.all(workers);
}
```

## Constraints & Preferences
- MV3 only (no MV2)
- No external dependencies or npm – pure vanilla JS
- All API calls from background service worker (CORS-free)
- Use `chrome.storage.local` for state persistence
- Keep it simple: single-purpose tool, no feature creep
- Generate simple colored SVG icons (no external icon files needed)
- Test-friendly: add console.log breadcrumbs for debugging

## Output
Produce a complete, ready-to-load-unpacked Chrome extension. Every file should be complete and functional. After building, provide instructions to:
1. Go to `chrome://extensions`
2. Enable Developer Mode
3. Click "Load unpacked" and select the extension folder
4. Navigate to `suno.com/me` and log in
5. Click extension icon → Scan → Download All
