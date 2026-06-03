/**
 * Router Client — opens a single TLS connection to LLMRouter, fetches the
 * host list, and closes the connection.
 *
 * The router is not involved after this point; all subsequent traffic is
 * direct between the LLMUser and the chosen LLMHost.
 *
 * See: docs/architecture_llmuser.md §2.1
 *      docs/implementation_plan_llmuser.md Phase 3A
 */

import type { Logger } from 'pino';
import {
  parseFingerprintFromUrl,
  connectWithPinnedFingerprint,
} from '@sharegrid/shared/tls';
import { TlsFingerprintError, RoleKeyMissingError } from '@sharegrid/shared/errors';
import {
  PROTOCOL_VERSION,
  type HostListEntry,
  type HostListRequest,
  type HostListResponse,
} from '@sharegrid/shared/protocol';
import type { Config } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface RouterClientDeps {
  config: Config;
  logger: Logger;
}

export interface RouterClient {
  /**
   * Connect to the router, request the host list, close the connection, and
   * return the list. Each call opens and closes its own connection.
   *
   * @throws {TlsFingerprintError} on cert mismatch — do not retry.
   * @throws {Error} on any other connection or protocol error.
   */
  fetchHostList(): Promise<HostListEntry[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MiB

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createRouterClient(deps: RouterClientDeps): RouterClient {
  const { config, logger } = deps;
  const log = logger.child({ component: 'router-client' });

  return {
    async fetchHostList(): Promise<HostListEntry[]> {
      const { host, port, fingerprint, roleKey } = parseFingerprintFromUrl(config.SHAREGRID_ROUTER_URL);

      log.info({ host, port }, 'connecting to router');

      const sock = await connectWithPinnedFingerprint({ host, port, fingerprint });

      return new Promise<HostListEntry[]>((resolve, reject) => {
        let buf = '';
        let resolved = false;

        sock.setEncoding('utf8');

        const cleanup = (err?: Error): void => {
          if (!sock.destroyed) sock.destroy();
          if (err !== undefined && !resolved) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        };

        sock.on('error', (err: Error) => {
          if (!resolved) reject(err instanceof Error ? err : new Error(String(err)));
        });

        sock.on('data', (chunk: string) => {
          buf += chunk;
          if (buf.length > MAX_MESSAGE_BYTES) {
            cleanup(new Error('router response exceeded 1 MiB'));
            return;
          }

          const nl = buf.indexOf('\n');
          if (nl === -1) return;

          const line = buf.slice(0, nl).trim();

          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            cleanup(new Error('router sent non-JSON response'));
            return;
          }

          if (
            typeof raw !== 'object' ||
            raw === null ||
            (raw as Record<string, unknown>)['v'] !== PROTOCOL_VERSION
          ) {
            cleanup(new Error('router response has unexpected protocol version'));
            return;
          }

          const msg = raw as Record<string, unknown>;
          if (msg['type'] !== 'host_list_response') {
            cleanup(
              new Error(`expected host_list_response, got ${String(msg['type'])}`),
            );
            return;
          }

          const response = msg as unknown as HostListResponse;
          if (!Array.isArray(response.hosts)) {
            cleanup(new Error('host_list_response missing hosts array'));
            return;
          }

          resolved = true;
          log.info({ hostCount: response.hosts.length }, 'received host list');
          sock.destroy();
          resolve(response.hosts);
        });

        sock.on('close', () => {
          if (!resolved) {
            reject(new Error('router closed connection before sending host list'));
          }
        });

        // Send the request.
        const request: HostListRequest = { v: PROTOCOL_VERSION, type: 'host_list_request', roleKey };
        sock.write(JSON.stringify(request) + '\n');
      });
    },
  };
}

export { TlsFingerprintError, RoleKeyMissingError };
