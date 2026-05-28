import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PROTOCOL_VERSION } from '@sharegrid/shared/protocol';
import { HostBusyError, InvalidTokenError, NotRegisteredError, ProtocolVersionError, TlsFingerprintError } from '@sharegrid/shared/errors';
import pino from 'pino';

// ── Mock @sharegrid/shared/tls ────────────────────────────────────────────────
const mockConnect = vi.fn();
vi.mock('@sharegrid/shared/tls', async (importOriginal) => {
  const real = await importOriginal<typeof import('@sharegrid/shared/tls')>();
  return { ...real, connectWithPinnedFingerprint: mockConnect };
});

const { createSessionClient, SessionTimeoutError } = await import('../../src/session-client.js');

// ── Mock socket ───────────────────────────────────────────────────────────────

class MockSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  writable = true;

  setEncoding(_enc: string) { return this; }
  write(data: string) { this.written.push(data); return true; }
  end(cb?: () => void) { this.destroyed = true; cb?.(); return this; }
  destroy() { this.destroyed = true; return this; }
  removeListener(event: string, fn: (...args: unknown[]) => void) {
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
  contextSize: 4096,
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
      sock.inject({ v: PROTOCOL_VERSION, type: 'response_chunk', content: 'oops' });

      await expect(openPromise).rejects.toThrow(ProtocolVersionError);
    });

    it('propagates TlsFingerprintError before any payload is sent', async () => {
      mockConnect.mockRejectedValueOnce(new TlsFingerprintError('mismatch'));

      const client = createSessionClient({ logger });
      await expect(client.openSession(fakeHost)).rejects.toThrow(TlsFingerprintError);
    });
  });

  // ─── 5-3: Prompt / response ──────────────────────────────────────────────

  describe('sendPrompt — prompt/response cycle', () => {
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

    it('sends PromptPayload with the full messages array passed by the caller', async () => {
      const { client, sock } = await openedClient();

      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'how are you?' },
      ];

      const sendPromise = client.sendPrompt(messages, vi.fn(), vi.fn());
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'response_end' });
      await sendPromise;

      const promptMsg = sock.messages().find((m) => m['type'] === 'prompt')!;
      expect(promptMsg['messages']).toEqual(messages);
    });

    it('calls onChunk for each response_chunk', async () => {
      const { client, sock } = await openedClient();
      const chunks: string[] = [];

      const sendPromise = client.sendPrompt([], (c) => chunks.push(c), vi.fn());
      await new Promise((r) => setTimeout(r, 0));

      sock.inject({ v: PROTOCOL_VERSION, type: 'response_chunk', content: 'Hello' });
      sock.inject({ v: PROTOCOL_VERSION, type: 'response_chunk', content: ' world' });
      sock.inject({ v: PROTOCOL_VERSION, type: 'response_end' });

      await sendPromise;
      expect(chunks).toEqual(['Hello', ' world']);
    });

    it('calls onEnd and resolves sendPrompt on response_end', async () => {
      const { client, sock } = await openedClient();
      const onEnd = vi.fn();

      const sendPromise = client.sendPrompt([], vi.fn(), onEnd);
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'response_end' });

      await expect(sendPromise).resolves.toBeUndefined();
      expect(onEnd).toHaveBeenCalledOnce();
    });

    it('session_timeout rejects in-flight sendPrompt with SessionTimeoutError', async () => {
      const { client, sock } = await openedClient();

      const sendPromise = client.sendPrompt([], vi.fn(), vi.fn());
      await new Promise((r) => setTimeout(r, 0));
      sock.inject({ v: PROTOCOL_VERSION, type: 'session_timeout' });

      await expect(sendPromise).rejects.toThrow(SessionTimeoutError);
    });

    it('unexpected socket close rejects in-flight sendPrompt', async () => {
      const { client, sock } = await openedClient();

      const sendPromise = client.sendPrompt([], vi.fn(), vi.fn());
      await new Promise((r) => setTimeout(r, 0));

      sock.emit('close');

      await expect(sendPromise).rejects.toThrow(/closed/i);
    });
  });
});
