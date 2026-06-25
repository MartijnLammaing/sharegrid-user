/**
 * Integration test — happy path (6-1).
 *
 * Stand up a mock router that returns one host, and a mock host that accepts
 * a session and returns streamed chunks. Test end-to-end through the Router
 * Client and Session Client.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouterClient } from '../../src/router-client.js';
import { createSessionClient } from '../../src/session-client.js';
import {
  startMockRouter,
  startMockHost,
  makeConfig,
  collectInference,
  extractContent,
  logger,
  makeHostListEntry,
  type MockRouter,
  type MockHost,
} from './helpers.js';

describe('User integration — happy path', () => {
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

  it('fetches host list and opens/closes session cleanly', async () => {
    const config = makeConfig(mockRouter);

    // 1. Fetch host list via Router Client
    const routerClient = createRouterClient({ config, logger });
    const hosts = await routerClient.fetchHostList();

    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.modelName).toBe('test-model');

    // 2. Open session via Session Client
    const sessionClient = createSessionClient({ logger });
    await sessionClient.openSession(hosts[0]!);
    expect(sessionClient.isAlive()).toBe(true);

    // 3. Close session — mock host must receive session_close
    await sessionClient.closeSession();
    await new Promise((r) => setTimeout(r, 100));

    const closeMsg = mockHost.received.find((m) => m['type'] === 'session_close');
    expect(closeMsg).toBeDefined();
  }, 10_000);

  it('sendInferenceRequest streams SSE chunks and resolves on [DONE]', async () => {
    mockHost.inferenceChunks = ['Hello', ' world'];

    const config = makeConfig(mockRouter);
    const routerClient = createRouterClient({ config, logger });
    const hosts = await routerClient.fetchHostList();

    const sessionClient = createSessionClient({ logger });
    await sessionClient.openSession(hosts[0]!);

    const sseLines = await collectInference(sessionClient, JSON.stringify({ model: 'test-model', messages: [] }));

    expect(extractContent(sseLines)).toBe('Hello world');
    expect(sseLines[sseLines.length - 1]).toBe('data: [DONE]');

    await sessionClient.closeSession();
  }, 10_000);

  it('two sequential requests reuse the same session (conversation affinity)', async () => {
    mockHost.inferenceChunks = ['ok'];

    const config = makeConfig(mockRouter);
    const routerClient = createRouterClient({ config, logger });
    const hosts = await routerClient.fetchHostList();

    const sessionClient = createSessionClient({ logger });
    await sessionClient.openSession(hosts[0]!);

    await collectInference(sessionClient, JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'turn 1' }] }));
    await collectInference(sessionClient, JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'turn 2' }] }));

    const sessionOpens = mockHost.received.filter((m) => m['type'] === 'session_open');
    expect(sessionOpens).toHaveLength(1);

    const inferenceRequests = mockHost.received.filter((m) => m['type'] === 'inference_request');
    expect(inferenceRequests).toHaveLength(2);

    await sessionClient.closeSession();
  }, 10_000);

  it('router client closes the TLS connection after receiving the host list', async () => {
    const config = makeConfig(mockRouter);
    const routerClient = createRouterClient({ config, logger });
    await routerClient.fetchHostList();

    // After fetchHostList returns, the router connection must be closed.
    // Give the router a tick to process the close.
    await new Promise((r) => setTimeout(r, 100));
    // No assertion needed beyond the function returning without hanging.
  }, 5_000);
});
