# Research: voice-input, project `server`

Stage 2 (research) output. This is not a plan and not production code. Type sketches only show shapes for the plan stage. Facts marked **(verified)** were checked against the installed modules, the upstream sources or registries on 2026-10-09. Facts marked **(estimate)** still need a measurement during the plan or implementation stage.

## 0. Recommendation (TL;DR)

1. **Engine: run the external `whisper-cli` from whisper.cpp, spawned once per transcription (Homebrew `whisper.cpp` 1.9.5, MIT, Metal on by default).** The server adds no npm dependency. It probes the binary and the model at startup and is "voice unavailable" if either is missing. A Whisper crash cannot take down the Node process that holds the in-memory question registry. Nothing stays resident between dictations, so idle RAM is zero. Cancel = kill the child process. A long-running `whisper-server` (lower latency) remains an optional backend behind the same interface for later. Homebrew does **not** ship `whisper-server`, so that option needs a source build.
2. **Default model: `ggml-large-v3-turbo-q8_0.bin` (874 MB)**, with an optional Silero VAD model `ggml-silero-v6.2.0.bin` (885 KB). Turbo has the best quality-to-latency ratio for Russian (FLEURS ru WER 5.9 % at Q8_0, against 7.3 % for medium and 11.9 % for small). Its 4-layer decoder makes it several times faster than large-v3. Set the language to `ru`/`en` and add a short initial prompt with Latin-script tech terms to handle mixed ru+en speech.
3. **Upload format: the client encodes 16 kHz mono 16-bit PCM WAV.** This needs no ffmpeg anywhere. 1 h is about 115 MB, which is fine over loopback. The route takes a **raw request body** (`Content-Type: audio/wav`, not multipart). It uses a pass-through content-type parser and streams the body to a file in an OS temp spool folder (`otago-voice-*`, never under `trees/`). Memory stays bounded, the WAV header is validated while streaming, and the file is deleted in `finally`.
4. **API (server-owned contract):**
   - `GET /api/voice` reports the capability.
   - `POST /api/voice/transcriptions?language=auto|en|ru` takes the WAV body and **responds with a short-lived SSE stream**: `queued` → `started` → `done {text, language, durationMs}` or `error {error, code}`, plus `: ping` keep-alives.
   - Validation errors before the stream opens are normal JSON `AppError`s with new `VoiceErrorCode`s.
   - SSE keeps long jobs and queue waits safe from idle timeouts (Safari/WebKit 60 s idle). It also reserves a `segment` event for future streaming partials at no cost.
5. **Concurrency: serialize transcriptions in a FIFO queue (one at a time), bounded to a few waiting jobs** (503 `voice_busy` beyond that). A closed connection removes the job from the queue or kills its process.
6. **Testability:** a `Transcriber` interface (async generator of `segment`/`done`, like `Agent.ask`) is injected through `AppDeps`. The default is none, so voice is unavailable and every existing test passes unchanged. `fakeTranscriber()` lives in `test/helpers.ts`. The spawn logic can also be tested with a tiny Node shim script posing as `whisper-cli` (no real Whisper).
7. **Config:** `OTAGO_VOICE` (`auto`/`off`), `OTAGO_WHISPER_BIN`, `OTAGO_WHISPER_MODEL`, `OTAGO_WHISPER_VAD_MODEL`, `OTAGO_WHISPER_THREADS`. Paths resolve from `server/` like `OTAGO_TREES_DIR`. The defaults auto-detect a Homebrew install and `server/models/*.bin`.

## 1. Context

### 1.1 Stack (verified)
- Fastify **5.12.5** with `fastify-type-provider-zod` 7 and Zod 4.6. TypeScript 7, ESM, Vitest 5. Node 24.14 locally, `>=22` required. `@fastify/multipart` 10.1.2 is registered globally with `limits: { fileSize: MAX_SOURCE_BYTES, files: 1 }` (`app.ts`). The message route overrides limits per request (`request.parts({ limits })` in `routes/message-input.ts`).
- Fastify 5.12 defaults: `requestTimeout: 0`, `connectionTimeout: 0`, `handlerTimeout: 0`, `bodyLimit: 1 MiB` (`node_modules/fastify/lib/config-validator.js`). **No server-side timeout cuts a long upload or a long transcription.** `bodyLimit` applies only to buffering parsers (`parseAs`/`asString`/`asBuffer`). A custom parser that hands the payload stream through (`content-type-parser.js` L213-225) is **not** limited, so the route must enforce any cap itself.
- pnpm 10 workspace with `onlyBuiltDependencies: [esbuild]`. Any npm package with an install/postinstall script (native addons) must be allowlisted explicitly. This is extra friction for options (c) and (e) below.
- Dev machine: Apple **M5 Pro, 24 GB**. `brew` and `ffmpeg` are present. `whisper-cli` is not installed yet.

