// Runtime-toggleable verbose logger shared by every bundle (background,
// content, popup, debug). The flag lives in chrome.storage.local rather than
// the IndexedDB settings store: content scripts cannot reach that store, and
// chrome.storage.onChanged is the only channel that pushes toggle changes live
// into every context (service worker, content scripts, extension pages).
//
// Three levels: debugLog (info), debugWarn, debugError. Every call — while the
// flag is on — also records a timestamped event into a bounded flow buffer
// (last FLOW_BUFFER_SIZE events). debugWarn/debugError attach that recent flow,
// a JS stack, and the current href to a single console entry so the whole
// failure context is self-contained and can be handed to an AI agent to debug.
// When the flag is off nothing is recorded and thunks are never invoked.

export const DEBUG_LOGGING_STORAGE_KEY = 'debugLoggingEnabled';

export type DebugLogLevel = 'info' | 'warn' | 'error';

export interface DebugFlowEvent {
  ts: string;
  level: DebugLogLevel;
  scope: string;
  message: string;
  payload?: unknown;
}

// Bounded, oldest-first ring of recent events. Only appended to while enabled,
// so it stays empty (zero cost) when logging is off.
const FLOW_BUFFER_SIZE = 50;
const flowBuffer: DebugFlowEvent[] = [];

function recordFlowEvent(event: DebugFlowEvent): void {
  flowBuffer.push(event);
  if (flowBuffer.length > FLOW_BUFFER_SIZE) flowBuffer.shift();
}

// Cached so debugLog stays a cheap synchronous call on the hot path. Kept in
// sync with storage by the onChanged listener attached in initDebugLogging.
let enabled = false;

// initDebugLogging runs in each bundle and may be reached more than once
// (re-entrant module init); this guard keeps a single storage subscription.
let initialized = false;

/** Reads the flag from chrome.storage.local and subscribes to onChanged.
 *  Safe no-op when chrome or chrome.storage is unavailable (tests, plain pages).
 *  Idempotent — calling twice must not double-subscribe. */
export function initDebugLogging(): void {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  if (initialized) return;
  initialized = true;

  // MV3 supports the promise form of storage.get in all our contexts.
  void chrome.storage.local.get(DEBUG_LOGGING_STORAGE_KEY).then((result) => {
    enabled = result[DEBUG_LOGGING_STORAGE_KEY] === true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && DEBUG_LOGGING_STORAGE_KEY in changes) {
      enabled = changes[DEBUG_LOGGING_STORAGE_KEY].newValue === true;
    }
  });
}

export function isDebugLoggingEnabled(): boolean {
  return enabled;
}

/** Test hook (repo convention: *ForTest). Sets the cached flag directly. */
export function setDebugLoggingEnabledForTest(value: boolean): void {
  enabled = value;
}

/** Test hook (repo convention: *ForTest). Empties the flow buffer. */
export function clearDebugFlowForTest(): void {
  flowBuffer.length = 0;
}

/** Test hook (repo convention: *ForTest). Returns a copy of the flow buffer. */
export function getDebugFlowForTest(): DebugFlowEvent[] {
  return [...flowBuffer];
}

function resolvePayload(payload: unknown): unknown {
  return typeof payload === 'function' ? (payload as () => unknown)() : payload;
}

/** No-op unless enabled. Output: console.log(`[ResearchPDF][${scope}][${ts}] ${message}`, payload)
 *  (payload arg omitted from console.log when undefined). Records the event into
 *  the flow buffer at info level.
 *  payload may be a thunk: when it is a function it is called only while enabled
 *  and its return value logged, so call sites can skip building expensive
 *  payloads when logging is off. */
export function debugLog(scope: string, message: string, payload?: unknown): void {
  if (!enabled) return;
  const ts = new Date().toISOString();
  const resolved = resolvePayload(payload);
  recordFlowEvent({ ts, level: 'info', scope, message, payload: resolved });
  const line = `[ResearchPDF][${scope}][${ts}] ${message}`;
  if (resolved === undefined) {
    console.log(line);
    return;
  }
  console.log(line, resolved);
}

