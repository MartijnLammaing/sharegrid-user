/**
 * Session Client — owns the direct TLS connection to a chosen LLMHost.
 *
 * Phase 2 responsibilities:
 *  - Open a TLS connection pinned to the host's cert fingerprint.
 *  - Present the host key token to open a session (session_open → session_ack).
 *  - Send InferenceRequestPayload messages and stream InferenceResponseChunk
 *    messages back to the caller via sendInferenceRequest.
 *  - Keep the session open between inference turns (persistent session model).
 *  - Handle host-initiated termination (SessionTimeout, SessionClose).
 *  - Expose abort() to destroy the socket (signals the host to cancel).
 *  - Close the connection cleanly on user exit.
 *
 * See: docs/architecture_llmuser.md §2.4
 *      docs/implementation_plan_llmuser.md Phase 2
 */

import { type TLSSocket } from 'node:tls';
import type { Logger } from 'pino';
import { connectWithPinnedFingerprint } from '@sharegrid/shared/tls';
import {
  HostBusyError,
  InvalidTokenError,
  NotRegisteredError,
  TlsFingerprintError,
  ProtocolVersionError,
} from '@sharegrid/shared/errors';
import {
  PROTOCOL_VERSION,
  type HostListEntry,
  type SessionOpenPayload,
  type SessionAck,
  type SessionReject,
  type InferenceRequestPayload,
  type SessionClose,
  type SessionTimeout,
  type UserFromHostMessage,
} from '@sharegrid/shared/protocol';

// ─────────────────────────────────────────────────────────────────────────────
// Local error type
// ─────────────────────────────────────────────────────────────────────────────

/** The host closed the session due to an idle timeout. */
export class SessionTimeoutError extends Error {
  readonly code = 'SESSION_TIMEOUT' as const;
  constructor(message = 'session timed out') {
    super(message);
    this.name = 'SessionTimeoutError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionClientDeps {
  logger: Logger;
}

export interface SessionClient {
  /**
   * Open a TLS connection to the host and complete the session handshake.
   *
   * @throws {TlsFingerprintError}   on cert mismatch (before token is sent).
   * @throws {HostBusyError}         if the host slot is occupied.
   * @throws {InvalidTokenError}     if the token is rejected.
   * @throws {NotRegisteredError}    if the host is not registered.
   * @throws {ProtocolVersionError}  on any unexpected first response.
   */
  openSession(host: HostListEntry): Promise<void>;

  /**
   * Send the full OpenAI request body and stream raw SSE lines back.
   *
   * Sends an `inference_request` message carrying the JSON-serialised OpenAI
   * request body. Calls `onChunk` for each received `inference_response_chunk`
   * data field. Resolves when `data: [DONE]` is received, when the host sends
   * `session_close`, or when the socket closes (e.g. after `abort()`).
   * Rejects with `SessionTimeoutError` on `session_timeout`.
   *
   * If `signal` fires, `abort()` is called automatically, which destroys the
   * socket — the host detects this and cancels the inference.
   */
  sendInferenceRequest(
    body: string,
    onChunk: (sseLine: string) => void,
    signal: AbortSignal,
  ): Promise<void>;

  /**
   * Destroy the TLS socket immediately, cancelling any in-flight inference.
   * The host detects the close, aborts the llama.cpp request, and flushes the
   * KV cache. The session is marked dead; the next acquire() will re-open it.
   */
  abort(): void;

  /** Returns true if the session socket is alive and the session is open. */
  isAlive(): boolean;

  /** Send SessionClose and close the socket gracefully. */
  closeSession(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MiB

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createSessionClient(deps: SessionClientDeps): SessionClient {
  const { logger } = deps;
  const log = logger.child({ component: 'session-client' });

  // ── Mutable connection state ──────────────────────────────────────────────
  let sock: TLSSocket | null = null;
  let sessionActive = false;

  // ── Active inference tracking ─────────────────────────────────────────────
  // Set for the duration of a sendInferenceRequest call; cleared on settlement.
  let activeInferenceResolve: (() => void) | null = null;
  let activeInferenceReject: ((err: Error) => void) | null = null;
  let activeOnChunk: ((sseLine: string) => void) | null = null;

  function resolveActiveInference(): void {
    const r = activeInferenceResolve;
    activeInferenceResolve = null;
    activeInferenceReject = null;
    activeOnChunk = null;
    r?.();
  }

  function rejectActiveInference(err: Error): void {
    const r = activeInferenceReject;
    activeInferenceResolve = null;
    activeInferenceReject = null;
    activeOnChunk = null;
    r?.(err);
  }

  // ── NDJSON framing ────────────────────────────────────────────────────────

  function writeMessage(msg: object): void {
    if (sock !== null && !sock.destroyed && sock.writable) {
      sock.write(JSON.stringify(msg) + '\n');
    }
  }

  // ── openSession ───────────────────────────────────────────────────────────

  async function openSession(host: HostListEntry): Promise<void> {
    const lastColon = host.endpoint.lastIndexOf(':');
    const endpointHost = host.endpoint.slice(0, lastColon);
    const endpointPort = parseInt(host.endpoint.slice(lastColon + 1), 10);

    sock = await connectWithPinnedFingerprint({
      host: endpointHost,
      port: endpointPort,
      fingerprint: host.tlsFingerprint,
    });

    log.info({ endpoint: host.endpoint }, 'connected to host');

    return new Promise<void>((resolve, reject) => {
      let buf = '';
      let handshakeDone = false;

      if (sock === null) {
        reject(new Error('socket was destroyed before handshake'));
        return;
      }

      sock.setEncoding('utf8');

      sock.on('error', (err: Error) => {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        if (!handshakeDone) {
          reject(wrapped);
        } else {
          log.warn({ err }, 'session socket error');
          sessionActive = false;
        }
      });

      sock.on('close', () => {
        sessionActive = false;
        if (!handshakeDone) {
          reject(new Error('host closed connection before session ack'));
        } else {
          // Settle any in-flight sendInferenceRequest (abort or unexpected close).
          resolveActiveInference();
        }
      });

      sock.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.length > MAX_MESSAGE_BYTES) {
          sock?.destroy();
          const err = new Error('host message exceeded 1 MiB');
          if (!handshakeDone) reject(err);
          else rejectActiveInference(err);
          return;
        }

        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.length === 0) continue;

          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            const err = new Error('host sent non-JSON message');
            if (!handshakeDone) reject(err);
            else rejectActiveInference(err);
            return;
          }

          if (
            typeof raw !== 'object' ||
            raw === null ||
            (raw as Record<string, unknown>)['v'] !== PROTOCOL_VERSION
          ) {
            const err = new ProtocolVersionError();
            if (!handshakeDone) reject(err);
            else rejectActiveInference(err);
            return;
          }

          const msg = raw as unknown as UserFromHostMessage;

          if (!handshakeDone) {
            handleHandshakeMessage(msg, resolve, reject);
            if (msg.type === 'session_ack') {
              handshakeDone = true;
            }
          } else {
            handleSessionMessage(msg);
          }
        }
      });