### 1.2 Existing patterns this feature must follow (verified)
- **Dependency injection.** `buildApp(deps: AppDeps)` builds `RouteDeps` (`treesDir`, `agent`, `models`, `locks`, `allowPrivateUrls`, `questions`), and every route plugin receives them. Services with lifecycles (`Questions`) are optional in `AppDeps`, created by default, and closed in `preClose`/`onClose` hooks (`questions.endStreams()`, `questions.close()`).
- **External engine behind an interface.** `Agent` (`agent/types.ts`) is an async generator of `chunk` events plus one `done` event, with an `AbortSignal` in the input. `fakeAgent()` in `test/helpers.ts` provides scripted chunks, gates raced with abort, and failures. No test makes a real SDK call. `Transcriber` should mirror this exactly.
- **Errors.** `AppError(statusCode, message, code?, details?)` with code unions per area (`ConflictCode`, `UploadErrorCode`, ...) in `errors.ts`. The central handler sends `{ error, code?, details? }`. `UploadError` maps `file_too_large` to 413 and everything else to 400.
- **Disk.** "`storage/` is the only layer that touches disk." OS-temp data already lives there. `storage/held-files.ts` creates a lazily made, process-owned `mkdtemp(os.tmpdir()/otago-held-)` root, removes it on `close()`, and runs `sweepHeldRoots()` at startup for orphans older than 24 h. A voice spool should copy this pattern (or generalize the sweep by prefix).
- **SSE.** `routes/sse.ts` `openSse(reply, { retryMs, pingIntervalMs, maxBufferedBytes })` hijacks the reply and handles headers, `: ping`, slow-consumer cut-off, `onClose` callbacks and `end()`. The web has `api/sse.ts` `readSse` (fetch + reader), which a POST-SSE response can reuse.
- **Rejecting uploads cleanly.** `drainParts` reads the rest of a rejected upload so that the client gets the JSON error rather than a connection reset. A raw-body route needs the same treatment.
- **Config.** `loadConfig(env)` in `config.ts` is pure and unit-tested (`test/config.test.ts`). Paths resolve from `SERVER_DIR`, and `index.ts` builds the production dependencies. `server/.env` is loaded by `env.ts`, and Turbo passes `OTAGO_*` through.
- **Shutdown.** `index.ts` handles SIGINT/SIGTERM with `app.close()` and a 10 s hard exit. Child processes must be killed in `preClose`.

## 2. Q1: How to run Whisper locally from the Node server

### 2.1 Options

| | Option | Install for the user | Accel. on Apple Silicon | Process model | Maintenance (Oct 2026) | License |
|---|---|---|---|---|---|---|
| a | **`whisper-cli` spawned per request** | `brew install whisper.cpp` (bottled for arm64 Sequoia/Tahoe) + download model | Metal (Homebrew `ggml` builds the Metal backend on arm64). No Core ML | Child process per job, killed on cancel | whisper.cpp **1.9.5** (2026-10-06), very active | MIT |
| b | **`whisper-server` child kept running** | **Not in Homebrew** (`-DWHISPER_BUILD_SERVER=OFF` in the formula). Build from source with cmake | Metal; Core ML if built with `-DWHISPER_COREML=1` + generated `.mlmodelc` | Long-lived child on a localhost port, model stays loaded | same | MIT |
| c | **Node native binding** | `pnpm add` (prebuilt or node-gyp) | depends on the package | In-process (same address space as Otago) | see 2.2 | MIT |
| d | **Python sidecar** (mlx-whisper / faster-whisper) | Python env (uv/venv) + pip, + ffmpeg for mlx-whisper file decoding | mlx-whisper: MLX (GPU). faster-whisper: **CPU only** on macOS | Long-lived sidecar (HTTP/stdio) | mlx-whisper 0.4.3 (2025-08), faster-whisper 1.2.1 (2025-10) | MIT |
| e | **transformers.js** in Node | `pnpm add @huggingface/transformers` (4.3.1); pulls `onnxruntime-node` + `sharp` | CPU by default; Node WebGPU is new in v4; Core ML EP not documented for Whisper | In-process | very active | Apache-2.0 |
| f | **WhisperKit CLI** `serve` (Swift, Core ML/ANE) | `brew install whisperkit-cli` | ANE + GPU | Long-lived local server with an OpenAI-style API | active; flags not verified | MIT |

### 2.2 Node bindings, state in 2026 (verified on the npm registry, downloads for 2026-09-08..10-07)
- **`@fugood/whisper.node`**: `latest` = `1.2.0-rc.1` (2026-10-07); the last stable is 1.1.3 (2026-08-27). About 15k downloads/month. Prebuilt optional packages per platform (darwin-arm64 with Metal, about 8 MB). Persistent context, `transcribeData(PCM)`, `stop()` cancellation, and Parakeet too. **The best binding today.** Note that `latest` points at an RC and that it has a `postinstall` check script (pnpm allowlist).
- **`whisper-cpp-node`** 0.2.12 (2026-03): prebuilt darwin-arm64 (Metal, optional Core ML) and VAD. Small user base (about 1k/month), forked whisper.cpp.
- **`smart-whisper`** 0.8.1: last release 2024-10, `node-gyp rebuild` on install. Stale.
- **`nodejs-whisper`** 0.3.1 (2026-08): not a binding. It clones and **compiles whisper.cpp with `make` inside `node_modules`** and shells out to the CLI, with ffmpeg conversion. It works around the CLI without adding anything.
- **`@kutalia/whisper-node-addon`** 1.1.0 (2025-07) and **`whisper-node`** 1.1.1 (2023-11): stale.

