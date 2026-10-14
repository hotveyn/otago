/**
 * CONTRACT SPEC (planning artifact) — feature `voice-input`. Owner: server.
 * The audio a client MUST upload to `POST /api/voice/transcriptions`, and how the server
 * judges it. The demo mock applies the same rules (sizes, duration, silence) so the UI sees
 * the same outcomes.
 *
 * DECISION: the client encodes 16 kHz mono 16-bit little-endian PCM WAV itself (AudioWorklet
 * capture or decode + `OfflineAudioContext` resample — web plan decides). No compressed
 * formats, no ffmpeg on either side. 32 000 bytes per second (~1.9 MB/min, ~115 MB/h);
 * irrelevant on loopback.
 */

/** Accepted request `Content-Type` media types (case-insensitive, parameters ignored). */
export const VOICE_AUDIO_MIME_TYPES = ['audio/wav', 'audio/x-wav', 'audio/wave'] as const;
/** What clients send. */
export const VOICE_AUDIO_MIME_TYPE = 'audio/wav';

/** The only accepted PCM layout (also reported by `GET /api/voice` → `audio`). */
export interface VoiceAudioFormat {
  mimeType: 'audio/wav';
  sampleRate: 16000;
  channels: 1;
  bitsPerSample: 16;
}

export const VOICE_AUDIO_FORMAT: VoiceAudioFormat = {
  mimeType: 'audio/wav',
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
};

/** 16 000 samples/s × 2 bytes. `durationMs = Math.round(dataBytes / 32)`. */
export const VOICE_BYTES_PER_SECOND = 32_000;

/**
 * WAV layout rules (server: streaming inspector, no assumption of a 44-byte header).
 *  1. `RIFF` <u32 size> `WAVE`. The RIFF size field is NOT checked (writers get it wrong).
 *  2. Chunks follow: `<4-char id><u32le size><payload, padded to even size>`.
 *     Any chunk before `data` other than `fmt ` (e.g. `LIST`, `fact`) is skipped.
 *  3. `fmt ` MUST come before `data` and MUST say: audioFormat = 1 (PCM; WAVE_FORMAT_EXTENSIBLE
 *     is NOT accepted), channels = 1, sampleRate = 16000, bitsPerSample = 16
 *     (blockAlign 2, byteRate 32000 — mismatching derived fields → `invalid_audio`).
 *  4. `data` size field MUST be even, MUST NOT be 0xFFFFFFFF (streaming placeholder) and the
 *     body MUST contain at least that many bytes after the chunk header. Bytes after the
 *     `data` payload are ignored.
 *  5. Everything before the `data` payload is at most VOICE_MAX_HEADER_BYTES.
 * Violations:
 *  - not RIFF/WAVE, malformed/truncated chunks, missing `fmt `/`data`, rule 4/5 → 400
 *    `invalid_audio`,
 *  - a well-formed WAV with another PCM layout (e.g. 48 kHz, stereo, float32, 8-bit) → 415
 *    `unsupported_audio_format` with `details: UnsupportedAudioDetails` (./errors.ts).
 * Clients SHOULD write the canonical 44-byte header (`RIFF`, `fmt ` of 16 bytes, `data`).
 */
export const VOICE_MAX_HEADER_BYTES = 64 * 1024;

/**
 * Minimum audio: `data` shorter than this (100 ms = 3 200 bytes) → 400 `empty_audio`.
 * A zero-length request body is also `empty_audio`. Clients treat `empty_audio` exactly like an
 * empty transcript ("nothing recognized"), not as a failure.
 */
export const VOICE_MIN_DURATION_MS = 100;

/**
 * Maximum size of the whole request body. NOT a product cap (the product has none): it is a
 * disk-safety limit, server-configurable (`OTAGO_VOICE_MAX_MB`, ./lifecycle.ts). Default 4 GiB
 * − 1 byte = the WAV format ceiling (32-bit sizes) ≈ 37 hours. The live value is published in
 * `GET /api/voice` → `limits.maxBytes`; clients MAY refuse to upload above it (and show the
 * same notice as for 413 `audio_too_large`), the server enforces it either way.
 */
export const VOICE_DEFAULT_MAX_BYTES = 0xffff_ffff;

/**
 * Silence rule (server-side, authoritative): if the absolute peak of all samples is below this
 * value (int16 scale; 328 ≈ -40 dBFS), Whisper is NOT run and the response is
 * `done { text: '', language: null }` immediately (no `queued`/`started`). Prevents Whisper's
 * silence hallucinations at zero cost.
 * Clients MAY apply the same rule to skip the upload (optional optimisation). The demo mock
 * MUST apply it, so a silent recording shows "nothing recognized" in the demo too.
 */
export const VOICE_SILENCE_PEAK = 328;
