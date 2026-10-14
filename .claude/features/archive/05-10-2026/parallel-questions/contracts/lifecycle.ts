/**
 * CONTRACT SPEC (planning artifact) — feature `parallel-questions`. Owner: server.
 * Lifecycle, locking, retention and storage rules of the in-flight question registry.
 * Mostly server-internal; recorded here because clients rely on the timings and guarantees.
 * All timings are constructor options of the server's question service (tests shrink them).
 */

/* ---------------------------------------------------------------------------------------
 * State machine (one entry per QuestionId)
 *
 *   start (202) ─► streaming ──agent done──► [seal attachments] ─► naming ──► [commit] ─► done ─► (expired)
 *                     │                                              │            │
 *                     │ agent error / watchdog                       │ error      └─ commit error ─► failed
 *                     ▼                                              ▼
 *                   failed ◄──────────────────────────────────────────
 *                     │  retry (202) ─► streaming (attempt + 1) ...
 *                     │  DELETE ─► removed{dismissed}
 *                     │  TTL / cap ─► removed{expired | evicted}
 *   streaming|naming ── DELETE before the commit starts ─► removed{cancelled}
 *
 * - "commit starts" = right before `createNode` renames staging into place. From then on the
 *   cancel signal is ignored; DELETE waits for the outcome.
 * - Naming failure or timeout is NOT a failure: the name falls back to one derived from the
 *   question (./naming.ts). The answer is never lost once it is complete.
 * - Client disconnects never change state. Only DELETE, the watchdog or shutdown abort.
 * ------------------------------------------------------------------------------------- */

/** Watchdog: max wall time of one attempt until its commit starts; then `failed{timeout}`. */
export const ATTEMPT_TIMEOUT_MS = 30 * 60 * 1000;
/** Naming call timeout (then fallback name). */
export const NAMING_TIMEOUT_MS = 30 * 1000;

/* ---------------------------------------------------------------------------------------
 * Locking (per-tree readers–writer lock `TreeLocks`, semantics unchanged)
 * - A question holds the tree's SHARED lock from its start request (before reading the chain
 *   and receiving files) through streaming, naming and commit — also after the client
 *   disconnected — and releases it:
 *     done:      after the node and its done payload (attachments, files) were read, BEFORE
 *                the `done` event is emitted;
 *     failed:    after staging is discarded and files are held, BEFORE the `failed` event;
 *     cancelled: after teardown, BEFORE the `removed` event and the DELETE 204.
 * - Failed and done entries hold NO lock (structural ops may change their parent; the
 *   registry remaps or removes them, see below). A retry takes a new shared lock.
 * - Shared acquisitions carry a holder id (the question id) so a structural 409 can list the
 *   blockers (`TreeBusyDetails`). No cap, no queue (non-goals); `acquire*` stays the seam.
 * ------------------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------------------
 * Retention (DECISION, open question "retention policy")
 * - Cancelled: removed immediately.
 * - Done: the answer text is dropped at commit (`node.md` has it; `live` becomes null). The
 *   summary (meta, `nodeId`, `attachments`, `files`) is kept DONE_TTL_MS so reloading /
 *   reconnecting clients can still follow a focused question to its node, then
 *   `removed{expired, nodeId}`. At most DONE_CAP_PER_TREE done entries per tree (oldest
 *   removed first, reason `expired`). Clients cannot delete done entries.
 * - Failed: kept until DELETE (dismiss) or retry; at most FAILED_TTL_MS
 *   (`removed{expired}`); at most FAILED_CAP_PER_TREE per tree (oldest `removed{evicted}`).
 *   Removal of a failed entry deletes its held files.
 * - All timers are `unref()`'d. Memory is bounded by the caps; running entries are bounded
 *   by the user (no cap — non-goal).
 * ------------------------------------------------------------------------------------- */

export const DONE_TTL_MS = 30 * 60 * 1000;
export const DONE_CAP_PER_TREE = 50;
export const FAILED_TTL_MS = 24 * 60 * 60 * 1000;
export const FAILED_CAP_PER_TREE = 50;

/* ---------------------------------------------------------------------------------------
 * Structural ops vs retained entries (running entries cannot be affected: they hold the lock)
 * - move  (`moved` map) / node rename (`{ [id]: newId }`): prefix remap of `parentId`,
 *   `context.anchor` and done `nodeId`: `x === old || x.startsWith(old + '/')` →
 *   `new + x.slice(old.length)` (same rule as the web undo stack). Then, if a side anchor is no
 *   longer the parent or one of its ancestors, `anchor = parentId`. Changed entries emit
 *   `question`.
 * - delete (`deleted` keys): entries whose `parentId` (or done `nodeId`) is the same as or
 *   inside a deleted id are removed with `removed{deleted}` (held files deleted). Restore does
 *   not bring them back.
 * - tree title rename (old id → new id): `tree` rewritten on every entry of the old id; each
 *   emits `question`.
 * These run inside the exclusive lock of the structural op, after it succeeded.
 * ------------------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------------------
 * Files of failed questions (DECISION: research F2, "holding folder outside trees/")
 * - On failure: staging is sealed, partial `attachments/` dropped, `files/` MOVED to
 *   `<heldRoot>/<questionId>/files` (on EXDEV: copy + remove), staging discarded. Nothing of a
 *   failed question remains under `trees/` (NFR "nothing written on failure").
 * - `heldRoot` default: `mkdtemp(os.tmpdir() + '/' + HELD_DIR_PREFIX)` per process, created
 *   lazily, removed on server close. Injectable (tests).
 * - On retry: a new staging folder is created under the CURRENT parent and the held `files/`
 *   are moved back in; prompt lines are rebuilt from the staged folder.
 * - On dismiss/expire/evict/delete: the held folder is removed.
 * - On startup (production entry point only): `HELD_DIR_PREFIX*` folders in `os.tmpdir()`
 *   older than HELD_SWEEP_AGE_MS are removed (orphans of a crashed process).
 * - Uploads that fail validation never create an entry and never reach the holding folder.
 * ------------------------------------------------------------------------------------- */

export const HELD_DIR_PREFIX = 'otago-held-';
export const HELD_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

/* ---------------------------------------------------------------------------------------
 * Agent isolation between parallel answers (risk "cross-question leakage")
 * - The PreToolUse guard (today: soft-deleted folders) is extended: a Read/Grep/Glob whose
 *   path-like input (`file_path`, `path`, `glob`, and `pattern` except for Grep — same keys as the
 *   trash guard) contains a path
 *   segment starting with `.tmp-` OTHER than this answer's own staging folder name is denied
 *   ("Other answers in progress are not available"). The own staging folder stays readable
 *   (its `files/` are the current message's files).
 * - System rules gain: "Folders whose name starts with `.tmp-` are other answers being
 *   written; ignore them, except the files listed for the current question."
 * - Residual risk (as for trash): an unscoped Grep/Glob over the whole tree may still list
 *   matches inside another `.tmp-answer-*` folder if the tool traverses hidden folders.
 * ------------------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------------------
 * Shutdown
 * - `preClose`: every SSE subscriber response is ended (otherwise `server.close()` hangs).
 * - `onClose`: running attempts are aborted (reason "shutdown", no events), their staging is
 *   discarded and locks released; timers cleared; the owned held root removed.
 * - Production entry point: SIGINT/SIGTERM → `app.close()` (force exit after 10 s).
 * Registry content is lost on restart (non-goal); stale staging folders are swept by the
 * existing 1-hour `sweepStaleStaging`.
 * ------------------------------------------------------------------------------------- */
export type LifecycleRules = never;
