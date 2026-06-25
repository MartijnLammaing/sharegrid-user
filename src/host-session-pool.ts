/**
 * Host Session Pool — manages persistent TLS sessions to LLMHosts.
 *
 * Maintains a list of live SessionClients per hostId. `acquire` reuses an idle
 * session for the same host when available (conversation affinity); otherwise
 * it opens a fresh session. Sessions stay open between inference turns for the
 * duration of the process — this is the persistent-session model described in
 * architecture_llmuser.md §2.3.
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
   * Return a live session to the given host. Reuses an idle, alive session if
   * one exists (conversation affinity); otherwise opens a new one.
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

  const sessions = new Map<string, SessionClient[]>();

  return {
    async acquire(host: HostListEntry): Promise<SessionClient> {
      let list = sessions.get(host.hostId);
      if (list === undefined) {
        list = [];
        sessions.set(host.hostId, list);
      }

      // Prune dead sessions in-place so they are not reused.
      list = list.filter((s) => s.isAlive());
      sessions.set(host.hostId, list);

      // Conversation affinity: reuse an idle session if one exists.
      const idle = list.find((s) => !s.isInferenceActive());
      if (idle !== undefined) {
        return idle;
      }

      // No idle session available — open a new one.
      log.info({ hostId: host.hostId, endpoint: host.endpoint }, 'opening new session to host');
      const client = createSessionClient({ logger });
      await client.openSession(host);
      list.push(client);
      return client;
    },

    async closeAll(): Promise<void> {
      const closing = [...sessions.values()]
        .flatMap((list) => list)
        .map((s) =>
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
