# Plan: voice-input, project `server`

Stage 3 (plan). This plan is binding for `/feature:implement server`. The shared contract is in
`.claude/features/voice-input/contracts/` (owner: server). It covers `voice-api.ts`,
`voice-events.ts`, `errors.ts`, `audio.ts`, `lifecycle.ts`, `shared.ts` and `index.ts`. Every
shape and number below comes from it. If this plan and the contract disagree, the contract wins.
Fix the contract first, then the code.

Inputs: `feature.md`, `projects/server/research.md`, the existing server code (Fastify 5 + Zod
type provider, `AppDeps`/`RouteDeps`, `AppError` + codes, `openSse`, `storage/held-files.ts`,
`test/helpers.ts`).

The server gets no new npm dependency. Whisper (`whisper-cli` from Homebrew `whisper.cpp`) is an
optional external binary. The server starts without it, and every test passes without it.

---

## Decisions

These are the user's binding decisions plus the open questions from research §11, resolved here.

| # | Topic | Decision |
|---|---|---|
| D1 | Engine | External `whisper-cli` (whisper.cpp, brew), **one process per job**, no shell. Behind a `Transcriber` interface (async generator + `AbortSignal`, like `Agent.ask`). A resident `whisper-server` or a native binding can be added later behind the same interface without contract changes. |
| D2 | Model | Only `ggml-large-v3-turbo-q8_0.bin` (874 MB). No picker. `OTAGO_WHISPER_MODEL` only says **where** the file is (default `server/models/…`). `GET /api/voice` reports the file name. |
| D3 | Upload | Raw body `Content-Type: audio/wav`, 16 kHz / mono / 16-bit PCM (`audioFormat` 1 only, no WAVE_FORMAT_EXTENSIBLE). The client encodes it. No multipart, no ffmpeg. |
| D4 | Response (§11.1) | SSE from the POST by default (`queued`/`started`/`segment` reserved/`done`/`error`, `: ping` every 15 s, ended after the terminal event). **Also a blocking JSON variant** when `Accept` has `application/json` and not `text/event-stream`. It is cheap because both modes share the `Voice` service, and it is useful for curl, scripts and tests. The web uses SSE. |
| D5 | Initial prompt (§11.2) | Built-in prompts for `ru` and `en` (contract `VOICE_DEFAULT_PROMPTS`: a Russian sentence and an English sentence with Latin-script tech terms). Overrides: `OTAGO_WHISPER_PROMPT_RU` / `OTAGO_WHISPER_PROMPT_EN`. An empty value disables the prompt, an unset variable uses the default. **`auto` gets no prompt**, because a prompt biases language detection toward its own language. `--carry-initial-prompt` is passed with every prompt (when the binary supports it), so long recordings keep English terms in Latin script after the first 30 s window. |
| D6 | Queue (§11.3) | Concurrency 1. At most **4** admitted-but-not-running jobs (`OTAGO_VOICE_QUEUE`; 0 = no waiting). Beyond that: 503 `voice_busy` + `Retry-After: 10`. The slot is reserved at **admission, before the body is read**, so a burst of uploads cannot overfill the queue. FIFO order is by upload completion. |
| D7 | Timeout (§11.3) | Per-job watchdog = `120 s + factor × audio duration`, with factor `OTAGO_VOICE_TIMEOUT_FACTOR` (default 2). It starts at `started`; time spent waiting in the queue does not count. When it fires: kill → `transcription_timeout`. |
| D8 | Availability (§11.4) | Probe once at startup, in Fastify `onReady` (logged). While the result is unavailable for any reason **other than `disabled`**, `GET /api/voice` (and POST admission) re-probes at most every 10 s, so installing Whisper or downloading the model needs no restart. Once available, the result is never downgraded; later breakage surfaces as `transcription_failed`. |
| D9 | Silence (§11.5) | Server-side and authoritative, in the streaming WAV inspector: if the peak \|sample\| is below **328 (≈ −40 dBFS)**, Whisper is skipped and the server answers `done { text: '', language: null }` without queueing. The threshold is a constant (`VOICE_SILENCE_PEAK`), not an env var. Clients may apply the same rule; the demo must. Whisper VAD (Silero) runs as well when its model file exists. |
| D10 | Safety cap (§11.6) | **No product cap.** The only limit is a disk-safety cap `OTAGO_VOICE_MAX_MB`. Its default, 4096 MiB (→ `0xFFFFFFFF` bytes), equals the WAV format ceiling of about 37 h of audio, so by default it caps nothing that a valid WAV could hold. Larger values are clamped to the ceiling. Exceeding it → 413 `audio_too_large`. The value is published as `limits.maxBytes`. |
| D11 | Hallucinations (§11.7) | The cleaning rules and phrase list are in contract `lifecycle.ts` (`VOICE_HALLUCINATIONS`: 7 ru + 4 en, normalized). Matching is exact on the **whole** transcript only; prompt echoes and segments that are only bracketed tags (e.g. `[BLANK_AUDIO]`) are dropped. `whisper-cli -sns` is passed when supported. |
| D12 | Contract layout (§11.8) | `contracts/{index,shared,audio,voice-api,voice-events,errors,lifecycle}.ts`, mirroring the `parallel-questions` contract. The suggested client surface (`api.voiceInfo`, `api.transcribe`) and the demo-mock obligations are documented in `voice-api.ts`. The web owns the final names, and the demo shim must export them (`exportsComplete`). |
| D13 | Minimum audio | An empty body, or data < 100 ms (3 200 bytes) → 400 `empty_audio`. The client treats it as "nothing recognized". |
| D14 | Segments | `segment` is reserved and **not emitted in v1**. `whisper-cli` stdout is ignored (`stdio: 'ignore'`, so nothing can block on a full pipe); the result comes from `-oj` JSON. |
| D15 | Cancellation | The client aborts the fetch. There is no job id and no DELETE route. Detection uses `reply.raw` `close` before the stream opens and `sse.onClose` after it. |
| D16 | Version robustness | The startup probe captures the `--help` text. Optional flags (`-sns`, `--carry-initial-prompt`, `--vad`/`-vm`) are passed only if `--help` lists them. `-l` is always passed. |
| D17 | Disk layering | The spool (temp audio and engine output) lives in `storage/voice-spool.ts`; `storage/` stays the only layer that writes data files. One exception: `voice/probe.ts` `stat`s/`access`es the configured binary and model paths. These paths are configuration, not data, much as the agent SDK locates its CLI. |
| D18 | Privacy and logs | The transcript text is never logged. Logs contain the duration, processing time, language, exit codes and the stderr tail on failures. |
| D19 | Setup tooling | No download script. The README documents `brew install` + two `curl` commands. Instead, a small `pnpm --filter @otago/server transcribe <file.wav> [ru\|en\|auto]` script (like `ask`) prints the probe status and transcribes one file through the real `Voice` service. It serves the manual quality check and latency measurement. |
| D20 | Model location | `server/models/` (gitignored), resolved from `server/` like `OTAGO_TREES_DIR`. |

