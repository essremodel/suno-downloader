/**
 * injected.js — Runs in the MAIN world (page context) via manifest "world": "MAIN".
 * No inline script injection needed, so Suno's CSP is not violated.
 *
 * Monkey-patches fetch and XHR to capture Authorization headers sent to
 * studio-api.prod.suno.com / clerk.suno.com, then posts them to the content
 * script via window.postMessage. Also relays the origin so background.js
 * can auto-discover the live API base domain.
 */

(function () {
  'use strict';

  // ── Patch fetch ────────────────────────────────────────────────────────────
  const _origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof Request
        ? input.url
        : '';

    if (
      url.includes('studio-api.prod.suno.com') ||
      url.includes('studio-api.suno.ai') ||   // legacy fallback — intercept either domain
      url.includes('clerk.suno.com')
    ) {
      const headers =
        (init && init.headers) ||
        (input instanceof Request && input.headers) ||
        {};

      let auth = null;
      if (headers instanceof Headers) {
        auth = headers.get('authorization') || headers.get('Authorization');
      } else if (typeof headers === 'object') {
        auth = headers['authorization'] || headers['Authorization'];
      }

      if (auth) {
        let apiBase = null;
        try { apiBase = new URL(url).origin; } catch {}
        window.postMessage(
          { type: '__SUNO_AUTH_TOKEN__', token: auth, url, apiBase },
          '*'
        );
      }
    }

    return _origFetch.apply(this, arguments);
  };

  // ── Patch XHR ──────────────────────────────────────────────────────────────
  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._sunoUrl = url;
    return _origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (
      name.toLowerCase() === 'authorization' &&
      this._sunoUrl &&
      (this._sunoUrl.includes('studio-api.prod.suno.com') ||
        this._sunoUrl.includes('studio-api.suno.ai') ||
        this._sunoUrl.includes('clerk.suno.com'))
    ) {
      window.postMessage(
        { type: '__SUNO_AUTH_TOKEN__', token: value, url: this._sunoUrl },
        '*'
      );
    }
    return _origSetHeader.apply(this, arguments);
  };
})();
