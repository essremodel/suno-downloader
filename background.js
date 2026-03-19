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

// ── API config ────────────────────────────────────────────────────────────────
// Primary domain confirmed via Suno's security disclosure + open-source projects.
// The legacy .suno.ai domain returns 503. Auto-discovery overrides both at runtime
// by reading the actual domain from intercepted page requests.
const API_DOMAINS = [
  'https://studio-api.prod.suno.com',
  'https://studio-api.suno.ai',        // legacy fallback
];
let activeApiBase = API_DOMAINS[0];    // updated by auto-discovery

// ── State ─────────────────────────────────────────────────────────────────────
let currentToken = null;
let tokenExpiry = 0;           // ms timestamp
let lastRefreshAttempt = 0;    // cooldown guard — prevents infinite retry loops
const REFRESH_COOLDOWN_MS = 10_000;
let scanAbortController = null;
let downloadActive = false;

// ── Message Router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[BG] message:', msg.action);

  switch (msg.action) {
    case 'storeToken':
      handleStoreToken(msg.token, msg.apiBase);
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

function handleStoreToken(token, apiBase) {
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

  // Auto-discover the live API base from the intercepted request URL
  if (apiBase && apiBase.includes('studio-api')) {
    activeApiBase = apiBase;
    console.log('[BG] API base auto-discovered from page:', activeApiBase);
    chrome.storage.local.set({ cachedToken: token, tokenExpiry, apiBase });
  } else {
    chrome.storage.local.set({ cachedToken: token, tokenExpiry });
  }
}

async function getValidToken() {
  // 1. Check in-memory first (fastest path — Strategy A intercept lands here)
  if (currentToken && Date.now() < tokenExpiry) {
    return currentToken;
  }

  // 2. Check storage (survives service-worker restarts)
  const stored = await chrome.storage.local.get(['cachedToken', 'tokenExpiry']);
  if (stored.cachedToken && Date.now() < (stored.tokenExpiry || 0)) {
    currentToken = stored.cachedToken;
    tokenExpiry = stored.tokenExpiry;
    return currentToken;
  }

  // 3. Cooldown guard — don't hammer Clerk if it keeps failing
  if (Date.now() - lastRefreshAttempt < REFRESH_COOLDOWN_MS) {
    throw new Error('No valid token. Browse any page on suno.com to capture your auth token automatically, or wait a moment and try Refresh Token.');
  }

  // 4. Fallback: try Clerk cookie flow
  return refreshTokenViaCookie();
}

async function refreshTokenViaCookie() {
  console.log('[BG] Attempting Clerk cookie token refresh...');
  lastRefreshAttempt = Date.now();

  // ── Step 1: Try __session on suno.com first ────────────────────────────────
  // __session is a short-lived (~60s) JWT Clerk sets on the app domain.
  // When present it's already a valid Bearer token — no exchange needed.
  const sessionCookie = await chrome.cookies.get({ url: 'https://suno.com', name: '__session' }).catch(() => null);
  if (sessionCookie?.value) {
    console.log('[BG] Using __session cookie directly as token');
    handleStoreToken(sessionCookie.value);
    return sessionCookie.value;
  }

  // ── Step 2: Use __client on clerk.suno.com (the FAPI domain) ──────────────
  // __client is long-lived and lives on clerk.suno.com, NOT on suno.com.
  const clientCookie = await chrome.cookies.get({ url: 'https://clerk.suno.com', name: '__client' }).catch(() => null);

  if (!clientCookie?.value) {
    throw new Error('No Clerk cookies found — please log in at suno.com and browse a page so your token is captured automatically.');
  }

  // ── Step 3: Parse __client JWT to extract active session ID ───────────────
  let sessionId;
  try {
    const payload = JSON.parse(
      atob(clientCookie.value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
    );
    console.log('[BG] __client payload keys:', Object.keys(payload));

    // Clerk encodes the session ID in `sid` or `sub` at the top level,
    // OR inside a nested `client.sessions` array.
    sessionId =
      payload.sid ||
      payload.sub ||
      payload.client?.sessions?.find(s => s.status === 'active')?.id ||
      payload.client?.sessions?.[0]?.id ||
      payload.sessions?.find(s => s.status === 'active')?.id ||
      payload.sessions?.[0]?.id;

    if (!sessionId) throw new Error('Could not locate session ID in __client JWT');
    console.log('[BG] Session ID:', sessionId);
  } catch (e) {
    throw new Error('Failed to parse __client cookie: ' + e.message);
  }

  // ── Step 4: Exchange session for a fresh JWT ───────────────────────────────
  // Service workers cannot use `credentials: include`, so we forward the
  // __client cookie value manually in the Cookie header.
  const url = `https://clerk.suno.com/v1/client/sessions/${sessionId}/tokens?__clerk_api_version=2021-02-05`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': `__client=${clientCookie.value}`,
    },
  });

  if (!resp.ok) {
    throw new Error(`Clerk token endpoint returned ${resp.status} — try reloading suno.com`);
  }

  const data = await resp.json();
  const jwt = data.jwt || data.token;
  if (!jwt) throw new Error('Clerk response missing jwt: ' + JSON.stringify(data));

  handleStoreToken(jwt);
  console.log('[BG] Token refreshed via Clerk cookie flow');
  return jwt;
}