---

## Target file layout

New:

```
server/src/voice/
  constants.ts      contract constants (audio format, limits, timings defaults, prompts, hallucinations)
  types.ts          Transcriber seam, VoiceInfo, ProbeResult, TranscriptionResult, VoiceTimings
  transcript.ts     cleanTranscript(), normalizeForMatch(), isTagOnly()
  queue.ts          VoiceQueue (FIFO, concurrency 1, bounded admission, positions)
  probe.ts          resolveWhisperBin(), probeWhisper()
  whisper-cli.ts    buildWhisperArgs(), parseWhisperOutput(), createWhisperCli()
  service.ts        Voice facade (info/refresh, admit → VoiceTicket, shutdown, close)
  index.ts          barrel + whisperVoiceOptions(config)
server/src/storage/
  wav.ts            WavInspector (pure, incremental RIFF parser + peak/sample count)
  voice-spool.ts    createVoiceSpool(), sweepVoiceSpools(), readEngineOutput()
server/src/routes/
  voice.ts          GET /voice, POST /voice/transcriptions
server/scripts/
  transcribe.ts     manual CLI (D19)
server/test/
  wav.test.ts, voice-spool.test.ts, voice-transcript.test.ts, voice-queue.test.ts,
  whisper-cli.test.ts, voice-probe.test.ts, voice-service.test.ts, voice-api.test.ts,
  voice-stream.test.ts
```

Changed: `server/src/errors.ts`, `server/src/config.ts`, `server/src/app.ts`, `server/src/index.ts`,
`server/src/storage/index.ts`, `server/test/helpers.ts`, `server/test/config.test.ts`,
`server/package.json` (script only), `server/.env.example`, `.gitignore`, `README.md`, `CLAUDE.md`.

There is no generated code and no codegen command. The repo has no OpenAPI or other codegen; the web
mirrors the types by hand in `web/src/api/types.ts`. Do not hand-write anything into `web/` or
`demo/` from this project.

**`docs/design.md` does not exist** (removed in commit `e2f3e3e`, even though README and CLAUDE.md
still link to it). Do not recreate it for this feature. The documentation targets are README and
CLAUDE.md (Step 11).

---

## Step 1: Error codes (`server/src/errors.ts`)

- Add `export type VoiceErrorCode` with the 9 codes from contract `errors.ts` (pre-stream + stream).
- Add `VoiceErrorCode` to the `AppError.code` union.
- Add `VOICE_ERROR_STATUS: Record<VoiceErrorCode, number>`:
  - `voice_unavailable` 503, `voice_busy` 503, `unsupported_audio_format` 415, `invalid_audio` 400,
    `empty_audio` 400, `audio_too_large` 413,
  - `transcription_failed` 500, `transcription_timeout` 504, `server_shutdown` 503.
- `export class VoiceError extends AppError { constructor(code: VoiceErrorCode, message: string, details?: unknown) }`.
  The status comes from the table, so the same class serves pre-stream JSON errors, JSON-mode late
  errors and (through `{ error: message, code }`) the SSE `error` event.
- The English messages, safe to show, live in one `voiceErrorMessage(code)` helper in `voice/constants.ts`:
  - `voice_unavailable`: "Voice input is not available on this server"
  - `voice_busy`: "Too many transcriptions are waiting. Try again in a few seconds."
  - `unsupported_audio_format`: "Audio must be 16 kHz mono 16-bit PCM WAV (audio/wav)"
  - `invalid_audio`: "Audio is not a valid WAV file: <reason>"
  - `empty_audio`: "The recording is empty"
  - `audio_too_large`: "The recording is too large (max <n> MB)"
  - `transcription_failed`: "Speech recognition failed"
  - `transcription_timeout`: "Speech recognition took too long and was stopped"
  - `server_shutdown`: "The server is shutting down"

Test: covered by the route tests (status + code for every code).

## Step 2: Config (`server/src/config.ts`, `server/test/config.test.ts`)

- `export interface VoiceConfig { enabled: boolean; bin?: string; model: string; vadModel: string; threads?: number; prompts: { ru: string; en: string }; maxWaiting: number; timeoutFactor: number; maxBytes: number }`.
- `Config.voice: VoiceConfig`, filled by a pure `loadVoiceConfig(env)` called from `loadConfig`. Parsing follows the table in contract `lifecycle.ts`:
  - `enabled`: false iff `OTAGO_VOICE` ∈ {`off`, `0`, `false`} (case-insensitive).
  - `bin`: unset/empty → `undefined` (auto-detect in the probe). A value containing `/` → `path.resolve(SERVER_DIR, v)`. A bare name → kept as is (PATH lookup in the probe).
  - `model` / `vadModel`: `path.resolve(SERVER_DIR, env ?? default)`.
  - `threads`: positive int or `undefined`.
  - `prompts.ru/en`: `env.X === undefined ? VOICE_DEFAULT_PROMPTS.x : env.X.trim()` (`''` = none).
  - `maxWaiting`: int ≥ 0, default 4. `timeoutFactor`: number > 0, default 2.
  - `maxBytes`: `min(0xFFFFFFFF, round(MB × 1024 × 1024))`, default `0xFFFFFFFF`. Invalid values fall back to the default.
