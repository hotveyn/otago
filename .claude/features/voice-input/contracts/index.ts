/**
 * CONTRACT SPEC (planning artifact) — feature `voice-input`. Owner: server.
 * Single source of truth for the data shape during planning. Hand-authored TypeScript; NOT a
 * runtime module and not generated. There is no codegen in this repo: the server implements
 * these shapes in `server/src/voice/*`, `server/src/storage/voice-spool.ts`,
 * `server/src/routes/voice.ts` and `server/src/errors.ts`; the web mirrors them by hand in
 * `web/src/api/types.ts`; the demo mock (`demo/src/mock/`) reproduces the behaviour in the
 * browser.
 *
 * Files:
 *  - shared.ts        existing shapes reused (ErrorBody framing, SSE framing constants)
 *  - audio.ts         the audio the client MUST upload (16 kHz mono 16-bit PCM WAV), size and
 *                     duration rules, the silence rule
 *  - voice-api.ts     HTTP routes: GET /api/voice (capability), POST /api/voice/transcriptions
 *                     (SSE by default, JSON variant), cancellation, client + demo obligations
 *  - voice-events.ts  SSE events of a transcription response, ordering guarantees
 *  - errors.ts        new error codes, HTTP statuses, pre-stream vs in-stream errors
 *  - lifecycle.ts     server-internal: Transcriber interface, queue, spool, child process,
 *                     timeouts, hallucination filter, shutdown, config (env variables)
 *
 * Decisions (feature.md open questions + research §11), binding for server, web and demo:
 *  1. Engine: external whisper.cpp `whisper-cli`, one process per job. Only model:
 *     `ggml-large-v3-turbo-q8_0.bin`. Voice is optional: without it, `GET /api/voice` says
 *     `available: false` and the client hides the mic.
 *  2. Upload: raw body `Content-Type: audio/wav`, 16 kHz / mono / 16-bit PCM WAV encoded by the
 *     client. No multipart, no ffmpeg anywhere.
 *  3. Response: a short-lived SSE stream from the POST (`queued` → `started` → `done` | `error`,
 *     `segment` reserved), ended by the server after the terminal event. A blocking JSON
 *     variant exists for curl/scripts (`Accept: application/json`); the web uses SSE.
 *  4. Concurrency: FIFO queue, ONE transcription at a time, at most 4 admitted-but-not-running
 *     jobs (configurable); beyond that 503 `voice_busy` before the body is read.
 *  5. Cancellation: the client aborts the fetch. No job ids, no DELETE route. Retry = POST the
 *     same audio again (the server keeps nothing).
 *  6. Languages: `ru`, `en`, `auto` (query `language`, default `auto`). `ru`/`en` use a built-in
 *     initial prompt (env-overridable); `auto` uses none.
 *  7. No product length cap. The only limit is a configurable disk-safety cap whose default
 *     (4 GiB) equals the WAV format ceiling (~37 h of audio) → 413 `audio_too_large`.
 *  8. Silence: the server skips Whisper when the peak level is below -40 dBFS and answers
 *     `done { text: '' }`. Whisper output equal to a known hallucination phrase → `''`.
 *     An empty `text` is a success; the client shows "nothing recognized".
 *  9. Future seams: `segment` event + `VoiceAvailable.streaming` for partial transcripts;
 *     reserved query params `keep`/`tree` and reserved `done.audio` for "save audio into node";
 *     reserved path `/api/voice/streams` for live streaming input.
 */
export * from './audio';
export * from './errors';
export * from './lifecycle';
export * from './shared';
export * from './voice-api';
export * from './voice-events';