      const open: SessionOpenPayload = {
        v: PROTOCOL_VERSION,
        type: 'session_open',
        hostKeyToken: host.hostKeyToken,
      };
      writeMessage(open);
    });
  }

  function handleHandshakeMessage(
    msg: UserFromHostMessage,
    resolve: () => void,
    reject: (err: Error) => void,
  ): void {
    switch (msg.type) {
      case 'session_ack': {
        const _ack: SessionAck = msg;
        void _ack;
        sessionActive = true;
        log.info('session opened');
        resolve();
        break;
      }
      case 'session_reject': {
        const r: SessionReject = msg;
        sock?.destroy();
        sessionActive = false;
        switch (r.reason) {
          case 'busy':
            reject(new HostBusyError());
            break;
          case 'invalid_token':
            reject(new InvalidTokenError());
            break;
          case 'not_registered':
            reject(new NotRegisteredError());
            break;
          default:
            r.reason satisfies never;
            reject(new ProtocolVersionError(`unexpected session_reject reason: ${String(r.reason)}`));
        }
        break;
      }
      default:
        sock?.destroy();
        reject(new ProtocolVersionError(`unexpected message during handshake: ${msg.type}`));
    }
  }

  // ── Post-session message handler ──────────────────────────────────────────

  function handleSessionMessage(msg: UserFromHostMessage): void {
    switch (msg.type) {
      case 'inference_response_chunk': {
        // Route each raw SSE line to the active sendInferenceRequest call.
        activeOnChunk?.(msg.data);
        // The [DONE] line signals end of this inference turn.
        if (msg.data === 'data: [DONE]') {
          resolveActiveInference();
        }
        break;
      }
      case 'session_timeout': {
        const _t: SessionTimeout = msg;
        void _t;
        log.info('session timed out by host');
        sessionActive = false;
        sock?.destroy();
        rejectActiveInference(new SessionTimeoutError());
        break;
      }
      case 'session_close': {
        const _c: SessionClose = msg;
        void _c;
        log.info('host initiated session close');
        sessionActive = false;
        sock?.destroy();
        resolveActiveInference();
        break;
      }
      case 'session_ack':
      case 'session_reject':
        log.warn({ type: msg.type }, 'unexpected message in session; ignoring');
        break;
      default:
        msg satisfies never;
    }
  }

  // ── sendInferenceRequest ──────────────────────────────────────────────────

  async function sendInferenceRequest(
    body: string,
    onChunk: (sseLine: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (!sessionActive || sock === null) {
      throw new Error('session is not open');
    }

    return new Promise<void>((resolve, reject) => {
      activeInferenceResolve = resolve;
      activeInferenceReject = reject;
      activeOnChunk = onChunk;

      // When the caller's signal fires (e.g. HTTP client disconnects), destroy
      // the socket. The host detects the close and cancels inference. The close
      // handler calls resolveActiveInference(), settling this promise.
      signal.addEventListener('abort', () => { abort(); }, { once: true });

      const payload: InferenceRequestPayload = {
        v: PROTOCOL_VERSION,
        type: 'inference_request',
        body,
      };
      writeMessage(payload);
    });
  }

  // ── abort ─────────────────────────────────────────────────────────────────

  function abort(): void {
    sessionActive = false;
    sock?.destroy();
    sock = null;
  }

  // ── isAlive ───────────────────────────────────────────────────────────────

  function isAlive(): boolean {
    return sessionActive && sock !== null && !sock.destroyed;
  }

  // ── closeSession ──────────────────────────────────────────────────────────

  async function closeSession(): Promise<void> {
    if (sock === null || sock.destroyed) return;

    if (sessionActive) {
      const close: SessionClose = { v: PROTOCOL_VERSION, type: 'session_close' };
      writeMessage(close);
    }

    sessionActive = false;

    await new Promise<void>((resolve) => {
      const s = sock!;
      s.end(() => resolve());
      setTimeout(() => {
        s.destroy();
        resolve();
      }, 3_000);
    });

    sock = null;
  }

  return { openSession, sendInferenceRequest, abort, isAlive, closeSession };
}

export {
  TlsFingerprintError,
  HostBusyError,
  InvalidTokenError,
  NotRegisteredError,
  ProtocolVersionError,
};