### 2.3 Trade-offs that decide it for Otago
- **Crash isolation matters more here than usual.** Running answers, held files and the question registry live **in memory** in the server process (`questions/registry.ts`). A native abort in ggml/Metal (`GGML_ASSERT` → `abort()`, out of memory) inside an in-process binding (c, e) would kill every running answer. A child process (a, b, d, f) only fails its own job.
- **Optional dependency.** Option (a) adds zero npm packages, and the server only probes a path. Options (c) and (e) add native packages to every `pnpm install` even when voice is unused: transformers.js brings `onnxruntime-node` and `sharp`, and they need pnpm `onlyBuiltDependencies` changes. They could be `optionalDependencies` with a dynamic `import()`, but that is more moving parts.
- **Latency.** (b), (c), (d), (e) and (f) keep the model loaded. (a) pays process start + model load + Metal init on every call. That is roughly **0.3–1.5 s (estimate)** for turbo-q8_0 once the file is in the page cache. Short clips still meet "a few seconds" (§3.3). Measure with the `load time`/`total time` lines `whisper-cli` prints.
- **Idle memory.** (a) uses none while idle. The resident options hold about 1–2 GB (turbo) for the whole server lifetime, which is noticeable on a 16–24 GB laptop that also runs Claude Code processes.
- **Cancellation.** (a): `SIGTERM`/`SIGKILL` the child, and the OS frees GPU memory. (b): the server's `abort_callback` checks `req.is_connection_closed()`, so aborting the HTTP request stops inference (verified in `examples/server/server.cpp`). The server also serializes requests with a `whisper_mutex`. (c): `stop()` (fugood). (d) and (f): depend on the sidecar.
- **Lifecycle.** (a) leaves nothing behind. If Node crashes mid-job, the orphan `whisper-cli` finishes and exits by itself. (b), (d) and (f) need port selection, readiness polling, restart-on-crash and kill-on-exit. With `tsx watch` restarting the server on every edit, that also means reloading the model or reconnecting to an orphaned server.
- **Install friction on macOS.** (a) is one `brew` command plus a model download. (b) needs a cmake build (about 1–2 min) and Xcode CLT. whisper.cpp releases ship **no macOS CLI binaries**, only an xcframework. (d) needs Python and torch (mlx-whisper requires `torch`). (f) is one `brew` command but macOS-only, its CLI flags and port are not verified, and the first Core ML compile is slow.
- **Speed ranking on Apple Silicon** (mac-whisper-speedtest, M4, short clip, large-v3-turbo): mlx-whisper 1.02 s, whisper.cpp turbo-q5_0+CoreML 1.23 s, WhisperKit large-v3 2.2 s, faster-whisper (CPU int8) 6.96 s. whisper.cpp with Metal is in the same class as the fastest Python option, and faster-whisper is ruled out on macOS.

### 2.4 Recommendation
**(a) Spawned `whisper-cli`** for v1. Keep the `Transcriber` interface generic so a **(b) `whisper-server` backend** can be added later without contract changes, for example `OTAGO_WHISPER_SERVER_URL` pointing at a user-managed server, if measured latency disappoints. Rejected for v1:
- (c): in-process crash risk, an RC `latest` tag and native-dependency friction. It is still the best fallback if we ever want "pnpm install and it works" with no brew step.
- (d): a second runtime and its packaging.
- (e): heavy dependencies and slower.
- (f): macOS-only and unverified flags.

Spawn details for the plan:
- Use `spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })` without a shell (prompt text travels as an argv element, so there is no injection).
- Example args: `-m <model> -f <wav> -l <ru|en|auto> -oj -of <spool>/<id> -np -t <threads> [--vad -vm <vad>] [-sns] [--prompt <p>]`.
- Read `<id>.json`. Its `result.language` gives the detected language for `auto`, and `transcription[].text` gives the segments.
- Keep only the last ~8 KB of stderr for error logs.
- Defaults in the current `cli.cpp` (verified): flash attention **on**, beam size 5, `-t` = min(4, cores), `-l` = `en`. That means `-l` must always be passed.
- Startup probe: `whisper-cli --help` (or `-h`) exits 0 and the model file exists. This catches a broken dylib chain (Homebrew links shared `ggml` and `llama.cpp`) at startup rather than on the first dictation.

## 3. Q2: Model choice

### 3.1 Data
FLEURS **Russian** WER, Q8_0 quantization (Handy model benchmark), and ggml file sizes from `huggingface.co/ggerganov/whisper.cpp`:

| Model | ru WER | File (q8_0 / q5 / f16) | RAM while running (whisper.cpp README, f16) | Notes |
|---|---|---|---|---|
| tiny | 35.6 % | — / — / 75 MB | ~273 MB | unusable for ru |
| base | 22.9 % | 82 / 60 / 148 MB | ~388 MB | unusable for ru |
| small | 11.9 % | 264 / 190 / 488 MB | ~852 MB | weak on code-switching |
| medium | 7.3 % | 823 / 539 / 1534 MB | ~2.1 GB | 24-layer decoder: slower **and** worse than turbo |
| **large-v3-turbo** | **5.9 %** | **874** / 574 / 1625 MB | ~1.5–2 GB (estimate: same encoder as large, 4-layer decoder) | 809 M params; ~4–8× faster decode than large-v3 |
| large-v3 | 5.0 % | — / 1081 / 3095 MB | ~3.9 GB | best quality, much slower decode |

Same benchmark, other relevant languages: turbo trails large-v3 by about 0.3–1 WER points (uk 7.3 vs 6.3, pt 4.2 vs 3.9). English is the strongest language for every large model. No public benchmark covers **mixed ru+en technical speech**, so the plan should include a 5-minute manual check with a few real dictations.

### 3.2 Recommendation
- **Default `ggml-large-v3-turbo-q8_0.bin`** (874 MB). Q8_0 is close to lossless, and the published ru number was measured at exactly Q8_0. **Lighter alternative: `-q5_0`** (574 MB). **Quality alternative: `ggml-large-v3-q5_0.bin`** (1.08 GB, slower).
- Models are configuration, not code. Any ggml file works through `OTAGO_WHISPER_MODEL`, and `GET /api/voice` reports the model's file name.
- Not in scope, but worth noting: whisper.cpp ≥ 1.9.0 also runs **NVIDIA Parakeet TDT 0.6B v3** (ru WER 6.5 %, about 4× faster than turbo, CC-BY-4.0). It is a candidate second engine behind the same interface, but it is not Whisper, and it has its own CLI and model format.

### 3.3 Latency (estimates; measure in the plan stage)
Whisper always encodes 30 s windows, so a 3 s clip costs about the same encoder pass as a 30 s clip.
- On M-series with Metal, turbo transcribes a short clip in about 1–1.5 s once loaded (mac-whisper-speedtest on M4).
- Process start and model load add about 0.3–1.5 s.
- **Expected for ≤ 30 s clips: about 1.5–3.5 s on the M5 Pro.**
- One hour of audio: probably a few minutes (turbo with Metal runs many times faster than real time). This is why the response must survive long waits (§7).

### 3.4 Initial prompt (vocabulary/style trick)
- `--prompt` ("initial prompt", at most n_text_ctx/2 ≈ 224 tokens) conditions the decoder on preceding text. Spelling, script (Latin vs Cyrillic for English terms), punctuation and capitalization all follow the prompt.
- For `ru`, a short Russian sentence with correct punctuation that contains typical Latin-script terms ("Обсуждаем код на TypeScript и React, Node.js, API, pull request, commit.") makes Whisper keep English terms in Latin rather than transliterating them.
- `--carry-initial-prompt` re-applies the prompt to every 30 s window (verified in `cli.cpp`). Without it, the prompt only affects the first window of a long recording.
- Risk: on near-silent input, Whisper can echo the prompt. VAD (§5) mitigates this.
- Plan decision: a built-in prompt per language (`en`/`ru`; none for `auto`?), optionally overridable by env. A tree-specific vocabulary (from the tree title/instructions) is a possible later improvement and can live inside the service without contract changes.

## 4. Q3: Audio format and ingest

### 4.1 What whisper.cpp accepts (verified in `examples/common-whisper.cpp`)
- `whisper-cli` decodes with **miniaudio**: WAV, FLAC, MP3 and Ogg **Vorbis** (help text: "supported audio formats: flac, mp3, ogg, wav").
- It **downmixes and resamples to 16 kHz mono itself** (`ma_decoder_config_init(ma_format_f32, 1, WHISPER_SAMPLE_RATE)`), with miniaudio's simple resampler.
- `-f -` reads from stdin.
- **WebM/Opus (Chrome MediaRecorder) and MP4/AAC (Safari MediaRecorder) are not supported** unless whisper.cpp was built with `WHISPER_COMMON_FFMPEG`. The Homebrew formula does not do that. `whisper-server --convert` shells out to the `ffmpeg` CLI.

### 4.2 Options
- **I1. The client sends 16 kHz mono 16-bit PCM WAV (recommended).** The client captures PCM itself (AudioWorklet) or decodes the MediaRecorder blob and resamples with `OfflineAudioContext`; the details belong to the web research. Pros: no ffmpeg on the server, the same path in Chrome and Safari, browser-quality resampling, and a trivially valid header. Size: 32 KB/s, so ~1.9 MB/min and ~115 MB/h. Loopback upload of 115 MB takes well under a second, and the server streams it to disk.
- **I2. Compressed upload (webm/opus, mp4/aac) + server-side ffmpeg.** About 10× smaller, but it makes ffmpeg a second optional dependency and adds a conversion step (ffmpeg spawn, time, temp file). The size gain is irrelevant on loopback.
- **I3. FLAC from the client.** About 50–60 % of WAV and natively decoded by miniaudio, but it needs a WASM FLAC encoder on the client. Possible later as an additional accepted MIME type with no API redesign.

