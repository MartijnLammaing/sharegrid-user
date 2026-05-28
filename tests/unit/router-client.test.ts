import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TlsFingerprintError } from '@sharegrid/shared/errors';
import { PROTOCOL_VERSION } from '@sharegrid/shared/protocol';
import pino from 'pino';

// ── Mock @sharegrid/shared/tls ────────────────────────────────────────────────
const mockConnect = vi.fn();
vi.mock('@sharegrid/shared/tls', async (importOriginal) => {
  const real = await importOriginal<typeof import('@sharegrid/shared/tls')>();
  return {
    ...real,
    connectWithPinnedFingerprint: mockConnect,
  };
});

// ── Import SUT after mocks are set up ─────────────────────────────────────────
const { createRouterClient } = await import('../../src/router-client.js');

// ── Mock socket factory ───────────────────────────────────────────────────────
class MockSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  writable = true;

  setEncoding(_enc: string) { return this; }
  write(data: string) { this.written.push(data); return true; }
  end() { this.destroyed = true; return this; }
  destroy() { this.destroyed = true; return this; }
  removeListener(event: string, fn: (...args: unknown[]) => void) {
    super.removeListener(event, fn);
    return this;
  }

  inject(msg: object) {
    this.emit('data', JSON.stringify(msg) + '\n');
  }
}

const logger = pino({ level: 'silent' });
const validUrl = 'https://router.example.com:8443?fp=sha256:' + 'a'.repeat(64);
const config = { SHAREGRID_ROUTER_URL: validUrl };

describe('RouterClient (user)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends HostListRequest with correct v and type', async () => {
    const sock = new MockSocket();
    mockConnect.mockResolvedValueOnce(sock);

    const fetchPromise = createRouterClient({ config, logger }).fetchHostList();

    // Give the write a tick to happen
    await new Promise((r) => setTimeout(r, 0));

    const sent = JSON.parse(sock.written[0]!.trim()) as Record<string, unknown>;
    expect(sent['v']).toBe(PROTOCOL_VERSION);
    expect(sent['type']).toBe('host_list_request');

    // Now inject response
    sock.inject({ v: PROTOCOL_VERSION, type: 'host_list_response', hosts: [] });
    await fetchPromise;
  });

  it('parses HostListResponse and returns the hosts array', async () => {
    const sock = new MockSocket();
    mockConnect.mockResolvedValueOnce(sock);

    const hosts = [
      {
        hostId: 'h1', modelName: 'gpt', contextSize: 4096,
        endpoint: '10.0.0.1:9000', tlsFingerprint: 'sha256:' + 'b'.repeat(64),
        hostKeyToken: 'tok',
      },
    ];

    const fetchPromise = createRouterClient({ config, logger }).fetchHostList();
    await new Promise((r) => setTimeout(r, 0));
    sock.inject({ v: PROTOCOL_VERSION, type: 'host_list_response', hosts });

    const result = await fetchPromise;
    expect(result).toHaveLength(1);
    expect(result[0]!.hostId).toBe('h1');
    expect(result[0]!.modelName).toBe('gpt');
  });

  it('rejects when response type is not host_list_response', async () => {
    const sock = new MockSocket();
    mockConnect.mockResolvedValueOnce(sock);

    const fetchPromise = createRouterClient({ config, logger }).fetchHostList();
    await new Promise((r) => setTimeout(r, 0));
    sock.inject({ v: PROTOCOL_VERSION, type: 'unexpected_type' });

    await expect(fetchPromise).rejects.toThrow(/host_list_response/);
  });

  it('rejects when response v !== PROTOCOL_VERSION', async () => {
    const sock = new MockSocket();
    mockConnect.mockResolvedValueOnce(sock);

    const fetchPromise = createRouterClient({ config, logger }).fetchHostList();
    await new Promise((r) => setTimeout(r, 0));
    sock.inject({ v: 99, type: 'host_list_response', hosts: [] });

    await expect(fetchPromise).rejects.toThrow(/protocol/i);
  });

  it('destroys the socket after receiving the response', async () => {
    const sock = new MockSocket();
    mockConnect.mockResolvedValueOnce(sock);

    const fetchPromise = createRouterClient({ config, logger }).fetchHostList();
    await new Promise((r) => setTimeout(r, 0));
    sock.inject({ v: PROTOCOL_VERSION, type: 'host_list_response', hosts: [] });

    await fetchPromise;
    expect(sock.destroyed).toBe(true);
  });

  it('propagates TlsFingerprintError from connectWithPinnedFingerprint', async () => {
    mockConnect.mockRejectedValueOnce(new TlsFingerprintError('mismatch'));
    const client = createRouterClient({ config, logger });
    await expect(client.fetchHostList()).rejects.toThrow(TlsFingerprintError);
  });

  it('rejects when router closes connection before sending response', async () => {
    const sock = new MockSocket();
    mockConnect.mockResolvedValueOnce(sock);

    const fetchPromise = createRouterClient({ config, logger }).fetchHostList();
    await new Promise((r) => setTimeout(r, 0));
    sock.emit('close');

    await expect(fetchPromise).rejects.toThrow(/closed/i);
  });
});
