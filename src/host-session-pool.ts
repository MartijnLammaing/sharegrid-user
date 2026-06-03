/**
 * Host Session Pool — manages persistent TLS sessions to LLMHosts.
 *
 * Maintains at most one live SessionClient per hostId. `acquire` returns the
 * existing session if it is still alive, otherwise opens a fresh one. Sessions
 * stay open between inference turns for the duration of the process — this is
 * the persistent-session model described in architecture_llmuser.md §2.3.
 *
 * See: docs/architecture_llmuser.md §2.3
 *      docs/implementation_plan_llmuser.md Phase 3
 */

import type { Logger } from 'pino';
import type { HostListEntry } from '@sharegrid/shared/protocol';
import { createSessionClient, type SessionClient } from './session-client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface HostSessionPoolDeps {
  logger: Logger;
}

export interface HostSessionPool {
  /**
   * Return a live session to the given host. If no session exists or the
   * existing one has died (`isAlive() === false`), a new one is opened.
   *
   * @throws Any error from `SessionClient.openSession` (e.g. `HostBusyError`,
   *         `TlsFingerprintError`) — propagated directly; nothing is stored on
   *         failure.
   */
  acquire(host: HostListEntry): Promise<SessionClient>;

  /**
   * Gracefully close every open session and clear the pool.
   * Uses `session_close` so the host can tear down cleanly.
   */
  closeAll(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createHostSessionPool(deps: HostSessionPoolDeps): HostSessionPool {
  const { logger } = deps;
  const log = logger.child({ component: 'host-session-pool' });

  const sessions = new Map<string, SessionClient>();

  return {
    async acquire(host: HostListEntry): Promise<SessionClient> {
      const existing = sessions.get(host.hostId);
      if (existing !== undefined && existing.isAlive()) {
        return existing;
      }

      // Open a fresh session.
      log.info({ hostId: host.hostId, endpoint: host.endpoint }, 'opening new session to host');
      const client = createSessionClient({ logger });
      await client.openSession(host);
      sessions.set(host.hostId, client);
      return client;
    },

    async closeAll(): Promise<void> {
      const closing = Array.from(sessions.values()).map((s) =>
        s.closeSession().catch((err: unknown) => {
          log.warn({ err }, 'error closing session during closeAll');
        }),
      );
      await Promise.all(closing);
      sessions.clear();
      log.info('all sessions closed');
    },
  };
}