- Tests (extend `config.test.ts`, new `describe('voice config')`):
  - defaults (paths under `SERVER_DIR/models`, enabled, queue 4, factor 2, maxBytes `0xFFFFFFFF`, default prompts);
  - `off`/`0`/`false` disable;
  - a relative bin with `/` resolves from `server/`, a bare name stays;
  - an empty prompt disables, an unset prompt uses the default;
  - invalid numbers fall back;
  - `OTAGO_VOICE_MAX_MB=10` → 10 485 760, and `999999` → clamped.

## Step 3: WAV inspector + spool (`storage/wav.ts`, `storage/voice-spool.ts`)

`storage/wav.ts` is pure and works on Buffers (no fs):

```ts
export class WavError extends Error { code: 'invalid_audio' | 'unsupported_audio_format'; details?: UnsupportedAudioDetails }
export interface WavSummary { dataBytes: number; durationMs: number; peak: number }
export class WavInspector {
  feed(chunk: Buffer): void   // incremental; throws WavError as soon as the header proves bad
  finish(): WavSummary        // throws WavError('invalid_audio') if header/data incomplete
}
```

- Implements the rules in contract `audio.ts`:
  - RIFF/WAVE magic, chunk walk with even padding, skipping non-`fmt ` chunks before `data`;
  - `fmt ` checks: format 1 / 1 ch / 16000 Hz / 16 bit, then blockAlign 2 / byteRate 32000 → else `invalid_audio`;
  - the `data` size must be even and not `0xFFFFFFFF`;
  - the header is ≤ 64 KiB;
  - the body must contain at least the `data` bytes; trailing bytes are ignored.
- Header bytes can arrive split across any chunk boundary (buffer until a chunk header is complete).
- Peak: the max of `|int16|` over data samples only, with a carry byte for a sample split across chunks (`-32768` counts as 32768).
- `durationMs = Math.round(dataBytes / 32)`.

`storage/voice-spool.ts` copies the `held-files.ts` pattern:

```ts
export const VOICE_SPOOL_PREFIX = 'otago-voice-';
export interface SpooledAudio extends WavSummary { id: string; dir: string; file: string }
export interface VoiceSpool {
  /** Stream `body` into <root>/<uuid>/audio.wav through a WavInspector. */
  receive(body: AsyncIterable<Buffer> | undefined, options: { maxBytes: number; signal: AbortSignal }): Promise<SpooledAudio>;
  /** Remove a job folder. Idempotent. */
  remove(dir: string): Promise<void>;
  /** Remove the root if owned. */
  close(): Promise<void>;
  /** Root path once created (tests/diagnostics). */
  readonly root: string | undefined;
}
export function createVoiceSpool(options?: { root?: string }): VoiceSpool;
export function sweepVoiceSpools(options?: { tmpDir?: string; maxAgeMs?: number }): Promise<void>;
export function readEngineOutput(file: string): Promise<string | undefined>; // undefined if missing
```

- The root is lazy: `mkdtemp(os.tmpdir()/otago-voice-)`, owned, and removed in `close()`. With `options.root` (tests) it is created, not owned, and not removed on close. Job ids are UUIDs, with folders resolved via `resolveInside`.
- **Do not use `stream.pipeline` with the request as the source.** On error it destroys the request, and the client then sees a reset instead of the JSON error. Use a manual `for await (const chunk of body)` loop: count bytes, `inspector.feed(chunk)`, `await fileHandle.write(chunk)`.
  - When `count > maxBytes` or the inspector throws: close and remove the job folder, **keep iterating and discard the rest (drain)**, then throw `VoiceError('audio_too_large', …, { maxBytes })` or the WavError mapped to a `VoiceError`.
  - On `signal.aborted`, checked per chunk and via an abort listener: remove the folder and stop iterating without draining. Reasons: the client is gone, or it is a shutdown. Throw `VoiceError('server_shutdown')` for reason `'shutdown'`, else a `RequestAborted` error (as in `routes/questions.ts`).
  - At the end: `inspector.finish()` (→ `invalid_audio`). `dataBytes < 3200` or an empty/undefined body → `empty_audio` (folder removed).
- `sweepVoiceSpools` is `sweepHeldRoots` with a different prefix. Factor out a shared private `sweepTempRoots(prefix, …)` in `held-files.ts` or `fs-utils.ts` and keep both exports.
- Export both modules from `storage/index.ts`.

Tests:
- `test/wav.test.ts`: WAVs generated in the test (helper `wavBytes`, Step 8), no binary fixtures.
  - canonical header; a header fed 1 byte at a time; a `LIST` chunk before `fmt `/`data`;
  - `fmt ` after `data` → invalid; WAVE_FORMAT_EXTENSIBLE (0xFFFE) → 415;
  - 48 kHz / stereo / 8-bit / float (3) → 415 with `details`;
  - wrong blockAlign → invalid; odd or `0xFFFFFFFF` data size → invalid; truncated data → invalid on `finish`;
  - a 70 KiB `LIST` → invalid; not RIFF → invalid;
  - trailing bytes after `data` are ignored;
  - peak with a sample split across chunks; the peak of `-32768`; `durationMs` rounding.
- `test/voice-spool.test.ts`:
  - `receive` writes the exact bytes and returns the summary;
  - invalid header → error, folder gone, the whole source consumed (drained);
  - `maxBytes` exceeded → `audio_too_large`, folder gone, source drained;
  - abort mid-stream → folder gone;
  - `remove` is idempotent;
  - `close` removes an owned root and keeps an injected one;
  - the sweep removes only old `otago-voice-*` dirs (mtime via `utimes`).

## Step 4: Voice types, constants, transcript cleaning (`voice/types.ts`, `voice/constants.ts`, `voice/transcript.ts`)

- `types.ts`:
  - `VoiceLanguage`, `VoiceInfo` (`VoiceAvailable | VoiceUnavailable`), `VoiceUnavailableReason`;
  - `TranscribeInput`, `TranscriberEvent`, `Transcriber` (exactly as in contract `lifecycle.ts`);
  - `TranscriptionResult` (`{ text, language, durationMs, processingMs }`);
  - `ProbeResult = { available: true; transcriber: Transcriber; vad: boolean } | { available: false; reason; message }`;
  - `VoiceTimings { pingIntervalMs; retryMs; maxBufferedBytes; timeoutBaseMs; reprobeIntervalMs }` + `DEFAULT_VOICE_TIMINGS` (15 000 / 2 000 / 1 MiB / 120 000 / 10 000);
  - `VoiceStreamEvent` (the SSE union from contract `voice-events.ts`).
  - Header comment: `// Mirrors .claude/features/voice-input/contracts/…` (same style as `held-files.ts`).
