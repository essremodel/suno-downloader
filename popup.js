/**
 * popup.js — Popup UI controller
 *
 * Manages all UI state transitions and communicates with background.js
 * via chrome.runtime.sendMessage.
 */

'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const panels = {
  disconnected: $('panel-disconnected'),
  connected:    $('panel-connected'),
  scanning:     $('panel-scanning'),
  library:      $('panel-library'),
  downloading:  $('panel-downloading'),
};

// ── State ─────────────────────────────────────────────────────────────────────
let allSongs = [];         // full library from storage
let filteredSongs = [];    // after search filter
let selectedIds = new Set();
let downloadedIds = new Set();
let currentPanel = 'disconnected';

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindButtons();
  listenToBackground();
  await loadStatus();
}

async function loadStatus() {
  try {
    const status = await bg('getStatus');
    log('Status loaded', 'info');
    applyStatus(status);
  } catch (e) {
    setStatus('Error connecting to background: ' + e.message);
    showPanel('disconnected');
  }
}

function applyStatus(status) {
  updateBadge(status.connected);

  if (!status.connected) {
    setStatus('Browse any page on suno.com — your token is captured automatically. Or click Refresh Token below.');
    showPanel('disconnected');
    return;
  }

  $('username-display').textContent = status.username || 'essremodel';

  if (status.libraryCount > 0) {
    $('library-count-display').textContent = `${status.libraryCount} songs`;
    // Load library data
    loadLibraryFromStorage();
  } else {
    $('library-count-display').textContent = 'Not scanned yet';
    setStatus('Connected. Click Scan Library to fetch your songs.');
    showPanel('connected');
  }
}

// ── Panel control ─────────────────────────────────────────────────────────────
function showPanel(name) {
  currentPanel = name;
  Object.entries(panels).forEach(([key, el]) => {
    el.classList.toggle('hidden', key !== name);
  });
}

function updateBadge(connected) {
  const badge = $('connection-badge');
  badge.textContent = connected ? 'Connected' : 'Not connected';
  badge.className = `badge ${connected ? 'badge-connected' : 'badge-disconnected'}`;
}

// ── Button bindings ───────────────────────────────────────────────────────────
function bindButtons() {
  // Refresh connection buttons
  $('btn-refresh-token').addEventListener('click', handleRefreshToken);
  $('btn-refresh-token-2').addEventListener('click', handleRefreshToken);

  // Scan
  $('btn-scan').addEventListener('click', handleScan);
  $('btn-cancel-scan').addEventListener('click', handleCancelScan);
  $('btn-rescan').addEventListener('click', handleScan);

  // Library controls
  $('btn-select-all').addEventListener('click', () => {
    selectedIds = new Set(filteredSongs.map(c => c.id));
    renderSongList();
    updateSelectionCount();
  });
  $('btn-deselect-all').addEventListener('click', () => {
    selectedIds.clear();
    renderSongList();
    updateSelectionCount();
  });

  // Search
  $('search-input').addEventListener('input', handleSearch);

  // Download
  $('btn-download-selected').addEventListener('click', handleDownload);

  // CSV export
  $('btn-export-csv').addEventListener('click', handleExportCSV);
}

// ── Token refresh ─────────────────────────────────────────────────────────────
async function handleRefreshToken() {
  setStatus('Refreshing token…');
  log('Refreshing Clerk token…', 'info');
  try {
    const result = await bg('refreshToken');
    if (result.error) throw new Error(result.error);
    log('Token refreshed successfully', 'success');
    await loadStatus();
  } catch (e) {
    setStatus('Refresh failed: ' + e.message);
    log('Refresh failed: ' + e.message, 'error');
    // Don't call loadStatus() here — it re-shows the same disconnected panel
    // and can feel like a loop. Let the user decide what to do next.
  }
}

// ── Scan ──────────────────────────────────────────────────────────────────────
async function handleScan() {
  showPanel('scanning');
  $('scan-status-text').textContent = 'Scanning page 0…';
  $('scan-count').textContent = 'Found 0 songs';
  setStatus('Scanning your library…');
  log('Starting library scan…', 'info');

  try {
    const result = await bg('scanLibrary');
    if (result.error) throw new Error(result.error);
    if (result.cancelled) {
      log(`Scan cancelled after finding ${result.count} songs`, 'info');
      setStatus(`Scan cancelled. Found ${result.count} songs.`);
      await loadStatus();
      return;
    }
    log(`Scan complete: ${result.count} songs found`, 'success');
    setStatus(`Found ${result.count} songs.`);
    await loadLibraryFromStorage();
  } catch (e) {
    log('Scan error: ' + e.message, 'error');
    setStatus('Scan failed: ' + e.message);
    showPanel('connected');
  }
}

