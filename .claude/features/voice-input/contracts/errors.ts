/**
 * CONTRACT SPEC (planning artifact) — feature `voice-input`. Owner: server.
 * Error codes of the voice routes. JSON body shape = the existing central error handler
 * (./shared.ts `ErrorBody`), unchanged. Existing codes of other routes are unchanged.
 */
import type { VoiceUnavailableReason } from './voice-api';

/** Codes sent as a JSON error BEFORE the stream opens (HTTP status ≠ 200). */
export type VoicePreStreamErrorCode =
  /** 503: no transcriber (disabled / whisper-cli or model missing / probe failed). */
  | 'voice_unavailable'
  /** 503: queue full (1 running + VOICE_QUEUE_MAX_WAITING admitted). `Retry-After` header. */
  | 'voice_busy'
  /** 415: content type not audio/wav, or a WAV with another PCM layout. */
  | 'unsupported_audio_format'
  /** 400: not a parseable RIFF/WAVE (./audio.ts rules). */
  | 'invalid_audio'
  /** 400: empty body or < VOICE_MIN_DURATION_MS of samples. Client: "nothing recognized". */
  | 'empty_audio'
  /** 413: body over `limits.maxBytes` (Content-Length or counted while receiving). */
  | 'audio_too_large';

/**
 * Codes of the in-stream `error` event (SSE mode), and of the late JSON errors in JSON mode
 * (500 / 504 / 503 respectively).
 */
export type VoiceStreamErrorCode =
  /** whisper-cli could not start (spawn error), exited non-zero / by signal, or its output was
   *  missing/unparseable. Message is generic; the stderr tail goes to the server log only. */
  | 'transcription_failed'
  /** The per-job watchdog fired (./lifecycle.ts VOICE_TIMEOUT_*); the process was killed. */
  | 'transcription_timeout'
  /** The server is shutting down (SIGINT/SIGTERM, incl. `tsx watch` restarts). */
  | 'server_shutdown';

export type VoiceErrorCode = VoicePreStreamErrorCode | VoiceStreamErrorCode;

/** For the web's `isErrorCode` list and the demo's errors. */
export const VOICE_ERROR_CODES: readonly VoiceErrorCode[] = [
  'voice_unavailable',
  'voice_busy',
  'unsupported_audio_format',
  'invalid_audio',
  'empty_audio',
  'audio_too_large',
  'transcription_failed',
  'transcription_timeout',
  'server_shutdown',
];

/** `details` of 503 `voice_unavailable`. */
export interface VoiceUnavailableDetails {
  reason: VoiceUnavailableReason;
}

/** `details` of 503 `voice_busy` (also: header `Retry-After: 10`). */
export interface VoiceBusyDetails {
  /** Jobs admitted and not yet running (uploading or queued). */
  waiting: number;
  /** Configured maximum of `waiting`. */
  maxWaiting: number;
}

/**
 * `details` of 415 `unsupported_audio_format`: absent when the content type itself was wrong;
 * present (what the header said) when the WAV layout was wrong.
 */
export interface UnsupportedAudioDetails {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

/** `details` of 413 `audio_too_large`. */
export interface AudioTooLargeDetails {
  maxBytes: number;
}

/**
 * Status / code tables.
 *
 * GET /api/voice                  | 200 only (`VoiceInfo`).
 *
 * POST /api/voice/transcriptions — before the stream (JSON `ErrorBody`), in check order:
 * | 503 | `voice_unavailable`        | details VoiceUnavailableDetails                      |
 * | 415 | `unsupported_audio_format` | missing/other Content-Type (no details)              |
 * | 400 | (none) + Zod details       | `Invalid input`: bad `language`                      |
 * | 413 | `audio_too_large`          | Content-Length > maxBytes (connection closed, no drain) |
 * | 503 | `voice_busy`               | queue full; `Retry-After: 10`; details VoiceBusyDetails |
 * | 400 | `invalid_audio`            | malformed WAV (while receiving)                       |
 * | 415 | `unsupported_audio_format` | WAV layout ≠ 16 kHz/mono/16-bit PCM; details UnsupportedAudioDetails |
 * | 413 | `audio_too_large`          | received bytes exceeded maxBytes; details AudioTooLargeDetails |
 * | 400 | `empty_audio`              | empty body / < 100 ms                                 |
 * | 503 | `server_shutdown`          | the server began shutting down while receiving the body |
 * Nothing is queued or kept on any of these.
 *
 * After the stream opened (SSE `error` event; JSON mode status in brackets):
 * | transcription_failed  [500] | spawn error, non-zero exit/signal, missing/invalid output |
 * | transcription_timeout [504] | watchdog fired                                           |
 * | server_shutdown       [503] | server closing                                          |
 *
 * Client abort: no response at all (the connection is gone).
 */
export type StatusTables = never;
