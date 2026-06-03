/**
 * Integration test — router unreachable on startup (6-5).
 *
 * When no router is listening, the Router Client must fail with a connection
 * error. The CLI exits with a non-zero code and a clear error message on stderr.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouterClient } from '../../src/router-client.js';
import { createModelRegistry } from '../../src/model-registry.js';
import { createHostSessionPool } from '../../src/host-session-pool.js';
import { createCli } from '../../src/cli.js';
import { logger, startMockRouter } from './helpers.js';

// ── Mock readline so the CLI doesn't block on stdin ───────────────────────────
vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(),
    close: vi.fn(),
    terminal: false,
  })),
}));

describe('User integration — router unreachable', () => {
  let stderrLines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any;

  beforeEach(() => {
    stderrLines = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((data: unknown) => {
      stderrLines.push(String(data));
      return true;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((): never => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 6-5: Router unreachable ───────────────────────────────────────────────

  it('Router Client fails with a connection error when no router is running', async () => {
    const config = {
      SHAREGRID_ROUTER_URL: 'https://127.0.0.1:19999?fp=sha256:' + 'a'.repeat(64) + '&key=dummykey', SHAREGRID_LISTEN_PORT: 3000, SHAREGRID_MODE: 'server' as const,
    };

    const routerClient = createRouterClient({ config, logger });
    await expect(routerClient.fetchHostList()).rejects.toThrow();
  }, 10_000);

  it('CLI exits with a non-zero code and prints an error when router is unreachable', async () => {
    const config = {
      SHAREGRID_ROUTER_URL: 'https://127.0.0.1:19999?fp=sha256:' + 'a'.repeat(64) + '&key=dummykey', SHAREGRID_LISTEN_PORT: 3000, SHAREGRID_MODE: 'server' as const,
    };

    const routerClient = createRouterClient({ config, logger });
    const modelRegistry = createModelRegistry({ routerClient });
    const sessionPool = createHostSessionPool({ logger });
    const cli = createCli({ modelRegistry, sessionPool, logger });

    // process.exit is mocked to not throw/exit, so run() may throw after the
    // exit call due to uninitialized state — that's expected; catch and ignore.
    try {
      await cli.run();
    } catch {
      // Expected: process.exit(1) is mocked as a no-op, code after it may throw
    }

    // process.exit must have been called with code 1
    expect(exitSpy).toHaveBeenCalledWith(1);

    // stderr must contain an error message
    const stderrHasError = stderrLines.some(
      (l) => l.toLowerCase().includes('error') || l.toLowerCase().includes('connect'),
    );
    expect(stderrHasError).toBe(true);
  }, 10_000);

  // ── Phase 9 (9-4): Wrong roleKey causes rejection ─────────────────────────

  it('CLI exits with an error when router rejects the user access key', async () => {
    // Start a real mock router — it will reject any key other than its userSecret
    const mockRouter = await startMockRouter([]);
    const wrongKeyConfig = {
      SHAREGRID_ROUTER_URL: `https://127.0.0.1:${mockRouter.port}?fp=${mockRouter.fingerprint}&key=completely-wrong-key`,
      SHAREGRID_LISTEN_PORT: 3000,
      SHAREGRID_MODE: 'server' as const,
    };

    const routerClient = createRouterClient({ config: wrongKeyConfig, logger });
    const modelRegistry = createModelRegistry({ routerClient });
    const sessionPool = createHostSessionPool({ logger });
    const cli = createCli({ modelRegistry, sessionPool, logger });

    try {
      await cli.run();
    } catch {
      // process.exit mocked as no-op; subsequent code may throw
    }

    mockRouter.stop();

    // process.exit(1) must have been called
    expect(exitSpy).toHaveBeenCalledWith(1);

    // stderr or stdout must contain an error indication
    const hasError = stderrLines.some(
      (l) => l.toLowerCase().includes('error') || l.toLowerCase().includes('connect'),
    );
    expect(hasError).toBe(true);
  }, 15_000);
});