/** Builds the self-contained report for a warn/error entry: the current event
 *  plus a stack, href, and a snapshot of the recent flow (oldest first, taken
 *  BEFORE the current event is appended). The report object is always defined. */
function emitLeveledReport(level: 'warn' | 'error', scope: string, message: string, payload?: unknown): void {
  const ts = new Date().toISOString();
  const resolved = resolvePayload(payload);
  const flow = [...flowBuffer];
  recordFlowEvent({ ts, level, scope, message, payload: resolved });
  const report = {
    ts,
    level,
    scope,
    message,
    payload: resolved,
    stack: new Error().stack,
    href: typeof location !== 'undefined' ? location.href : undefined,
    flow,
  };
  const line = `[ResearchPDF][${scope}][${ts}] ${message}`;
  if (level === 'warn') {
    console.warn(line, report);
  } else {
    console.error(line, report);
  }
}

/** Warn-level counterpart to debugLog. No-op (and never invokes the thunk) unless
 *  enabled. When enabled, emits a single console.warn carrying a self-contained
 *  report { ts, level, scope, message, payload, stack, href, flow }. */
export function debugWarn(scope: string, message: string, payload?: unknown): void {
  if (!enabled) return;
  emitLeveledReport('warn', scope, message, payload);
}

/** Error-level counterpart to debugLog. No-op (and never invokes the thunk) unless
 *  enabled. When enabled, emits a single console.error carrying a self-contained
 *  report { ts, level, scope, message, payload, stack, href, flow }. */
export function debugError(scope: string, message: string, payload?: unknown): void {
  if (!enabled) return;
  emitLeveledReport('error', scope, message, payload);
}

// Depth cap doubles as the cycle guard: a self-referential object stops copying
// once it hits REDACT_MAX_DEPTH instead of recursing forever.
const REDACT_KEY_PATTERN = /password|apikey|secret|token/i;
const REDACT_MAX_DEPTH = 6;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactDeep(value: unknown, depth: number): unknown {
  if (depth >= REDACT_MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, depth + 1));
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = REDACT_KEY_PATTERN.test(key) ? '[redacted]' : redactDeep(entry, depth + 1);
    }
    return output;
  }
  return value;
}

/** Deep-copies plain objects/arrays replacing values whose key matches
 *  /password|apikey|secret|token/i with '[redacted]'. Non-plain values pass through. */
export function redactForDebugLog(value: unknown): unknown {
  return redactDeep(value, 0);
}

/** Turns an unknown thrown value into a plain, log-safe object. Never throws.
 *  Non-Error inputs collapse to `{ message: String(error) }`. Error inputs keep
 *  name/message/stack plus SDK-style `status`/`code` when present. Because the
 *  @google/genai SDK double-encodes its ApiError — Error.message is a JSON
 *  string whose { error: { message } } inner message is ALSO a JSON string —
 *  `message` is unwrapped at most twice so `details` bottoms out at the real API
 *  error object, with the raw `message` string kept alongside it. */
export function serializeErrorForDebugLog(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  const output: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  const status = (error as { status?: unknown }).status;
  if (status !== undefined) output.status = status;
  const code = (error as { code?: unknown }).code;
  if (code !== undefined) output.code = code;
  // Two parse attempts, no more: message -> {error:{message:"<json>"}} ->
  // {error:{code,message,status}}.
  try {
    const parsed: unknown = JSON.parse(error.message);
    output.details = parsed;
    if (isPlainObject(parsed) && isPlainObject(parsed.error) && typeof parsed.error.message === 'string') {
      try {
        output.details = JSON.parse(parsed.error.message);
      } catch {
        // Inner message was not JSON; keep the once-parsed value under details.
      }
    }
  } catch {
    // message is not JSON; omit details entirely.
  }
  return output;
}
