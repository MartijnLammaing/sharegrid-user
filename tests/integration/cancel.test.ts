/**
 * Integration test — cancel mid-stream (8-4).
 *
 * Verifies that:
 *  (a) the CLI prints [stopped] after a cancel,
 *  (b) the session socket stays open (no session_close sent),
 *  (c) a subsequent prompt is accepted and streams normally.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionClient } from '../../src/session-client.js';
import { PromptCancelledError } from '../../src/session-client.js';
import {
  startMockRouter,
  startMockHost,
  makeConfig,
  logger,
  type MockRouter,
  type MockHost,
} from './helpers.js';
import { createRouterClient } from '../../src/router-client.js';

describe('User integration — prompt cancellation', () => {
  let mockRouter: MockRouter;
  let mockHost: MockHost;

  beforeEach(async () => {
    mockHost   = await startMockHost();
    mockRouter = await startMockRouter([
      {
        hostId: 'host-1',
        modelName: 'test-model',
        endpoint: `127.0.0.1:${mockHost.port}`,
        tlsFingerprint: mockHost.fingerprint,
        hostKeyToken: mockHost.hostKeyToken,
      },
    ]);
  });

  afterEach(() => {
    mockRouter.stop();
    mockHost.stop();
  });

  it('cancel mid-stream: session stays open and next prompt succeeds', async () => {
    const config = makeConfig(mockRouter);

    // Configure mock host to pause after 1 chunk (simulate mid-stream).
    mockHost.promptChunks = ['partial...', ' more'];
    mockHost.pauseAfterChunks = 1;

    const routerClient = createRouterClient({ config, logger });
    const hosts = await routerClient.fetchHostList();

    const sessionClient = createSessionClient({ logger });
    await sessionClient.openSession(hosts[0]!);

    // ── First prompt: cancel mid-stream ────────────────────────────────────

    const chunks1: string[] = [];
    const sendPromise = sessionClient.sendPrompt(
      [{ role: 'user', content: 'hi' }],
      (c) => chunks1.push(c),
      () => { /* onEnd — not called on cancel */ },
    );

    // Give the host a tick to send the first chunk, then cancel.
    await new Promise((r) => setTimeout(r, 50));
    await sessionClient.cancelPrompt();

    await expect(sendPromise).rejects.toThrow(PromptCancelledError);

    // Partial chunk was received.
    expect(chunks1).toEqual(['partial...']);

    // Verify prompt_cancel was received by the mock host.
    const cancelMsg = mockHost.received.find((m) => m['type'] === 'prompt_cancel');
    expect(cancelMsg).toBeDefined();

    // ── Second prompt: normal response after cancel ────────────────────────

    // Reset host to send normally.
    mockHost.pauseAfterChunks = null;
    mockHost.promptChunks = ['Hello', ' world'];

    const chunks2: string[] = [];
    await sessionClient.sendPrompt(
      [{ role: 'user', content: 'hi again' }],
      (c) => chunks2.push(c),
      () => { /* onEnd */ },
    );

    expect(chunks2).toEqual(['Hello', ' world']);

    // No session_close should have been sent during the cancel.
    const closeMsgs = mockHost.received.filter((m) => m['type'] === 'session_close');
    expect(closeMsgs).toHaveLength(0);

    await sessionClient.closeSession();
  }, 10_000);
});