- `constants.ts`: `VOICE_AUDIO_MIME_TYPES`, `VOICE_AUDIO_FORMAT`, `VOICE_MIN_DURATION_MS`, `VOICE_DEFAULT_MAX_BYTES`, `VOICE_SILENCE_PEAK`, `VOICE_DEFAULT_PROMPTS`, `VOICE_HALLUCINATIONS`, `VOICE_BUSY_RETRY_AFTER_S`, `VOICE_KILL_GRACE_MS`, `VOICE_PROBE_TIMEOUT_MS`, `VOICE_STDERR_TAIL_BYTES`, `VOICE_LANGUAGES`, `voiceErrorMessage()`. The values come from the contract. Keep this file free of Node APIs.
- `transcript.ts`:
  - `normalizeForMatch(s)`: NFC → lowercase → `ё`→`е` → replace `[^\p{L}\p{N}\s]` with `''` → collapse whitespace → trim.
  - `isTagOnly(segment)`: the trimmed text is a sequence of `[...]`, `(...)`, `*...*` and `♪` groups and whitespace only.
  - `cleanTranscript(segments: string[], prompt?: string): string`: implements the 4 rules in contract `lifecycle.ts`.
- `test/voice-transcript.test.ts`:
  - joins and collapses whitespace (`' Привет,', ' мир.'` → `'Привет, мир.'`);
  - drops `[BLANK_AUDIO]`, `(музыка)`, `*applause*` segments but keeps `"use [brackets] here"`;
  - each listed phrase in raw form (`'Продолжение следует...'`, `'Thanks for watching!'`, `'Субтитры сделал DimaTorzok'`, `' you'`) → `''`;
  - real speech containing a phrase is kept (`'Спасибо за просмотр кода'`);
  - prompt echo → `''`;
  - `ё` normalization.

## Step 5: Queue (`voice/queue.ts`)

```ts
export class VoiceQueue {
  constructor(options: { maxWaiting: number });
  /** Reserve a slot (throws VoiceError voice_busy with details { waiting, maxWaiting }). */
  admit(): QueueSlot;
  readonly waiting: number;   // admitted, not running (uploading + queued)
  readonly running: boolean;
}
export interface QueueSlot {
  /** Enter the FIFO line; `onPosition(n)` on entry if not first-and-idle and whenever n drops. Resolves when it is this slot's turn; rejects (and leaves the line) when `signal` aborts. */
  turn(signal: AbortSignal, onPosition: (position: number) => void): Promise<void>;
  /** Free the slot (and the running seat if it ran). Idempotent; starts the next in line. */
  release(): void;
}
```

- A slot moves through: admitted (counts in `waiting`) → in line (has a position) → running (leaves `waiting`) → released.
- Releasing a slot that never reached `turn` just frees capacity. Releasing the running slot hands the seat to the head of the line synchronously, and then the remaining positions are re-announced.
- `test/voice-queue.test.ts`:
  - the first slot runs immediately with no position callback;
  - the second gets position 1 and the third position 2; releasing the first starts the second and re-announces position 1 to the third;
  - aborting a queued slot removes it and re-announces positions behind it;
  - `admit` beyond `maxWaiting` throws `voice_busy` with details;
  - an uploading (admitted, not in line) slot counts for capacity but has no position;
  - `maxWaiting = 0`: one job allowed only when idle;
  - `release` is idempotent.

## Step 6: whisper-cli adapter + probe (`voice/whisper-cli.ts`, `voice/probe.ts`)

`whisper-cli.ts`:

```ts
export interface WhisperCliOptions {
  bin: string; model: string; vadModel?: string /* only when the file exists */; threads?: number;
  flags: { suppressNst: boolean; carryPrompt: boolean; vad: boolean };   // from the probe (D16)
  killGraceMs?: number;      // default VOICE_KILL_GRACE_MS
  log?: Pick<FastifyBaseLogger, 'warn' | 'error'>;
}
export function buildWhisperArgs(o: WhisperCliOptions, input: Pick<TranscribeInput, 'file' | 'workDir' | 'language' | 'prompt'>): string[];
export function parseWhisperOutput(json: string): { segments: string[]; language: string | null }; // Zod, loose; throws on bad shape
export function createWhisperCli(o: WhisperCliOptions): Transcriber;   // info = { engine: 'whisper.cpp', model: basename without .bin }
```

- Args, in this order:
  - `-m <model> -f <file> -l <language> -oj -of <workDir>/out -np`
  - `[-t n]`
  - `[-sns]` if `flags.suppressNst`
  - `[--vad -vm <vadModel>]` if `flags.vad && vadModel`
  - `[--prompt <p>]` if `prompt`, plus `[--carry-initial-prompt]` if `flags.carryPrompt`
- `transcribe` is an async generator:
  - Spawn with `stdio: ['ignore', 'ignore', 'pipe']` and `shell: false`. Keep the last `VOICE_STDERR_TAIL_BYTES` of stderr.
  - `signal` abort → `SIGTERM`, then a `setTimeout(SIGKILL, killGraceMs)` (cleared on close).
  - Always await the `close` event (a `once(child, 'close')` raced with `error`) before returning or throwing, so the caller removes the folder only after the process exited.
  - Abort → throw an `AbortError` that carries `signal.reason`.
  - Spawn `error` (ENOENT/EACCES), exit code ≠ 0, a signal, or missing/invalid `out.json` (read with `readEngineOutput`) → throw `VoiceError('transcription_failed')` and log `{ code, signal, stderrTail }` through `log.error`.
  - On success: yield `{ type: 'done', segments, language }`.
- whisper.cpp JSON: `{ result: { language: string }, transcription: [{ text: string, offsets: { from, to } }] }`. Parse with `z.looseObject` (unknown keys allowed) and default `transcription` to `[]`.

