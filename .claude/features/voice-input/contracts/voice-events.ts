/**
 * CONTRACT SPEC (planning artifact) — feature `voice-input`. Owner: server.
 * Server-Sent Events of `POST /api/voice/transcriptions` (SSE mode, the default).
 *
 * Response: 200 with the SSE headers and framing of ./shared.ts (`retry:` first, `id:` per
 * event, `: ping` every 15 s). Unlike `GET /api/questions/events`, this stream ENDS: the
 * server closes it right after the terminal event (`done` or `error`).
 * Every 4xx/5xx known before the stream opens is a JSON error instead (./errors.ts); once the
 * 200 is sent, failures arrive as an `error` event.
 */
import type { VoiceStreamErrorCode } from './errors';
import type { VoiceLanguage } from './voice-api';

/**
 * `event: queued` — the job waits behind other transcriptions (other tabs/panels).
 * `position` = 1-based place in the waiting line (1 = runs next). Sent only if the job does
 * not start immediately; re-sent each time the position decreases. Informational ("waiting
 * for another transcription…").
 */
export interface TranscriptionQueuedEventData {
  position: number;
}

/**
 * `event: started` — whisper-cli is running for this job. At most once. `durationMs` = audio
 * duration from the WAV data size (`dataBytes / 32`), so the client can show e.g.
 * "transcribing 12:34 of audio…".
 */
export interface TranscriptionStartedEventData {
  durationMs: number;
}

/**
 * `event: segment` — RESERVED for streaming partials. NOT emitted in v1 (`VoiceAvailable.
 * streaming === false`). When emitted later: one recognized segment, in order, `index` from
 * 0; text is provisional (the hallucination filter runs only on the final text). Clients may
 * display segments as a preview but MUST replace the preview with `done.text`.
 */
export interface TranscriptionSegmentEventData {
  index: number;
  /** Segment text, trimmed. */
  text: string;
  /** Offsets in the audio. */
  startMs: number;
  endMs: number;
  /** RESERVED: `false` for revisable partials of a future live mode. Absent = final. */
  final?: boolean;
}

/**
 * `event: done` — terminal success. Also the JSON-mode 200 body (`TranscriptionResult`).
 */
export interface TranscriptionDoneEventData {
  /**
   * Final transcript: segments joined, whitespace collapsed, trimmed. `''` = nothing
   * recognized (silence skip, VAD found no speech, or the whole output was a known
   * hallucination / prompt echo). Never contains bracketed non-speech tags like
   * `[BLANK_AUDIO]` or `(music)` on their own.
   */
  text: string;
  /**
   * Language actually used: the requested one for `ru`/`en`; the detected ISO 639-1 code for
   * `auto` (may be any Whisper language, e.g. `uk`, `de`); `null` when Whisper did not run
   * (silence skip) or reported none.
   */
  language: Exclude<VoiceLanguage, 'auto'> | (string & {}) | null;
  /** Audio duration (same as `started`). */
  durationMs: number;
  /** Wall time of the Whisper run (0 when skipped). Informational / latency checks. */
  processingMs: number;
  /**
   * RESERVED (future "save audio into node", only with the future `keep` query param): a
   * server-side handle of the kept audio. Never present in v1.
   */
  audio?: never;
}

/**
 * `event: error` — terminal failure after the stream opened. Same shape as `ErrorBody`.
 * All three codes are retryable with the same audio.
 */
export interface TranscriptionErrorEventData {
  /** Human-readable English message, safe to show (clients use their own i18n per `code`). */
  error: string;
  code: VoiceStreamErrorCode;
}

export type TranscriptionStreamEvent =
  | { event: 'queued'; data: TranscriptionQueuedEventData }
  | { event: 'started'; data: TranscriptionStartedEventData }
  | { event: 'segment'; data: TranscriptionSegmentEventData }
  | { event: 'done'; data: TranscriptionDoneEventData }
  | { event: 'error'; data: TranscriptionErrorEventData };

/**
 * ORDERING GUARANTEES (per response):
 *  1. Zero or more `queued` (strictly decreasing `position`), then at most one `started`, then
 *     (future) zero or more `segment`, then EXACTLY ONE terminal event (`done` | `error`),
 *     then the server ends the stream. Nothing follows the terminal event.
 *  2. `queued` / `started` are optional: a silent recording gets `done` directly; a job
 *     cancelled by shutdown while queued gets `error` without `started`.
 *  3. A stream that ends without a terminal event = failure (treat as `transcription_failed`).
 *  4. `: ping` comments may appear anywhere before the end (also while queued/running).
 * Example (one job waiting behind another):
 *   retry: 2000
 *   id: 1 / event: queued / data: {"position":1}
 *   : ping
 *   id: 2 / event: started / data: {"durationMs":8420}
 *   id: 3 / event: done / data: {"text":"Как работает borrow checker в Rust?","language":"ru",
 *                                "durationMs":8420,"processingMs":1630}
 */
export type OrderingGuarantees = never;
