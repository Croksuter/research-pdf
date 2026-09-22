import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDebugFlowForTest,
  DEBUG_LOGGING_STORAGE_KEY,
  debugError,
  debugLog,
  debugWarn,
  getDebugFlowForTest,
  initDebugLogging,
  isDebugLoggingEnabled,
  redactForDebugLog,
  serializeErrorForDebugLog,
  setDebugLoggingEnabledForTest,
} from '../src/shared/debugLog';

// The console line carries an ISO timestamp bracket the tests cannot predict, so
// match the fixed prefix/suffix around it. e.g. [ResearchPDF][bg][2026-…Z] started
function loggedLine(scope: string, message: string): RegExp {
  return new RegExp(`^\\[ResearchPDF\\]\\[${scope}\\]\\[\\d{4}-\\d{2}-\\d{2}T[^\\]]+\\] ${message}$`);
}

// Flush pending microtasks so the storage.local.get().then() cache update runs.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type StorageListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

describe('debugLog', () => {
  beforeEach(() => {
    setDebugLoggingEnabledForTest(false);
    clearDebugFlowForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('is a no-op when logging is disabled', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    debugLog('scope', 'hello', { a: 1 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('logs scope/message with payload when enabled and omits payload when undefined', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setDebugLoggingEnabledForTest(true);

    debugLog('bg', 'started', { count: 3 });
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(loggedLine('bg', 'started')), { count: 3 });

    spy.mockClear();
    debugLog('bg', 'no payload');
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(loggedLine('bg', 'no payload')));
    // payload arg must be omitted entirely, not passed as undefined.
    expect(spy.mock.calls[0]).toHaveLength(1);
  });

  it('invokes a thunk payload only when enabled, once, and logs its return value', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const thunk = vi.fn(() => ({ heavy: true }));

    debugLog('scope', 'msg', thunk);
    expect(thunk).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();

    setDebugLoggingEnabledForTest(true);
    debugLog('scope', 'msg', thunk);
    expect(thunk).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(loggedLine('scope', 'msg')), { heavy: true });
  });

  it('initDebugLogging is a safe no-op when chrome is unavailable', () => {
    expect(() => initDebugLogging()).not.toThrow();
    expect(isDebugLoggingEnabled()).toBe(false);
  });

  it('reads the initial value from storage.local and flips the flag live via onChanged', async () => {
    let captured: StorageListener | null = null;
    const get = vi.fn(() => Promise.resolve({ [DEBUG_LOGGING_STORAGE_KEY]: true }));
    const addListener = vi.fn((listener: StorageListener) => {
      captured = listener;
    });
    vi.stubGlobal('chrome', {
      storage: {
        local: { get },
        onChanged: { addListener },
      },
    });

    // Fresh module instance so the internal init guard starts unset.
    vi.resetModules();
    const mod = await import('../src/shared/debugLog');
    mod.initDebugLogging();

    expect(get).toHaveBeenCalledWith(DEBUG_LOGGING_STORAGE_KEY);
    await flushMicrotasks();
    expect(mod.isDebugLoggingEnabled()).toBe(true);

    expect(captured).toBeTypeOf('function');
    captured!({ [DEBUG_LOGGING_STORAGE_KEY]: { newValue: false } }, 'local');
    expect(mod.isDebugLoggingEnabled()).toBe(false);
  });

  it('does not double-subscribe when initDebugLogging is called twice', async () => {
    const get = vi.fn(() => Promise.resolve({}));
    const addListener = vi.fn();
    vi.stubGlobal('chrome', {
      storage: {
        local: { get },
        onChanged: { addListener },
      },
    });

    vi.resetModules();
    const mod = await import('../src/shared/debugLog');
    mod.initDebugLogging();
    mod.initDebugLogging();

    expect(addListener).toHaveBeenCalledTimes(1);
  });
});

