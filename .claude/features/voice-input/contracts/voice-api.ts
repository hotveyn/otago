/**
 * CONTRACT SPEC (planning artifact) — feature `voice-input`. Owner: server.
 * HTTP routes of voice input. All paths are under `/api`. JSON errors use the central error
 * body (./shared.ts `ErrorBody`, codes in ./errors.ts).
 *
 * DECISION (research §7): a capability route + one transcription route whose response is a
 * short-lived SSE stream. Not on the app-wide `GET /api/questions/events` stream: transcripts
 * are private to the requesting tab and need no retention. No WebSocket (no bidirectional need
 * yet). No job ids.
 */
import type { VoiceAudioFormat } from './audio';
import type { VoiceErrorCode } from './errors';
import type { TranscriptionDoneEventData } from './voice-events';

/** Recognition language. `auto` = Whisper detects ONE language from the first 30 s window. */
export type VoiceLanguage = 'auto' | 'en' | 'ru';
export const VOICE_LANGUAGES: readonly VoiceLanguage[] = ['auto', 'en', 'ru'];
/** Used when the `language` query param is absent. Clients always send it explicitly. */
export const VOICE_DEFAULT_LANGUAGE: VoiceLanguage = 'auto';

/* ---------------------------------------------------------------------------------------
 * GET /api/voice — capability                                                    (NEW)
 *
 * Always 200 (never 404/503), JSON `VoiceInfo`. The web fetches it once per page load (and may
 * refetch on window focus); the mic button and shortcut exist only when `available: true`.
 *
 * Availability:
 *  - probed once at server startup (binary runs `--help` with exit 0 AND the model file exists),
 *  - while unavailable for a reason other than `disabled`, this route re-probes at most once
 *    every 10 s, so installing whisper-cli / downloading the model needs no server restart
 *    (the user reloads the page),
 *  - once available it stays available for the process lifetime (a later failure surfaces as
 *    an in-stream `transcription_failed`).
 * ------------------------------------------------------------------------------------- */

export type VoiceUnavailableReason =
  /** `OTAGO_VOICE=off`, or the server was built without a transcriber (tests). Final. */
  | 'disabled'
  /** `whisper-cli` not found (configured path or PATH/Homebrew lookup). */
  | 'binary_not_found'
  /** The ggml model file does not exist / is not a readable file. */
  | 'model_not_found'
  /** The binary exists but `--help` failed (e.g. a broken Homebrew dylib chain), or timed out. */
  | 'probe_failed';

export interface VoiceUnavailable {
  available: false;
  reason: VoiceUnavailableReason;
  /**
   * Human-readable setup hint in English (e.g. `whisper-cli not found: brew install
   * whisper.cpp`). For logs / a possible settings screen; the web v1 does not show it.
   */
  message: string;
}

export interface VoiceAvailable {
  available: true;
  /** Always `['auto', 'en', 'ru']` in v1 (order is not meaningful). */
  languages: VoiceLanguage[];
  /** What the client MUST upload (./audio.ts). */
  audio: VoiceAudioFormat;
  limits: {
    /** Max request body bytes (./audio.ts VOICE_DEFAULT_MAX_BYTES unless configured lower). */
    maxBytes: number;
    /** VOICE_MIN_DURATION_MS. */
    minDurationMs: number;
  };
  /**
   * RESERVED (future streaming partials): `true` once the server emits `segment` events while
   * transcribing. Always `false` in v1; clients must work with either value.
   */
  streaming: false;
  /** Informational. Demo: `{ name: 'demo', model: 'lorem-ipsum' }`. */
  engine: {
    name: 'whisper.cpp' | (string & {});
    /** Model file name without extension, e.g. `ggml-large-v3-turbo-q8_0`. */
    model: string;
  };
}

export type VoiceInfo = VoiceAvailable | VoiceUnavailable;
/** `GET /api/voice` 200 body. */
export type GetVoiceResponse = VoiceInfo;