`probe.ts`:

```ts
export async function resolveWhisperBin(bin: string | undefined, env: NodeJS.ProcessEnv): Promise<string | undefined>;
export async function probeWhisper(config: VoiceConfig, options?: { timeoutMs?: number; log?; killGraceMs? }): Promise<ProbeResult>;
```

- `resolveWhisperBin`:
  - An absolute path → `access(X_OK)`.
  - A bare name → each `PATH` dir.
  - `undefined` → the name `whisper-cli` on PATH, then `/opt/homebrew/bin/whisper-cli`, then `/usr/local/bin/whisper-cli`.
- `probeWhisper` checks in order:
  1. Binary not found → `binary_not_found`, with the message "whisper-cli not found: install with `brew install whisper.cpp` or set OTAGO_WHISPER_BIN".
  2. `stat(model)` is not a non-empty file → `model_not_found`, with a message containing the path and the download URL.
  3. Spawn `bin --help` with a `VOICE_PROBE_TIMEOUT_MS` timeout and capture stdout + stderr. A non-zero exit, a timeout or a spawn error → `probe_failed` (message + output tail).
  4. Otherwise `flags` from the help text (`--suppress-nst`/`-sns`, `--carry-initial-prompt`, `--vad`), and `vad = flags.vad && isFile(vadModel)` → `{ available: true, transcriber: createWhisperCli(…), vad }`.

Tests, with no real Whisper. Fake binaries are **shim scripts written by the test** into a temp dir: the first line is `#!${process.execPath}`, followed by CommonJS code, `chmod 0o755`. Put a helper `writeFakeWhisper(dir, behaviour)` in `test/helpers.ts`. This avoids committed executables and exec-bit issues.

- `test/whisper-cli.test.ts`:
  - `buildWhisperArgs`:
    - always `-l`;
    - `auto` with no prompt;
    - prompt as a single argv element even with quotes, `;`, `$()`;
    - carry/sns/vad only with the matching flags;
    - threads.
  - `parseWhisperOutput`: valid, extra keys, missing `transcription`, bad JSON → throws.
  - Spawn through a shim:
    - (a) `ok`: the shim reads `-of`/`-l` from argv, writes `out.json` with two segments and `language`, exits 0 → a `done` event; the shim also records its argv to a file so the test can assert the prompt arrived intact.
    - (b) `exit 1` with stderr → `transcription_failed`; the log mock got the stderr tail.
    - (c) `hang` until SIGTERM, abort → the generator throws an AbortError after the child exited.
    - (d) `ignore SIGTERM`, `killGraceMs: 50` → SIGKILL, settles.
    - (e) exit 0 without writing `out.json` → `transcription_failed`.
    - (f) a nonexistent bin → `transcription_failed` (spawn ENOENT).
- `test/voice-probe.test.ts`:
  - `resolveWhisperBin` with an explicit path, a bare name on a fake `PATH`, and a missing binary;
  - `probeWhisper`: missing bin → `binary_not_found`; missing/empty model file → `model_not_found`; help exits 1 → `probe_failed`; a help shim that sleeps past `timeoutMs` → `probe_failed`;
  - help text with/without the optional flags → flags parsed; VAD on only when the VAD file exists.

## Step 7: Voice service (`voice/service.ts`, `voice/index.ts`)

```ts
export interface VoiceOptions {
  /** Availability source. Default: always `{ available: false, reason: 'disabled', message }`. */
  probe?: () => Promise<ProbeResult>;
  /** Shortcut for tests: available with this transcriber (no probe). */
  transcriber?: Transcriber;
  prompts?: { ru: string; en: string };          // default VOICE_DEFAULT_PROMPTS; '' = none
  maxWaiting?: number; maxBytes?: number; timeoutFactor?: number;
  spoolDir?: string;                             // tests; default owned OS-temp root
  timings?: Partial<VoiceTimings>;
  log?: FastifyBaseLogger;
}
export class Voice {
  readonly timings: VoiceTimings;
  /** Probe now (startup) — or re-probe if unavailable (not disabled) and older than reprobeIntervalMs. Concurrent calls share one probe. */
  refresh(force?: boolean): Promise<VoiceInfo>;
  info(): Promise<VoiceInfo>;                    // = refresh(false)
  /** Throws VoiceError voice_unavailable (details { reason }) / voice_busy / server_shutdown. */
  admit(): Promise<VoiceTicket>;
  /** preClose: abort every ticket with reason 'shutdown', await their disposal. */
  shutdown(): Promise<void>;
  /** onClose: shutdown() if not yet, then remove the spool root. */
  close(): Promise<void>;
}
export interface VoiceTicket {
  readonly signal: AbortSignal;                  // aborted by cancel()/shutdown()/watchdog
  /** Spool + validate the body (pre-stream VoiceErrors; drains on rejection). */
  receive(body: AsyncIterable<Buffer> | undefined): Promise<SpooledAudio>;
  /** Silence skip → queue → watchdog → transcriber → cleanTranscript. Throws VoiceError with a stream code. */
  run(audio: SpooledAudio, options: { language: VoiceLanguage; onEvent: (e: VoiceStreamEvent) => void }): Promise<TranscriptionResult>;
  /** Client went away. */
  cancel(): void;
  /** Free the queue slot, remove the job folder (after the engine exited). Idempotent; ALWAYS awaited by the route in `finally`. */
  dispose(): Promise<void>;
}
```

- `run` details:
  1. `audio.peak < VOICE_SILENCE_PEAK` → release the slot and return `{ text: '', language: null, durationMs, processingMs: 0 }` without calling the engine.
  2. `await slot.turn(signal, (p) => onEvent({ event: 'queued', data: { position: p } }))`.
  3. `onEvent(started { durationMs })`.
  4. Start the watchdog `timeoutBaseMs + timeoutFactor × durationMs` → `controller.abort('timeout')`.
  5. Iterate `transcriber.transcribe({ file, workDir: audio.dir, language, prompt: language === 'auto' ? undefined : prompts[language] || undefined, durationMs, signal })`. `segment` events are ignored in v1 (D14). Keep the `done` event.
  6. `text = cleanTranscript(segments, prompt)`. `language` = the requested language for `ru`/`en`; the engine's language for `auto`.
  7. Log `info` `{ durationMs, processingMs, language }` (no text, D18).
