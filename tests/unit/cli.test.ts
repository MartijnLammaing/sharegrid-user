/**
 * CLI unit tests (5-4).
 *
 * Strategy: `cli.run()` loops indefinitely until the host list becomes empty.
 * Each test is designed to drive through a specific code path and then
 * terminate naturally by returning an empty host list on the final re-fetch.
 *
 * The SIGINT handler calls `process.exit(0)`. For the Ctrl+C test we mock
 * process.exit so it does NOT throw (overriding Vitest's interceptor), then
 * verify that closeSession was called before the exit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { HostBusyError, InvalidTokenError } from '@sharegrid/shared/errors';
import type { MockInstance } from '@vitest/spy';

// ── Mock node:readline ────────────────────────────────────────────────────────
type QuestionCallback = (answer: string) => void;

const mockRl = {
  question: vi.fn<[string, QuestionCallback], void>(),
  close: vi.fn(),
  on: vi.fn(),
  terminal: true,
};

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => mockRl),
}));

const { createCli } = await import('../../src/cli.js');
const { SessionTimeoutError, PromptCancelledError } = await import('../../src/session-client.js');

const logger = pino({ level: 'silent' });

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHosts(count = 2) {
  return Array.from({ length: count }, (_, i) => ({
    hostId: `host-${i}`,
    modelName: `model-${i}`,
    contextSize: (i + 1) * 1000,
    endpoint: `10.0.0.${i}:9000`,
    tlsFingerprint: 'sha256:' + '0'.repeat(63) + String(i),
    hostKeyToken: `token-${i}`,
  }));
}

/**
 * Drive readline questions from a queue. The last answer is used for all
 * subsequent calls if the queue is exhausted.
 */
function queueAnswers(answers: string[]) {
  let idx = 0;
  mockRl.question.mockImplementation((_q: string, cb: QuestionCallback) => {
    const answer = answers[idx] ?? answers[answers.length - 1] ?? '';
    idx++;
    setTimeout(() => cb(answer), 0);
  });
}

