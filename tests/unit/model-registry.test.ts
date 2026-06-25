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
    contextSize: 4096 * (i + 1),
    availableSlots: 1,
    totalSlots: 2,
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
    expect(models[0]).toEqual({
      id: 'model-0',
      object: 'model',
      owned_by: 'sharegrid',
      context_length: 4096,
      sharegrid_available_slots: 1,
      sharegrid_total_slots: 2,
    });
    expect(models[1]).toEqual({
      id: 'model-1',
      object: 'model',
      owned_by: 'sharegrid',
      context_length: 8192,
      sharegrid_available_slots: 1,
      sharegrid_total_slots: 2,
    });
  });

  it('getModels() aggregates slot metadata for hosts sharing the same model name', async () => {
    const entries = [
      { hostId: 'host-a', modelName: 'phi', endpoint: '10.0.0.1:9000', tlsFingerprint: 'sha256:' + 'a'.repeat(64), hostKeyToken: 'tok-a', contextSize: 4096, availableSlots: 0, totalSlots: 2 },
      { hostId: 'host-b', modelName: 'phi', endpoint: '10.0.0.2:9000', tlsFingerprint: 'sha256:' + 'b'.repeat(64), hostKeyToken: 'tok-b', contextSize: 4096, availableSlots: 1, totalSlots: 2 },
      { hostId: 'host-c', modelName: 'llama', endpoint: '10.0.0.3:9000', tlsFingerprint: 'sha256:' + 'c'.repeat(64), hostKeyToken: 'tok-c', contextSize: 8192, availableSlots: 1, totalSlots: 1 },
    ];
    const rc = makeRouterClient(entries);
    const registry = createModelRegistry({ routerClient: rc });

    const models = await registry.getModels();

    expect(models).toHaveLength(2);
    const phi = models.find((m) => m.id === 'phi')!;
    expect(phi).toEqual({
      id: 'phi',
      object: 'model',
      owned_by: 'sharegrid',
      context_length: 4096,
      sharegrid_available_slots: 1,
      sharegrid_total_slots: 4,
    });
    const llama = models.find((m) => m.id === 'llama')!;
    expect(llama).toEqual({
      id: 'llama',
      object: 'model',
      owned_by: 'sharegrid',
      context_length: 8192,
      sharegrid_available_slots: 1,
      sharegrid_total_slots: 1,
    });
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

  it('resolveHost returns the first available host when multiple hosts serve the same model', async () => {
    const entries = [
      { hostId: 'host-a', modelName: 'phi', endpoint: '10.0.0.1:9000', tlsFingerprint: 'sha256:' + 'a'.repeat(64), hostKeyToken: 'tok-a', contextSize: 4096, availableSlots: 0, totalSlots: 2 },
      { hostId: 'host-b', modelName: 'phi', endpoint: '10.0.0.2:9000', tlsFingerprint: 'sha256:' + 'b'.repeat(64), hostKeyToken: 'tok-b', contextSize: 4096, availableSlots: 1, totalSlots: 2 },
    ];
    const rc = makeRouterClient(entries);
    const registry = createModelRegistry({ routerClient: rc });

    const result = await registry.resolveHost('phi');

    expect(result.hostId).toBe('host-b');
  });

  it('resolveHosts returns all matching hosts sorted available-first', async () => {
    const entries = [
      { hostId: 'host-a', modelName: 'phi', endpoint: '10.0.0.1:9000', tlsFingerprint: 'sha256:' + 'a'.repeat(64), hostKeyToken: 'tok-a', contextSize: 4096, availableSlots: 0, totalSlots: 2 },
      { hostId: 'host-b', modelName: 'phi', endpoint: '10.0.0.2:9000', tlsFingerprint: 'sha256:' + 'b'.repeat(64), hostKeyToken: 'tok-b', contextSize: 4096, availableSlots: 1, totalSlots: 2 },
      { hostId: 'host-c', modelName: 'phi', endpoint: '10.0.0.3:9000', tlsFingerprint: 'sha256:' + 'c'.repeat(64), hostKeyToken: 'tok-c', contextSize: 4096, availableSlots: 0, totalSlots: 2 },
    ];
    const rc = makeRouterClient(entries);
    const registry = createModelRegistry({ routerClient: rc });

    const result = await registry.resolveHosts('phi');

    expect(result).toHaveLength(3);
    expect(result.map((e) => e.hostId)).toEqual(['host-b', 'host-a', 'host-c']);
  });

  it('resolveHosts throws HostNotFoundError for an unknown model ID', async () => {
    const rc = makeRouterClient(makeEntries(1));
    const registry = createModelRegistry({ routerClient: rc });

    await expect(registry.resolveHosts('nonexistent')).rejects.toThrow(HostNotFoundError);
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