- Error mapping in `run`, on abort reason or thrown error:
  - `'timeout'` → `VoiceError('transcription_timeout')`;
  - `'shutdown'` → `server_shutdown`;
  - `'cancel'` → rethrow as is (nobody listens);
  - a `VoiceError` → as is;
  - anything else → `transcription_failed` (logged).
- `admit()`:
  - After `shutdown()` → `server_shutdown`.
  - `await info()` (re-probe rule D8); unavailable → `voice_unavailable` with `details: { reason }`.
  - `queue.admit()`. Every ticket goes into a `Set` for shutdown.
- `info()` for available returns `VoiceAvailable` with `languages: ['auto','en','ru']`, `audio: VOICE_AUDIO_FORMAT`, `limits: { maxBytes, minDurationMs: 100 }`, `streaming: false` and `engine: transcriber.info`.
- `voice/index.ts`: `export function whisperVoiceOptions(config: VoiceConfig): Omit<VoiceOptions, 'log'>`. It returns `probe` (or `undefined` when `!config.enabled`, which gives `disabled`) together with `prompts`, `maxWaiting`, `maxBytes` and `timeoutFactor`.
- `test/voice-service.test.ts` (unit, with `fakeTranscriber`, no HTTP):
  - disabled by default (and `refresh` never calls a probe);
  - the re-probe throttle, with a counting probe stub and `reprobeIntervalMs: 30`: unavailable → no re-probe within the interval → re-probe after it → becomes available → never re-probes again;
  - concurrent `info()` calls share one probe;
  - silence skip without an engine call;
  - prompt choice (ru default, en override `''` → none, auto none);
  - `language` in the result (requested vs detected);
  - the watchdog (`timeoutBaseMs: 30`, `timeoutFactor: 0`, gated fake) → `transcription_timeout`, engine signal aborted with reason `'timeout'`;
  - engine throws → `transcription_failed`;
  - `shutdown()` while running and while queued → `server_shutdown` for both, and the job folders gone after `dispose`;
  - `admit()` after shutdown → `server_shutdown`.

## Step 8: Route + app wiring + test helpers

`server/src/routes/voice.ts` (`FastifyPluginAsyncZod<RouteDeps>`, uses `deps.voice`), registered inside one encapsulated scope:

- `scope.removeAllContentTypeParsers()` and `scope.addContentTypeParser('*', (_req, payload, done) => done(null, payload))`. This is a pass-through parser: no buffering and no `bodyLimit` (research §1.1). It removes the inherited JSON and multipart parsers in this scope only.
- `GET /voice` → `voice.info()`.
- `POST /voice/transcriptions`. There is **no** Zod `querystring` schema: route-level validation would reply before the body could be drained. Instead `transcriptionQuery.safeParse(request.query)` runs in the handler and fails with `InvalidBodyError(issues)`, which gives the same `400 Invalid input` + details shape. The handler:
  1. `const body = request.body as Readable | undefined`.
  2. Pre-checks, in the contract's order:
     - `voice.info()` unavailable → `voice_unavailable` (via `admit`, see below);
     - content type: media type before `;`, lowercased, in `VOICE_AUDIO_MIME_TYPES`, else 415 `unsupported_audio_format`;
     - query;
     - `content-length > maxBytes` → 413 `audio_too_large` with `reply.header('connection', 'close')` and **no drain**;
     - `voice.admit()` → `voice_unavailable` / `voice_busy`. For `voice_busy`, set `reply.header('retry-after', '10')` before rethrowing (a test asserts the header survives the error handler).
     - On every pre-check error except the 413: `await drainBody(body)` (resume until `end`/`close`/`error`), then rethrow.
  3. Wire disconnects: `reply.raw.on('close', onClose)` with `if (!reply.raw.writableEnded) ticket.cancel()`, as in `routes/questions.ts`.
  4. `try { audio = await ticket.receive(body) } catch { await ticket.dispose(); throw }`. The `RequestAborted` case is the same 400 class as in questions; nobody reads it.
  5. Mode by `Accept`: JSON iff it includes `application/json` and not `text/event-stream`.
     - JSON mode: `try { return await ticket.run(audio, { language, onEvent: () => {} }) } finally { off(close); await ticket.dispose() }`. A thrown `VoiceError` becomes 500/504/503 through the central handler.
     - SSE mode:
       - `const sse = openSse(reply, voice.timings)`, `sse.onClose(() => ticket.cancel())`, `let seq = 0`.
       - `try { const result = await ticket.run(audio, { language, onEvent: (e) => sse.send(++seq, e.event, e.data) }); sse.send(++seq, 'done', result) } catch (error) { if (!sse.closed) sse.send(++seq, 'error', { error: message, code }) } finally { sse.end(); await ticket.dispose() }`.
       - A non-`VoiceError` in the catch is logged and sent as `transcription_failed`.
- `drainBody` and `parseAccept` live in this file. Keep them small and pure where possible.

`server/src/app.ts`:

- `AppDeps.voice?: Voice` (tests inject an instance) and `AppDeps.voiceOptions?: Omit<VoiceOptions, 'log'>` (production).
- `const voice = deps.voice ?? new Voice({ ...deps.voiceOptions, log: app.log })`.
- `RouteDeps.voice: Voice` (always present).
- Hooks:
  - `app.addHook('onReady', async () => log the probe result of `await voice.refresh(true)`)`: info "Voice input: whisper.cpp <model> (VAD on|off)", or info "Voice input unavailable (<reason>): <message>". Skip the log for `disabled` when no options were given.
  - `preClose`: `questions.endStreams(); await voice.shutdown();`.
  - `onClose`: `await questions.close(); await voice.close();`.
- Register `voiceRoutes` under `/api` with `routeDeps`.
- No existing route or test changes. Without `voice`/`voiceOptions`, voice is `disabled`.

`server/test/helpers.ts`:

