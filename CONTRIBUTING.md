# Contributing

Keep changes focused and describe the user-visible behavior they affect. For bug reports, include your Chrome version, the action that failed, and a sanitized error message. Never attach authentication headers, cookies, HAR files, local browser storage, or private library exports.

## Local setup

Follow the [README installation steps](./README.md#install). Edit the source files, reload the unpacked extension in `chrome://extensions`, and reload the Suno tab so its content scripts update.

No npm install or build step is needed. The repository has no automated test suite or CI workflow.

## Syntax checks

If Node.js and Python 3 are available, run these from the repository root:

```bash
for file in background.js content.js injected.js id3-writer.js offscreen.js popup.js; do
  node --input-type=module --check < "$file" || exit 1
done
python3 -m json.tool manifest.json > /dev/null
git diff --check
```

These check parsing and whitespace; they do not validate Chrome APIs or live Suno behavior.

## Manual verification

For behavior changes, use your own account and record which checks you performed:

- Load the extension and inspect the service worker for startup errors.
- Connect with a signed-in Suno tab and scan the library.
- Check search, **All**, **None**, and the selected count. Search alone preserves hidden selections.
- Download one song before trying a batch. Check the file, playback, metadata, and available artwork.
- Export CSV and inspect the columns against the cached library.
- If changing scan logic, exercise cancellation and resume, and compare the result with a full rescan.

For documentation changes, verify file links, heading anchors, commands, and images. Inspect the README at desktop and narrow widths. Keep screenshots free of account details; label any captured state accurately.

## Pull requests

Explain the problem, resulting behavior, validation performed, and any remaining limitations. Keep generated assets small and place README images in `assets/`. Avoid committing downloads, credentials, browser profiles, or debug captures.
