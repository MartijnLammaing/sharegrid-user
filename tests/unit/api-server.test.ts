/**
 * API Server unit tests.
 *
 * Strategy: start a real HTTP server on a free port with mocked
 * ModelRegistry, HostSessionPool, and SessionClient dependencies.
 * Make actual http.request() calls so the full request/response path
 * is exercised without touching real TLS or router connections.
 */

import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { HostNotFoundError, HostBusyError, TlsFingerprintError } from '@sharegrid/shared/errors';
import { createApiServer } from '../../src/api-server.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(port: number, path: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function post(port: number, path: string, bodyObj: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(bodyObj);
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────────────────────────────────────

const fakeHost = {
  hostId: 'h1', modelName: 'phi', endpoint: '10.0.0.1:9000',
  tlsFingerprint: 'sha256:' + 'a'.repeat(64), hostKeyToken: 'tok',
  contextSize: 4096, availableSlots: 1, totalSlots: 1,
};

const fakeHost2 = {
  hostId: 'h2', modelName: 'phi', endpoint: '10.0.0.2:9000',
  tlsFingerprint: 'sha256:' + 'b'.repeat(64), hostKeyToken: 'tok2',
  contextSize: 4096, availableSlots: 1, totalSlots: 1,
};

const logger = pino({ level: 'silent' });