- `fakeTranscriber(options?: { segments?: string[]; language?: string | null; gate?: () => Promise<void>; failWith?: string; onTranscribe?: (input: TranscribeInput) => void | Promise<void>; info?: { engine: string; model: string } }): Transcriber & { calls: TranscribeInput[] }`.
  - It awaits `onTranscribe`, then the gate raced with abort via `raceAbort`. On abort it throws an error whose `cause`/`reason` is `input.signal.reason`. Then it throws `failWith` or yields `done { segments (default ['Привет', ' мир']), language (default input.language === 'auto' ? 'ru' : input.language) }`.
- `wavBytes(options?: { ms?: number; sampleRate?: number; channels?: number; bits?: number; format?: number; amplitude?: number /* 0 = silence, default 8000 sine */; extraChunks?: Array<{ id: string; data: Buffer }>; dataSizeOverride?: number }): Buffer`.
- `writeFakeWhisper(dir, behaviour: 'ok' | 'fail' | 'hang' | 'ignore-term' | 'no-output' | { help: string; exit?: number; sleepMs?: number }): Promise<string>` (Step 6).
- `MakeAppExtra.voice?: { transcriber?: Transcriber; options?: Partial<VoiceOptions> }`. `makeApp` then builds `new Voice({ transcriber, spoolDir: <temp>, ...options })`, passes it as `AppDeps.voice`, returns `voice` and `spoolDir`, and cleans up the temp spool in `close`. Without `extra.voice` nothing changes (disabled).
- `postVoice(ctx, body: Buffer, opts?: { language?: string; accept?: string; contentType?: string | null })` → `app.inject` (POST `/api/voice/transcriptions`).
- `openVoiceStream(baseUrl, body, opts)`: a `fetch` + incremental `parseSseBlock`, like `openEventStream`, with an `abort()`. It is used for the queue and abort tests over a real socket.
- Helper `spoolEntries(spoolDir)` → the job folders left (must be `[]` after each case).

`test/voice-api.test.ts` (`app.inject`; the SSE body ends by itself, so `parseSse(res.body)`):

1. No voice deps: `GET /api/voice` → `{ available: false, reason: 'disabled', message }`; POST a valid WAV → 503 `voice_unavailable`, `details.reason === 'disabled'`, the JSON body arrives (drained).
2. With `fakeTranscriber`: GET → `available: true`, `languages`, `audio`, `limits.maxBytes`, `minDurationMs: 100`, `streaming: false`, `engine` from the fake.
3. Happy SSE (`language=ru`):
   - status 200 and the SSE content type;
   - frames `retry`, `started { durationMs }`, `done { text: 'Привет мир', language: 'ru', durationMs, processingMs ≥ 0 }`, no `queued`;
   - the fake saw `language: 'ru'`, the default ru prompt, a `file` that existed with the exact byte size (checked in `onTranscribe`), and `durationMs`;
   - `spoolEntries` is empty afterwards.
4. Language:
   - query absent → `auto`, no prompt, and `done.language` is the fake's detected value (`'uk'`);
   - `language=en` → the en prompt;
   - `options.prompts.en = ''` → no prompt;
   - `language=de` → 400 `Invalid input` + details.
5. JSON mode: `accept: application/json` → 200 JSON `TranscriptionResult`; `failWith` → 500 `transcription_failed`; the timeout → 504 `transcription_timeout`.
6. Pre-stream errors (each asserts status, `code` and an empty spool):
   - no content type → 415; `application/octet-stream` → 415; `audio/wav; codecs=1` is accepted;
   - garbage body → 400 `invalid_audio`; 48 kHz stereo → 415 + details; extensible → 415;
   - empty body → 400 `empty_audio`; 50 ms → 400 `empty_audio`;
   - `content-length` above `options.maxBytes: 10_000` → 413 `audio_too_large`;
   - `voice_busy` (see stream tests) carries `Retry-After: 10` + details.
7. Silence: an all-zero 1 s WAV → `done { text: '', language: null, processingMs: 0 }`, no `started`, the fake not called.
8. Cleaning: fake segments `['Продолжение следует...']` → `text: ''`; `['[BLANK_AUDIO]']` → `''`.
9. In-stream failure: `failWith` → frames `started`, `error { code: 'transcription_failed', error }`, the stream ended, the spool empty. The timeout (`timings.timeoutBaseMs: 30`, factor 0, never-opening gate) → `error { code: 'transcription_timeout' }`.
10. The `trees/` dir is untouched by any voice request (no entries besides what the test created).

`test/voice-stream.test.ts` (`app.listen` + `fetch`, like `questions-stream.test.ts`):

1. Queue: A is gated → B gets `queued { position: 1 }` → C gets `queued { position: 2 }` → open A's gate → B `started`/`done`, C sees `queued { position: 1 }` then `started`/`done`. FIFO order is asserted through `fake.calls`.
2. Busy: `maxWaiting: 1`, A running (gated), B queued → C → 503 `voice_busy`, `retry-after: 10`, `details { waiting: 1, maxWaiting: 1 }`.
3. Abort running: abort A's fetch → the fake's signal is aborted (reason `'cancel'`) → the spool is empty (`waitFor`) → B starts.
4. Abort queued: A running, B and C queued, abort B → C gets `queued { position: 1 }`; the fake never sees B.
5. Abort during upload: the POST body is a `ReadableStream` (`duplex: 'half'`) that sends a valid header and then stalls; abort → no fake call, the spool is empty, and a following request is admitted (capacity freed).
6. Received-size cap: a streamed body with no content-length (chunked) over `maxBytes: 10_000` → 413 `audio_too_large` (drained, JSON received).
7. Shutdown: A running (gated) and B queued; `app.close()` → both streams receive `error { code: 'server_shutdown' }` and end; `close()` resolves; the injected spool dir has no job folders.
8. Pings: with `timings.pingIntervalMs: 20`, a gated job's stream shows `: ping` comments while waiting.

## Step 9: Production entry (`server/src/index.ts`)

- `buildApp({ …, voiceOptions: whisperVoiceOptions(config.voice) })`.
- `await sweepVoiceSpools().catch(log)` next to `sweepHeldRoots`.
- The probe runs in `onReady` (Step 8), so `listen` logs the availability. A missing Whisper is logged at **info** level, not as an error, because it is optional.
- Shutdown needs no change: `app.close()` runs the hooks, and SIGTERM → SIGKILL fits the 10 s budget.

