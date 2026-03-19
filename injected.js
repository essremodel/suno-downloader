/**
 * injected.js — Runs in the MAIN world (page context) via manifest "world": "MAIN".
 * No inline script injection needed, so Suno's CSP is not violated.
 *
 * Monkey-patches fetch and XHR to capture Authorization headers sent to
 * studio-api.suno.ai / clerk.suno.com, then posts them to the content script
 * via window.postMessage.
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
      url.includes('studio-api.suno.ai') ||
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
        window.postMessage(
          { type: '__SUNO_AUTH_TOKEN__', token: auth, url },
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
      (this._sunoUrl.includes('studio-api.suno.ai') ||
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