### 4.3 Ingest design (recommended)
- **Raw body, not multipart:** `POST` with `Content-Type: audio/wav` (also accept `audio/x-wav` and `audio/wave`). Query parameters carry `language`.
  - There is one stream and no boundary parsing. The global multipart `fileSize: MAX_SOURCE_BYTES` limit does not interfere.
  - The future "save the audio into the node" stays independent: the client keeps the `Blob` and later posts it through the existing message `files` path.
- **Encapsulated pass-through parser** inside the voice plugin only: `addContentTypeParser(['audio/wav', ...], (req, payload, done) => done(null, payload))`. The body is then the raw stream, `bodyLimit` does not apply (verified), and no other route is affected.
- **Spool to the OS temp dir.** `pipeline(body, wavInspector, createWriteStream(<spool>/<uuid>.wav))`:
  - The spool is a process-owned `mkdtemp(os.tmpdir()/otago-voice-)` folder in `storage/`, removed on close, with orphans swept at startup like `sweepHeldRoots`.
  - The inspector Transform parses the RIFF chunk list (do not assume a 44-byte header). It requires PCM format 1, 1 channel, 16 000 Hz and 16 bits, and rejects anything else with **415 `unsupported_audio_format`**.
  - It counts data bytes, which gives `durationMs = bytes / 32` (used for the timeout, the response and the empty check).
  - It can also track the peak/RMS level, so the server can **skip Whisper entirely for silent audio** (the cheapest hallucination guard; the threshold is a plan decision).
  - Memory stays O(chunk).
- **Limits.** The product says no length cap. The only hard ceiling is RIFF's 32-bit size field (4 GiB ≈ 37 h at 32 KB/s). The plan may add a configurable safety cap (disk protection) → 413 `audio_too_large`. Audio shorter than a minimum (for example 0.2 s) → 400 `empty_audio`.
- **Timeouts.** There is no HTTP timeout (all Fastify defaults are 0). A per-job watchdog of `max(120 s, 2 × durationMs)` (configurable) kills a hung process → `transcription_timeout`.
- **Cleanup.** The temp WAV and JSON are deleted in `finally` for success, failure, abort and timeout. If the client aborts mid-upload, the pipeline errors → delete the partial file, and nothing is queued.
- **Early rejection** (voice unavailable, bad query, wrong content type) happens before the body is read. Drain the body (bounded, like `drainParts`) or the browser may see a reset instead of the JSON error. The web should check `GET /api/voice` first anyway.

## 5. Q4: Language handling and hallucinations

- **Parameter.** `language ∈ {auto, en, ru}` maps directly to `-l`. Always pass it: the CLI default is `en`. The `done` event returns `language` (the detected one for `auto`, from `result.language` in the JSON output).
- **Auto-detect and mixed speech.** Whisper picks one language token from the first window and decodes everything with it. **`auto` does not switch languages mid-utterance.** For Russian speech with English terms, `ru` + the prompt (§3.4) is the best setting, and that is what the feature's default (UI language) produces. `auto` is fine for unknown monolingual input. Short or ambiguous clips can be misdetected (for example, as Ukrainian or Bulgarian for Russian speech). The response reports the detected language so the UI can show it later.
- **Silence hallucinations.** Whisper was trained on subtitles. On silence or noise it produces typical endings: en "Thank you for watching.", "Thanks for watching!"; ru "Продолжение следует...", "Субтитры сделал DimaTorzok", "Редактор субтитров ... Корректор ...". Mitigations, in order of value:
  1. **Silero VAD** (`--vad -vm ggml-silero-v6.2.0.bin`, supported by the current CLI and server; model 885 KB). It feeds only speech segments to Whisper. With no speech, the result is an empty transcript, which the client reports as "nothing recognized". VAD also speeds up long recordings with pauses. Enable it automatically when the VAD model file exists.
  2. A server-side **silence pre-check** from the spool inspector (§4.3).
  3. `-sns` (`--suppress-nst`, suppress non-speech tokens such as "[Music]" and "(applause)").
  4. A **post-filter**: if the whole transcript (trimmed, case-folded, punctuation-stripped) equals a known hallucination phrase from a small per-language list, return `''`. Keep it exact-match only, so real speech is never cut.
  5. `--no-speech-thold` (default 0.6) exists. Do not rely on it alone, because its effect depends on the log-prob threshold and the decoding mode.
- **Empty result** is a success: `done {text: ''}`. The client decides what to show.

## 6. Q5: Concurrency and cancellation