## Step 10: Manual CLI (`server/scripts/transcribe.ts`, `server/package.json`)

- `"transcribe": "tsx scripts/transcribe.ts"`. Usage: `pnpm --filter @otago/server transcribe <file.wav> [auto|en|ru]`.
- It loads `env.ts` + `loadConfig()`, builds a `Voice` from `whisperVoiceOptions`, and prints `refresh(true)`. When available, it reads the file through a `createReadStream` into `ticket.receive` and `run`s it, printing events, the final text, `durationMs` and `processingMs`. It writes nothing outside the OS temp spool and exits non-zero on errors.
- No unit test (thin wrapper over tested modules). It must pass `tsc --noEmit`.

## Step 11: Docs and config files

- `.gitignore`: add `server/models/`.
- `server/.env.example` (the planner could not read it because of sandbox permissions; append): a commented `# Voice input (optional)` block with every variable from contract `lifecycle.ts`, all commented out, defaults shown.
- `README.md`:
  - Features: one bullet for dictation (local Whisper, optional).
  - New section **"Voice input (optional)"** after Configuration:
    - `brew install whisper.cpp`;
    - `mkdir -p server/models` + the two `curl -L -o` commands (`ggml-large-v3-turbo-q8_0.bin`, `ggml-silero-v6.2.0.bin` for VAD, optional but recommended);
    - restart `pnpm dev` and look for the log line;
    - `pnpm --filter @otago/server transcribe sample.wav ru` to check;
    - Linux note (distro or source build; set `OTAGO_WHISPER_BIN`);
    - privacy note (audio only in the OS temp dir during the request, never in `trees/`).
  - Configuration table: add the `OTAGO_VOICE*` / `OTAGO_WHISPER_*` rows.
  - Scripts: the `transcribe` command.
- `CLAUDE.md`:
  - Server section: one bullet on `voice/` (Transcriber seam, `whisper-cli` per job, queue, spool in `storage/voice-spool.ts`, `routes/voice.ts` POST-SSE, contract path `.claude/features/voice-input/contracts/`).
  - Tests bullet: `fakeTranscriber`, `wavBytes`, `writeFakeWhisper`, `makeApp(…, { voice })`.
  - Config line: the new env vars.
- `docs/design.md`: not present in the repo (see "Target file layout"). Skip it.

## Step 12: Verification

```bash
pnpm --filter @otago/server test                       # all server tests, incl. the new ones
pnpm --filter @otago/server test -- test/voice-api.test.ts
pnpm --filter @otago/server test -- test/voice-stream.test.ts
pnpm --filter @otago/server test -- test/whisper-cli.test.ts
pnpm check                                             # Biome auto-fix (never hand-format)
pnpm lint                                              # biome check + tsc --noEmit, all packages
pnpm test                                              # whole repo still green (web/demo untouched by this project)
```

- The full suite must pass on a machine **without** whisper-cli. CI-like check: `PATH=/usr/bin:/bin pnpm --filter @otago/server test`. No test may depend on Homebrew paths: tests always pass explicit `bin` paths or fakes, and the `resolveWhisperBin` default-path test injects `env`.

Manual (once, on the dev machine, after `brew install whisper.cpp` + model download):

1. `pnpm dev` → the log says voice is available with the model name. `curl -s 127.0.0.1:3001/api/voice`.
2. `pnpm --filter @otago/server transcribe <short ru clip>.wav ru` → check that English terms stay in Latin script and note `processingMs`. The target is ≤ 3.5 s for ≤ 30 s clips on the M5 Pro. If it is consistently higher, record that for a later resident-backend follow-up; it does not block this feature.
3. `curl -N -H 'content-type: audio/wav' --data-binary @clip.wav '127.0.0.1:3001/api/voice/transcriptions?language=ru'` (SSE), plus the same with `-H 'accept: application/json'`.
4. A silent WAV → `done` with `''`. Ctrl+C on curl during a long file → the log shows the job cancelled, `ps` shows no `whisper-cli` left, and the `otago-voice-*` dir is empty.
5. Two curls at once → the second shows `queued`.
6. Stop the server during a long job → curl receives `server_shutdown`, and no `whisper-cli` survives.
7. Long recording sanity (e.g. a 20-30 min WAV): completes and its pings keep the connection alive. A Safari check comes with the web feature.

---

## Data model / interface changes summary

- No changes to `trees/` formats, node files or existing routes and contracts.
- New routes: `GET /api/voice`, `POST /api/voice/transcriptions` (contract `voice-api.ts`).
- New error codes: 9 `VoiceErrorCode`s (contract `errors.ts`). Existing codes are unchanged.
- New DI: `AppDeps.voice?`, `AppDeps.voiceOptions?`, `RouteDeps.voice`.
- New config: `Config.voice` (10 env vars, all optional).
- New OS-temp folder prefix: `otago-voice-` (swept after 24 h).

## Step ordering and dependencies

1 (errors) → 2 (config) → 3 (wav + spool) → 4 (types/constants/transcript) → 5 (queue) → 6 (whisper-cli + probe) → 7 (service) → 8 (route + wiring + helpers + API/stream tests) → 9 (index) → 10 (script) → 11 (docs) → 12 (verify).

Steps 3-6 are independent of each other after 1-2 and 4, and each comes with its own unit tests. Run `pnpm --filter @otago/server test` after every step: existing tests must stay green throughout, because voice is disabled unless injected.

## Notes for the clients (web, demo)

- Plan strictly against `contracts/voice-api.ts` ("Client obligations", "Demo mock obligations"), `voice-events.ts`, `errors.ts` (`VOICE_ERROR_CODES` → web `isErrorCode`) and `audio.ts` (WAV encoding, `VOICE_SILENCE_PEAK`, `VOICE_MIN_DURATION_MS`).
- Server-side guarantees the web can rely on:
  - aborting the fetch is the whole cancel story;
  - the transcript is never broadcast;
  - `done.text === ''` and 400 `empty_audio` both mean "nothing recognized";
  - a retry is a plain re-POST.
