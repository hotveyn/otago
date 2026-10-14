/**
 * CONTRACT SPEC (planning artifact) — feature `voice-input`. Owner: server.
 * Server-internal behaviour behind the routes: the Transcriber seam, queue, temp files,
 * child process, timeouts, transcript cleaning, shutdown and configuration. Clients do not
 * depend on these details beyond what ./voice-api.ts and ./voice-events.ts promise; the demo
 * mock imitates only the observable effects.
 */
import type { VoiceLanguage } from './voice-api';

/* ---------------------------------------------------------------------------------------
 * Transcriber seam (mirrors `Agent.ask`: async generator + AbortSignal). Implemented by
 * `server/src/voice/whisper-cli.ts`; tests inject `fakeTranscriber()`. A future resident
 * backend (`whisper-server`, a native binding) implements the same interface without contract
 * changes.
 * ------------------------------------------------------------------------------------- */

export interface TranscribeInput {
  /** Absolute path of the validated 16 kHz mono WAV in the job folder (OS temp, never trees/). */
  file: string;
  /** Job folder (inside the spool root) where the engine may write its output. */
  workDir: string;
  language: VoiceLanguage;
  /** Initial prompt for this language (`undefined` = none, always for `auto`). */
  prompt?: string;
  durationMs: number;
  /** Aborted on client disconnect, watchdog timeout or shutdown (`reason` tells which). */
  signal: AbortSignal;
}

export type TranscriberEvent =
  /** Future streaming partials (whisper-cli adapter v1 does not yield them). */
  | { type: 'segment'; index: number; text: string; startMs: number; endMs: number }
  /** Raw (uncleaned) result: `segments` in order + detected/used language. */
  | { type: 'done'; segments: string[]; language: string | null };

export interface Transcriber {
  readonly info: { engine: string; model: string };
  /** Yields zero or more `segment`, then exactly one `done`. Throws on failure / abort. */
  transcribe(input: TranscribeInput): AsyncIterable<TranscriberEvent>;
}

/* ---------------------------------------------------------------------------------------
 * Queue
 *  - ONE job runs at a time (two Metal jobs do not finish sooner and each loads ~1.5-2 GB).
 *  - Admission happens BEFORE the body is read: a job holds a slot while uploading and while
 *    queued. `waiting` = admitted and not running. `waiting >= VOICE_QUEUE_MAX_WAITING` at
 *    admission → 503 `voice_busy`.
 *  - FIFO by the time the upload finished (a slow upload does not block a finished one).
 *  - Only queued jobs (upload finished) have positions. When a queued job ahead leaves the line
 *    (it starts or is cancelled), every job behind it gets a new `queued` event.
 *  - Silent audio never enters the queue (slot released after the silence check).
 * ------------------------------------------------------------------------------------- */
export const VOICE_QUEUE_MAX_WAITING = 4;
export const VOICE_BUSY_RETRY_AFTER_S = 10;

/* ---------------------------------------------------------------------------------------
 * Temp files ("spool"), `server/src/storage/voice-spool.ts`
 *  - Root: `mkdtemp(<os.tmpdir()>/otago-voice-)`, created lazily, owned by the process,
 *    removed on close. Per job: `<root>/<uuid>/audio.wav` (+ engine output `out.json`).
 *  - The body is piped through a streaming WAV inspector into `audio.wav`; memory O(chunk).
 *  - The job folder is removed in `finally` for every outcome (success, error, abort,
 *    timeout, shutdown) — AFTER the child process has exited.
 *  - Startup sweep removes `otago-voice-*` roots older than 24 h (crashed processes), like
 *    `sweepHeldRoots`.
 *  - Never under `trees/`. The audio is not kept "by design" only in v1: the reserved `keep`
 *    param (./voice-api.ts) could later move it instead of deleting it.
 * ------------------------------------------------------------------------------------- */
export const VOICE_SPOOL_PREFIX = 'otago-voice-';
export const VOICE_SPOOL_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

/* ---------------------------------------------------------------------------------------
 * whisper-cli process (one per job)
 *  - `spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false })`; the prompt is
 *    one argv element (no shell, no injection). stdout is ignored in v1 (the JSON file is the
 *    source of truth); the last 8 KiB of stderr are kept for the log.
 *  - args: `-m <model> -f <workDir>/audio.wav -l <ru|en|auto> -oj -of <workDir>/out -np
 *    [-t <threads>] [-sns] [--vad -vm <vadModel>] [--prompt <p> [--carry-initial-prompt]]`.
 *    `-l` is ALWAYS passed (the CLI default is `en`). Optional flags are passed only if the
 *    startup probe saw them in `--help` (robust across whisper.cpp versions); VAD only if the
 *    VAD model file exists.
 *  - Success = exit code 0 AND `<workDir>/out.json` parses: `result.language` →
 *    `language`, `transcription[].text` → `segments`.
 *  - Cancel (`signal` aborts): SIGTERM, SIGKILL after VOICE_KILL_GRACE_MS; the job settles
 *    only after the process `close` event.
 *  - Watchdog per job, started at `started`: VOICE_TIMEOUT_BASE_MS + factor × durationMs
 *    (factor `OTAGO_VOICE_TIMEOUT_FACTOR`, default 2) → abort('timeout') →
 *    `transcription_timeout`. Queue waiting time does not count.
 * ------------------------------------------------------------------------------------- */
