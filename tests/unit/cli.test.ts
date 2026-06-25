/**
 * CLI unit tests — Phase 6.
 *
 * Strategy: mock ModelRegistry, HostSessionPool, and the SessionClient
 * returned by acquire(). Drive readline via queued answers. Each test is
 * designed to terminate naturally by having getModels() return [] on the
 * second call (or by having the conversation loop return an action that
 * loops back to an empty model list).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { HostBusyError, HostNotFoundError, InvalidTokenError } from '@sharegrid/shared/errors';
import type { HostListEntry } from '@sharegrid/shared/protocol';

// ── Mock node:readline ────────────────────────────────────────────────────────

type QuestionCallback = (answer: string) => void;

const { mockRl } = vi.hoisted(() => ({
  mockRl: {
    question: vi.fn() as (q: string, cb: QuestionCallback) => void,
    close: vi.fn(),
    on: vi.fn(),
    terminal: true,
  },
}));

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => mockRl),
}));

import { createCli } from '../../src/cli.js';

// ─────────────────────────────────────────────────────────────────────────────

const logger = pino({ level: 'silent' });

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeModels(ids = ['model-0', 'model-1']) {
  return ids.map((id) => ({
    id,
    object: 'model' as const,
    owned_by: 'sharegrid',
    context_length: 4096,
    sharegrid_available_slots: 1,
    sharegrid_total_slots: 1,
  }));
}

function makeHosts(ids = ['model-0', 'model-1']) {
  return ids.map((id, i) => ({
    hostId: `host-${i}`,
    modelName: id,
    endpoint: `10.0.0.${i}:9000`,
    tlsFingerprint: 'sha256:' + 'a'.repeat(64),
    hostKeyToken: `tok-${i}`,
    contextSize: 4096,
    availableSlots: 1,
    totalSlots: 1,
  }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Drive readline questions from a queue. When exhausted, always returns the
 * last queued answer so that re-prompts resolve predictably.
 */
function queueAnswers(answers: string[]) {
  let idx = 0;
  (mockRl.question as ReturnType<typeof vi.fn>).mockImplementation((_q: string, cb: QuestionCallback) => {
    const answer = answers[idx] ?? answers[answers.length - 1] ?? '';
    idx++;
    setTimeout(() => cb(answer), 0);
  });
}

/**
 * A ModelRegistry that returns `models` on the first call and [] on subsequent
 * calls, so the outer run() loop terminates naturally.
 */
function makeModelRegistry(models = makeModels(), hosts = makeHosts()) {
  let calls = 0;
  const resolveHost = vi.fn().mockImplementation((id: string) => {
    const host = hosts.find((h) => h.modelName === id);
    if (!host) return Promise.reject(new HostNotFoundError(`no host for '${id}'`));
    return Promise.resolve(host);
  });
  return {
    getModels: vi.fn().mockImplementation(() =>
      Promise.resolve(calls++ === 0 ? models : []),
    ),
    resolveHost,
    resolveHosts: vi.fn().mockImplementation(async (id: string): Promise<HostListEntry[]> => [await resolveHost(id)]),
    invalidate: vi.fn(),
  };
}

