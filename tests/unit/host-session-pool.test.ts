import { describe, expect, it, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { HostBusyError } from '@sharegrid/shared/errors';

// ── Mock session-client ───────────────────────────────────────────────────────
// We intercept createSessionClient so every test gets a fresh, controllable mock.

const { mockCreateSessionClient } = vi.hoisted(() => ({
  mockCreateSessionClient: vi.fn(),
}));

vi.mock('../../src/session-client.js', () => ({
  createSessionClient: mockCreateSessionClient,
}));

import { createHostSessionPool } from '../../src/host-session-pool.js';

// ─────────────────────────────────────────────────────────────────────────────

const logger = pino({ level: 'silent' });

const fakeHost = {
  hostId: 'host-1',
  modelName: 'phi',
  endpoint: '10.0.0.1:9000',
  tlsFingerprint: 'sha256:' + 'a'.repeat(64),
  hostKeyToken: 'tok',
  contextSize: 4096,
  availableSlots: 1,
  totalSlots: 1,
};

const fakeHost2 = {
  hostId: 'host-2',
  modelName: 'llama',
  endpoint: '10.0.0.2:9000',
  tlsFingerprint: 'sha256:' + 'b'.repeat(64),
  hostKeyToken: 'tok2',
  contextSize: 8192,
  availableSlots: 1,
  totalSlots: 1,
};

/** Build a mock SessionClient with controllable behaviour. */
function makeMockClient(overrides: {
  alive?: boolean;
  inferring?: boolean;
  openError?: Error;
} = {}) {
  let alive = overrides.alive ?? true;
  let inferring = overrides.inferring ?? false;
  return {
    openSession: vi.fn().mockImplementation(() =>
      overrides.openError ? Promise.reject(overrides.openError) : Promise.resolve(),
    ),
    isAlive: vi.fn().mockImplementation(() => alive),
    isInferenceActive: vi.fn().mockImplementation(() => inferring),
    setAlive(v: boolean) { alive = v; },
    setInferring(v: boolean) { inferring = v; },
    closeSession: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
    sendInferenceRequest: vi.fn().mockResolvedValue(undefined),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('HostSessionPool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('first acquire creates and opens a new session', async () => {
    const client = makeMockClient();
    mockCreateSessionClient.mockReturnValueOnce(client);

    const pool = createHostSessionPool({ logger });
    const result = await pool.acquire(fakeHost);

    expect(mockCreateSessionClient).toHaveBeenCalledOnce();
    expect(client.openSession).toHaveBeenCalledWith(fakeHost);
    expect(result).toBe(client);
  });

  it('second acquire for same hostId returns the existing idle session without re-opening', async () => {
    const client = makeMockClient({ alive: true, inferring: false });
    mockCreateSessionClient.mockReturnValue(client);

    const pool = createHostSessionPool({ logger });
    const first = await pool.acquire(fakeHost);
    const second = await pool.acquire(fakeHost);

    expect(mockCreateSessionClient).toHaveBeenCalledOnce();
    expect(client.openSession).toHaveBeenCalledOnce();
    expect(second).toBe(first);
  });

  it('second acquire while the existing session is inferring opens a new session', async () => {
    const firstClient = makeMockClient({ alive: true, inferring: true });
    const secondClient = makeMockClient({ alive: true, inferring: false });
    mockCreateSessionClient
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(secondClient);

    const pool = createHostSessionPool({ logger });
    const first = await pool.acquire(fakeHost);
    const second = await pool.acquire(fakeHost);

    expect(mockCreateSessionClient).toHaveBeenCalledTimes(2);
    expect(first).toBe(firstClient);
    expect(second).toBe(secondClient);
    expect(secondClient.openSession).toHaveBeenCalledWith(fakeHost);
  });

  it('acquire prunes dead sessions before reusing idle ones', async () => {
    const dead = makeMockClient({ alive: false });
    const fresh = makeMockClient({ alive: true });
    mockCreateSessionClient
      .mockReturnValueOnce(dead)
      .mockReturnValueOnce(fresh);

    const pool = createHostSessionPool({ logger });
    await pool.acquire(fakeHost);

    const result = await pool.acquire(fakeHost);
    expect(mockCreateSessionClient).toHaveBeenCalledTimes(2);
    expect(fresh.openSession).toHaveBeenCalledWith(fakeHost);
    expect(result).toBe(fresh);
  });

  it('acquire opens a fresh session after all existing sessions have died', async () => {
    const dead = makeMockClient({ alive: true });
    const fresh = makeMockClient({ alive: true });
    mockCreateSessionClient
      .mockReturnValueOnce(dead)
      .mockReturnValueOnce(fresh);

    const pool = createHostSessionPool({ logger });
    await pool.acquire(fakeHost);

    // Kill the session
    dead.setAlive(false);

    const result = await pool.acquire(fakeHost);
    expect(mockCreateSessionClient).toHaveBeenCalledTimes(2);
    expect(fresh.openSession).toHaveBeenCalledWith(fakeHost);
    expect(result).toBe(fresh);
  });

  it('closeAll calls closeSession on every stored session and clears the pool', async () => {
    const client1 = makeMockClient({ alive: true, inferring: true });
    const client2 = makeMockClient({ alive: true, inferring: false });
    const client3 = makeMockClient({ alive: true, inferring: false });
    mockCreateSessionClient
      .mockReturnValueOnce(client1)
      .mockReturnValueOnce(client2)
      .mockReturnValueOnce(client3);

    const pool = createHostSessionPool({ logger });
    await pool.acquire(fakeHost);
    await pool.acquire(fakeHost);
    await pool.acquire(fakeHost2);

    await pool.closeAll();

    expect(client1.closeSession).toHaveBeenCalledOnce();
    expect(client2.closeSession).toHaveBeenCalledOnce();
    expect(client3.closeSession).toHaveBeenCalledOnce();

    // Pool is cleared — next acquire opens new sessions
    const fresh = makeMockClient();
    mockCreateSessionClient.mockReturnValueOnce(fresh);
    await pool.acquire(fakeHost);
    expect(fresh.openSession).toHaveBeenCalledOnce();
  });

  it('HostBusyError from openSession propagates and nothing is stored', async () => {
    const busy = makeMockClient({ openError: new HostBusyError() });
    mockCreateSessionClient.mockReturnValueOnce(busy);

    const pool = createHostSessionPool({ logger });
    await expect(pool.acquire(fakeHost)).rejects.toThrow(HostBusyError);

    // Pool should be empty — next acquire tries again with the same mock sequence
    mockCreateSessionClient.mockReturnValueOnce(busy);
    await expect(pool.acquire(fakeHost)).rejects.toThrow(HostBusyError);
  });
});