// ── Suno API fetch helper ─────────────────────────────────────────────────────

async function sunoApiFetch(path, token) {
  const url = `${activeApiBase}${path}`;
  console.log(`[BG] API fetch: ${url}`);

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Origin': 'https://suno.com',
      'Referer': 'https://suno.com/',
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${text.substring(0, 200)}`);
  }

  return resp.json();
}

async function findWorkingApiBase(token) {
  for (const base of API_DOMAINS) {
    try {
      console.log(`[BG] Trying API domain: ${base}`);
      const resp = await fetch(`${base}/api/feed/v2?page=0`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'Origin': 'https://suno.com',
          'Referer': 'https://suno.com/',
        },
      });
      if (resp.ok || resp.status === 401) {
        // 401 = domain works but token bad; 200 = domain + token both good
        console.log(`[BG] Working API domain: ${base} (${resp.status})`);
        activeApiBase = base;
        chrome.storage.local.set({ apiBase: base });
        return base;
      }
      console.log(`[BG] Domain ${base} returned ${resp.status}`);
    } catch (e) {
      console.log(`[BG] Domain ${base} unreachable: ${e.message}`);
    }
  }
  throw new Error('All API domains failed — check your connection');
}

// ── Status ────────────────────────────────────────────────────────────────────

async function getStatus() {
  const stored = await chrome.storage.local.get(['library', 'downloaded', 'cachedToken', 'tokenExpiry', 'username', 'apiBase']);
  const hasToken = !!(stored.cachedToken && Date.now() < (stored.tokenExpiry || 0));

  // Restore the last-known working API base
  if (stored.apiBase) activeApiBase = stored.apiBase;

  const username = stored.username || null;

  return {
    connected: hasToken,
    username,
    apiBase: activeApiBase,
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

    // On the very first page, probe for the working API domain if needed
    let domainVerified = false;

    while (!signal.aborted) {
      const token = await getValidToken();

      console.log(`[BG] Scanning page ${page} via ${activeApiBase}...`);
      sendProgress('scan', { page, found: allClips.length, status: 'scanning' });

      let data;
      try {
        if (!domainVerified) {
          // First call — if it fails with 503 try fallback domains before giving up
          try {
            data = await sunoApiFetch(`/api/feed/v2?page=${page}`, token);
            domainVerified = true;
          } catch (e) {
            if (e.message.includes('503') || e.message.includes('502')) {
              console.warn(`[BG] ${activeApiBase} returned ${e.message} — trying fallback domains`);
              await findWorkingApiBase(token);
              data = await sunoApiFetch(`/api/feed/v2?page=${page}`, token);
              domainVerified = true;
            } else {
              throw e;
            }
          }
        } else {
          data = await sunoApiFetch(`/api/feed/v2?page=${page}`, token);
        }
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


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

console.log('[BG] Suno Downloader service worker started');
