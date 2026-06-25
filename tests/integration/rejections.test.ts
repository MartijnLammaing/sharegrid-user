/**
 * Integration tests — session rejection handling (6-2, 6-3).
 *
 * Tests that the Session Client propagates typed errors from the mock host
 * and that the Router Client can re-fetch the host list.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostBusyError, InvalidTokenError } from '@sharegrid/shared/errors';
import { createRouterClient } from '../../src/router-client.js';
import { createSessionClient } from '../../src/session-client.js';
import {
  startMockRouter,
  startMockHost,
  makeConfig,
  logger,
  makeHostListEntry,
  type MockRouter,
  type MockHost,
} from './helpers.js';

describe('User integration — rejections', () => {
  let mockRouter: MockRouter;
  let mockHost: MockHost;

  beforeEach(async () => {
    mockHost   = await startMockHost();
    mockRouter = await startMockRouter([
      makeHostListEntry({
        hostId: 'host-1',
        modelName: 'test-model',
        endpoint: `127.0.0.1:${mockHost.port}`,
        tlsFingerprint: mockHost.fingerprint,
        hostKeyToken: mockHost.hostKeyToken,
      }),
    ]);
  });

  afterEach(() => {
    mockRouter.stop();
    mockHost.stop();
  });

  // ── 6-2: Host busy ────────────────────────────────────────────────────────

  it('session_reject reason: busy propagates as HostBusyError', async () => {
    mockHost.sessionRejectReason = 'busy';

    const config = makeConfig(mockRouter);
    const routerClient = createRouterClient({ config, logger });
    const hosts = await routerClient.fetchHostList();

    const sessionClient = createSessionClient({ logger });
    await expect(sessionClient.openSession(hosts[0]!)).rejects.toThrow(HostBusyError);
  }, 10_000);

  // ── 6-3: Token expired ────────────────────────────────────────────────────

  it('session_reject reason: invalid_token propagates as InvalidTokenError', async () => {
    mockHost.sessionRejectReason = 'invalid_token';

    const config = makeConfig(mockRouter);
    const routerClient = createRouterClient({ config, logger });
    const hosts = await routerClient.fetchHostList();

    const sessionClient = createSessionClient({ logger });
    await expect(sessionClient.openSession(hosts[0]!)).rejects.toThrow(InvalidTokenError);
  }, 10_000);

  it('router client can re-fetch the host list after InvalidTokenError', async () => {
    mockHost.sessionRejectReason = 'invalid_token';

    const config = makeConfig(mockRouter);
    const routerClient = createRouterClient({ config, logger });

    // First fetch + failed session
    const hosts1 = await routerClient.fetchHostList();
    const sessionClient = createSessionClient({ logger });
    await expect(sessionClient.openSession(hosts1[0]!)).rejects.toThrow(InvalidTokenError);

    // Re-fetch — router client must be able to open a new connection
    const hosts2 = await routerClient.fetchHostList();
    expect(hosts2).toHaveLength(1);
    expect(hosts2[0]!.modelName).toBe('test-model');
  }, 10_000);
});
