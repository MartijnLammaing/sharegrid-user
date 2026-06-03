/**
 * Integration test — abort() mid-inference.
 *
 * Verifies that calling abort() on a live SessionClient while an
 * inference_request is in flight destroys the socket cleanly, resolves the
 * sendInferenceRequest promise, and causes the mock host to see a disconnect
 * (rather than a graceful session_close).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouterClient } from '../../src/router-client.js';
import { createSessionClient } from '../../src/session-client.js';
import {
  startMockRouter,
  startMockHost,
  makeConfig,
  logger,
  type MockRouter,
  type MockHost,
} from './helpers.js';

describe('User integration — abort mid-inference', () => {
  let mockRouter: MockRouter;
  let mockHost: MockHost;

  beforeEach(async () => {
    mockHost = await startMockHost();
    mockRouter = await startMockRouter([{
      hostId: 'host-1',
      modelName: 'test-model',
      endpoint: `127.0.0.1:${mockHost.port}`,
      tlsFingerprint: mockHost.fingerprint,
      hostKeyToken: mockHost.hostKeyToken,
    }]);
  }, 15_000);

  afterEach(() => {
    mockRouter.stop();
    mockHost.stop();
  });

  it('abort() destroys the socket, resolves sendInferenceRequest, and the host sees a disconnect', async () => {
    // Host sends 1 chunk then pauses — never sends [DONE]
    mockHost.pauseAfterChunks = 1;
    mockHost.inferenceChunks = ['partial chunk'];

    const config = makeConfig(mockRouter);
    const routerClient = createRouterClient({ config, logger });
    const hosts = await routerClient.fetchHostList();

    const sessionClient = createSessionClient({ logger });
    await sessionClient.openSession(hosts[0]!);

    const chunks: string[] = [];
    const inferencePromise = sessionClient.sendInferenceRequest(
      JSON.stringify({ model: 'test-model', messages: [] }),
      (line) => { chunks.push(line); },
      new AbortController().signal,
    );

    // Wait for the first chunk to arrive from the host
    await new Promise((r) => setTimeout(r, 100));
    expect(chunks.length).toBeGreaterThanOrEqual(1);

    // Abort — destroys the socket; host sees the disconnect
    sessionClient.abort();

    // sendInferenceRequest must RESOLVE (not reject) on abort
    await expect(inferencePromise).resolves.toBeUndefined();

    // Session is now dead
    expect(sessionClient.isAlive()).toBe(false);

    // Host received an inference_request but no graceful session_close
    expect(mockHost.received.some((m) => m['type'] === 'inference_request')).toBe(true);
    expect(mockHost.received.some((m) => m['type'] === 'session_close')).toBe(false);
  }, 10_000);
});
