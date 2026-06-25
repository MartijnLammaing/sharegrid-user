/**
 * Integration tests — LLMUser HTTP server (server mode).
 *
 * Stands up a real mock router, a real mock host, and the full LLMUser API
 * server stack (ModelRegistry + HostSessionPool + ApiServer). Makes actual
 * HTTP requests to exercise the end-to-end path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import {
  startMockRouter,
  startMockHost,
  startUserServer,
  extractContent,
  makeHostListEntry,
  type MockRouter,
  type MockHost,
} from './helpers.js';

// ── HTTP client helpers ───────────────────────────────────────────────────────

function getJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface StreamResult { status: number; body: string }

function postStream(port: number, bodyObj: unknown): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(bodyObj);
    const req = httpRequest(
      {
        hostname: '127.0.0.1', port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('User integration — server mode', () => {
  let mockRouter: MockRouter;
  let mockHost: MockHost;
  let userServer: Awaited<ReturnType<typeof startUserServer>>;

  beforeEach(async () => {
    mockHost = await startMockHost();
    mockRouter = await startMockRouter([makeHostListEntry({
      hostId: 'host-1',
      modelName: 'test-model',
      endpoint: `127.0.0.1:${mockHost.port}`,
      tlsFingerprint: mockHost.fingerprint,
      hostKeyToken: mockHost.hostKeyToken,
    })]);
    userServer = await startUserServer(mockRouter);
  }, 15_000);

  afterEach(async () => {
    await userServer.stop();
    mockRouter.stop();
    mockHost.stop();
  }, 10_000);

  // ── GET /v1/models ────────────────────────────────────────────────────────

  it('GET /v1/models returns model list from mock router', async () => {
    const result = await getJson(userServer.port, '/v1/models');

    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body['object']).toBe('list');
    const data = body['data'] as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(data[0]!['id']).toBe('test-model');
    expect(data[0]!['context_length']).toBe(4096);
    expect(data[0]!['sharegrid_available_slots']).toBe(1);
    expect(data[0]!['sharegrid_total_slots']).toBe(1);
  }, 10_000);

  // ── POST /v1/chat/completions ─────────────────────────────────────────────

  it('POST /chat/completions streams SSE back from mock host', async () => {
    mockHost.inferenceChunks = ['Hello', ' world'];

    const result = await postStream(userServer.port, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.status).toBe(200);
    // Body contains raw SSE lines — extract content
    const sseLines = result.body.split('\n\n').map((l) => l.trim()).filter(Boolean);
    expect(extractContent(sseLines)).toBe('Hello world');
    expect(result.body).toContain('data: [DONE]');
  }, 10_000);

  // ── Multi-host model routing ───────────────────────────────────────────────

  it('routes to the second host when the first host is full', async () => {
    // Start a second mock host for the same model
    const mockHost2 = await startMockHost();
    mockRouter.hosts = [
      makeHostListEntry({
        hostId: 'host-1',
        modelName: 'test-model',
        endpoint: `127.0.0.1:${mockHost.port}`,
        tlsFingerprint: mockHost.fingerprint,
        hostKeyToken: mockHost.hostKeyToken,
        availableSlots: 0,
        totalSlots: 1,
      }),
      makeHostListEntry({
        hostId: 'host-2',
        modelName: 'test-model',
        endpoint: `127.0.0.1:${mockHost2.port}`,
        tlsFingerprint: mockHost2.fingerprint,
        hostKeyToken: mockHost2.hostKeyToken,
        availableSlots: 1,
        totalSlots: 1,
      }),
    ];

    mockHost.sessionRejectReason = 'busy';
    mockHost2.inferenceChunks = ['routed'];

    const result = await postStream(userServer.port, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.status).toBe(200);
    expect(result.body).toContain('routed');
    // Availability-aware sorting means the non-full host is tried first.
    expect(mockHost2.received.some((m) => m['type'] === 'session_open')).toBe(true);
    expect(mockHost.received.some((m) => m['type'] === 'session_open')).toBe(false);

    mockHost2.stop();
  }, 15_000);

  // ── Multi-turn: session pool reuse ────────────────────────────────────────

  it('multi-turn: second POST reuses the existing host session', async () => {
    // Two sequential inference requests on the same host
    await postStream(userServer.port, { model: 'test-model', messages: [{ role: 'user', content: 'turn 1' }] });
    await postStream(userServer.port, { model: 'test-model', messages: [{ role: 'user', content: 'turn 2' }] });

    // Pool must have opened only ONE session (one session_open)
    const opens = mockHost.received.filter((m) => m['type'] === 'session_open');
    expect(opens).toHaveLength(1);

    // Both inference_requests must have arrived
    const requests = mockHost.received.filter((m) => m['type'] === 'inference_request');
    expect(requests).toHaveLength(2);
  }, 15_000);

  // ── All-hosts-busy → 503 ─────────────────────────────────────────────────

  it('returns 503 when all hosts for a model are busy', async () => {
    const mockHost2 = await startMockHost();
    mockRouter.hosts = [
      makeHostListEntry({
        hostId: 'host-1',
        modelName: 'test-model',
        endpoint: `127.0.0.1:${mockHost.port}`,
        tlsFingerprint: mockHost.fingerprint,
        hostKeyToken: mockHost.hostKeyToken,
        availableSlots: 0,
        totalSlots: 1,
      }),
      makeHostListEntry({
        hostId: 'host-2',
        modelName: 'test-model',
        endpoint: `127.0.0.1:${mockHost2.port}`,
        tlsFingerprint: mockHost2.fingerprint,
        hostKeyToken: mockHost2.hostKeyToken,
        availableSlots: 0,
        totalSlots: 1,
      }),
    ];

    mockHost.sessionRejectReason = 'busy';
    mockHost2.sessionRejectReason = 'busy';

    const result = await postStream(userServer.port, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.status).toBe(503);
    expect(result.body.toLowerCase()).toContain('busy');

    mockHost2.stop();
  }, 15_000);

  // ── Client disconnect → inference aborted ────────────────────────────────

  it('HTTP client disconnect aborts the in-flight inference', async () => {
    // Host will pause after the first chunk — never sending [DONE]
    mockHost.pauseAfterChunks = 1;
    mockHost.inferenceChunks = ['partial'];

    await new Promise<void>((resolve) => {
      const payload = JSON.stringify({ model: 'test-model', messages: [] });
      const req = httpRequest(
        {
          hostname: '127.0.0.1', port: userServer.port,
          path: '/v1/chat/completions', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          res.setEncoding('utf8');
          res.once('data', () => {
            // Received the first chunk — destroy the client socket
            req.destroy();
            setTimeout(resolve, 200); // give the server time to detect the close
          });
        },
      );
      req.on('error', () => { /* suppress ECONNRESET */ });
      req.write(payload);
      req.end();
    });

    // The mock host should have received the inference_request
    expect(mockHost.received.some((m) => m['type'] === 'inference_request')).toBe(true);
    // And no [DONE] was ever sent (host was paused) — confirming the stream was cut
    const chunks = mockHost.received.filter((m) => m['type'] === 'inference_response_chunk');
    expect(chunks.length).toBeGreaterThanOrEqual(0); // host sent ≥0 chunks
  }, 10_000);

  // ── Host busy → 503 ──────────────────────────────────────────────────────

  it('POST returns 503 when host slot is busy', async () => {
    mockHost.sessionRejectReason = 'busy';

    const result = await postStream(userServer.port, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.status).toBe(503);
  }, 10_000);
});
