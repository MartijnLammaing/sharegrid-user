/**
 * Integration test — session timeout mid-conversation (6-4).
 *
 * The mock host sends session_timeout instead of response chunks.
 * The Session Client must reject the in-flight sendPrompt with a
 * SessionTimeoutError.
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
    mockHost   = await startMockHost();
    mockRouter = await startMockRouter([
      {
        hostId: 'host-1',
        modelName: 'test-model',
        contextSize: 4096,
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

  it('session_timeout mid-conversation rejects sendPrompt with SessionTimeoutError', async () => {
    mockHost.sendTimeout = true;

    const config = makeConfig(mockRouter);
    const routerClient = createRouterClient({ config, logger });
    const hosts = await routerClient.fetchHostList();

    const sessionClient = createSessionClient({ logger });
    await sessionClient.openSession(hosts[0]!);

    await expect(
      sessionClient.sendPrompt(
        [{ role: 'user', content: 'hello' }],
        () => { /* chunk */ },
        () => { /* end */ },
      ),
    ).rejects.toThrow(SessionTimeoutError);
  }, 10_000);
});
