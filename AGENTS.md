# TOEFL Learning Studio contributor guidance

This is a static, client-side Vite app deployed to GitHub Pages. Each cloud task already has an isolated checkout; use the existing checkout and do not create a worktree unless explicitly asked.

## Development and validation

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci
npm run dev
npm test
npm run build
CHROME_PATH=/usr/bin/chromium npm run test:browser
CHROME_PATH=/usr/bin/chromium npm run test:restart
RUN_TTS=1 CHROME_PATH=/usr/bin/chromium npm run test:browser
```

Do not equate a build with working speech. Test the actual production build, IndexedDB round trips, backup with audio and real inference when touching the TTS path. The default browser suite does not run model inference; report that separately. Chrome/Edge native save pickers and audible quality need human checks. Keep TLS and package integrity verification enabled. CUDA is unnecessary for the browser workflow; the official ONNX install skip flag avoids a redundant Node GPU download.

## Active architecture

- `index.html`: CSP, static shell, accessible dialogs/progress, new app entry.
- `src/studio.js`: four libraries, material editor, vocabulary/source capture, review, audio views, settings, hash routing. All user text must be escaped before HTML insertion.
- `src/studio-db.js`: IndexedDB stores (`materials`, `vocabulary`, `audio`, `settings`), stable content block IDs, source relations, deduplication, hashes and atomic validated backup restore.
- `src/studio-tts.js`: one active inference job, monotonic IDs and cancellation; wraps the original module Worker.
- `src/studio.css`, `src/studio-layout.css`: responsive reading-oriented UI. System fonts avoid external font dependencies.
- `src/tts.worker.js`, `src/chunk.js`, `src/audio.js`, `src/voices.js`: existing Kokoro inference and audio helpers, shared by every subject.
- `src/save.js`, `src/storage.js`: existing native file picker, directory handle persistence and download fallback. Their old `textusound` DB is independent of the learning library.
- `src/main.js` and `src/styles.css`: retained legacy Textusound UI, not the current entry point.
- `tests/data.test.js`, `tests/browser.cjs`, `tests/restart.cjs`: model integrity tests and served production browser checks.

## Invariants

1. Preserve the original worker protocol. Job IDs gate results, generation is serialized with a trailing queue catch, and cancellation cannot publish stale output.
2. Paragraph breaks survive chunking. `chunkText` returns `{ text, paragraphBreakBefore }`; the worker inserts longer paragraph pauses. Never flatten all whitespace before chunking.
3. Materials and content block IDs remain stable during edits. Speaking always contains four ordered questions. Answers have their own IDs and types.
4. Audio records hold actual Blob bytes, text, content SHA-256, owner/block identity, voice, speed and timestamp. Cache reuse requires text hash and settings. Old audio is retained with a warning when its source text changes. Original uploads are explicitly distinct from generated TTS.
5. Vocabulary is deduplicated by normalized term and collection. Sources can have multiple examples. Removing a material/answer unlinks only its sources; unrelated vocabulary survives. Remove orphaned owned audio in the same transaction.
6. Only report saving after transaction commit. Backup import validates schema and references before replacing stores in a single transaction. Never partially clear a library on a bad backup.
7. Native save picker must be invoked directly in the user click before awaiting anything else. Preserve download fallback and do not discard saved audio when permission is denied or the picker is cancelled.
8. Revoke object URLs when discarding/replacing views or audio. Do not persist blob URLs or local file paths as audio.
9. All app asset paths stay relative (`base: "./"`). Use hash navigation for GitHub Pages subpath support. CSP must include every external model/runtime origin; do not weaken it globally.
10. No backend, paid API, hidden external text upload or invented translations/IPA. Local browser storage is not cloud backup. Keep backup/export and capacity guidance visible.

Keep vanilla ES modules, two-space indentation and plain user-facing language. Prefer permissive third-party licenses (MIT/BSD/Apache); app code is CC0. Changes to dependency licensing should be reviewed.
