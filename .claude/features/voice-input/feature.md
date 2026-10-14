# Voice input (dictation into the composer)

## Summary
Let the user dictate a message instead of typing it. A microphone button in every chat composer records speech in the browser; the local Otago server transcribes it with a locally running Whisper model and the text is inserted into the draft. Nothing leaves the machine. The user reviews/edits the text and sends it as usual.

## Goals
- Dictate into the main chat composer and the side chat composer.
- Fully local speech-to-text (Whisper on the server); no cloud STT, no audio sent to third parties.
- Good quality on Russian, English and mixed ru+en technical speech.
- Toggle control: mic button + keyboard shortcut (start / stop).
- Recognition language defaults to the UI language (`en`/`ru`, `web/src/i18n/language.ts`), with a small per-user switcher next to the mic (incl. "auto-detect"); the choice is remembered.
- Feature is optional: if Whisper is not available/configured on the server, the mic is hidden and the app works exactly as before.
- Demo (`demo/`) shows the full UI flow with a fake transcription.

## Non-goals
- Live/streaming partial transcripts while speaking (text appears after recording stops).
- Saving the audio recording into the node (`files/`) or anywhere under `trees/`.
- Voice commands ("send", "new branch"), auto-send after dictation.
- Text-to-speech of answers.
- Cloud STT providers, browser Web Speech API.
- Push-to-talk (hold to record).

## Actors
- **User** — dictates into a composer in the web UI (single local user, same machine as the server).
- **Web client** (`@otago/web`) — captures microphone audio, sends it for transcription, inserts the text.
- **Server** (`@otago/server`) — exposes transcription capability + endpoint, runs local Whisper.
- **Demo mock** (`@otago/demo`) — mimics the server contract in the browser.

## Main scenarios
1. **Dictate a question.** User clicks the mic (or presses the shortcut while the composer is focused) → browser asks for mic permission the first time → recording indicator (pulsing mic, elapsed time) → user clicks again / presses the shortcut → "transcribing…" state → recognized text is inserted at the caret (with a separating space if needed) → caret placed after it → user edits and sends normally. No auto-send.
2. **Switch language.** User picks `RU` / `EN` / `Auto` in the switcher next to the mic; the choice persists (localStorage) and is used for the next recordings.
3. **Cancel a recording.** `Esc` while recording discards the audio; nothing is sent to the server, draft unchanged.
4. **Server without Whisper.** Capability check says voice is unavailable → no mic button, no shortcut.
5. **Demo.** Recording works for real (mic permission), the mock "transcribes" to Lorem ipsum after a short delay, same UI states as the real app.

## Edge cases
- **Mic permission denied / no input device / insecure context** → recording does not start; inline notice in the composer explaining why (via `lib/notices.ts` style); mic stays usable for retry.
- **Browser without `getUserMedia`/MediaRecorder** → mic hidden (or disabled with tooltip — decide in plan).
- **Empty/silent recording or empty transcript** → nothing inserted, short notice "nothing recognized".
- **Transcription fails** (Whisper crash, timeout, server down, 5xx) → notice with error; the recorded audio is kept in memory so the user can retry transcription once without re-recording; draft untouched.
- **Composer locked** (a question in flight, textarea disabled) → mic disabled; a recording started before the lock still completes and its text is inserted into the draft (draft survives, `lib/draft-stash.ts`).
- **Only one recording at a time per tab**: starting in one panel (main vs side) while the other records stops/blocks the first (decide in plan; must be explicit).
- **Panel unmount / tree or node navigation during recording or transcription** → recording stops; transcript (if it arrives) lands in the draft of the composer it was started in (drafts survive remounts via `draft-stash`), or is dropped if that draft target no longer exists.
- **User keeps typing while transcription runs** → insertion happens at the current caret at arrival time, not at the stop position; must not overwrite typed text.
- **Tab hidden / mic unplugged mid-recording** → recording ends; what was captured goes to transcription.
- **No length cap** (product decision): long recordings (tens of minutes) must still work — upload size limits, request timeout and server memory must accommodate them (see Constraints). UI shows elapsed time so the user sees how long it is.
- **Concurrent transcriptions** (several tabs) → server must not run unbounded parallel Whisper processes; queue/serialize or reject with a clear error code (decide in plan).
- **Server restarts mid-transcription** → client gets a network error → same as "transcription fails".

## Constraints (NFR)
- **Local only**: audio and text never leave the machine. Audio is held in memory / OS temp dir only for the request and deleted afterwards; never written under `trees/` (consistent with `storage/` being the only layer touching `trees/`).
- **No length cap**: endpoint must accept large payloads (1 h of 16 kHz mono 16-bit WAV ≈ 115 MB); prefer a compact upload format and/or streaming upload so memory stays bounded. Fastify multipart/body limits for this route are set separately from `MAX_SOURCE_BYTES` / `MAX_MESSAGE_FILE_BYTES`.
- **Latency**: short dictations (≤ 30 s) should come back within a few seconds on Apple Silicon.
- **Optional dependency**: the server must start and pass all tests without Whisper installed. Tests use a fake transcriber (like `fakeAgent()`); no real Whisper in tests.
- **Config** via `server/.env` `OTAGO_*` variables (passed through by Turbo); exact variables decided in research/plan.
- **Contract**: server owns it. Web and demo mock follow it; the demo shim must export everything the real `api/client.ts` exports (`exportsComplete`).
- **UI**: i18n (`en`/`ru`) for all new strings; accessible button (`aria-pressed`, label changes with state); shortcut handled through `lib/keyboard.ts` rules and must not collide with existing ones (Ctrl+Z undo, Enter send).
- **Browser**: Chrome and Safari on macOS at minimum; `127.0.0.1` counts as a secure context for `getUserMedia`.

## Future considerations (out of scope, design must allow)
- **Streaming transcription**: partial text while speaking. Keep the transcriber behind an interface on the server and the client "voice session" state machine able to receive incremental text later (e.g. an SSE/WebSocket variant of the same endpoint) without rewriting the composer integration.
- **Save the audio into the node**: keep the recorded audio as a `Blob`/`File` on the client until insertion so it could later be attached via the existing message-files path (`files/`); the transcription API should not assume the audio is thrown away by design.

## Open questions
- How Whisper is installed and run (external `whisper.cpp` binary + model path in `.env`, Node native bindings with auto-download, other) → **decide in `/feature:research server`**.
- ~~Model size default~~ **Decided:** `large-v3-turbo` (ggml q8_0, 874 MB) is the only model; smaller ones are too weak on ru+en mixed speech. Russian speech with English terms is handled via `-l ru` + an initial prompt (Russian text with Latin-script tech terms), configurable via `.env`.
- Audio format the browser uploads (WAV 16 kHz encoded client-side vs. webm/opus/mp4 + server-side conversion, which may need ffmpeg).
- Keyboard shortcut choice.
- Unsupported browser: hide mic vs. disabled with tooltip.
- Second panel starts recording while the first records: stop the first or refuse.
- Concurrent transcriptions on the server: queue vs. 409.
