/**
 * Model Registry — fetches the available host list from the router and
 * presents it as an OpenAI-compatible model list with a short-TTL cache.
 *
 * `getModels()` is called by the API Server for GET /v1/models.
 * `resolveHost()` is called by the API Server for POST /v1/chat/completions
 * to translate a model ID back to the `HostListEntry` containing the
 * endpoint, fingerprint, and host key token needed to open a session.
 *
 * See: docs/architecture_llmuser.md §2.2
 *      docs/implementation_plan_llmuser.md Phase 4
 */

import type { HostListEntry } from '@sharegrid/shared/protocol';
import { HostNotFoundError } from '@sharegrid/shared/errors';
import type { RouterClient } from './router-client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** OpenAI-format model object returned by GET /v1/models. */
export interface OpenAIModel {
  id: string;
  object: 'model';
  owned_by: string;
}

export interface ModelRegistryDeps {
  routerClient: RouterClient;
  /** Cache TTL in milliseconds. Defaults to 30 000 (30 seconds). */
  cacheTtlMs?: number;
}

export interface ModelRegistry {
  /** Return the list of available models, using the cache when fresh. */
  getModels(): Promise<OpenAIModel[]>;
  /**
   * Find the `HostListEntry` for a given model ID.
   * Uses the same cache as `getModels()`.
   *
   * @throws {HostNotFoundError} if no host with that model name is registered.
   */
  resolveHost(modelId: string): Promise<HostListEntry>;
  /**
   * Drop the current cache immediately so the next call to `getModels()` or
   * `resolveHost()` fetches a fresh host list from the router.
   *
   * Call this whenever a connection error indicates a host has changed (e.g.
   * TlsFingerprintError after a host restart with a new ephemeral cert).
   */
  invalidate(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CACHE_TTL_MS = 30_000;

export function createModelRegistry(deps: ModelRegistryDeps): ModelRegistry {
  const { routerClient, cacheTtlMs = DEFAULT_CACHE_TTL_MS } = deps;

  // Both `models` and `entries` are derived from the same router fetch and
  // expire together — store them in a single cache object.
  let cache: { models: OpenAIModel[]; entries: HostListEntry[]; fetchedAt: number } | null = null;

  async function refresh(): Promise<void> {
    const entries = await routerClient.fetchHostList();
    const models: OpenAIModel[] = entries.map((e) => ({
      id: e.modelName,
      object: 'model',
      owned_by: 'sharegrid',
    }));
    cache = { models, entries, fetchedAt: Date.now() };
  }

  function isFresh(): boolean {
    return cache !== null && Date.now() - cache.fetchedAt < cacheTtlMs;
  }

  return {
    async getModels(): Promise<OpenAIModel[]> {
      if (!isFresh()) await refresh();
      return cache!.models;
    },

    async resolveHost(modelId: string): Promise<HostListEntry> {
      if (!isFresh()) await refresh();
      const entry = cache!.entries.find((e) => e.modelName === modelId);
      if (entry === undefined) {
        throw new HostNotFoundError(`no host with model '${modelId}' is registered`);
      }
      return entry;
    },

    invalidate(): void {
      cache = null;
    },
  };
}
