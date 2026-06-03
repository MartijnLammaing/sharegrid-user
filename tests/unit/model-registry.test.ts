import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostNotFoundError } from '@sharegrid/shared/errors';
import { createModelRegistry } from '../../src/model-registry.js';

// ─────────────────────────────────────────────────────────────────────────────

function makeEntries(count = 2) {
  return Array.from({ length: count }, (_, i) => ({
    hostId: `host-${i}`,
    modelName: `model-${i}`,
    endpoint: `10.0.0.${i}:9000`,
    tlsFingerprint: 'sha256:' + String(i).repeat(64).slice(0, 64),
    hostKeyToken: `tok-${i}`,
  }));
}

function makeRouterClient(entries = makeEntries()) {
  return { fetchHostList: vi.fn().mockResolvedValue(entries) };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('ModelRegistry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('getModels() calls fetchHostList and maps entries to OpenAI model shape', async () => {
    const rc = makeRouterClient(makeEntries(2));
    const registry = createModelRegistry({ routerClient: rc });

    const models = await registry.getModels();

    expect(rc.fetchHostList).toHaveBeenCalledOnce();
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({ id: 'model-0', object: 'model', owned_by: 'sharegrid' });
    expect(models[1]).toEqual({ id: 'model-1', object: 'model', owned_by: 'sharegrid' });
  });

  it('second call within TTL uses cache without calling fetchHostList again', async () => {
    const rc = makeRouterClient();
    const registry = createModelRegistry({ routerClient: rc, cacheTtlMs: 10_000 });

    await registry.getModels();
    await registry.getModels();

    expect(rc.fetchHostList).toHaveBeenCalledOnce();
  });

  it('call after TTL expiry re-fetches from the router', async () => {
    const rc = makeRouterClient();
    const registry = createModelRegistry({ routerClient: rc, cacheTtlMs: 5_000 });

    await registry.getModels();

    vi.advanceTimersByTime(5_001);

    await registry.getModels();

    expect(rc.fetchHostList).toHaveBeenCalledTimes(2);
  });

  it('resolveHost returns the matching HostListEntry', async () => {
    const entries = makeEntries(3);
    const rc = makeRouterClient(entries);
    const registry = createModelRegistry({ routerClient: rc });

    const result = await registry.resolveHost('model-1');

    expect(result).toEqual(entries[1]);
  });

  it('resolveHost uses cached data without an extra fetchHostList call', async () => {
    const rc = makeRouterClient();
    const registry = createModelRegistry({ routerClient: rc, cacheTtlMs: 30_000 });

    await registry.getModels(); // warms the cache
    await registry.resolveHost('model-0');

    expect(rc.fetchHostList).toHaveBeenCalledOnce();
  });

  it('resolveHost throws HostNotFoundError for an unknown model ID', async () => {
    const rc = makeRouterClient(makeEntries(1));
    const registry = createModelRegistry({ routerClient: rc });

    await expect(registry.resolveHost('nonexistent')).rejects.toThrow(HostNotFoundError);
  });
});