/* ---------------------------------------------------------------------------------------
 * POST /api/voice/transcriptions?language=<auto|en|ru> — transcribe one recording   (NEW)
 *
 * Request:
 *  - headers: `Content-Type: audio/wav` (./audio.ts VOICE_AUDIO_MIME_TYPES; required);
 *    `Content-Length` recommended (a `Blob` body sets it); `Accept` selects the response mode:
 *      · SSE (default): anything else, incl. missing, `*\/*`, `text/event-stream`,
 *      · JSON: `Accept` contains `application/json` and does NOT contain `text/event-stream`.
 *  - query: `TranscriptionQuery`. Unknown params are ignored.
 *  - body: the raw WAV bytes (NOT multipart, NOT base64). Streamed to an OS temp file by the
 *    server (never under `trees/`), deleted when the request ends — success, error or abort.
 *
 * Server sequence (authoritative):
 *  1. Voice available, else 503 `voice_unavailable` (+ `details: { reason }`).
 *  2. Content type is one of the accepted ones, else 415 `unsupported_audio_format`.
 *  3. Query valid, else 400 `Invalid input` (+ Zod `details`).
 *  4. `Content-Length` (if sent) ≤ `limits.maxBytes`, else 413 `audio_too_large` (sent with
 *     `connection: close`, the body is NOT drained).
 *  5. Admission: a free queue slot (≤ 4 jobs admitted and not running), else 503 `voice_busy`
 *     with a `Retry-After` header (seconds). The slot is held from here on.
 *  Rejections in 1-3 and 5 drain (discard) the request body before replying, so the browser
 *  receives the JSON error instead of a connection reset.
 *  6. Receive the body to the temp file while validating the WAV header and counting
 *     samples/peak: 400 `invalid_audio`, 415 `unsupported_audio_format`, 413
 *     `audio_too_large` (body exceeded `maxBytes`; rest is drained), 400 `empty_audio`.
 *     A client abort here deletes the partial file; nothing is queued.
 *  --- from here on no JSON error status is possible in SSE mode ---
 *  7. Open the response: SSE 200 (or, in JSON mode, keep it pending).
 *  8. Silent audio (./audio.ts VOICE_SILENCE_PEAK) → `done { text: '' }` at once, end.
 *  9. Enqueue (FIFO by the time step 6 finished). While waiting: `queued { position }`, re-sent
 *     whenever the position changes. When it runs: `started { durationMs }`.
 * 10. whisper-cli runs; on success the transcript is cleaned (hallucination filter) →
 *     `done`; on failure → `error { code: transcription_failed }`; after the watchdog
 *     (./lifecycle.ts) → `error { code: transcription_timeout }`; on server shutdown →
 *     `error { code: server_shutdown }`.
 * 11. The server ends the response right after the terminal event. Temp files are deleted.
 *
 * JSON mode (curl/scripts; the web does not use it): steps 1-6 identical; then the response
 * stays pending (no keep-alive possible) and finally is
 *   200 `TranscriptionResult`, or a JSON error: 500 `transcription_failed`,
 *   504 `transcription_timeout`, 503 `server_shutdown`.
 *
 * Cancellation (both modes): the client aborts the fetch (AbortController) or closes the tab.
 *  - during upload: the partial temp file is deleted, nothing is queued, the slot is freed;
 *  - queued: the job leaves the queue; later jobs get new `queued` positions;
 *  - running: whisper-cli gets SIGTERM, then SIGKILL after 2 s; temp files deleted; the next
 *    job starts.
 *  No event is sent (the connection is gone). There is no DELETE route and nothing to clean up
 *  on the client side. Cancelling never affects other tabs' transcriptions.
 *
 * Retry: POST the same audio again. The server keeps no state between requests, so a retry
 * after any failure (incl. a server restart = network error) is always safe.
 *
 * Privacy: audio and text never leave the machine; the transcript is sent only on this
 * response (never broadcast to other tabs or logged; logs contain durations and error tails
 * only).
 * ------------------------------------------------------------------------------------- */

export interface TranscriptionQuery {
  /** Default VOICE_DEFAULT_LANGUAGE. Any other value → 400 `Invalid input`. */
  language?: VoiceLanguage;
  /**
   * RESERVED (future "save audio into node"): ask the server to keep the uploaded audio for a
   * later question instead of deleting it; the `done` event would then carry `audio`. Ignored
   * in v1 — clients must not send it yet. (v1 path for saving audio: the client keeps its
   * `Blob` and attaches it through the existing message `files` upload.)
   */
  keep?: never;
  /**
   * RESERVED (future): tree id whose title/instructions would extend the initial prompt with
   * tree-specific vocabulary. Ignored in v1 — clients must not send it yet.
   */
  tree?: never;
}

