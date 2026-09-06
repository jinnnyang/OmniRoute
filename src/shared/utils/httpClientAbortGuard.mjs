"use strict";

/**
 * HTTP client-abort crash guard (#fix-dev-server-aborted).
 *
 * Node's http.Server turns an 'error' event on an IncomingMessage/ServerResponse
 * into an uncaughtException (and therefore a process exit) WHENEVER the emitter
 * has no listener. The single most common such error is a *client* abort: the
 * browser closes the TCP socket (navigation, Back/Forward cache, HMR reconnect,
 * cancelling a fetch) while the server is still streaming the response. Node
 * emits `Error: aborted` / `ERR_STREAM_PREMATURE_CLOSE` / `ECONNRESET` on the
 * request stream, and absent a handler it kills the whole server process.
 *
 * That surfaced as "login succeeds, then the dashboard hangs with a wall of
 * `net::ERR_CONNECTION_REFUSED`": after auth the SPA opens many polling
 * connections + a live WebSocket; stray client-side socket closes during
 * navigation/HMR were taking the dev server down.
 *
 * Two layers:
 *   1. `attachRequestStreamGuards(req, res)` — per-request listeners that absorb
 *      client-abort errors so they never bubble to the process level. Call it
 *      inside every `http.createServer((req, res) => …)` request listener.
 *   2. `installProcessCrashGuard()` — a last-resort safety net on
 *      `process.on('uncaughtException' | 'unhandledRejection')` that swallows
 *      the same benign client-abort errors but otherwise preserves the existing
 *      crash semantics (so genuine bugs still surface). Idempotent.
 *
 * Kept as a `.mjs` module (no build step) so it is importable both from the
 * Node-only dev server (`scripts/dev/run-next.mjs`) and from the TypeScript
 * servers under `src/` (tsconfig `allowJs: true`).
 *
 * @module
 */

/**
 * @param {unknown} err
 * @returns {boolean} true when `err` represents a client closing the
 *   connection rather than a server-side fault.
 */
export function isClientAbortError(err) {
  if (!err || typeof err !== "object") return false;
  const e = /** @type {NodeJS.ErrnoException} */ (err);
  // Node emits `Error: aborted` (no code) from http.Server#abortIncoming.
  if (e.message === "aborted" || e.message === "Aborted") return true;
  // Node wraps a non-Error abort() reason as `Error [AbortError]: <reason>`
  // (see rateLimitManager's onAbort construction). An AbortError is the loser
  // of an abort race — a coordination signal, benign unless its cause chains
  // down to a genuine error.
  if (e.name === "AbortError") {
    const abortCause = /** @type {{ cause?: unknown }} */ (err).cause;
    if (abortCause == null || typeof abortCause === "string") return true;
    return isClientAbortError(abortCause);
  }
  // Internal abort-coordination reasons propagate as plain string causes
  // (e.g. combo hedge cancellation — open-sse/services/combo/comboAbortReasons.ts).
  // Literals kept inline: this module is dependency-free by design.
  const cause = /** @type {{ cause?: unknown }} */ (err).cause;
  if (
    typeof cause === "string" &&
    (cause === "hedge-cancelled" ||
      cause === "combo-per-model-timeout" ||
      cause === "client_closed" ||
      cause === "cancelled")
  ) {
    return true;
  }
  switch (e.code) {
    case "ERR_STREAM_PREMATURE_CLOSE":
    case "ECONNRESET":
    case "EPIPE":
    case "ECONNABORTED":
    case "ETIMEDOUT":
    case "ENOTCONN":
    case "ECANCELED":
      return true;
    default:
      return false;
  }
}