function makeConfig(port: number) {
  return {
    SHAREGRID_ROUTER_URL: 'https://x:1?fp=sha256:' + 'a'.repeat(64) + '&key=k',
    SHAREGRID_LISTEN_PORT: port,
    SHAREGRID_LISTEN_HOST: '127.0.0.1',
    SHAREGRID_MODE: 'server' as const,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('ApiServer', () => {
  let port: number;
  let mockGetModels: ReturnType<typeof vi.fn>;
  let mockResolveHosts: ReturnType<typeof vi.fn>;
  let mockAcquire: ReturnType<typeof vi.fn>;
  let mockSendInferenceRequest: ReturnType<typeof vi.fn>;
  let server: Awaited<ReturnType<typeof createApiServer>>;

  beforeEach(async () => {
    port = await getFreePort();
    mockGetModels = vi.fn();
    mockResolveHosts = vi.fn();
    mockAcquire = vi.fn();
    mockSendInferenceRequest = vi.fn().mockResolvedValue(undefined);

    const mockSession = { sendInferenceRequest: mockSendInferenceRequest, abort: vi.fn(), isAlive: vi.fn(() => true), closeSession: vi.fn() };
    mockAcquire.mockResolvedValue(mockSession);
    mockResolveHosts.mockResolvedValue([fakeHost]);

    server = createApiServer({
      config: makeConfig(port),
      modelRegistry: { getModels: mockGetModels, resolveHost: vi.fn(), resolveHosts: mockResolveHosts, invalidate: vi.fn() },
      sessionPool: { acquire: mockAcquire, closeAll: vi.fn() },
      logger,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    vi.clearAllMocks();
  });

  // ── GET /v1/models ──────────────────────────────────────────────────────────

  it('GET /v1/models returns { object: "list", data: [...] } with status 200', async () => {
    mockGetModels.mockResolvedValue([
      { id: 'phi', object: 'model', owned_by: 'sharegrid', context_length: 4096, sharegrid_available_slots: 1, sharegrid_total_slots: 1 },
    ]);

    const result = await get(port, '/v1/models');

    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toContain('application/json');
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body['object']).toBe('list');
    expect(Array.isArray(body['data'])).toBe(true);
    const first = (body['data'] as Array<Record<string, unknown>>)[0];
    expect(first?.['id']).toBe('phi');
    expect(first?.['sharegrid_available_slots']).toBe(1);
    expect(first?.['sharegrid_total_slots']).toBe(1);
    expect(first?.['context_length']).toBe(4096);
  });

  it('GET /v1/models returns 503 when model registry throws', async () => {
    mockGetModels.mockRejectedValue(new Error('router unreachable'));

    const result = await get(port, '/v1/models');

    expect(result.status).toBe(503);
  });

  // ── POST /v1/chat/completions ───────────────────────────────────────────────

  it('POST /chat/completions calls sendInferenceRequest with stream forced to true', async () => {
    let capturedBody = '';
    mockSendInferenceRequest.mockImplementation((body: string) => {
      capturedBody = body;
      return Promise.resolve();
    });

    await post(port, '/v1/chat/completions', { model: 'phi', messages: [{ role: 'user', content: 'hi' }] });

    expect(mockSendInferenceRequest).toHaveBeenCalledOnce();
    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(parsed['stream']).toBe(true);
    expect(parsed['model']).toBe('phi');
    expect(parsed['messages']).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('SSE lines are forwarded verbatim with \\n\\n framing', async () => {
    mockSendInferenceRequest.mockImplementation((_body: string, onChunk: (line: string) => void) => {
      onChunk('data: {"choices":[{"delta":{"content":"hello"}}]}');
      onChunk('data: [DONE]');
      return Promise.resolve();
    });

    const result = await post(port, '/v1/chat/completions', { model: 'phi' });

    expect(result.body).toContain('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    expect(result.body).toContain('data: [DONE]\n\n');
  });

  it('response ends after data: [DONE] is forwarded', async () => {
    let doneSent = false;
    mockSendInferenceRequest.mockImplementation((_body: string, onChunk: (line: string) => void) => {
      onChunk('data: [DONE]');
      doneSent = true;
      return Promise.resolve();
    });

    const result = await post(port, '/v1/chat/completions', { model: 'phi' });

    expect(doneSent).toBe(true);
    expect(result.body).toContain('data: [DONE]');
  });

  it('client disconnect triggers AbortController.abort() on the signal', async () => {
    let capturedSignal: AbortSignal | null = null;

    mockSendInferenceRequest.mockImplementation((_body: string, _onChunk: unknown, signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
    );
    const body = JSON.stringify({ model: 'phi' });
    req.on('error', () => { /* suppress ECONNRESET */ });
    req.write(body);
    req.end();

    // Poll until the server has started the inference (sendInferenceRequest called)
    const start = Date.now();
    while (capturedSignal === null && Date.now() - start < 2_000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);

    // Destroy the client request — forces the server-side connection to close
    req.destroy();

    // Poll until the server-side close event propagates and aborts the signal
    const deadline = Date.now() + 2_000;
    while (!capturedSignal!.aborted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(capturedSignal!.aborted).toBe(true);
  }, 5_000);

  // ── Error paths ─────────────────────────────────────────────────────────────

  it('unknown model returns 404', async () => {
    mockResolveHosts.mockRejectedValue(new HostNotFoundError());

    const result = await post(port, '/v1/chat/completions', { model: 'unknown' });

    expect(result.status).toBe(404);
  });

  it('first host busy routes to the second host', async () => {
    mockResolveHosts.mockResolvedValue([fakeHost, fakeHost2]);
    mockAcquire
      .mockRejectedValueOnce(new HostBusyError())
      .mockResolvedValueOnce({
        sendInferenceRequest: mockSendInferenceRequest,
        abort: vi.fn(),
        isAlive: vi.fn(() => true),
        closeSession: vi.fn(),
      });

    const result = await post(port, '/v1/chat/completions', { model: 'phi' });

    expect(mockAcquire).toHaveBeenCalledTimes(2);
    expect(mockAcquire).toHaveBeenNthCalledWith(1, fakeHost);
    expect(mockAcquire).toHaveBeenNthCalledWith(2, fakeHost2);
    expect(result.status).toBe(200);
  });

  it('all hosts busy returns 503', async () => {
    mockResolveHosts.mockResolvedValue([fakeHost, fakeHost2]);
    mockAcquire.mockRejectedValue(new HostBusyError());

    const result = await post(port, '/v1/chat/completions', { model: 'phi' });

    expect(mockAcquire).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(503);
    expect(result.body).toContain('all hosts are busy');
  });

  it('non-HostBusyError on first host invalidates cache and tries next host', async () => {
    const mockInvalidate = vi.fn();
    mockResolveHosts.mockResolvedValue([fakeHost, fakeHost2]);
    mockAcquire
      .mockRejectedValueOnce(new TlsFingerprintError('mismatch'))
      .mockResolvedValueOnce({
        sendInferenceRequest: mockSendInferenceRequest,
        abort: vi.fn(),
        isAlive: vi.fn(() => true),
        closeSession: vi.fn(),
      });

    await server.stop();
    server = createApiServer({
      config: makeConfig(port),
      modelRegistry: { getModels: mockGetModels, resolveHost: vi.fn(), resolveHosts: mockResolveHosts, invalidate: mockInvalidate },
      sessionPool: { acquire: mockAcquire, closeAll: vi.fn() },
      logger,
    });
    await server.start();

    const result = await post(port, '/v1/chat/completions', { model: 'phi' });

    expect(mockAcquire).toHaveBeenCalledTimes(2);
    expect(mockInvalidate).toHaveBeenCalledOnce();
    expect(result.status).toBe(200);
  });

  it('unknown path returns 404', async () => {
    const result = await get(port, '/unknown/path');

    expect(result.status).toBe(404);
  });
});
