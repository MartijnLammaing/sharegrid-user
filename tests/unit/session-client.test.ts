import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PROTOCOL_VERSION } from '@sharegrid/shared/protocol';
import { HostBusyError, InvalidTokenError, NotRegisteredError, ProtocolVersionError, TlsFingerprintError } from '@sharegrid/shared/errors';
import pino from 'pino';

// ── Mock @sharegrid/shared/tls ────────────────────────────────────────────────
const { mockConnect } = vi.hoisted(() => ({ mockConnect: vi.fn() }));
vi.mock('@sharegrid/shared/tls', async (importOriginal) => {
  const real = await importOriginal<typeof import('@sharegrid/shared/tls')>();
  return { ...real, connectWithPinnedFingerprint: mockConnect };
});

import { createSessionClient, SessionTimeoutError } from '../../src/session-client.js';

// ── Mock socket ───────────────────────────────────────────────────────────────

class MockSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  writable = true;

  setEncoding(_enc: string) { return this; }
  write(data: string) { this.written.push(data); return true; }
  end(cb?: () => void) { this.destroyed = true; cb?.(); return this; }
  destroy() { this.destroyed = true; return this; }
  override removeListener(event: string, fn: (...args: unknown[]) => void) {
    super.removeListener(event, fn);
    return this;
  }

  inject(msg: object) { this.emit('data', JSON.stringify(msg) + '\n'); }

  messages(): Array<Record<string, unknown>> {
    return this.written.map((w) => JSON.parse(w.trim()) as Record<string, unknown>);
  }
}

const logger = pino({ level: 'silent' });

const fakeHost = {
  hostId: 'h1',
  modelName: 'gpt',
  endpoint: '10.0.0.1:9000',
  tlsFingerprint: 'sha256:' + 'a'.repeat(64),
  hostKeyToken: 'host-key-token',
};

describe('SessionClient', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  // ─── 5-2: Handshake ─────────────────────────────────────────────────────

  describe('openSession — handshake', () => {
    it('session_ack resolves openSession', async () => {
      const sock = new MockSocket();
      mockConnect.mockResolvedValueOnce(sock);

      const client = createSessionClient({ logger });
      const openPromise = client.openSession(fakeHost);

      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'session_ack' });

      await expect(openPromise).resolves.toBeUndefined();
    });

    it('sends SessionOpenPayload before any other message', async () => {
      const sock = new MockSocket();
      mockConnect.mockResolvedValueOnce(sock);

      const client = createSessionClient({ logger });
      const openPromise = client.openSession(fakeHost);
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'session_ack' });
      await openPromise;

      const first = sock.messages()[0]!;
      expect(first['type']).toBe('session_open');
      expect(first['hostKeyToken']).toBe(fakeHost.hostKeyToken);
    });

    it.each([
      ['busy', HostBusyError],
      ['invalid_token', InvalidTokenError],
      ['not_registered', NotRegisteredError],
    ] as const)(
      'session_reject reason: %s maps to %s',
      async (reason, ErrorClass) => {
        const sock = new MockSocket();
        mockConnect.mockResolvedValueOnce(sock);

        const client = createSessionClient({ logger });
        const openPromise = client.openSession(fakeHost);

        await new Promise((r) => setTimeout(r, 0));
        sock.inject({ v: PROTOCOL_VERSION, type: 'session_reject', reason });

        await expect(openPromise).rejects.toThrow(ErrorClass);
      },
    );

    it('throws ProtocolVersionError on unexpected first message', async () => {
      const sock = new MockSocket();
      mockConnect.mockResolvedValueOnce(sock);

      const client = createSessionClient({ logger });
      const openPromise = client.openSession(fakeHost);

      await new Promise((r) => setTimeout(r, 0));
      // Send a message type that is not session_ack or session_reject
      sock.inject({ v: PROTOCOL_VERSION, type: 'session_timeout' });

      await expect(openPromise).rejects.toThrow(ProtocolVersionError);
    });

    it('propagates TlsFingerprintError before any payload is sent', async () => {
      mockConnect.mockRejectedValueOnce(new TlsFingerprintError('mismatch'));

      const client = createSessionClient({ logger });
      await expect(client.openSession(fakeHost)).rejects.toThrow(TlsFingerprintError);
    });
  });

  // ─── Phase 2: sendInferenceRequest / abort / isAlive ────────────────────
  // Full tests written in user Phase 9 of the implementation plan.

  describe('isAlive', () => {
    it('returns false before openSession', () => {
      const client = createSessionClient({ logger });
      expect(client.isAlive()).toBe(false);
    });

    it('returns true after successful openSession', async () => {
      const sock = new MockSocket();
      mockConnect.mockResolvedValueOnce(sock);
      const client = createSessionClient({ logger });
      const openPromise = client.openSession(fakeHost);
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'session_ack' });
      await openPromise;
      expect(client.isAlive()).toBe(true);
    });

    it('returns false after abort()', async () => {
      const sock = new MockSocket();
      mockConnect.mockResolvedValueOnce(sock);
      const client = createSessionClient({ logger });
      const openPromise = client.openSession(fakeHost);
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'session_ack' });
      await openPromise;
      client.abort();
      expect(client.isAlive()).toBe(false);
    });
  });

  describe('sendInferenceRequest (stub)', () => {
    it('throws "not implemented" — Phase 2 implementation pending', async () => {
      const sock = new MockSocket();
      mockConnect.mockResolvedValueOnce(sock);
      const client = createSessionClient({ logger });
      const openPromise = client.openSession(fakeHost);
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'session_ack' });
      await openPromise;

      await expect(
        client.sendInferenceRequest('{}', vi.fn(), new AbortController().signal),
      ).rejects.toThrow('not implemented');
    });
  });
});