/**
 * Recognise an OmniRoute-generated *local rate-limit* failure.
 *
 * Incident 2026-09-05 (production, new server): the omniroute container was
 * killed 6 times in 9 minutes by an uncaughtException whose message was
 *   "Request exceeded OmniRoute's local rate-limit execution expiration
 *    (legacy resilienceSettings.requestQueue.maxWaitMs=15000ms) for ..."
 * with `code: 'RATE_LIMIT_EXECUTION_TIMEOUT', status: 504` and a `[cause]` of
 * Bottleneck's `This job timed out after 15000 ms.`
 *
 * Mechanism: Bottleneck's per-job `expiration` timer fires inside a bare
 * `setTimeout` (Job#doExpire -> _onFailure -> `this._reject(error)`), so the
 * rejection lands on the `limiter.schedule()` promise. `withRateLimit` catches
 * that BottleneckError and rethrows it branded with the code above. When the
 * awaiting caller has ALREADY walked away — combo hedge cancellation, a
 * per-target timeout, or the client closing the stream — nobody is left to
 * await that promise, so Node raises it as an unhandledRejection and the crash
 * guard rethrew it, taking the whole process down.
 *
 * These are *business outcomes*, not server faults: the request rightly fails
 * with HTTP 504 and the caller (or combo fallback) handles it. An orphaned copy
 * of that same outcome must never kill the process. Raising the configured
 * maxWaitMs only lowers the frequency; it cannot remove the race — which is why
 * this is fixed here rather than in configuration.
 *
 * Deliberately narrow: matched on the branded `code` **plus** corroborating
 * evidence (the stamped 504/429/503 status, or the Bottleneck expiry `cause`),
 * so an arbitrary upstream error that merely borrows the string cannot silence
 * a genuine crash.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isLocalRateLimitTimeoutError(err) {
  if (!err || typeof err !== "object") return false;
  const e = /** @type {{ code?: unknown; status?: unknown; cause?: unknown }} */ (err);
  if (e.code !== "RATE_LIMIT_EXECUTION_TIMEOUT") return false;
  // Corroboration #1: the status markLocalRateLimitError() stamps alongside it.
  if (e.status === 504 || e.status === 429 || e.status === 503) return true;
  // Corroboration #2: the Bottleneck expiry error preserved as `cause`.
  const cause = e.cause;
  if (cause && typeof cause === "object") {
    const message = /** @type {{ message?: unknown }} */ (cause).message;
    if (typeof message === "string" && /^This job timed out after \d+ ms\.$/.test(message)) {
      return true;
    }
  }
  return false;
}
/**
 * Decide whether a process-level uncaughtException/unhandledRejection should be
 * swallowed (benign client-abort) or allowed to surface (genuine bug).
 *
 * Pure + exported so it can be unit-tested without poking process listeners.
 *
 * @param {unknown} err
 * @param {string | undefined} origin  Node's uncaughtException origin (e.g.
 *   "uncaughtException" / "unhandledRejection"); absent/empty for rejections.
 * @returns {boolean} true => swallow (log only), false => re-throw / let crash.
 */
export function shouldSwallowUncaught(err, origin) {
  // Benign client aborts AND OmniRoute's own local rate-limit expiry (a 504
  // business outcome whose awaiting caller may already be gone — see
  // isLocalRateLimitTimeoutError for the incident that required this).
  if (!isClientAbortError(err) && !isLocalRateLimitTimeoutError(err)) return false;
  // Only swallow when the origin matches what the guard installed for. If some
  // other subsystem raised it (e.g. a deliberate `throw` in a domain), keep the
  // existing crash semantics.
  return !origin || origin === "uncaughtException" || origin === "unhandledRejection";
}

/**
 * Attach `error` listeners to a request/response pair that swallow client-abort
 * errors. Idempotent per (req, res) pair via a Symbol flag.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
export function attachRequestStreamGuards(req, res) {
  const flag = Symbol.for("omniroute.requestAbortGuard");
  if (req[flag] || res[flag]) return;
  req[flag] = true;
  res[flag] = true;

  req.on("error", (err) => {
    if (!isClientAbortError(err)) {
      // Re-emit a genuine request error through the normal channel so it is
      // still observable in logs, but never as an uncaughtException.
      console.error("[server] request stream error:", err);
    }
  });

  res.on("error", (err) => {
    if (!isClientAbortError(err)) {
      console.error("[server] response stream error:", err);
    }
  });
}

let crashGuardInstalled = false;

/**
 * Install process-level safety nets. Idempotent. Benign client-abort errors are
 * logged once and swallowed; everything else is re-thrown on a fresh stack so
 * the process keeps its current crash semantics (genuine bugs still crash/hang
 * loudly, and a supervisor or test harness sees them).
 *
 * @param {(level: "warn" | "error", ...args: unknown[]) => void} [log]
 */
export function installProcessCrashGuard(log) {
  if (crashGuardInstalled) return;
  crashGuardInstalled = true;

  const logger = log ?? console;

  process.on("uncaughtException", (err, origin) => {
    if (shouldSwallowUncaught(err, origin)) {
      logger("warn", "[server] swallowed client-abort uncaughtException:", err?.message ?? err);
      return;
    }
    throw err;
  });

  process.on("unhandledRejection", (reason) => {
    if (shouldSwallowUncaught(reason, "unhandledRejection")) {
      logger(
        "warn",
        "[server] swallowed client-abort unhandledRejection:",
        reason?.message ?? reason
      );
      return;
    }
    throw reason;
  });
}