- **Options.** (A) reject a second job with 409 while one runs; (B) FIFO queue with concurrency 1; (C) parallel processes.
- (C) is ruled out. Two Metal jobs on one GPU do not finish faster in total, and each one loads its own copy of the model (about 1.5–2 GB).
- (A) is simple, but the single local user with two tabs (or main and side panels in quick succession) would get spurious failures, and every client would need its own retry loop.
- **Recommendation: (B)** `VoiceQueue` with `concurrency = 1` and at most **4 waiting jobs** (configurable). Above that → **503 `voice_busy`** before the body is read. A bounded queue protects against runaway clients without bothering the normal user.
  - The SSE response tells waiting clients `queued {position}`, so the UI can say "waiting for another transcription".
  - A long recording ahead in the queue delays short ones. That is acceptable for a single user, and it is visible to them.
- **Cancellation.** The job holds an `AbortController`, wired to the response's `close` (the client aborts fetch, the tab closes, or the server ends the stream).
  - Queued → removed from the queue (later positions are re-announced).
  - Running → `SIGTERM` the child, then `SIGKILL` after ~2 s; temp files deleted.
  - Mid-upload → the pipeline error deletes the partial file.
- **Shutdown.** In `preClose`: end the voice streams with `error {code: 'server_shutdown'}` (or just end them), abort all jobs and kill the children. In `onClose`: remove the spool root. Same hooks as `Questions`.

## 7. Q6: API shape (server-owned contract)

### 7.1 Capability
**`GET /api/voice`** (new; neither `/models`, which is about Claude models, nor `/health`, which is liveness, fits):
```ts
type VoiceInfo =
  | { available: false; reason: 'disabled' | 'binary_not_found' | 'model_not_found' | 'probe_failed' }
  | {
      available: true;
      languages: Array<'auto' | 'en' | 'ru'>;
      /** What the client must upload. */
      audio: { mimeType: 'audio/wav'; sampleRate: 16000; channels: 1; bitsPerSample: 16 };
      /** Future: partial `segment` events while transcribing / live input. */
      streaming: false;
      engine: { name: 'whisper.cpp'; model: string /* file name, e.g. ggml-large-v3-turbo-q8_0 */ };
    };
```
- `reason` is mainly for logs and a possible settings hint. The web only reads `available`.
- Probed once at startup. A cheap re-probe (`stat`) on each `GET` is an option, so that downloading the model does not need a restart; plan decision.
- The demo mock returns `available: true`.

### 7.2 Transcription
**`POST /api/voice/transcriptions?language=auto|en|ru`**, body = WAV (§4.3), `Accept: text/event-stream`.

Errors before the stream opens (JSON, `AppError`, new `VoiceErrorCode` union in `errors.ts`):

| Status | `code` | When |
|---|---|---|
| 503 | `voice_unavailable` | no transcriber configured/probed |
| 503 | `voice_busy` | queue full (send `Retry-After`) |
| 400 | — (Zod `Invalid input`) | bad `language` |
| 415 | `unsupported_audio_format` | wrong content type or a WAV that is not 16 kHz/mono/16-bit PCM |
| 400 | `invalid_audio` | malformed RIFF |
| 400 | `empty_audio` | no or too few samples |
| 413 | `audio_too_large` | only if the plan adds a safety cap |

After the body is spooled, the server opens SSE through `openSse` and **ends it after the terminal event**:

| Event | Data | Notes |
|---|---|---|
| `queued` | `{ position: number }` | only when the job waits; re-sent when the position changes |
| `started` | `{ durationMs: number }` | Whisper is running |
| `segment` | `{ text, startMs, endMs }` | **reserved for streaming**; may be emitted already (whisper-cli prints segments as it goes), clients may ignore it |
| `done` | `{ text: string; language: string \| null; durationMs: number }` | `text` trimmed; `''` = nothing recognized |
| `error` | `{ error: string; code: 'transcription_failed' \| 'transcription_timeout' \| 'server_shutdown' }` | same shape as a JSON error body |

- `: ping` every ~15 s keeps the connection alive during queue waits and long jobs.

Why SSE instead of a plain JSON response:
- **WebKit applies a 60 s network idle timeout to `fetch`**, which web code cannot change. A 1 h recording or a queue wait can exceed 60 s without a response byte. Verify in Safari during implementation; see References.
- The `queued` state gets a UI.
- Future streaming partials only add events and need no new endpoint.
- The repo already has both halves (`openSse`, `readSse`).

Costs:
- Errors that occur after the stream opens arrive as in-band `error` events, not as HTTP status codes.
- `app.inject` tests read the whole body and parse it with the existing `parseSse` helper (the stream ends by itself).
- Optional: also answer `Accept: application/json` with a blocking JSON response for curl and scripts. It is cheap because both paths share the service. Plan decision.

Rejected:
- A 202 + job id design with results on the app-wide `GET /questions/events` stream. That would couple voice to the question registry and contract and broadcast transcripts to all tabs, and voice jobs need no retention.
- WebSocket: no bidirectional need yet. Live streaming input might justify it later.