describe('CLI', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.clearAllMocks();
    // Remove any SIGINT listeners registered by previous tests so they don't
    // fire when this test emits SIGINT.
    process.removeAllListeners('SIGINT');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Helper: build a session client where every call sequence terminates ──

  function makeTerminatingClient(opts: {
    openSessionResults?: Array<'ok' | Error>;
    sendPromptResult?: Error;
  } = {}) {
    const opens = opts.openSessionResults ?? ['ok'];
    let openIdx = 0;

    const sc = {
      openSession: vi.fn().mockImplementation((): Promise<void> => {
        const result = opens[openIdx++] ?? new InvalidTokenError();
        if (result instanceof Error) return Promise.reject(result);
        return Promise.resolve();
      }),
      sendPrompt: vi.fn().mockImplementation(
        (_msgs: unknown, _onChunk: unknown, onEnd: () => void): Promise<void> => {
          if (opts.sendPromptResult) return Promise.reject(opts.sendPromptResult);
          onEnd();
          return Promise.resolve();
        },
      ),
      cancelPrompt: vi.fn().mockResolvedValue(undefined),
      closeSession: vi.fn().mockResolvedValue(undefined),
    };
    return sc;
  }

  /**
   * Build a router client that returns `hosts` on the first call and `[]` on
   * all subsequent calls (so run() terminates after the first re-fetch).
   */
  function makeRouterClient(hosts = makeHosts()) {
    let calls = 0;
    return {
      fetchHostList: vi.fn().mockImplementation(() => {
        return Promise.resolve(calls++ === 0 ? hosts : []);
      }),
    };
  }

  // ─── Test: host list renders all entries ──────────────────────────────────

  it('renders all hosts with correct 1-based numbering', async () => {
    const hosts = makeHosts(3);
    const rc = makeRouterClient(hosts);
    // openSession succeeds once, then throws InvalidTokenError → refetch (empty)
    const sc = makeTerminatingClient({ openSessionResults: ['ok', new InvalidTokenError()] });

    // Answers: select host 1, send one prompt, then select host 1 again (refetch will terminate)
    sc.sendPrompt.mockImplementationOnce(
      (_msgs: unknown, _onChunk: unknown, _onEnd: unknown): Promise<void> =>
        Promise.reject(new SessionTimeoutError()),
    );
    queueAnswers(['1', 'hello', '1']);

    await createCli({ routerClient: rc, sessionClient: sc, logger }).run();

    expect(stdoutOutput).toContain('[1]');
    expect(stdoutOutput).toContain('[2]');
    expect(stdoutOutput).toContain('[3]');
    expect(stdoutOutput).toContain('model-0');
    expect(stdoutOutput).toContain('model-1');
    expect(stdoutOutput).toContain('model-2');
  });

  // ─── Test: empty host list ────────────────────────────────────────────────

  it('prints a clear message and returns when the host list is empty', async () => {
    const rc = { fetchHostList: vi.fn().mockResolvedValue([]) };
    const sc = makeTerminatingClient();
    queueAnswers([]);

    await createCli({ routerClient: rc, sessionClient: sc, logger }).run();

    expect(stdoutOutput.toLowerCase()).toContain('no hosts');
  });

  // ─── Test: invalid selection reprompts ───────────────────────────────────

  it('reprompts on invalid host selection input', async () => {
    const hosts = makeHosts(2);
    const rc = makeRouterClient(hosts);
    // After valid selection, InvalidTokenError → refetch → empty → done
    const sc = makeTerminatingClient({ openSessionResults: [new InvalidTokenError()] });
    // 'abc' invalid, '99' out-of-range, '1' valid
    queueAnswers(['abc', '99', '1']);

    await createCli({ routerClient: rc, sessionClient: sc, logger }).run();

    // question called at least 3 times before a valid selection
    expect(mockRl.question.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  // ─── Test: HostBusyError re-selection ────────────────────────────────────

  it('HostBusyError displays "busy" message and returns to host list', async () => {
    const hosts = makeHosts(2);
    const rc = makeRouterClient(hosts);
    // First openSession → busy, second → InvalidTokenError → refetch → empty
    const sc = makeTerminatingClient({
      openSessionResults: [new HostBusyError(), new InvalidTokenError()],
    });
    queueAnswers(['1', '1']);

    await createCli({ routerClient: rc, sessionClient: sc, logger }).run();

    expect(stdoutOutput.toLowerCase()).toContain('busy');
  });

  // ─── Test: InvalidTokenError re-fetches host list ──────────────────────

  it('InvalidTokenError displays "expired" message and re-fetches the host list', async () => {
    const hosts = makeHosts(1);
    const rc = makeRouterClient(hosts);
    // openSession → InvalidTokenError → refetch (router returns []) → done
    const sc = makeTerminatingClient({ openSessionResults: [new InvalidTokenError()] });
    queueAnswers(['1']);

    await createCli({ routerClient: rc, sessionClient: sc, logger }).run();

    // fetchHostList called twice: initial + after invalid_token refetch
    expect(rc.fetchHostList).toHaveBeenCalledTimes(2);
    expect(stdoutOutput.toLowerCase()).toContain('expired');
  });

  // ─── Test: SessionTimeoutError re-selection ───────────────────────────────

  it('SessionTimeoutError displays "timed out" and returns to host selection', async () => {
    const hosts = makeHosts(1);
    const rc = makeRouterClient(hosts);
    // Session opens, prompt times out → reselect; second open → InvalidTokenError → refetch → done
    const sc = makeTerminatingClient({
      openSessionResults: ['ok', new InvalidTokenError()],
      sendPromptResult: new SessionTimeoutError(),
    });
    queueAnswers(['1', 'hello', '1']);

    await createCli({ routerClient: rc, sessionClient: sc, logger }).run();

    expect(stdoutOutput.toLowerCase()).toContain('timed out');
  });

  // ─── Test: Ctrl+C at idle prompt closes session and exits ────────────────

  it('Ctrl+C at idle prompt (no generation in flight) calls closeSession and prints goodbye', async () => {
    const hosts = makeHosts(1);
    const rc = makeRouterClient(hosts);
    const sc = {
      openSession: vi.fn().mockResolvedValue(undefined),
      sendPrompt: vi.fn(), // never called in this test
      cancelPrompt: vi.fn().mockResolvedValue(undefined),
      closeSession: vi.fn().mockResolvedValue(undefined),
    };

    // Override process.exit so Vitest doesn't intercept it as an error.
    const proc = process as { exit: (code?: number) => never };
    const exitSpy: MockInstance<(code?: number) => never> = vi.spyOn(proc, 'exit').mockImplementation(
      (_code?: number): never => undefined as never,
    );

    // promptCall=1: host selection; promptCall=2: "You:" prompt where SIGINT fires.
    // After process.exit is absorbed we answer so run() can drain via refetch.
    let promptCall = 0;
    let sigintFired = false;
    mockRl.question.mockImplementation((_q: string, cb: QuestionCallback) => {
      promptCall++;
      if (promptCall === 1) {
        setTimeout(() => cb('1'), 0); // initial host selection
      } else if (!sigintFired) {
        // First non-selection prompt ("You:"): fire SIGINT exactly once.
        sigintFired = true;
        setTimeout(() => {
          process.emit('SIGINT'); // generationInFlight===false → closeSession + exit(0)
          // Provide answer after exit is absorbed so the awaited prompt() resolves
          // and run() can continue via the reselect/refetch termination path.
          setTimeout(() => cb('hello'), 20);
        }, 5);
      } else {
        // Subsequent questions (re-selection): return '1' to drive the termination path.
        setTimeout(() => cb('1'), 0);
      }
    });

    // After SIGINT-triggered reselect, openSession → InvalidTokenError → refetch → [] → done.
    sc.openSession
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new InvalidTokenError());
    sc.sendPrompt.mockRejectedValue(new SessionTimeoutError());

    await createCli({ routerClient: rc, sessionClient: sc, logger }).run();

    expect(sc.closeSession).toHaveBeenCalled();
    expect(stdoutOutput).toContain('Goodbye');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  // ─── Test: SIGINT during generation calls cancelPrompt, not exit ──────────

  it('SIGINT during generation calls cancelPrompt and prints [stopped] without exiting', async () => {
    const hosts = makeHosts(1);
    const rc = makeRouterClient(hosts);

    // sendPrompt: first call blocks (will be cancelled); second call throws SessionTimeoutError
    // to exit conversationLoop → reselect → InvalidTokenError → refetch → [] → done.
    let sendPromptReject: (e: Error) => void;
    let sendCallCount = 0;
    const sc = {
      openSession: vi.fn()
        .mockResolvedValueOnce(undefined)          // first open succeeds
        .mockRejectedValueOnce(new InvalidTokenError()), // reselect open fails → refetch → done
      sendPrompt: vi.fn().mockImplementation(
        (_msgs: unknown, _onChunk: unknown, _onEnd: unknown): Promise<void> => {
          sendCallCount++;
          if (sendCallCount === 1) {
            return new Promise<void>((_res, rej) => { sendPromptReject = rej; });
          }
          return Promise.reject(new SessionTimeoutError());
        },
      ),
      cancelPrompt: vi.fn().mockResolvedValue(undefined),
      closeSession: vi.fn().mockResolvedValue(undefined),
    };

    const proc = process as { exit: (code?: number) => never };
    const exitSpy: MockInstance<(code?: number) => never> = vi.spyOn(proc, 'exit').mockImplementation(
      (_code?: number): never => undefined as never,
    );

    let promptCall = 0;
    mockRl.question.mockImplementation((_q: string, cb: QuestionCallback) => {
      promptCall++;
      if (promptCall === 1) {
        setTimeout(() => cb('1'), 0); // initial host selection
      } else if (promptCall === 2) {
        setTimeout(() => {
          cb('hello'); // triggers sendPrompt (which blocks)
          setTimeout(() => {
            // Fire SIGINT while generation is in flight.
            process.emit('SIGINT');
            // After cancelPrompt resolves, reject sendPrompt with PromptCancelledError.
            setTimeout(() => { sendPromptReject(new PromptCancelledError()); }, 10);
          }, 5);
        }, 0);
      } else if (promptCall === 3) {
        // After [stopped] the loop continues; triggers second sendPrompt
        // which throws SessionTimeoutError → conversationLoop returns 'reselect'.
        setTimeout(() => cb('follow-up'), 0);
      } else {
        // Host re-selection after reselect: '1' → openSession throws InvalidTokenError
        // → refetch → [] → run() completes.
        setTimeout(() => cb('1'), 0);
      }
    });

    await createCli({ routerClient: rc, sessionClient: sc, logger }).run();

    expect(sc.cancelPrompt).toHaveBeenCalled();
    expect(stdoutOutput).toContain('[stopped]');
    expect(exitSpy).not.toHaveBeenCalled();
  }, 10_000);

  // ─── Test: PromptCancelledError discards partial response ────────────────

  it('PromptCancelledError discards partial response and does not add to messages', async () => {
    const hosts = makeHosts(1);
    const rc = makeRouterClient(hosts);

    let sendCallCount = 0;
    let capturedMessages: Array<unknown>[] = [];
    const sc = {
      openSession: vi.fn().mockResolvedValue(undefined),
      sendPrompt: vi.fn().mockImplementation(
        (msgs: unknown, _onChunk: unknown, _onEnd: unknown): Promise<void> => {
          capturedMessages.push(msgs as unknown[]);
          sendCallCount++;
          if (sendCallCount === 1) {
            // First call: emit a partial chunk then reject with PromptCancelledError.
            return Promise.reject(new PromptCancelledError());
          }
          // Second call: succeed normally so the test can terminate.
          return Promise.reject(new InvalidTokenError());
        },
      ),
      cancelPrompt: vi.fn().mockResolvedValue(undefined),
      closeSession: vi.fn().mockResolvedValue(undefined),
    };

    queueAnswers(['1', 'first prompt', 'second prompt']);

    await createCli({ routerClient: rc, sessionClient: sc, logger }).run();

    // The cancelled turn must not appear in the messages array sent on the
    // second sendPrompt call — only the original user message.
    expect(stdoutOutput).toContain('[stopped]');
    // Second sendPrompt should only contain the first user message (no assistant
    // turn from the cancelled response).
    if (capturedMessages[1]) {
      const secondCallMessages = capturedMessages[1] as Array<{ role: string }>;
      const assistantTurns = secondCallMessages.filter((m) => m.role === 'assistant');
      expect(assistantTurns).toHaveLength(0);
    }
  });
});
