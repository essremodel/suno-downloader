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
      scanLibrary(sendResponse, msg.resumeFromPage || 0);
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
      chrome.storage.local.remove(['library', 'downloaded', 'scanComplete', 'scanPage'], () => sendResponse({ ok: true }));
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

// options: { signal, maxRetries, onRateLimit(waitSecs) }
async function sunoApiFetch(path, token, { signal, maxRetries = 5, onRateLimit } = {}) {
  const url = `${activeApiBase}${path}`;
  console.log(`[BG] API fetch: ${url}`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let resp;
    try {
      resp = await fetch(url, {
        signal,
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
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (attempt === maxRetries) throw e;
      await sleep(2000 * attempt);
      continue;
    }

    if (resp.ok) return resp.json();

    if (resp.status === 429) {
      if (attempt === maxRetries) {
        throw new Error(`HTTP 429: Rate limited after ${maxRetries} attempts`);
      }
      // Respect Retry-After header if present, otherwise exponential backoff:
      // attempt 1→10s, 2→30s, 3→60s, 4→120s cap at 240s
      const retryAfter = resp.headers.get('Retry-After');
      let waitMs;
      if (retryAfter && !isNaN(retryAfter)) {
        waitMs = parseInt(retryAfter) * 1000 + 1000;
      } else {
        waitMs = Math.min(10_000 * Math.pow(3, attempt - 1), 240_000);
      }
      const waitSecs = Math.round(waitMs / 1000);
      console.log(`[BG] Rate limited (429). Waiting ${waitSecs}s (attempt ${attempt}/${maxRetries})…`);
      if (onRateLimit) onRateLimit(waitSecs);
      await sleep(waitMs);
      continue;
    }

    // 5xx: shorter backoff, give up after maxRetries
    if (resp.status >= 500 && attempt < maxRetries) {
      const waitMs = 2000 * Math.pow(2, attempt - 1);
      console.warn(`[BG] HTTP ${resp.status}, retrying in ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }

    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${text.substring(0, 200)}`);
  }
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
  const stored = await chrome.storage.local.get(['library', 'downloaded', 'cachedToken', 'tokenExpiry', 'username', 'apiBase', 'scanComplete', 'scanPage']);
  const hasToken = !!(stored.cachedToken && Date.now() < (stored.tokenExpiry || 0));

  if (stored.apiBase) activeApiBase = stored.apiBase;

  return {
    connected: hasToken,
    username: stored.username || null,
    apiBase: activeApiBase,
    libraryCount: (stored.library || []).length,
    downloadedCount: Object.keys(stored.downloaded || {}).length,
    downloadActive,
    scanComplete: stored.scanComplete !== false,  // true if never run or finished
    scanPage: stored.scanPage || 0,
  };
}

// ── Library Scanning ──────────────────────────────────────────────────────────

async function scanLibrary(sendResponse, startPage = 0) {
  if (scanAbortController) scanAbortController.abort();
  scanAbortController = new AbortController();
  const signal = scanAbortController.signal;

  const PAGE_SIZE = 20;
  const PAGE_DELAY_MS = 1500; // 1.5s between pages to stay well under rate limit
  let page = startPage;

  // Load pre-existing songs when resuming
  let allClips = [];
  if (startPage > 0) {
    const stored = await chrome.storage.local.get(['library']);
    allClips = stored.library || [];
    console.log(`[BG] Resuming from page ${startPage} with ${allClips.length} existing songs`);
  }

  let domainVerified = startPage > 0; // skip domain probe when resuming

  const onRateLimit = (waitSecs) =>
    sendProgress('scan', { page, found: allClips.length, status: 'ratelimit', waitSecs });

  try {
    sendProgress('scan', { page, found: allClips.length, status: startPage > 0 ? 'resuming' : 'starting' });

    while (!signal.aborted) {
      const token = await getValidToken();

      console.log(`[BG] Scanning page ${page} via ${activeApiBase}…`);
      sendProgress('scan', { page, found: allClips.length, status: 'scanning' });

      let data;
      try {
        if (!domainVerified) {
          try {
            data = await sunoApiFetch(`/api/feed/v2?page=${page}`, token, { signal, onRateLimit });
            domainVerified = true;
          } catch (e) {
            if (e.message.includes('503') || e.message.includes('502')) {
              console.warn(`[BG] ${activeApiBase} → ${e.message} — trying fallback domains`);
              await findWorkingApiBase(token);
              data = await sunoApiFetch(`/api/feed/v2?page=${page}`, token, { signal, onRateLimit });
              domainVerified = true;
            } else {
              throw e;
            }
          }
        } else {
          data = await sunoApiFetch(`/api/feed/v2?page=${page}`, token, { signal, onRateLimit });
        }
      } catch (e) {
        if (e.name === 'AbortError') break;
        throw e;
      }

      const clips = Array.isArray(data) ? data : (data.clips || data.songs || data.data || []);

      if (!clips || clips.length === 0) {
        console.log('[BG] Scan complete — no more pages');
        break;
      }

      const valid = clips.filter(c => c.id && (c.status === 'complete' || c.audio_url));
      allClips.push(...valid);

      console.log(`[BG] Page ${page}: ${clips.length} clips (${valid.length} valid), total: ${allClips.length}`);

      // Save incrementally after every page so a later failure doesn't lose everything
      await chrome.storage.local.set({ library: allClips, scanComplete: false, scanPage: page });

      if (clips.length < PAGE_SIZE) break; // last page

      page++;
      await sleep(PAGE_DELAY_MS);
    }

    if (signal.aborted) {
      sendProgress('scan', { status: 'cancelled', found: allClips.length });
      sendResponse({ cancelled: true, count: allClips.length });
      return;
    }

    await chrome.storage.local.set({ library: allClips, scanComplete: true, scanPage: page });
    console.log(`[BG] Library saved: ${allClips.length} songs`);

    sendProgress('scan', { status: 'complete', found: allClips.length });
    sendResponse({ ok: true, count: allClips.length });

  } catch (e) {
    console.error('[BG] Scan error:', e);

    if (allClips.length > 0) {
      // Preserve the songs we already have — never throw them away
      await chrome.storage.local.set({ library: allClips, scanComplete: false, scanPage: page });
      console.log(`[BG] Partial scan saved: ${allClips.length} songs through page ${page}`);
      sendProgress('scan', { status: 'partial', found: allClips.length, page, error: e.message });
      sendResponse({ partial: true, count: allClips.length, page, error: e.message });
    } else {
      sendProgress('scan', { status: 'error', error: e.message });
      sendResponse({ error: e.message });
    }
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