### 7.3 Room for the future
- **Streaming transcription.** `segment` events now. Live microphone streaming later would be a separate endpoint or a WebSocket, for example `POST /api/voice/streams`. The `Transcriber` interface already yields segments.
- **Saving the audio.** The API never claims the audio is discarded "by design". The server deletes its temp copy, and the client keeps the `Blob` and can attach it through the existing `files` path.

## 8. Q7: Testability

Sketch (shape only):
```ts
// server/src/voice/types.ts
export type VoiceLanguage = 'auto' | 'en' | 'ru';
export interface TranscribeInput {
  file: string;            // absolute path of the spooled 16 kHz mono WAV (OS temp, never trees/)
  language: VoiceLanguage;
  prompt?: string;
  durationMs: number;
  signal: AbortSignal;     // client gone, timeout, shutdown
}
export type TranscriberEvent =
  | { type: 'segment'; text: string; startMs: number; endMs: number }
  | { type: 'done'; text: string; language: string | null };
export interface Transcriber {
  readonly info: { engine: string; model: string };
  transcribe(input: TranscribeInput): AsyncIterable<TranscriberEvent>; // throws on failure
}
```
- **Layers**:
  - `voice/whisper-cli.ts` implements `Transcriber` (argument building, spawn, kill, JSON parse).
  - `voice/service.ts` `Voice` provides the queue, the watchdog, the hallucination filter, the prompt choice and `info()`.
  - `storage/voice-spool.ts` provides the temp root, the WAV inspector and the sweep.
  - `routes/voice.ts` holds the parser, the validation and the SSE.
- **Dependencies.** `AppDeps.transcriber?: Transcriber` and an optional `AppDeps.voice?: Voice`, like `questions`. `RouteDeps.voice` is always present and reports `available: false` when there is no transcriber. **Existing tests change nothing.**
- **`fakeTranscriber({ text, segments, language, gate, failWith, onTranscribe })`** in `test/helpers.ts`. It records calls, races gates with abort like `fakeAgent`, and lets `onTranscribe` assert that the spooled file exists and has the expected duration. `makeApp(..., { transcriber })` passes it through. Tests can then cover:
  - SSE event order;
  - queueing (a gate blocks job 1, job 2 sees `queued`) and `voice_busy`;
  - abort on client close (with `listen` + `fetch`, as in the stream tests);
  - temp cleanup (the spool dir is empty after each case);
  - the WAV validation codes;
  - the silence and hallucination filters;
  - shutdown.
- **`whisper-cli` adapter tests without Whisper.** Pure tests for `buildArgs` and `parseOutput`. Optionally, one integration test that points `OTAGO_WHISPER_BIN` at a small Node shim script (in `test/fixtures/`) that writes a canned JSON or sleeps until killed. That exercises spawn, kill and exit-code handling with no real model.
- **WAV fixtures** are generated in tests (header + N zero or sine samples). No binary fixtures are needed.

## 9. Q8: Config and setup

| Variable | Default | Purpose |
|---|---|---|
| `OTAGO_VOICE` | `auto` | `off` disables voice even when Whisper is installed |
| `OTAGO_WHISPER_BIN` | `whisper-cli` on `PATH`, then `/opt/homebrew/bin/whisper-cli`, `/usr/local/bin/whisper-cli` | whisper.cpp CLI |
| `OTAGO_WHISPER_MODEL` | `./models/ggml-large-v3-turbo-q8_0.bin` (relative to `server/`) | ggml model |
| `OTAGO_WHISPER_VAD_MODEL` | `./models/ggml-silero-v6.2.0.bin` | VAD is on iff this file exists |
| `OTAGO_WHISPER_THREADS` | whisper default (4) | CPU threads (Metal does the heavy lifting) |

- Possible extras (plan decision): `OTAGO_WHISPER_PROMPT` override, `OTAGO_VOICE_QUEUE` max waiting jobs, `OTAGO_VOICE_TIMEOUT_FACTOR`, and later `OTAGO_WHISPER_SERVER_URL`.
- `loadConfig` gains a pure `voice` section, unit-tested like `loadModels`. The probe (`which` + `stat` + `--help`) runs in `index.ts` and logs why voice is unavailable.
- Add `server/models/` to `.gitignore` (or ignore `*.bin` under `server/`).

README "Voice input (optional)" draft:
```bash
brew install whisper.cpp            # provides whisper-cli (Metal on Apple Silicon)
mkdir -p server/models && cd server/models
curl -LO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin   # 874 MB
curl -LO https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin          # optional, recommended
```
- Restart `pnpm dev`. The mic appears when the server log says voice is available.
- Linux: whisper.cpp from the distro or a source build. Other models: set `OTAGO_WHISPER_MODEL`.
- Optional `pnpm --filter @otago/server voice:setup` script (download + checksum) in the style of `scripts/ask.ts`. Plan decision.

