/**
 * offscreen.js — Runs inside the offscreen document (full DOM context).
 *
 * MV3 service workers do not have URL.createObjectURL. This offscreen document
 * acts as a thin proxy: it receives base64-encoded MP3 data from the background
 * service worker, decodes it, creates a blob URL, and returns the URL.
 *
 * Communication: chrome.runtime.sendMessage (background ↔ offscreen).
 */

'use strict';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  // ── Create a blob URL from base64-encoded MP3 data ─────────────────────────
  if (msg.action === 'createBlobUrl') {
    try {
      // Decode base64 → binary string → Uint8Array
      const binary = atob(msg.base64);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      const blob = new Blob([bytes], { type: msg.mimeType || 'audio/mpeg' });
      const url  = URL.createObjectURL(blob);
      sendResponse({ url });

      // Auto-revoke after 5 minutes as a safety net against leaks
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
    } catch (err) {
      console.error('[Offscreen] createBlobUrl error:', err);
      sendResponse({ error: err.message });
    }
    return true; // keep message channel open for async sendResponse
  }

  // ── Explicitly revoke a blob URL when the download finishes ───────────────
  if (msg.action === 'revokeBlobUrl') {
    try { URL.revokeObjectURL(msg.url); } catch { /* already revoked is fine */ }
    sendResponse({ ok: true });
    return false;
  }
});
