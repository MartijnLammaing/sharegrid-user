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
  end(cb?: () => void) { this.destroyed = true; cb?.(); setImmediate(() => this.emit('close')); return this; }
  destroy() { this.destroyed = true; setImmediate(() => this.emit('close')); return this; }
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
  contextSize: 4096,
  availableSlots: 1,
  totalSlots: 1,
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

  describe('isInferenceActive', () => {
    it('returns false before sendInferenceRequest', async () => {
      const sock = new MockSocket();
      mockConnect.mockResolvedValueOnce(sock);
      const client = createSessionClient({ logger });
      const openPromise = client.openSession(fakeHost);
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'session_ack' });
      await openPromise;

      expect(client.isInferenceActive()).toBe(false);
    });

    it('returns true while a sendInferenceRequest promise is pending', async () => {
      const sock = new MockSocket();
      mockConnect.mockResolvedValueOnce(sock);
      const client = createSessionClient({ logger });
      const openPromise = client.openSession(fakeHost);
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'session_ack' });
      await openPromise;

      const promise = client.sendInferenceRequest('{}', vi.fn(), new AbortController().signal);
      await new Promise((r) => setTimeout(r, 0));

      expect(client.isInferenceActive()).toBe(true);

      sock.inject({ v: PROTOCOL_VERSION, type: 'inference_response_chunk', data: 'data: [DONE]' });
      await promise;
    });

    it('returns false after the promise resolves', async () => {
      const sock = new MockSocket();
      mockConnect.mockResolvedValueOnce(sock);
      const client = createSessionClient({ logger });
      const openPromise = client.openSession(fakeHost);
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'session_ack' });
      await openPromise;

      const promise = client.sendInferenceRequest('{}', vi.fn(), new AbortController().signal);
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'inference_response_chunk', data: 'data: [DONE]' });
      await promise;

      expect(client.isInferenceActive()).toBe(false);
    });

    it('returns false after the promise rejects', async () => {
      const sock = new MockSocket();
      mockConnect.mockResolvedValueOnce(sock);
      const client = createSessionClient({ logger });
      const openPromise = client.openSession(fakeHost);
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'session_ack' });
      await openPromise;

      const promise = client.sendInferenceRequest('{}', vi.fn(), new AbortController().signal);
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'session_timeout' });

      await expect(promise).rejects.toThrow(SessionTimeoutError);
      expect(client.isInferenceActive()).toBe(false);
    });
  });

  // ─── Phase 2: sendInferenceRequest ─────────────────────────────────────────

  describe('sendInferenceRequest', () => {
    async function openedClient() {
      const sock = new MockSocket();
      mockConnect.mockResolvedValueOnce(sock);
      const client = createSessionClient({ logger });
      const openPromise = client.openSession(fakeHost);
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'session_ack' });
      await openPromise;
      return { client, sock };
    }

    it('sends inference_request with the correct body', async () => {
      const { client, sock } = await openedClient();
      const body = '{"messages":[],"stream":true}';

      // Don't await — we'll settle it ourselves
      const promise = client.sendInferenceRequest(body, vi.fn(), new AbortController().signal);
      await new Promise((r) => setTimeout(r, 0));

      const msgs = sock.messages();
      const req = msgs.find((m) => m['type'] === 'inference_request')!;
      expect(req).toBeDefined();
      expect(req['body']).toBe(body);

      // Settle by injecting [DONE]
      sock.inject({ v: PROTOCOL_VERSION, type: 'inference_response_chunk', data: 'data: [DONE]' });
      await promise;
    });

    it('calls onChunk for each inference_response_chunk.data', async () => {
      const { client, sock } = await openedClient();
      const chunks: string[] = [];

      const promise = client.sendInferenceRequest('{}', (line) => chunks.push(line), new AbortController().signal);
      await new Promise((r) => setTimeout(r, 0));

      sock.inject({ v: PROTOCOL_VERSION, type: 'inference_response_chunk', data: 'data: hello' });
      sock.inject({ v: PROTOCOL_VERSION, type: 'inference_response_chunk', data: 'data: world' });
      sock.inject({ v: PROTOCOL_VERSION, type: 'inference_response_chunk', data: 'data: [DONE]' });
      await promise;

      expect(chunks).toEqual(['data: hello', 'data: world', 'data: [DONE]']);
    });

    it('resolves when data: [DONE] chunk is received', async () => {
      const { client, sock } = await openedClient();

      const promise = client.sendInferenceRequest('{}', vi.fn(), new AbortController().signal);
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'inference_response_chunk', data: 'data: [DONE]' });

      await expect(promise).resolves.toBeUndefined();
    });

    it('does not resolve before [DONE] is received', async () => {
      const { client, sock } = await openedClient();

      let settled = false;
      const promise = client.sendInferenceRequest('{}', vi.fn(), new AbortController().signal);
      promise.then(() => { settled = true; }).catch(() => { settled = true; });

      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'inference_response_chunk', data: 'data: partial' });
      await new Promise((r) => setTimeout(r, 0));

      expect(settled).toBe(false);

      // Settle
      sock.inject({ v: PROTOCOL_VERSION, type: 'inference_response_chunk', data: 'data: [DONE]' });
      await promise;
    });

    it('resolves cleanly when abort() is called mid-inference', async () => {
      const { client } = await openedClient();

      const promise = client.sendInferenceRequest('{}', vi.fn(), new AbortController().signal);
      await new Promise((r) => setTimeout(r, 0));

      client.abort();

      await expect(promise).resolves.toBeUndefined();
    });

    it('signal.abort calls abort() which destroys socket and resolves promise', async () => {
      const { client, sock } = await openedClient();

      const controller = new AbortController();
      const promise = client.sendInferenceRequest('{}', vi.fn(), controller.signal);
      await new Promise((r) => setTimeout(r, 0));

      controller.abort();
      await new Promise((r) => setTimeout(r, 0));

      await expect(promise).resolves.toBeUndefined();
      expect(sock.destroyed).toBe(true);
      expect(client.isAlive()).toBe(false);
    });

    it('rejects with SessionTimeoutError on session_timeout', async () => {
      const { client, sock } = await openedClient();

      const promise = client.sendInferenceRequest('{}', vi.fn(), new AbortController().signal);
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'session_timeout' });

      await expect(promise).rejects.toThrow(SessionTimeoutError);
    });

    it('resolves cleanly on host-initiated session_close', async () => {
      const { client, sock } = await openedClient();

      const promise = client.sendInferenceRequest('{}', vi.fn(), new AbortController().signal);
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'session_close' });

      await expect(promise).resolves.toBeUndefined();
    });

    it('stale inference_response_chunk after [DONE] is a no-op', async () => {
      const { client, sock } = await openedClient();
      const chunks: string[] = [];

      const promise = client.sendInferenceRequest('{}', (line) => chunks.push(line), new AbortController().signal);
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'inference_response_chunk', data: 'data: [DONE]' });
      await promise;

      const countBefore = chunks.length;
      // Inject a late chunk — should be a no-op
      sock.inject({ v: PROTOCOL_VERSION, type: 'inference_response_chunk', data: 'data: stale' });
      await new Promise((r) => setTimeout(r, 0));

      expect(chunks.length).toBe(countBefore);
    });

    it('throws "session is not open" when called before openSession', async () => {
      const client = createSessionClient({ logger });
      await expect(
        client.sendInferenceRequest('{}', vi.fn(), new AbortController().signal),
      ).rejects.toThrow('session is not open');
    });
  });
});
