/**
 * content.js — Runs on suno.com pages in the ISOLATED world (document_start).
 *
 * injected.js (world: MAIN) patches fetch/XHR and posts tokens via postMessage.
 * This script listens for those messages and relays them to background.js.
 */

(function () {
  'use strict';

  // ── Listen for messages from injected.js (MAIN world) ─────────────────────
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== '__SUNO_AUTH_TOKEN__') return;

    const token = event.data.token;
    if (!token || !token.startsWith('Bearer ')) return;

    console.log('[Suno Downloader] Intercepted auth token from page');
    chrome.runtime.sendMessage({
      action: 'storeToken',
      token: token.replace('Bearer ', ''),
      apiBase: event.data.apiBase || null,
    }).catch(() => {}); // popup may not be open
  });

  // Notify background that a suno.com tab is active
  chrome.runtime.sendMessage({ action: 'sunoTabActive' }).catch(() => {});
})();
