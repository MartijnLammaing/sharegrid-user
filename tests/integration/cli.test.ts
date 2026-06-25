/**
 * Integration tests — CLI mode.
 *
 * Uses real mock router + mock host but mocked readline. The full path from
 * CLI → ModelRegistry → HostSessionPool → SessionClient → MockHost is
 * exercised against genuine network connections.
 *
 * Termination strategy: use cacheTtlMs:0 on ModelRegistry so every getModels()
 * call hits the router, then set mockRouter.hosts=[] at the right moment so
 * the CLI's "No hosts available. Exiting." path fires and run() returns
 * naturally — no process.exit mocking needed.
 *
 * To trigger a second getModels() call we make the conversationLoop return an
 * action via mockHost.sendTimeout=true (→ SessionTimeoutError → 'reselect').
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import {
  startMockRouter,
  startMockHost,
  type MockRouter,
  type MockHost,
  makeHostListEntry,
} from './helpers.js';
import { createRouterClient } from '../../src/router-client.js';
import { createModelRegistry } from '../../src/model-registry.js';
import { createHostSessionPool } from '../../src/host-session-pool.js';
import { createCli } from '../../src/cli.js';

// ── Mock readline ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────

const logger = pino({ level: 'silent' });

describe('User integration — CLI mode', () => {
  let mockRouter: MockRouter;
  let mockHost: MockHost;
  let stdoutOutput: string;
  let routerUrl: string;

  beforeEach(async () => {
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.clearAllMocks();
    process.removeAllListeners('SIGINT');

    mockHost = await startMockHost();
    mockRouter = await startMockRouter([makeHostListEntry({
      hostId: 'host-1',
      modelName: 'test-model',
      endpoint: `127.0.0.1:${mockHost.port}`,
      tlsFingerprint: mockHost.fingerprint,
      hostKeyToken: mockHost.hostKeyToken,
    })]);

    routerUrl = `https://127.0.0.1:${mockRouter.port}?fp=${mockRouter.fingerprint}&key=${mockRouter.userSecret}`;
  }, 15_000);

  afterEach(() => {
    mockRouter.stop();
    mockHost.stop();
    vi.restoreAllMocks();
  }, 10_000);

  /**
   * Create a CLI with cacheTtlMs:0 so every getModels() call hits the router.
   * This lets us set mockRouter.hosts=[] mid-test to trigger a natural exit.
   */
  function makeCli() {
    const config = {
      SHAREGRID_ROUTER_URL: routerUrl,
      SHAREGRID_LISTEN_PORT: 3000,
      SHAREGRID_LISTEN_HOST: '127.0.0.1',
      SHAREGRID_MODE: 'cli' as const,
    };
    const routerClient = createRouterClient({ config, logger });
    // cacheTtlMs:0 — every getModels() call goes to the router
    const modelRegistry = createModelRegistry({ routerClient, cacheTtlMs: 0 });
    const sessionPool = createHostSessionPool({ logger });
    return createCli({ modelRegistry, sessionPool, logger });
  }

  // ── Model list displayed ──────────────────────────────────────────────────

  it('model list is fetched from the real router and displayed', async () => {
    // First inference succeeds; second prompt triggers session_timeout → reselect
    // → getModels() returns [] (hosts cleared) → CLI exits naturally.
    mockHost.inferenceChunks = ['ok'];

    let inputCount = 0;
    (mockRl.question as ReturnType<typeof vi.fn>).mockImplementation(
      (_q: string, cb: QuestionCallback) => {
        inputCount++;
        if (inputCount === 1) {
          setTimeout(() => cb('1'), 0); // model selection
        } else if (inputCount === 2) {
          setTimeout(() => cb('hi'), 0); // first prompt → inference → ok
        } else {
          // After inference: clear hosts and set sendTimeout so the next
          // conversationLoop turn returns 'reselect' → getModels()=[] → exit
          mockRouter.hosts = [];
          mockHost.sendTimeout = true;
          setTimeout(() => cb('bye'), 0);
        }
      },
    );

    const cli = makeCli();
    await cli.run();

    expect(stdoutOutput).toContain('[1]');
    expect(stdoutOutput).toContain('test-model');
  }, 15_000);

  // ── Inference text displayed ──────────────────────────────────────────────

  it('prompt → real inference → delta.content written to stdout', async () => {
    mockHost.inferenceChunks = ['Hello', ' integration'];

    let inputCount = 0;
    (mockRl.question as ReturnType<typeof vi.fn>).mockImplementation(
      (_q: string, cb: QuestionCallback) => {
        inputCount++;
        if (inputCount === 1) {
          setTimeout(() => cb('1'), 0);
        } else if (inputCount === 2) {
          setTimeout(() => cb('hi'), 0);
        } else {
          mockRouter.hosts = [];
          mockHost.sendTimeout = true;
          setTimeout(() => cb('bye'), 0);
        }
      },
    );

    const cli = makeCli();
    await cli.run();

    expect(stdoutOutput).toContain('Hello');
    expect(stdoutOutput).toContain(' integration');
  }, 15_000);

  // ── Session pool reuse ────────────────────────────────────────────────────

  it('second prompt reuses the existing session (pool does not open a new session_open)', async () => {
    mockHost.inferenceChunks = ['ok'];

    let inputCount = 0;
    (mockRl.question as ReturnType<typeof vi.fn>).mockImplementation(
      (_q: string, cb: QuestionCallback) => {
        inputCount++;
        if (inputCount === 1) {
          setTimeout(() => cb('1'), 0);         // model selection
        } else if (inputCount === 2) {
          setTimeout(() => cb('first'), 0);     // first prompt → inference
        } else if (inputCount === 3) {
          setTimeout(() => cb('second'), 0);    // second prompt → inference (pool reuse)
        } else {
          mockRouter.hosts = [];
          mockHost.sendTimeout = true;
          setTimeout(() => cb('bye'), 0);       // third prompt → timeout → exit
        }
      },
    );

    const cli = makeCli();
    await cli.run();

    // Pool must have opened only ONE session (reused on second and third prompts)
    const sessionOpens = mockHost.received.filter((m) => m['type'] === 'session_open');
    expect(sessionOpens).toHaveLength(1);

    // Two successful inference_requests before the timeout one
    const inferenceRequests = mockHost.received.filter((m) => m['type'] === 'inference_request');
    expect(inferenceRequests.length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  // ── Ctrl+C during inference ───────────────────────────────────────────────

  it('Ctrl+C during inference prints [stopped] and host sees socket disconnect', async () => {
    // Host pauses after the first chunk — never sends [DONE]
    mockHost.pauseAfterChunks = 1;
    mockHost.inferenceChunks = ['partial'];

    let inputCount = 0;
    (mockRl.question as ReturnType<typeof vi.fn>).mockImplementation(
      (_q: string, cb: QuestionCallback) => {
        inputCount++;
        if (inputCount === 1) {
          setTimeout(() => cb('1'), 0); // model selection
        } else if (inputCount === 2) {
          // Send prompt then emit SIGINT while inference is paused
          setTimeout(() => {
            cb('hello');
            setTimeout(() => process.emit('SIGINT'), 60);
          }, 0);
        } else {
          // After [stopped], trigger clean exit via sendTimeout + empty hosts
          mockRouter.hosts = [];
          mockHost.pauseAfterChunks = null;
          mockHost.sendTimeout = true;
          setTimeout(() => cb('bye'), 0);
        }
      },
    );

    const cli = makeCli();
    await cli.run();

    expect(stdoutOutput).toContain('[stopped]');
    // The abort was via socket destroy — no graceful session_close
    expect(mockHost.received.some((m) => m['type'] === 'session_close')).toBe(false);
  }, 20_000);
});