/** JSON mode 200 body. Same fields as the SSE `done` event. */
export type TranscriptionResult = TranscriptionDoneEventData;

/** Endpoint table (documentation aid). */
export interface VoiceRoutes {
  'GET /api/voice': { response: GetVoiceResponse; status: 200 };
  'POST /api/voice/transcriptions': {
    query: TranscriptionQuery;
    headers: { 'content-type': 'audio/wav'; accept?: string };
    body: Blob /* WAV, ./audio.ts */;
    /** Default mode; events in ./voice-events.ts. */
    response: 'text/event-stream' | TranscriptionResult;
    status: 200;
    errors: VoiceErrorCode;
  };
  /**
   * RESERVED path (future live streaming input while the user speaks). Not implemented in v1:
   * 404 like any unknown route.
   */
  'POST /api/voice/streams': never;
}

/* ---------------------------------------------------------------------------------------
 * Client obligations (web), for planning against this contract:
 *  - Fetch `GET /api/voice`; hide the mic + shortcut unless `available`.
 *  - Upload with `fetch('/api/voice/transcriptions?language=..', { method: 'POST', body: wavBlob,
 *    headers: { 'content-type': 'audio/wav' }, signal })`. Non-2xx → JSON `ErrorBody` →
 *    the existing `ApiError` path (add VOICE_ERROR_CODES to the known codes).
 *  - 200 → read the body with `readSse`; ignore `retry:`, `id:`, comments, unknown events and
 *    (in v1) `segment`. Use ONLY `done.text` as the final text (never concatenate segments).
 *  - A stream that ends without `done`/`error`, a network error, or no bytes (not even a
 *    `: ping`) for 45 s (3 missed pings) ⇒ treat as `transcription_failed` (retryable).
 *  - `done.text === ''` or 400 `empty_audio` ⇒ "nothing recognized" (no retry offered).
 *  - Retryable (keep the Blob, offer one retry): 503 `voice_busy`, in-stream
 *    `transcription_failed` / `transcription_timeout` / `server_shutdown`, network errors, 5xx.
 *    Not retryable: 400/413/415 codes (client bug or too large) and 503 `voice_unavailable`
 *    (refetch `GET /api/voice`, it will hide the mic).
 *  Recommended client surface (owned by web; the demo shim must export the same names):
 *    `api.voiceInfo(): Promise<VoiceInfo>`
 *    `api.transcribe(audio: Blob, options: { language: VoiceLanguage; signal?: AbortSignal;
 *        onEvent?: (event: TranscriptionStreamEvent) => void }): Promise<TranscriptionResult>`
 *      resolves with `done` data, rejects with `ApiError` (pre-stream status or in-stream
 *      `error`, status 0 for in-stream errors is acceptable) or an `AbortError` on abort.
 *
 * Demo mock obligations (`demo/src/mock/`, no HTTP; mirrors the semantics at the client
 * function level):
 *  - `voiceInfo()` → `VoiceAvailable` with `engine: { name: 'demo', model: 'lorem-ipsum' }`,
 *    `languages: ['auto','en','ru']`, `audio: VOICE_AUDIO_FORMAT`, `streaming: false`,
 *    `limits.maxBytes` = a demo value (e.g. VOICE_DEFAULT_MAX_BYTES; nothing is stored).
 *  - `transcribe()` validates like the server where cheap: wrong MIME/format → 415
 *    `unsupported_audio_format`, broken header → 400 `invalid_audio`, < 100 ms → 400
 *    `empty_audio`; silent (VOICE_SILENCE_PEAK) → `done { text: '' }` at once.
 *  - Otherwise emits `started { durationMs }`, waits ~1-2 s (abortable → AbortError), then
 *    `done { text: <Lorem ipsum sentence(s), longer for longer audio>, language: requested
 *    language or 'en' for auto, durationMs, processingMs }`.
 *  - Serializes like the server (a second call while one runs gets `queued { position: 1 }`
 *    first); a 503 `voice_busy` path is optional.
 *  - Never stores the audio (no VFS / localStorage writes).
 * ------------------------------------------------------------------------------------- */
export type ClientObligations = never;