function handleCancelScan() {
  bg('cancelScan');
  setStatus('Cancelling scan…');
}

// ── Library ───────────────────────────────────────────────────────────────────
async function loadLibraryFromStorage() {
  const { library } = await bgRaw('getLibrary');
  const { downloaded = {} } = await new Promise(r => chrome.storage.local.get(['downloaded'], r));

  allSongs = library || [];
  downloadedIds = new Set(Object.keys(downloaded));

  // Select all by default
  selectedIds = new Set(allSongs.map(c => c.id));

  filteredSongs = [...allSongs];
  renderLibraryPanel();
  showPanel('library');
  setStatus(`Library: ${allSongs.length} songs (${downloadedIds.size} already downloaded)`);
}

function renderLibraryPanel() {
  $('total-count').textContent = `${allSongs.length} song${allSongs.length !== 1 ? 's' : ''}`;
  renderSongList();
  updateSelectionCount();
}

function renderSongList() {
  const list = $('song-list');
  list.innerHTML = '';

  if (filteredSongs.length === 0) {
    list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px">No songs match your filter</div>';
    return;
  }

  const frag = document.createDocumentFragment();

  filteredSongs.forEach(clip => {
    const checked = selectedIds.has(clip.id);
    const downloaded = downloadedIds.has(clip.id);
    const row = createSongRow(clip, checked, downloaded);
    frag.appendChild(row);
  });

  list.appendChild(frag);
}

function createSongRow(clip, checked, downloaded) {
  const row = document.createElement('div');
  row.className = `song-row${checked ? ' checked' : ''}`;
  row.dataset.id = clip.id;

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = checked;
  cb.addEventListener('change', () => toggleSong(clip.id, cb.checked, row));

  const info = document.createElement('div');
  info.className = 'song-info';

  const title = document.createElement('div');
  title.className = 'song-title';
  title.textContent = clip.title || 'Untitled';
  title.title = clip.title || '';

  const meta = document.createElement('div');
  meta.className = 'song-meta';

  if (clip.metadata?.duration) {
    const dur = document.createElement('span');
    dur.textContent = formatDuration(clip.metadata.duration);
    meta.appendChild(dur);
  }

  if (clip.created_at) {
    const date = document.createElement('span');
    date.textContent = formatDate(clip.created_at);
    meta.appendChild(date);
  }

  info.appendChild(title);
  info.appendChild(meta);

  row.appendChild(cb);
  row.appendChild(info);

  // Version tag
  const modelVersion = clip.model_name || clip.metadata?.model || '';
  if (modelVersion) {
    const tag = document.createElement('span');
    tag.className = 'version-tag';
    tag.textContent = modelVersion.replace('chirp-', 'v').split('-')[0] || modelVersion;
    row.appendChild(tag);
  }

  // Downloaded mark
  if (downloaded) {
    const mark = document.createElement('span');
    mark.className = 'downloaded-mark';
    mark.textContent = '✓';
    mark.title = 'Already downloaded';
    row.appendChild(mark);
  }

  // Click row to toggle checkbox
  row.addEventListener('click', e => {
    if (e.target === cb) return;
    cb.checked = !cb.checked;
    toggleSong(clip.id, cb.checked, row);
  });

  return row;
}

function toggleSong(id, checked, row) {
  if (checked) {
    selectedIds.add(id);
    row.classList.add('checked');
  } else {
    selectedIds.delete(id);
    row.classList.remove('checked');
  }
  updateSelectionCount();
}

function updateSelectionCount() {
  $('selected-count').textContent = `${selectedIds.size} selected`;
  $('btn-download-selected').textContent =
    selectedIds.size === 0
      ? 'Download Selected MP3s'
      : `Download ${selectedIds.size} MP3${selectedIds.size !== 1 ? 's' : ''}`;
  $('btn-download-selected').disabled = selectedIds.size === 0;
}

function handleSearch(e) {
  const q = e.target.value.toLowerCase().trim();
  filteredSongs = q
    ? allSongs.filter(c => (c.title || '').toLowerCase().includes(q))
    : [...allSongs];
  renderSongList();
}

// ── Download ──────────────────────────────────────────────────────────────────
async function handleDownload() {
  if (selectedIds.size === 0) return;

  const clipIds = [...selectedIds];
  showPanel('downloading');
  $('dl-count').textContent = `0 / ${clipIds.length}`;
  $('dl-pct').textContent = '0%';
  $('dl-progress-fill').style.width = '0%';
  $('dl-current').textContent = 'Starting…';
  $('dl-failed').classList.add('hidden');

  setStatus(`Downloading ${clipIds.length} songs…`);
  log(`Starting download of ${clipIds.length} songs…`, 'info');

  try {
    const result = await bg('startDownloads', { clipIds });
    if (result.error) throw new Error(result.error);
    log(`Downloads queued: ${clipIds.length} songs`, 'info');
  } catch (e) {
    log('Download error: ' + e.message, 'error');
    setStatus('Download failed: ' + e.message);
    showPanel('library');
  }
}

