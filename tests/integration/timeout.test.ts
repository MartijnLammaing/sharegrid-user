/**
 * Integration test — session_timeout mid-inference.
 *
 * Verifies that when the mock host sends session_timeout in response to an
 * inference_request, the SessionClient rejects sendInferenceRequest with
 * a SessionTimeoutError.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouterClient } from '../../src/router-client.js';
import { createSessionClient, SessionTimeoutError } from '../../src/session-client.js';
import {
  startMockRouter,
  startMockHost,
  makeConfig,
  logger,
  type MockRouter,
  type MockHost,
} from './helpers.js';

describe('User integration — session timeout', () => {
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

  it('session_timeout mid-inference rejects sendInferenceRequest with SessionTimeoutError', async () => {
    mockHost.sendTimeout = true;

    const config = makeConfig(mockRouter);
    const routerClient = createRouterClient({ config, logger });
    const hosts = await routerClient.fetchHostList();

    const sessionClient = createSessionClient({ logger });
    await sessionClient.openSession(hosts[0]!);

    await expect(
      sessionClient.sendInferenceRequest(
        JSON.stringify({ model: 'test-model', messages: [] }),
        () => { /* no chunks expected */ },
        new AbortController().signal,
      ),
    ).rejects.toThrow(SessionTimeoutError);
  }, 10_000);
});
