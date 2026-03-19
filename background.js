/**
 * background.js — MV3 Service Worker
 *
 * Responsibilities:
 *  - Auth token management (intercept from content.js OR Clerk cookie flow)
 *  - Library scanning (paginated feed API)
 *  - Bulk download orchestration (concurrency-limited queue)
 *  - Progress reporting to popup
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let currentToken = null;
let tokenExpiry = 0;         // ms timestamp
let scanAbortController = null;
let downloadActive = false;

// ── Message Router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[BG] message:', msg.action);

  switch (msg.action) {
    case 'storeToken':
      handleStoreToken(msg.token);
      sendResponse({ ok: true });
      break;

    case 'sunoTabActive':
      // Content script ping – no-op, just confirms tab is alive
      sendResponse({ ok: true });
      break;

    case 'getStatus':
      getStatus().then(sendResponse);
      return true; // async

    case 'refreshToken':
      refreshTokenViaCookie().then(token => sendResponse({ token })).catch(e => sendResponse({ error: e.message }));
      return true;

    case 'scanLibrary':
      scanLibrary(sendResponse);
      return true;

    case 'cancelScan':
      if (scanAbortController) scanAbortController.abort();
      sendResponse({ ok: true });
      break;

    case 'startDownloads':
      startDownloads(msg.clipIds, sendResponse);
      return true;

    case 'getLibrary':
      chrome.storage.local.get(['library'], r => sendResponse({ library: r.library || [] }));
      return true;

    case 'clearLibrary':
      chrome.storage.local.remove(['library', 'downloaded'], () => sendResponse({ ok: true }));
      return true;

    default:
      sendResponse({ error: 'unknown action' });
  }
});

// ── Token Helpers ─────────────────────────────────────────────────────────────

function handleStoreToken(token) {
  if (!token) return;
  currentToken = token;
  // Estimate expiry: Clerk JWTs expire in ~60s, be conservative
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    tokenExpiry = (payload.exp * 1000) - 5000;
    console.log('[BG] Token stored, expires in', Math.round((tokenExpiry - Date.now()) / 1000), 's');
  } catch {
    tokenExpiry = Date.now() + 55_000;
  }
  chrome.storage.local.set({ cachedToken: token, tokenExpiry });
}

async function getValidToken() {
  // Check in-memory first
  if (currentToken && Date.now() < tokenExpiry) {
    return currentToken;
  }

  // Check storage
  const stored = await chrome.storage.local.get(['cachedToken', 'tokenExpiry']);
  if (stored.cachedToken && Date.now() < (stored.tokenExpiry || 0)) {
    currentToken = stored.cachedToken;
    tokenExpiry = stored.tokenExpiry;
    return currentToken;
  }

  // Fallback: try Clerk cookie flow
  return refreshTokenViaCookie();
}

async function refreshTokenViaCookie() {
  console.log('[BG] Attempting Clerk cookie token refresh...');

  // 1. Read __client cookie
  let cookie;
  try {
    cookie = await chrome.cookies.get({ url: 'https://suno.com', name: '__client' });
  } catch (e) {
    throw new Error('Cannot read suno.com cookies — make sure you are logged in at suno.com');
  }

  if (!cookie) {
    throw new Error('No __client cookie found — please log in at suno.com');
  }

  // 2. Parse the Clerk client object from the cookie value
  //    The cookie value is a JWT. Decode the payload to find active session.
  let sessionId;
  try {
    const parts = cookie.value.split('.');
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    console.log('[BG] Clerk client payload keys:', Object.keys(payload));

    // The payload contains a `client` object with `sessions` array
    const sessions = payload.client?.sessions || payload.sessions || [];
    const activeSession = sessions.find(s => s.status === 'active') || sessions[0];

    if (!activeSession) throw new Error('No active Clerk session found in cookie');
    sessionId = activeSession.id;
    console.log('[BG] Found session ID:', sessionId);
  } catch (e) {
    if (e.message.includes('session')) throw e;
    throw new Error('Failed to parse __client cookie: ' + e.message);
  }

  // 3. Exchange session for JWT
  const url = `https://clerk.suno.com/v1/client/sessions/${sessionId}/tokens?__clerk_api_version=2021-02-05`;
  const resp = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!resp.ok) {
    throw new Error(`Clerk token endpoint returned ${resp.status}`);
  }

  const data = await resp.json();
  const jwt = data.jwt || data.token;
  if (!jwt) throw new Error('Clerk response missing jwt field: ' + JSON.stringify(data));

  handleStoreToken(jwt);
  console.log('[BG] Token refreshed via Clerk cookie flow');
  return jwt;
}

// ── Status ────────────────────────────────────────────────────────────────────

async function getStatus() {
  const stored = await chrome.storage.local.get(['library', 'downloaded', 'cachedToken', 'tokenExpiry', 'username']);
  const hasToken = !!(stored.cachedToken && Date.now() < (stored.tokenExpiry || 0));

  // Try to get username from stored data or fetch it
  let username = stored.username || null;

  return {
    connected: hasToken,
    username,
    libraryCount: (stored.library || []).length,
    downloadedCount: Object.keys(stored.downloaded || {}).length,
    downloadActive,
  };
}

// ── Library Scanning ──────────────────────────────────────────────────────────

async function scanLibrary(sendResponse) {
  if (scanAbortController) scanAbortController.abort();
  scanAbortController = new AbortController();
  const signal = scanAbortController.signal;

  const allClips = [];
  let page = 0;
  const PAGE_SIZE = 20; // Suno's default

  try {
    sendProgress('scan', { page: 0, found: 0, status: 'starting' });

    while (!signal.aborted) {
      const token = await getValidToken();
      const url = `https://studio-api.suno.ai/api/feed/v2?page=${page}`;

      console.log(`[BG] Scanning page ${page}...`);
      sendProgress('scan', { page, found: allClips.length, status: 'scanning' });

      let data;
      try {
        data = await fetchWithRetry(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });
      } catch (e) {
        if (e.name === 'AbortError') break;
        throw e;
      }

      // API returns either { clips: [...] } or just an array
      const clips = Array.isArray(data) ? data : (data.clips || data.data || []);

      if (!clips || clips.length === 0) {
        console.log('[BG] Scan complete — no more pages');
        break;
      }

      // Filter out non-complete clips (uploading, error, etc.)
      const valid = clips.filter(c => c.id && (c.status === 'complete' || c.audio_url));
      allClips.push(...valid);

      console.log(`[BG] Page ${page}: got ${clips.length} clips (${valid.length} valid), total: ${allClips.length}`);

      if (clips.length < PAGE_SIZE) {
        // Last page
        break;
      }

      page++;
      // Rate-limit: 500ms between pages
      await sleep(500);
    }

    if (signal.aborted) {
      sendProgress('scan', { status: 'cancelled', found: allClips.length });
      sendResponse({ cancelled: true, count: allClips.length });
      return;
    }

    // Persist library
    await chrome.storage.local.set({ library: allClips });
    console.log(`[BG] Library saved: ${allClips.length} songs`);

    sendProgress('scan', { status: 'complete', found: allClips.length });
    sendResponse({ ok: true, count: allClips.length });

  } catch (e) {
    console.error('[BG] Scan error:', e);
    sendProgress('scan', { status: 'error', error: e.message });
    sendResponse({ error: e.message });
  }
}

// ── Download Engine ───────────────────────────────────────────────────────────

async function startDownloads(clipIds, sendResponse) {
  if (downloadActive) {
    sendResponse({ error: 'Download already in progress' });
    return;
  }

  const { library = [], downloaded = {} } = await chrome.storage.local.get(['library', 'downloaded']);

  // Filter to requested clips (or all if not specified)
  const clips = clipIds
    ? library.filter(c => clipIds.includes(c.id))
    : library;

  if (clips.length === 0) {
    sendResponse({ error: 'No clips to download' });
    return;
  }

  downloadActive = true;
  sendResponse({ ok: true, total: clips.length });

  const total = clips.length;
  let completed = 0;
  let failed = 0;

  sendProgress('download', { completed, failed, total, status: 'starting' });

  try {
    await downloadQueue(clips, 3, async (clip, success, error) => {
      if (success) {
        completed++;
        downloaded[clip.id] = { title: clip.title, downloadedAt: Date.now() };
        await chrome.storage.local.set({ downloaded });
      } else {
        failed++;
        console.warn(`[BG] Failed to download "${clip.title}":`, error);
      }
      sendProgress('download', { completed, failed, total, current: clip.title, status: 'downloading' });
    });

    sendProgress('download', { completed, failed, total, status: 'complete' });
    console.log(`[BG] Downloads complete: ${completed} ok, ${failed} failed`);
  } catch (e) {
    console.error('[BG] Download error:', e);
    sendProgress('download', { completed, failed, total, status: 'error', error: e.message });
  } finally {
    downloadActive = false;
  }
}

async function downloadQueue(clips, maxConcurrent, onResult) {
  let index = 0;

  async function next() {
    while (index < clips.length) {
      const clip = clips[index++];
      const url = clip.audio_url || `https://cdn1.suno.ai/${clip.id}.mp3`;
      const filename = `Suno Downloads/${sanitizeFilename(clip.title || 'Untitled', clip.id)}`;

      console.log(`[BG] Downloading: ${clip.title} → ${filename}`);

      try {
        await downloadFile(url, filename);
        await onResult(clip, true, null);
      } catch (e) {
        await onResult(clip, false, e.message);
      }

      // Small delay between downloads to be polite
      await sleep(200);
    }
  }

  const workers = Array.from({ length: maxConcurrent }, () => next());
  await Promise.all(workers);
}

function downloadFile(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename, conflictAction: 'uniquify', saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        // Wait for download to complete
        const listener = (delta) => {
          if (delta.id !== downloadId) return;

          if (delta.state?.current === 'complete') {
            chrome.downloads.onChanged.removeListener(listener);
            resolve(downloadId);
          } else if (delta.state?.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(listener);
            reject(new Error(`Download interrupted: ${delta.error?.current || 'unknown'}`));
          }
        };

        chrome.downloads.onChanged.addListener(listener);

        // Timeout guard: 5 minutes per file
        setTimeout(() => {
          chrome.downloads.onChanged.removeListener(listener);
          resolve(downloadId); // Don't reject on timeout — it may still be downloading
        }, 300_000);
      }
    );
  });
}

// ── Progress Broadcast ────────────────────────────────────────────────────────

function sendProgress(type, data) {
  chrome.runtime.sendMessage({ action: 'progress', type, ...data }).catch(() => {
    // Popup may be closed — that's fine
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sanitizeFilename(title, clipId) {
  const clean = (title || 'Untitled')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 180);
  const shortId = (clipId || '').substring(0, 8);
  return shortId ? `${clean} [${shortId}].mp3` : `${clean}.mp3`;
}

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(1000 * Math.pow(2, attempt - 1)); // exponential backoff
    }
    try {
      const resp = await fetch(url, options);

      if (resp.status === 401 || resp.status === 403) {
        // Token expired — try refresh
        console.log(`[BG] Got ${resp.status}, attempting token refresh...`);
        try {
          await refreshTokenViaCookie();
        } catch {
          // If cookie refresh fails, we'll try again next iteration
        }
        // Retry with fresh token on next iteration
        if (options.headers) {
          const newToken = await getValidToken();
          options.headers.Authorization = `Bearer ${newToken}`;
        }
        continue;
      }

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }

      return resp.json();
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastError = e;
      console.warn(`[BG] Fetch attempt ${attempt + 1} failed:`, e.message);
    }
  }
  throw lastError || new Error('Max retries exceeded');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

console.log('[BG] Suno Downloader service worker started');