// ── CSV Export ────────────────────────────────────────────────────────────────
function handleExportCSV() {
  if (allSongs.length === 0) return;

  const headers = ['ID', 'Title', 'Duration', 'Model', 'Created At', 'Tags', 'Prompt', 'Audio URL'];
  const rows = allSongs.map(c => [
    c.id || '',
    csvEscape(c.title || ''),
    c.metadata?.duration ? formatDuration(c.metadata.duration) : '',
    c.model_name || c.metadata?.model || '',
    c.created_at ? new Date(c.created_at).toISOString() : '',
    csvEscape((c.metadata?.tags || '').toString()),
    csvEscape((c.metadata?.prompt || c.metadata?.gpt_description_prompt || '').toString()),
    c.audio_url || `https://cdn1.suno.ai/${c.id}.mp3`,
  ]);

  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download({
    url,
    filename: `Suno Library ${new Date().toISOString().slice(0, 10)}.csv`,
    saveAs: false,
  });

  log(`CSV export: ${allSongs.length} songs`, 'success');
}

function csvEscape(str) {
  if (!str) return '';
  const s = String(str).replace(/"/g, '""');
  return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s}"` : s;
}

// ── Background message listener ───────────────────────────────────────────────
function listenToBackground() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action !== 'progress') return;

    if (msg.type === 'scan') {
      handleScanProgress(msg);
    } else if (msg.type === 'download') {
      handleDownloadProgress(msg);
    }
  });
}

function handleScanProgress(msg) {
  if (currentPanel !== 'scanning') return;

  if (msg.status === 'scanning') {
    $('scan-status-text').textContent = `Scanning page ${msg.page}…`;
    $('scan-count').textContent = `Found ${msg.found} songs`;
  } else if (msg.status === 'complete') {
    $('scan-status-text').textContent = 'Scan complete!';
    $('scan-count').textContent = `Found ${msg.found} songs`;
  } else if (msg.status === 'error') {
    $('scan-status-text').textContent = 'Error: ' + msg.error;
  }
}

function handleDownloadProgress(msg) {
  if (currentPanel !== 'downloading') return;

  const { completed = 0, failed = 0, total = 1, current = '', status } = msg;
  const pct = Math.round((completed / total) * 100);

  $('dl-count').textContent = `${completed} / ${total}`;
  $('dl-pct').textContent = `${pct}%`;
  $('dl-progress-fill').style.width = `${pct}%`;

  if (current) {
    $('dl-current').textContent = `↓ ${current}`;
  }

  if (failed > 0) {
    $('dl-failed').classList.remove('hidden');
    $('dl-failed').textContent = `${failed} failed`;
  }

  if (status === 'complete') {
    setStatus(`Done! Downloaded ${completed} songs${failed > 0 ? `, ${failed} failed` : ''}.`);
    log(`Downloads complete: ${completed} ok, ${failed} failed`, completed > 0 ? 'success' : 'info');
    $('dl-current').textContent = 'All done!';
    // After a short delay, return to library panel
    setTimeout(() => {
      downloadedIds = new Set([...downloadedIds, ...selectedIds]);
      loadLibraryFromStorage();
    }, 2000);
  } else if (status === 'error') {
    setStatus('Download error: ' + msg.error);
    log('Download error: ' + msg.error, 'error');
    setTimeout(() => showPanel('library'), 1500);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function setStatus(text) {
  $('status-text').textContent = text;
}

function log(text, type = 'info') {
  const logArea = $('log-area');
  const content = $('log-content');
  const entry = document.createElement('span');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  content.appendChild(entry);
  content.appendChild(document.createElement('br'));
  logArea.classList.remove('hidden');
  logArea.scrollTop = logArea.scrollHeight;

  // Keep max 30 entries
  const entries = content.querySelectorAll('.log-entry');
  if (entries.length > 30) {
    entries[0].nextSibling?.remove(); // remove <br>
    entries[0].remove();
  }
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  try {
    return new Date(isoStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

// ── Chrome messaging helpers ──────────────────────────────────────────────────

function bg(action, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...extra }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (resp && resp.error) {
        reject(new Error(resp.error));
        return;
      }
      resolve(resp || {});
    });
  });
}

function bgRaw(action, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...extra }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp || {});
    });
  });
}
