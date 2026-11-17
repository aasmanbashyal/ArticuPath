# Backend and storage contracts

Both the desktop WebView and browser mode use `desktop-rust/src/server.rs`. `scripts/start.js` only builds, watches, and launches Rust. Browser mode uses the `full-media` feature for FFmpeg imports and background replacement. Compact desktop builds retain their existing platform codec support. The API rejects mutation requests from other origins and only listens on loopback in server mode.

## Sessions

`GET /api/state` returns models, settings, sessions, active transcription, and unfinished `recordings`. Sessions currently include their transcripts. `GET /api/transcription` provides a smaller polling response. `POST /api/sessions` imports media with an `application/octet-stream` body containing one JSON metadata line, a newline, then media bytes. Imports retain the 160 MiB and 15 minute limits.

`PATCH /api/sessions/:id` applies one edit category per request, in order: title, feedback, or tags/cue card. Send those edits separately. `DELETE /api/sessions/:id` deletes a saved take. `/media` supports ranges and `?download`; `POST /transcribe` saves results even if the requesting browser disconnects. Only one transcription runs at a time.

Each UUID directory contains `session.json` and `recording.<ext>` or `recording-small.webm`. JSON is the source of truth. It includes `id`, `title`, `kind`, `duration`, `file`, `mime`, `media`, `createdAt`, and `segments`. Optional fields include script, cueId, tags, captureMode, indexed, storage, modelId, transcriptDone, and feedback. Existing sessions and configured storage folders remain compatible. Metadata edits are atomic; finalization flushes media and metadata before deleting capture chunks.

## Recording during capture

1. `POST /api/recordings` accepts JSON with `filename`, `title`, `recorded`, `captureMode`, `script`, and `cueId`. It returns a UUID after storing `capture.json`.
2. `PUT /api/recordings/:id/chunks/:sequence` accepts binary data. Sequences start at zero and must be contiguous. The server writes a temporary file, flushes it to disk, then renames it to `chunks/0000.chunk`. A repeated sequence must have the same SHA-256 digest. Missing sequences and conflicting retries return 409. The total committed size cannot exceed 160 MiB.
3. `POST /api/recordings/:id/finish` streams committed chunks into the final media file, probes it, and writes `session.json`. A retry returns the same session. Failed probing leaves the original chunks intact.
4. `GET /api/recordings/:id/media` downloads the committed portion, including when it cannot be finalized. `DELETE /api/recordings/:id/discard` removes an unfinished take after the UI confirmation.

`capture.json` and numbered chunks are recoverable across restarts and storage-folder changes. `.partial` files are never treated as committed audio. A `session.json` marks completion, so a crash during cleanup cannot create a duplicate take. Recovery does not run automatically or apply retention until a take is successfully finalized.

The frontend requests a MediaRecorder chunk every second, releases acknowledged chunks, and stops recording if a write fails or more than 8 MiB waits for acknowledgment. Retries retain the pending bytes while the page stays open. Browser delivery can be delayed, and a final chunk can exceed the buffering threshold before capture stops. A crash can lose bytes still in the device, browser, or upload queue. Some interrupted containers need external repair; the saved portion remains downloadable.

## Compatibility names

ArticuPath retains `CADENCE_*` environment variables, `.cadence` browser storage, the `cadence-settings` preference key, `Rehearse`/`rehearse` desktop data directories, and the `rehearse` executable/package identifier. These names preserve installed data and integrations. The former Bun model catalog `handy-catalog.json` is read alongside Rust's cache so already downloaded models remain available.

Preferences, scripts, and practice marks still belong to the browser profile. Settings exports/restores them as a versioned practice backup without API keys or recordings. File-based practice storage, library indexing and lazy transcript loading, transcription queue/cancel, protected favorites, and feedback history remain separate follow-up work.
