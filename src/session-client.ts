/**
 * Session Client — owns the direct TLS connection to a chosen LLMHost.
 *
 * Responsibilities (Phase 1):
 *  - Open a TLS connection pinned to the host's cert fingerprint.
 *  - Present the host key token to open a session.
 *  - Send prompts and stream responses back to the caller via callbacks.
 *  - Handle host-initiated termination (SessionTimeout, SessionClose).
 *  - Close the connection cleanly on user exit.
 *
 * See: docs/architecture_llmuser.md §2.2, §4
 *      docs/implementation_plan_llmuser.md Phase 3B
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
  type ChatMessage,
  type SessionOpenPayload,
  type SessionAck,
  type SessionReject,
  type PromptPayload,
  type PromptCancel,
  type PromptCancelled,
  type ResponseChunk,
  type ResponseEnd,
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

/** The in-flight prompt was cancelled by the user via cancelPrompt(). */
export class PromptCancelledError extends Error {
  readonly code = 'PROMPT_CANCELLED' as const;
  constructor(message = 'prompt cancelled') {
    super(message);
    this.name = 'PromptCancelledError';
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
   * Send a prompt and stream the response.
   * The caller owns the full conversation history and passes it on every call.
   *
   * @param messages  Full message history including the new user turn.
   * @param onChunk   Called for each streamed response token.
   * @param onEnd     Called once when the response is complete.
   * @throws {SessionTimeoutError}   if the host times out the session mid-prompt.
   * @throws {PromptCancelledError}  if cancelPrompt() was called while in flight.
   */
  sendPrompt(
    messages: ChatMessage[],
    onChunk: (content: string) => void,
    onEnd: () => void,
  ): Promise<void>;

  /**
   * Cancel the in-flight prompt. Sends prompt_cancel to the host and waits for
   * prompt_cancelled. The in-flight sendPrompt promise rejects with
   * PromptCancelledError. No-op if no prompt is in flight.
   */
  cancelPrompt(): Promise<void>;

  /** Send SessionClose and close the socket. */
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

  // In-flight prompt bookkeeping: resolve/reject are set when sendPrompt is
  // waiting for a response, cleared when the response completes.
  let promptResolve: (() => void) | null = null;
  let promptReject: ((err: Error) => void) | null = null;

  // cancelPrompt bookkeeping: set while waiting for prompt_cancelled from host.
  let cancelResolve: (() => void) | null = null;

  // ── NDJSON framing ────────────────────────────────────────────────────────

  function writeMessage(msg: object): void {
    if (sock !== null && !sock.destroyed && sock.writable) {
      sock.write(JSON.stringify(msg) + '\n');
    }
  }

  // ── openSession ───────────────────────────────────────────────────────────

  async function openSession(host: HostListEntry): Promise<void> {
    // Parse the endpoint into host + port. The endpoint is `host:port`.
    const lastColon = host.endpoint.lastIndexOf(':');
    const endpointHost = host.endpoint.slice(0, lastColon);
    const endpointPort = parseInt(host.endpoint.slice(lastColon + 1), 10);

    // Connect with TLS cert pinning BEFORE presenting the token.
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
          rejectInFlight(wrapped);
        }
      });

      sock.on('close', () => {
        sessionActive = false;
        if (!handshakeDone) {
          reject(new Error('host closed connection before session ack'));
        } else {
          rejectInFlight(new Error('host closed connection unexpectedly'));
        }
      });

      sock.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.length > MAX_MESSAGE_BYTES) {
          sock?.destroy();
          const err = new Error('host message exceeded 1 MiB');
          if (!handshakeDone) reject(err);
          else rejectInFlight(err);
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
            else rejectInFlight(err);
            return;
          }

          if (
            typeof raw !== 'object' ||
            raw === null ||
            (raw as Record<string, unknown>)['v'] !== PROTOCOL_VERSION
          ) {
            const err = new ProtocolVersionError();
            if (!handshakeDone) reject(err);
            else rejectInFlight(err);
            return;
          }

          const msg = raw as unknown as UserFromHostMessage;

          if (!handshakeDone) {
            // First message must be session_ack or session_reject.
            handleHandshakeMessage(msg, resolve, reject);
            if (msg.type === 'session_ack') {
              handshakeDone = true;
            }
          } else {
            handleSessionMessage(msg);
          }
        }
      });

      // Send session_open.
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
      case 'response_chunk': {
        const chunk: ResponseChunk = msg;
        // Route chunk to the in-flight sendPrompt call.
        if (promptResolve !== null) {
          // The CLI's onChunk callback is stored elsewhere; we need to call it.
          // We communicate via the registered chunk callback.
          activeOnChunk?.(chunk.content);
        }
        break;
      }
      case 'response_end': {
        const _end: ResponseEnd = msg;
        void _end;
        activeOnEnd?.();
        const res = promptResolve;
        promptResolve = null;
        promptReject = null;
        activeOnChunk = null;
        activeOnEnd = null;
        res?.();
        break;
      }
      case 'prompt_cancelled': {
        const _pc: PromptCancelled = msg;
        void _pc;
        // Resolve the cancelPrompt() promise first, then reject sendPrompt.
        const res = cancelResolve;
        cancelResolve = null;
        res?.();
        rejectInFlight(new PromptCancelledError());
        break;
      }
      case 'session_timeout': {
        const _t: SessionTimeout = msg;
        void _t;
        log.info('session timed out by host');
        sessionActive = false;
        rejectInFlight(new SessionTimeoutError());
        sock?.destroy();
        break;
      }
      case 'session_close': {
        const _c: SessionClose = msg;
        void _c;
        log.info('host initiated session close');
        sessionActive = false;
        // Resolve any in-flight prompt as end-of-stream.
        activeOnEnd?.();
        const res = promptResolve;
        promptResolve = null;
        promptReject = null;
        activeOnChunk = null;
        activeOnEnd = null;
        res?.();
        sock?.destroy();
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

  // ── Callbacks for the active sendPrompt call ──────────────────────────────

  let activeOnChunk: ((content: string) => void) | null = null;
  let activeOnEnd: (() => void) | null = null;

  function rejectInFlight(err: Error): void {
    const rej = promptReject;
    promptResolve = null;
    promptReject = null;
    activeOnChunk = null;
    activeOnEnd = null;
    rej?.(err);
  }

  // ── sendPrompt ─────────────────────────────────────────────────────────────

  async function sendPrompt(
    messages: ChatMessage[],
    onChunk: (content: string) => void,
    onEnd: () => void,
  ): Promise<void> {
    if (!sessionActive || sock === null) {
      throw new Error('sendPrompt called before openSession succeeded');
    }

    return new Promise<void>((resolve, reject) => {
      promptResolve = resolve;
      promptReject = reject;
      activeOnChunk = onChunk;
      activeOnEnd = onEnd;

      const payload: PromptPayload = {
        v: PROTOCOL_VERSION,
        type: 'prompt',
        messages,
      };
      writeMessage(payload);
    });
  }

  // ── cancelPrompt ──────────────────────────────────────────────────────────

  async function cancelPrompt(): Promise<void> {
    if (!sessionActive || sock === null || promptResolve === null) {
      // No prompt in flight — nothing to cancel.
      return;
    }

    return new Promise<void>((resolve) => {
      cancelResolve = resolve;
      const payload: PromptCancel = { v: PROTOCOL_VERSION, type: 'prompt_cancel' };
      writeMessage(payload);
    });
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

  return { openSession, sendPrompt, cancelPrompt, closeSession };
}

export {
  TlsFingerprintError,
  HostBusyError,
  InvalidTokenError,
  NotRegisteredError,
  ProtocolVersionError,
};
