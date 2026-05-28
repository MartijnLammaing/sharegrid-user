/**
 * Integration test — router unreachable on startup (6-5).
 *
 * When no router is listening, the Router Client must fail with a connection
 * error. The CLI exits with a non-zero code and a clear error message on stderr.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouterClient } from '../../src/router-client.js';
import { createSessionClient } from '../../src/session-client.js';
import { createCli } from '../../src/cli.js';
import { logger } from './helpers.js';

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
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrLines = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrLines.push(String(data));
      return true;
    });
    const proc = process as { exit: (code?: number) => never };
    exitSpy = vi.spyOn(proc, 'exit').mockImplementation((): never => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 6-5: Router unreachable ───────────────────────────────────────────────

  it('Router Client fails with a connection error when no router is running', async () => {
    const config = {
      SHAREGRID_ROUTER_URL: 'https://127.0.0.1:19999?fp=sha256:' + 'a'.repeat(64),
    };

    const routerClient = createRouterClient({ config, logger });
    await expect(routerClient.fetchHostList()).rejects.toThrow();
  }, 10_000);

  it('CLI exits with a non-zero code and prints an error when router is unreachable', async () => {
    const config = {
      SHAREGRID_ROUTER_URL: 'https://127.0.0.1:19999?fp=sha256:' + 'a'.repeat(64),
    };

    const routerClient = createRouterClient({ config, logger });
    const sessionClient = createSessionClient({ logger });
    const cli = createCli({ routerClient, sessionClient, logger });

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
});
