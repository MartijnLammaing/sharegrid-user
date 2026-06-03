/**
 * CLI unit tests.
 *
 * Phase 2 note: the conversation loop (sendInferenceRequest + SSE parsing) is
 * being implemented in user Phase 6. Tests for the inference path, SIGINT
 * during generation, and session timeout handling are written in user Phase 9
 * of the implementation plan once the full CLI is in place.
 *
 * This file contains only tests for behaviour that terminates without entering
 * the conversation loop: host list rendering, empty list handling, and session
 * open errors that cause an immediate reselect/refetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { HostBusyError, InvalidTokenError } from '@sharegrid/shared/errors';

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

const logger = pino({ level: 'silent' });

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHosts(count = 2) {
  return Array.from({ length: count }, (_, i) => ({
    hostId: `host-${i}`,
    modelName: `model-${i}`,
    endpoint: `10.0.0.${i}:9000`,
    tlsFingerprint: 'sha256:' + '0'.repeat(63) + String(i),
    hostKeyToken: `token-${i}`,
  }));
}

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
 * A router client that returns `hosts` on the first call and [] on all
 * subsequent calls, so the CLI terminates naturally after the first refetch.
 */
function makeRouterClient(hosts = makeHosts()) {
  let calls = 0;
  return {
    fetchHostList: vi.fn().mockImplementation(() =>
      Promise.resolve(calls++ === 0 ? hosts : []),
    ),
  };
}

/**
 * A mock SessionClient with the Phase 2 interface.
 * `openSessionResults` controls the sequence of openSession outcomes.
 * When exhausted, openSession rejects with InvalidTokenError which causes
 * the CLI to refetch (and get an empty list → exit).
 */
function makeSessionClient(opts: {
  openSessionResults?: Array<'ok' | Error>;
} = {}) {
  const opens = opts.openSessionResults ?? ['ok'];
  let openIdx = 0;
  let alive = false;

  return {
    openSession: vi.fn().mockImplementation((): Promise<void> => {
      const result = opens[openIdx++] ?? new InvalidTokenError();
      if (result instanceof Error) return Promise.reject(result);
      alive = true;
      return Promise.resolve();
    }),
    sendInferenceRequest: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockImplementation(() => { alive = false; }),
    isAlive: vi.fn().mockImplementation(() => alive),
    closeSession: vi.fn().mockResolvedValue(undefined),
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

  // ── Empty host list ───────────────────────────────────────────────────────

  it('prints a clear message and returns when the host list is empty', async () => {
    const rc = { fetchHostList: vi.fn().mockResolvedValue([]) };
    const sc = makeSessionClient();
    queueAnswers([]);

    await createCli({ routerClient: rc, sessionClient: sc, logger }).run();

    expect(stdoutOutput.toLowerCase()).toContain('no hosts');
  });

  // ── Host list rendering ───────────────────────────────────────────────────
  //
  // The host list is rendered before openSession is called, so we can verify
  // rendering by having openSession fail immediately (no conversation loop).

  it('renders all hosts with correct 1-based numbering', async () => {
    const hosts = makeHosts(3);
    const rc = makeRouterClient(hosts);
    // First open: HostBusyError → reselect → host list rendered again
    // Second open (fallback InvalidTokenError) → refetch → [] → exit
    const sc = makeSessionClient({ openSessionResults: [new HostBusyError()] });
    queueAnswers(['1', '1']); // select 1 twice

    await createCli({ routerClient: rc, sessionClient: sc, logger }).run();

    expect(stdoutOutput).toContain('[1]');
    expect(stdoutOutput).toContain('[2]');
    expect(stdoutOutput).toContain('[3]');
    expect(stdoutOutput).toContain('model-0');
    expect(stdoutOutput).toContain('model-1');
    expect(stdoutOutput).toContain('model-2');
  });

  // ── Session open errors ───────────────────────────────────────────────────

  it('host busy: informs user and returns to host list', async () => {
    const rc = makeRouterClient();
    // HostBusyError → reselect. Next call (fallback) → InvalidTokenError → refetch → [] → exit.
    const sc = makeSessionClient({ openSessionResults: [new HostBusyError()] });
    queueAnswers(['1', '1']);

    await createCli({ routerClient: rc, sessionClient: sc, logger }).run();

    expect(stdoutOutput.toLowerCase()).toContain('busy');
  });

  it('invalid token: re-fetches host list', async () => {
    const rc = makeRouterClient();
    const sc = makeSessionClient({ openSessionResults: [new InvalidTokenError()] });
    queueAnswers(['1', '1']);

    await createCli({ routerClient: rc, sessionClient: sc, logger }).run();

    // fetchHostList called twice: initial fetch + refetch
    expect(rc.fetchHostList).toHaveBeenCalledTimes(2);
  });

  // Conversation-loop tests (session timeout, Ctrl+C, chunk streaming) are
  // written in user Phase 9 once the full sendInferenceRequest + SSE parsing
  // implementation is in place.
});