export const VOICE_KILL_GRACE_MS = 2_000;
export const VOICE_TIMEOUT_BASE_MS = 120_000;
export const VOICE_TIMEOUT_FACTOR = 2;
export const VOICE_STDERR_TAIL_BYTES = 8 * 1024;
/** Startup / re-probe: `whisper-cli --help` must exit 0 within this time. */
export const VOICE_PROBE_TIMEOUT_MS = 10_000;
/** `GET /api/voice` re-probes an unavailable (not `disabled`) voice at most this often. */
export const VOICE_REPROBE_INTERVAL_MS = 10_000;

/* ---------------------------------------------------------------------------------------
 * Initial prompts (vocabulary / script conditioning). Built-in defaults; env overrides
 * `OTAGO_WHISPER_PROMPT_RU` / `OTAGO_WHISPER_PROMPT_EN` (set to an empty value to disable).
 * `auto` never gets a prompt (it would bias language detection towards the prompt's
 * language).
 * ------------------------------------------------------------------------------------- */
export const VOICE_DEFAULT_PROMPTS: Record<Exclude<VoiceLanguage, 'auto'>, string> = {
  ru: 'Обсуждаем код на TypeScript и Rust: React, Node.js, API, pull request, commit, Docker.',
  en: 'We are discussing code in TypeScript and Rust: React, Node.js, API, pull request, commit, Docker.',
};

/* ---------------------------------------------------------------------------------------
 * Transcript cleaning (`server/src/voice/transcript.ts`), applied to the engine's `done`:
 *  1. Drop segments that consist only of bracketed tags: `[...]`, `(...)`, `*...*`, `♪...`
 *     (e.g. `[BLANK_AUDIO]`, `(музыка)`, `*applause*`).
 *  2. Join the remaining segments, collapse whitespace, trim.
 *  3. Normalize a copy for comparison: NFC, lowercase, `ё`→`е`, remove everything that is not
 *     a letter/digit/space, collapse spaces, trim.
 *  4. If the normalized text is empty, equals the normalized prompt (prompt echo), or EXACTLY
 *     equals a phrase of VOICE_HALLUCINATIONS (any language) → `''`. Exact match only:
 *     real speech that merely contains such a phrase is never cut.
 * ------------------------------------------------------------------------------------- */
export const VOICE_HALLUCINATIONS: readonly string[] = [
  // ru (normalized form)
  'продолжение следует',
  'субтитры сделал dimatorzok',
  'субтитры создавал dimatorzok',
  'субтитры делал dimatorzok',
  'редактор субтитров а синецкая корректор а егорова',
  'спасибо за просмотр',
  'подписывайтесь на канал',
  // en (normalized form)
  'thank you for watching',
  'thanks for watching',
  'subtitles by the amaraorg community',
  'you',
];

/* ---------------------------------------------------------------------------------------
 * Shutdown (Fastify hooks, like `Questions`)
 *  - `preClose`: stop admitting (Fastify stops accepting connections; a request admitted after
 *    this point gets 503 `server_shutdown` as JSON), abort every job with reason 'shutdown':
 *    uploading requests are
 *    answered 503 `server_shutdown` (JSON) if still writable; queued and running SSE jobs get
 *    `error { code: 'server_shutdown' }` and their stream is ended; running children are
 *    killed (SIGTERM → SIGKILL after VOICE_KILL_GRACE_MS).
 *  - `onClose`: await every job's teardown (child exited, job folder removed), then remove the
 *    spool root. Fits inside the entry point's 10 s hard-exit budget.
 *  - A crash of the Node process leaves an orphan whisper-cli that finishes on its own; its
 *    spool root is removed by the next startup sweep after 24 h.
 * ------------------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------------------
 * Configuration (`server/.env`, resolved by the pure `loadConfig`; Turbo passes OTAGO_*).
 * Relative paths resolve from `server/` (like OTAGO_TREES_DIR).
 * | Variable                   | Default                                        | Meaning |
 * |----------------------------|------------------------------------------------|---------|
 * | OTAGO_VOICE                | `auto`                                         | `off`/`0`/`false` disables voice (reason `disabled`) |
 * | OTAGO_WHISPER_BIN          | `whisper-cli` on PATH, then /opt/homebrew/bin/whisper-cli, /usr/local/bin/whisper-cli | whisper.cpp CLI (a name is looked up on PATH, a path is used as is) |
 * | OTAGO_WHISPER_MODEL        | `./models/ggml-large-v3-turbo-q8_0.bin`        | Location of THE model (only large-v3-turbo q8_0 is supported; no picker) |
 * | OTAGO_WHISPER_VAD_MODEL    | `./models/ggml-silero-v6.2.0.bin`              | VAD is on iff this file exists |
 * | OTAGO_WHISPER_THREADS      | unset (whisper default, min(4, cores))         | `-t` |
 * | OTAGO_WHISPER_PROMPT_RU    | VOICE_DEFAULT_PROMPTS.ru                       | Initial prompt for `ru`; empty = none |
 * | OTAGO_WHISPER_PROMPT_EN    | VOICE_DEFAULT_PROMPTS.en                       | Initial prompt for `en`; empty = none |
 * | OTAGO_VOICE_QUEUE          | 4                                              | Max admitted-not-running jobs (0 = only one job at a time, no waiting) |
 * | OTAGO_VOICE_TIMEOUT_FACTOR | 2                                              | Watchdog = 120 s + factor × audio duration |
 * | OTAGO_VOICE_MAX_MB         | 4096 (→ 0xFFFFFFFF bytes, the WAV ceiling)     | Disk-safety cap of one upload, MiB (values above 4096 are clamped) |
 * Invalid numbers fall back to the default.
 * ------------------------------------------------------------------------------------- */
export type VoiceConfigTable = never;