describe('debug levels + flow buffer', () => {
  beforeEach(() => {
    setDebugLoggingEnabledForTest(false);
    clearDebugFlowForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('debugWarn emits via console.warn and debugError via console.error', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setDebugLoggingEnabledForTest(true);

    debugWarn('w', 'warned', { a: 1 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(loggedLine('w', 'warned'));
    expect(warnSpy.mock.calls[0][1]).toMatchObject({ level: 'warn', scope: 'w', message: 'warned', payload: { a: 1 } });

    debugError('e', 'errored');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(loggedLine('e', 'errored'));
    expect(errorSpy.mock.calls[0][1]).toMatchObject({ level: 'error', scope: 'e', message: 'errored' });
  });

  it('debugWarn/debugError are no-ops and never invoke thunks when disabled', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnThunk = vi.fn(() => ({ heavy: true }));
    const errorThunk = vi.fn(() => ({ heavy: true }));

    debugWarn('w', 'nope', warnThunk);
    debugError('e', 'nope', errorThunk);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnThunk).not.toHaveBeenCalled();
    expect(errorThunk).not.toHaveBeenCalled();
    expect(getDebugFlowForTest()).toHaveLength(0);
  });

  it('attaches ts/level/scope/message/payload/stack and the prior flow (in order) to the report', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    setDebugLoggingEnabledForTest(true);

    debugLog('a', 'first', { n: 1 });
    debugLog('b', 'second', { n: 2 });
    debugError('c', 'boom', { detail: 'x' });

    const report = errorSpy.mock.calls[0][1];
    expect(report).toMatchObject({ level: 'error', scope: 'c', message: 'boom', payload: { detail: 'x' } });
    expect(typeof report.ts).toBe('string');
    expect(typeof report.stack).toBe('string');
    // flow is snapshotted BEFORE the current error event, so it holds only the two info events.
    expect(report.flow).toHaveLength(2);
    expect(report.flow[0]).toMatchObject({ level: 'info', scope: 'a', message: 'first', payload: { n: 1 } });
    expect(report.flow[1]).toMatchObject({ level: 'info', scope: 'b', message: 'second', payload: { n: 2 } });
  });

  it('caps the flow buffer at 50 entries and drops the oldest', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    setDebugLoggingEnabledForTest(true);

    for (let i = 0; i < 55; i += 1) debugLog('loop', `event ${i}`, { i });

    const flow = getDebugFlowForTest();
    expect(flow).toHaveLength(50);
    // events 0..4 were evicted; oldest surviving is event 5, newest event 54.
    expect(flow[0]).toMatchObject({ message: 'event 5' });
    expect(flow[49]).toMatchObject({ message: 'event 54' });
  });

  it('clearDebugFlowForTest empties the buffer', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    setDebugLoggingEnabledForTest(true);

    debugLog('x', 'one');
    debugLog('x', 'two');
    expect(getDebugFlowForTest()).toHaveLength(2);

    clearDebugFlowForTest();
    expect(getDebugFlowForTest()).toHaveLength(0);
  });
});

describe('redactForDebugLog', () => {
  it('masks password and apiKey keys at any depth while leaving other fields intact', () => {
    const input = {
      username: 'alice',
      password: 'hunter2',
      nested: { apiKey: 'sk-123', label: 'keep', deeper: { secret: 'x', token: 'y', ok: 1 } },
    };
    expect(redactForDebugLog(input)).toEqual({
      username: 'alice',
      password: '[redacted]',
      nested: { apiKey: '[redacted]', label: 'keep', deeper: { secret: '[redacted]', token: '[redacted]', ok: 1 } },
    });
  });

  it('redacts matching keys inside arrays and passes non-plain values through unchanged', () => {
    const when = new Date(0);
    const input = { items: [{ token: 'a', keep: 'b' }], when };
    const output = redactForDebugLog(input) as { items: Array<Record<string, unknown>>; when: unknown };
    expect(output.items[0]).toEqual({ token: '[redacted]', keep: 'b' });
    // A non-plain value (Date) is neither deep-copied nor redacted; it passes through by reference.
    expect(output.when).toBe(when);
  });

  it('does not mutate the input object', () => {
    const input = { password: 'secret-value', nested: { apiKey: 'k' } };
    const snapshot = JSON.stringify(input);
    redactForDebugLog(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('serializeErrorForDebugLog', () => {
  it('captures name/message/stack for a plain Error without a details field', () => {
    const result = serializeErrorForDebugLog(new Error('plain fail'));
    expect(result.name).toBe('Error');
    expect(result.message).toBe('plain fail');
    expect(typeof result.stack).toBe('string');
    expect(result).not.toHaveProperty('details');
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('code');
  });

  it('includes SDK-style status/code properties when present on the error', () => {
    const error = Object.assign(new Error('boom'), { status: 400, code: 'INVALID_ARGUMENT' });
    const result = serializeErrorForDebugLog(error);
    expect(result).toMatchObject({
      name: 'Error',
      message: 'boom',
      status: 400,
      code: 'INVALID_ARGUMENT',
    });
  });

  it('unwraps a double-encoded ApiError message so details reaches the real API error', () => {
    const apiError = {
      error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' },
    };
    // The SDK double-encodes: Error.message is JSON whose { error: { message } }
    // inner message is ITSELF a JSON string of the actual API error.
    const doubleEncoded = JSON.stringify({
      error: { message: JSON.stringify(apiError), code: 400, status: '' },
    });
    const result = serializeErrorForDebugLog(new Error(doubleEncoded));
    expect(result.message).toBe(doubleEncoded);
    expect(result.details).toEqual(apiError);
  });

  it('collapses a non-Error input to a stringified message', () => {
    expect(serializeErrorForDebugLog('kaput')).toEqual({ message: 'kaput' });
    expect(serializeErrorForDebugLog(42)).toEqual({ message: '42' });
    expect(serializeErrorForDebugLog(null)).toEqual({ message: 'null' });
  });

  it('never throws and omits details when the message is not JSON', () => {
    let result: Record<string, unknown> = {};
    expect(() => { result = serializeErrorForDebugLog(new Error('{ not json')); }).not.toThrow();
    expect(result.message).toBe('{ not json');
    expect(result).not.toHaveProperty('details');
  });
});
