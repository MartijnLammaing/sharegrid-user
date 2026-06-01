/**
 * Shared helpers for user integration tests.
 *
 * Provides real TLS servers acting as mock router and mock host so that the
 * Router Client and Session Client can be exercised against genuine network
 * connections.
 */

import { createServer as createTlsServer, type TLSSocket } from 'node:tls';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import selfsigned from 'selfsigned';
import { computeFingerprint } from '@sharegrid/shared/tls';
import { signEd25519, encodeHostKeyToken } from '@sharegrid/shared/crypto';
import { PROTOCOL_VERSION, type HostKeyTokenPayload, type HostListEntry } from '@sharegrid/shared/protocol';
import pino from 'pino';

export const logger = pino({ level: 'silent' });

// ── Port helper ───────────────────────────────────────────────────────────────

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ── NDJSON helpers ────────────────────────────────────────────────────────────

export function sendMsg(sock: TLSSocket, msg: object): void {
  sock.write(JSON.stringify(msg) + '\n');
}

export async function readMsg(sock: TLSSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        sock.removeListener('data', onData);
        sock.removeListener('error', onError);
        resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      }
    };
    const onError = (err: Error) => reject(err);
    sock.setEncoding('utf8');
    sock.on('data', onData);
    sock.once('error', onError);
  });
}

// ── TLS cert generation ───────────────────────────────────────────────────────

export function generateCert() {
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: 'test' }],
    { keySize: 2048, days: 1 },
  );
  const fingerprint = computeFingerprint(pems.cert);
  return { cert: pems.cert, key: pems.private, fingerprint };
}

// ── Mock Router ───────────────────────────────────────────────────────────────

export interface MockRouter {
  port: number;
  fingerprint: string;
  /** The host list that will be returned on HostListRequest */
  hosts: HostListEntry[];
  stop(): void;
}

export async function startMockRouter(hosts: HostListEntry[]): Promise<MockRouter> {
  const { cert, key, fingerprint } = generateCert();
  const port = await getFreePort();

  const server = createTlsServer({ cert, key }, (sock: TLSSocket) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg['type'] === 'host_list_request') {
          sendMsg(sock, { v: PROTOCOL_VERSION, type: 'host_list_response', hosts });
          sock.end();
        }
      }
    });
    sock.on('error', () => { /* suppress */ });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  return {
    port,
    fingerprint,
    hosts,
    stop() { server.close(); },
  };
}

// ── Mock Host ─────────────────────────────────────────────────────────────────

export type SessionRejectReason = 'busy' | 'invalid_token' | 'not_registered';

export interface MockHost {
  port: number;
  fingerprint: string;
  hostKeyToken: string;
  /** Messages received from the session client */
  received: Array<Record<string, unknown>>;
  /** Override to make session_open return a rejection */
  sessionRejectReason: SessionRejectReason | null;
  /** Chunks to send when a prompt arrives */
  promptChunks: string[];
  /** Whether to send session_timeout instead of response chunks */
  sendTimeout: boolean;
  /**
   * If set, the mock host sends this many chunks then pauses, waiting for a
   * prompt_cancel before sending prompt_cancelled. Use for cancel tests.
   */
  pauseAfterChunks: number | null;
  stop(): void;
}

export async function startMockHost(): Promise<MockHost> {
  const { cert, key, fingerprint } = generateCert();
  const port = await getFreePort();

  // Generate an Ed25519 token for this host
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  void publicKeyPem;

  function makeToken(): string {
    const payload: HostKeyTokenPayload = {
      hostId: 'mock-host',
      tlsFingerprint: fingerprint,
      expiresAt: Date.now() + 120_000,
    };
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = signEd25519(privateKey, Buffer.from(b64));
    return encodeHostKeyToken(payload, sig);
  }

  const hostKeyToken = makeToken();

  const state: MockHost = {
    port,
    fingerprint,
    hostKeyToken,
    received: [],
    sessionRejectReason: null,
    promptChunks: ['Hello from mock host'],
    sendTimeout: false,
    pauseAfterChunks: null,
    stop() { server.close(); },
  };

  const server = createTlsServer({ cert, key }, (sock: TLSSocket) => {
    let buf = '';
    let sessionOpen = false;
    sock.setEncoding('utf8');

    sock.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;

        const msg = JSON.parse(line) as Record<string, unknown>;
        state.received.push(msg);

        if (msg['type'] === 'session_open') {
          if (state.sessionRejectReason !== null) {
            sendMsg(sock, {
              v: PROTOCOL_VERSION,
              type: 'session_reject',
              reason: state.sessionRejectReason,
            });
            sock.end();
          } else {
            sessionOpen = true;
            sendMsg(sock, { v: PROTOCOL_VERSION, type: 'session_ack' });
          }
        } else if (msg['type'] === 'prompt' && sessionOpen) {
          if (state.sendTimeout) {
            sendMsg(sock, { v: PROTOCOL_VERSION, type: 'session_timeout' });
            sock.end();
          } else if (state.pauseAfterChunks !== null) {
            // Send the first N chunks then pause — wait for prompt_cancel.
            const n = state.pauseAfterChunks;
            for (let i = 0; i < n && i < state.promptChunks.length; i++) {
              sendMsg(sock, { v: PROTOCOL_VERSION, type: 'response_chunk', content: state.promptChunks[i]! });
            }
            // Do NOT send response_end — leave the stream open until cancelled.
          } else {
            for (const c of state.promptChunks) {
              sendMsg(sock, { v: PROTOCOL_VERSION, type: 'response_chunk', content: c });
            }
            sendMsg(sock, { v: PROTOCOL_VERSION, type: 'response_end' });
          }
        } else if (msg['type'] === 'prompt_cancel' && sessionOpen) {
          sendMsg(sock, { v: PROTOCOL_VERSION, type: 'prompt_cancelled' });
        } else if (msg['type'] === 'session_close') {
          sock.end();
        }
      }
    });
    sock.on('error', () => { /* suppress */ });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  return state;
}

// ── Config builder ────────────────────────────────────────────────────────────

export function makeConfig(router: MockRouter): { SHAREGRID_ROUTER_URL: string } {
  return {
    SHAREGRID_ROUTER_URL: `https://127.0.0.1:${router.port}?fp=${router.fingerprint}`,
  };
}