## 10. Risks
- **Per-call cold start** (a). If the measured load overhead makes short dictations exceed ~3 s, add the `whisper-server` backend (source build) or a binding behind `Transcriber`. The contract stays the same.
- **Homebrew changes.** The formula was recently renamed (`whisper-cpp` → `whisper.cpp`, old name kept as an alias) and links shared `ggml`/`llama.cpp`. A brew upgrade can break the dylib chain, and the startup probe surfaces that as `probe_failed`. Binary names have changed before (`main` → `whisper-cli` in 2024), so keep the binary path configurable.
- **Safari/WebKit idle timeout** on long waits. It is mitigated by SSE pings and must be verified manually in Safari.
- **Whisper quality on code-switching** varies by speaker. Prompt tuning and the `ru`/`en` choice matter more than model size above turbo.
- **Hallucinations** on silence or noise. Mitigated by VAD + the silence pre-check + an exact-match filter. A residual risk remains on noisy input.
- **Disk.** Long recordings temporarily take up to hundreds of MB in `os.tmpdir()`, cleaned in `finally` and by the startup sweep.
- **Native crash inside the child.** Isolated, and it surfaces as `transcription_failed` (non-zero exit or a signal). Log the stderr tail.
- **Early rejection resets.** Must drain the body, otherwise the browser shows a network error instead of the JSON error.
- **GPU contention** with other local GPU apps. Out of our control, and serialization keeps our own share to one job.

## 11. Open questions for the plan stage
1. JSON variant (`Accept: application/json`) in addition to SSE: yes or no?
2. Built-in initial prompts per language (text), env override, and whether `auto` gets a prompt.
3. Queue size and timeout factor defaults, and whether they get env vars.
4. Re-probe on `GET /api/voice` vs startup-only probe.
5. Silence pre-check threshold (and whether to do it server-side, client-side or both; coordinate with web).
6. Safety cap on upload size (product said none; RIFF caps at 4 GiB).
7. Hallucination phrase list (start small: about 5 ru + 4 en exact phrases).
8. Contract files in `.claude/features/voice-input/contracts/` (`voice-api.ts`, `errors.ts`) and the demo mock's `exportsComplete` additions (`getVoiceInfo`, `transcribe`).

## 12. References
- whisper.cpp repository, README (VAD, Core ML, FFmpeg "examples only", memory table): https://github.com/ggml-org/whisper.cpp
- whisper-cli options: https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/README.md and `examples/cli/cli.cpp` (flash attention on by default, `--carry-initial-prompt`, `-sns`, `-oj`)
- whisper-server (mutex, `abort_callback` on connection close, `--convert` needs ffmpeg): https://github.com/ggml-org/whisper.cpp/tree/master/examples/server
- Audio decoding (miniaudio, stdin, optional ffmpeg): https://github.com/ggml-org/whisper.cpp/blob/master/examples/common-whisper.cpp
- Releases (v1.9.5, 2026-10-06; Parakeet support since v1.9.0): https://github.com/ggml-org/whisper.cpp/releases
- Homebrew formula `whisper.cpp` (1.9.5, `WHISPER_BUILD_SERVER=OFF`): https://github.com/Homebrew/homebrew-core/blob/HEAD/Formula/w/whisper.cpp.rb
- Homebrew formula `ggml` (Metal backend on Apple Silicon): https://github.com/Homebrew/homebrew-core/blob/HEAD/Formula/g/ggml.rb
- ggml Whisper models and sizes: https://huggingface.co/ggerganov/whisper.cpp
- Silero VAD ggml models: https://huggingface.co/ggml-org/whisper-vad
- Russian FLEURS WER by model (Q8_0): https://models.handy.computer/languages/ru
- Apple Silicon implementation speed comparison: https://github.com/anvanvan/mac-whisper-speedtest
- `@fugood/whisper.node`: https://www.npmjs.com/package/@fugood/whisper.node (repo https://github.com/mybigday/whisper.node)
- `whisper-cpp-node`: https://www.npmjs.com/package/whisper-cpp-node
- `smart-whisper`: https://www.npmjs.com/package/smart-whisper · `nodejs-whisper`: https://www.npmjs.com/package/nodejs-whisper · `@kutalia/whisper-node-addon`: https://www.npmjs.com/package/@kutalia/whisper-node-addon · `whisper-node`: https://www.npmjs.com/package/whisper-node
- transformers.js: https://www.npmjs.com/package/@huggingface/transformers · https://github.com/huggingface/transformers.js/releases · ONNX Runtime Core ML EP: https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html
- mlx-whisper: https://pypi.org/project/mlx-whisper/ · faster-whisper: https://pypi.org/project/faster-whisper/
- WhisperKit (CLI `serve`): https://github.com/argmaxinc/WhisperKit
- OpenAI Whisper (MIT; prompting): https://github.com/openai/whisper · Whisper prompting guide: https://cookbook.openai.com/examples/whisper_prompting_guide
- WebKit network idle timeout reports (fetch/XHR, 60 s): https://bugs.webkit.org/show_bug.cgi?id=163814 · https://bugs.webkit.org/show_bug.cgi?id=164542
- Fastify content-type parser (pass-through stream, `bodyLimit` only for buffered parsers): https://fastify.dev/docs/latest/Reference/ContentTypeParser/ · server timeouts: https://fastify.dev/docs/latest/Reference/Server/