/** A mock SessionClient returned by acquire(). */
function makeMockSession(opts: {
  sendResult?: Error | 'resolve';
} = {}) {
  return {
    openSession: vi.fn().mockResolvedValue(undefined),
    sendInferenceRequest: vi.fn().mockImplementation(
      (_body: string, _onChunk: unknown, _signal: AbortSignal): Promise<void> => {
        if (opts.sendResult instanceof Error) return Promise.reject(opts.sendResult);
        return Promise.resolve();
      },
    ),
    abort: vi.fn(),
    isAlive: vi.fn().mockReturnValue(true),
    closeSession: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * A HostSessionPool where acquire() returns a controllable mock session.
 * `acquireError` makes the first acquire() reject.
 */
function makeSessionPool(opts: {
  acquireError?: Error;
  session?: ReturnType<typeof makeMockSession>;
} = {}) {
  const session = opts.session ?? makeMockSession();
  let acquireCount = 0;
  return {
    acquire: vi.fn().mockImplementation(() => {
      acquireCount++;
      if (opts.acquireError && acquireCount === 1) return Promise.reject(opts.acquireError);
      return Promise.resolve(session);
    }),
    closeAll: vi.fn().mockResolvedValue(undefined),
    _session: session,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('CLI', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.clearAllMocks();
    process.removeAllListeners('SIGINT');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Empty model list ────────────────────────────────────────────────────────

  it('prints a clear message and exits when model list is empty', async () => {
    const registry = { getModels: vi.fn().mockResolvedValue([]), resolveHost: vi.fn(), resolveHosts: vi.fn(), invalidate: vi.fn() };
    const pool = makeSessionPool();
    queueAnswers([]);

    await createCli({ modelRegistry: registry, sessionPool: pool, logger }).run();

    expect(stdoutOutput.toLowerCase()).toContain('no hosts');
  });

  // ── Model list rendering ────────────────────────────────────────────────────

  it('renders all models with correct 1-based numbering', async () => {
    const registry = makeModelRegistry(makeModels(['alpha', 'beta', 'gamma']));
    // HostBusyError on first acquire → 'reselect' → getModels() → [] → exit
    const pool = makeSessionPool({ acquireError: new HostBusyError() });
    queueAnswers(['1', '1']); // select model twice

    await createCli({ modelRegistry: registry, sessionPool: pool, logger }).run();

    expect(stdoutOutput).toContain('[1]');
    expect(stdoutOutput).toContain('[2]');
    expect(stdoutOutput).toContain('[3]');
    expect(stdoutOutput).toContain('alpha');
    expect(stdoutOutput).toContain('beta');
    expect(stdoutOutput).toContain('gamma');
  });

  // ── Session open errors ─────────────────────────────────────────────────────

  it('host busy: informs user and returns to model list', async () => {
    const registry = makeModelRegistry();
    const pool = makeSessionPool({ acquireError: new HostBusyError() });
    queueAnswers(['1', '1']);

    await createCli({ modelRegistry: registry, sessionPool: pool, logger }).run();

    expect(stdoutOutput.toLowerCase()).toContain('busy');
  });

  it('invalid token: re-fetches model list', async () => {
    const registry = makeModelRegistry();
    const pool = makeSessionPool({ acquireError: new InvalidTokenError() });
    queueAnswers(['1', '1']);

    await createCli({ modelRegistry: registry, sessionPool: pool, logger }).run();

    // getModels called twice: initial + after refetch action
    expect(registry.getModels).toHaveBeenCalledTimes(2);
  });

  // ── SSE content display ─────────────────────────────────────────────────────

  it('delta.content chunks from SSE lines are written to stdout', async () => {
    const session = makeMockSession();
    session.sendInferenceRequest.mockImplementation(
      (_body: string, onChunk: (line: string) => void) => {
        onChunk('data: {"choices":[{"delta":{"content":"hello"}}]}');
        onChunk('data: {"choices":[{"delta":{"content":" world"}}]}');
        onChunk('data: [DONE]');
        return Promise.resolve();
      },
    );

    const registry = makeModelRegistry();
    const pool = makeSessionPool({ session });
    // After one turn → sendInferenceRequest resolves → next prompt → acquire
    // throws InvalidTokenError → refetch → [] → exit
    pool.acquire
      .mockResolvedValueOnce(session)
      .mockRejectedValueOnce(new InvalidTokenError());

    queueAnswers(['1', 'hi', '1']);

    await createCli({ modelRegistry: registry, sessionPool: pool, logger }).run();

    expect(stdoutOutput).toContain('hello');
    expect(stdoutOutput).toContain(' world');
  });

  // ── Ctrl+C during generation ────────────────────────────────────────────────

  it('Ctrl+C during generation aborts the controller and prints [stopped]', async () => {
    const session = makeMockSession();
    session.sendInferenceRequest.mockImplementation(
      (_body: string, _onChunk: unknown, signal: AbortSignal): Promise<void> => {
        return new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    );

    const registry = makeModelRegistry();
    const pool = makeSessionPool({ session });

    let inputCallCount = 0;
    (mockRl.question as ReturnType<typeof vi.fn>).mockImplementation(
      (_q: string, cb: QuestionCallback) => {
        inputCallCount++;
        if (inputCallCount === 1) {
          // Model selection
          setTimeout(() => cb('1'), 0);
        } else if (inputCallCount === 2) {
          // First user prompt — after answering, schedule Ctrl+C
          setTimeout(() => {
            cb('hello');
            setTimeout(() => {
              // Queue next acquire to fail so the loop terminates after [stopped]
              pool.acquire.mockRejectedValueOnce(new InvalidTokenError());
              process.emit('SIGINT');
            }, 20);
          }, 0);
        } else {
          // After [stopped] the loop continues; this non-empty answer triggers
          // the queued InvalidTokenError from acquire → 'refetch' → [] → exit
          setTimeout(() => cb('bye'), 0);
        }
      },
    );

    await createCli({ modelRegistry: registry, sessionPool: pool, logger }).run();

    expect(stdoutOutput).toContain('[stopped]');
  }, 10_000);
});
