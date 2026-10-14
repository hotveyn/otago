/**
 * CONTRACT SPEC (planning artifact) — feature `voice-input`. Owner: server.
 *
 * Existing shapes this feature builds on, copied for reference from earlier contracts
 * (`parallel-questions`). UNCHANGED by this feature unless a comment says otherwise.
 */

/**
 * JSON error body of every non-2xx JSON response (central error handler in
 * `server/src/app.ts`). `code` / `details` are omitted when absent. Unchanged shape; this
 * feature adds new `code` values (./errors.ts).
 */
export interface ErrorBody {
  /** Human-readable, safe to show. */
  error: string;
  code?: string;
  details?: unknown;
}

/**
 * SSE framing used by the server's `openSse` helper (`server/src/routes/sse.ts`), unchanged and
 * reused by the transcription response:
 *   - first bytes: `retry: <ms>\n\n` — meaningless for a POST (the browser never reconnects a
 *     fetch); clients ignore it,
 *   - every event: `id: <seq>\nevent: <name>\ndata: <JSON on one line>\n\n`; `seq` starts at 1
 *     per response and has no meaning for clients,
 *   - keep-alive comment `: ping\n\n` every SSE_PING_INTERVAL_MS,
 *   - unknown event names MUST be ignored by clients (forward compatibility).
 * Response headers: content-type `text/event-stream; charset=utf-8`, cache-control
 * `no-cache, no-transform`, connection `keep-alive`, x-accel-buffering `no`.
 * The web parses it with the existing `readSse` (`web/src/api/sse.ts`).
 */
export const SSE_RETRY_MS = 2_000;
export const SSE_PING_INTERVAL_MS = 15_000;
