/**
 * Shared helpers for user integration tests.
 *
 * Provides real TLS servers acting as mock router and mock host so that the
 * Router Client, Session Client, Host Session Pool, Model Registry, and API
 * Server can be exercised against genuine network connections.
 */

import { createServer as createTlsServer, type TLSSocket } from 'node:tls';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import selfsigned from 'selfsigned';
import { computeFingerprint } from '@sharegrid/shared/tls';
import { signEd25519, encodeHostKeyToken } from '@sharegrid/shared/crypto';
import { PROTOCOL_VERSION, type HostKeyTokenPayload, type HostListEntry } from '@sharegrid/shared/protocol';
import pino from 'pino';
import { createRouterClient } from '../../src/router-client.js';
import { createModelRegistry } from '../../src/model-registry.js';
import { createHostSessionPool } from '../../src/host-session-pool.js';
import { createApiServer } from '../../src/api-server.js';
import type { SessionClient } from '../../src/session-client.js';

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
  /** User access secret — must match the `roleKey` in HostListRequest. */
  userSecret: string;
  stop(): void;
}

export async function startMockRouter(hosts: HostListEntry[], userSecret?: string): Promise<MockRouter> {
  const { cert, key, fingerprint } = generateCert();
  const port = await getFreePort();
  const secret = userSecret ?? `mock-user-secret-${Date.now()}`;

  // Use a mutable reference so tests can swap hosts mid-run (e.g. set to []
  // to trigger the CLI's "No hosts available" exit path).
  const state: MockRouter = { port, fingerprint, hosts: [...hosts], userSecret: secret, stop() { server.close(); } };

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
          if (msg['roleKey'] !== secret) { sock.destroy(); return; }
          // Read from state.hosts so tests can mutate it between calls
          sendMsg(sock, { v: PROTOCOL_VERSION, type: 'host_list_response', hosts: state.hosts });
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
  /** Content chunks to emit as SSE delta.content for each inference_request */
  inferenceChunks: string[];
  /** Send session_timeout instead of inference_response_chunk on inference_request */
  sendTimeout: boolean;
  /**
   * If set, send this many chunks then pause — do NOT send [DONE].
   * Used by abort tests: the client will destroy the socket, closing the connection.
   */
  pauseAfterChunks: number | null;
  stop(): void;
}

export async function startMockHost(): Promise<MockHost> {
  const { cert, key, fingerprint } = generateCert();
  const port = await getFreePort();

  const { privateKey } = generateKeyPairSync('ed25519');

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
    inferenceChunks: ['Hello from mock host'],
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
            sendMsg(sock, { v: PROTOCOL_VERSION, type: 'session_reject', reason: state.sessionRejectReason });
            sock.end();
          } else {
            sessionOpen = true;
            sendMsg(sock, { v: PROTOCOL_VERSION, type: 'session_ack' });
          }
        } else if (msg['type'] === 'inference_request' && sessionOpen) {
          if (state.sendTimeout) {
            sendMsg(sock, { v: PROTOCOL_VERSION, type: 'session_timeout' });
            sock.end();
          } else if (state.pauseAfterChunks !== null) {
            // Send N chunks then pause — caller destroys the socket to abort
            const n = state.pauseAfterChunks;
            for (let i = 0; i < n && i < state.inferenceChunks.length; i++) {
              sendMsg(sock, {
                v: PROTOCOL_VERSION,
                type: 'inference_response_chunk',
                data: `data: ${JSON.stringify({ choices: [{ delta: { content: state.inferenceChunks[i]! } }] })}`,
              });
            }
            // Do NOT send [DONE] — leave the stream open
          } else {
            for (const chunk of state.inferenceChunks) {
              sendMsg(sock, {
                v: PROTOCOL_VERSION,
                type: 'inference_response_chunk',
                data: `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}`,
              });
            }
            sendMsg(sock, { v: PROTOCOL_VERSION, type: 'inference_response_chunk', data: 'data: [DONE]' });
          }
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

export function makeConfig(
  router: MockRouter,
  listenPort = 3000,
): { SHAREGRID_ROUTER_URL: string; SHAREGRID_LISTEN_PORT: number; SHAREGRID_MODE: 'server' | 'cli' } {
  return {
    SHAREGRID_ROUTER_URL: `https://127.0.0.1:${router.port}?fp=${router.fingerprint}&key=${router.userSecret}`,
    SHAREGRID_LISTEN_PORT: listenPort,
    SHAREGRID_MODE: 'server',
  };
}

// ── Inference helpers ─────────────────────────────────────────────────────────

/**
 * Send an inference_request via a live SessionClient and collect all
 * inference_response_chunk.data lines until 'data: [DONE]' is received.
 */
export async function collectInference(client: SessionClient, body: string): Promise<string[]> {
  const lines: string[] = [];
  await client.sendInferenceRequest(
    body,
    (sseLine: string) => { lines.push(sseLine); },
    new AbortController().signal,
  );
  return lines;
}

/**
 * Extract concatenated delta.content from an array of raw SSE lines.
 */
export function extractContent(sseLines: string[]): string {
  let content = '';
  for (const line of sseLines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const choices = parsed['choices'];
      if (!Array.isArray(choices) || choices.length === 0) continue;
      const delta = (choices[0] as Record<string, unknown>)['delta'];
      if (typeof delta !== 'object' || delta === null) continue;
      const c = (delta as Record<string, unknown>)['content'];
      if (typeof c === 'string') content += c;
    } catch { /* skip malformed */ }
  }
  return content;
}

// ── Full LLMUser server stack helper ──────────────────────────────────────────

/**
 * Start the complete LLMUser HTTP server stack against a mock router.
 * Returns the bound port and a stop function.
 */
export async function startUserServer(
  mockRouter: MockRouter,
): Promise<{ port: number; stop(): Promise<void> }> {
  const port = await getFreePort();
  const config = makeConfig(mockRouter, port);

  const routerClient = createRouterClient({ config, logger });
  const modelRegistry = createModelRegistry({ routerClient });
  const sessionPool = createHostSessionPool({ logger });
  const apiServer = createApiServer({ config, modelRegistry, sessionPool, logger });

  await apiServer.start();

  return {
    port,
    async stop() {
      await sessionPool.closeAll();
      await apiServer.stop();
    },
  };
}
