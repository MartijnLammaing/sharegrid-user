import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from '@vitest/spy';

const validUrl = 'https://router.example.com:8443?fp=sha256:' + 'a'.repeat(64) + '&key=testUserKey123';

describe('loadConfig', () => {
  let exitSpy: MockInstance<(code?: number) => never>;

  beforeEach(() => {
    vi.resetModules();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(
      (_code?: string | number | null): never => {
        throw new Error('process.exit called');
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['SHAREGRID_ROUTER_URL'];
    delete process.env['SHAREGRID_LISTEN_PORT'];
    delete process.env['SHAREGRID_MODE'];
  });

  async function load() {
    const { loadConfig } = await import('../../src/config.js');
    return loadConfig();
  }

  it('returns parsed config when SHAREGRID_ROUTER_URL is valid', async () => {
    process.env['SHAREGRID_ROUTER_URL'] = validUrl;
    const config = await load();
    expect(config.SHAREGRID_ROUTER_URL).toBe(validUrl);
  });

  it('exits with code 1 when SHAREGRID_ROUTER_URL is missing', async () => {
    delete process.env['SHAREGRID_ROUTER_URL'];
    await expect(load()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when SHAREGRID_ROUTER_URL is not a valid URL', async () => {
    process.env['SHAREGRID_ROUTER_URL'] = 'not-a-url';
    await expect(load()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when SHAREGRID_ROUTER_URL lacks fp query param', async () => {
    process.env['SHAREGRID_ROUTER_URL'] = 'https://router.example.com:8443?key=testUserKey123';
    await expect(load()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when fp value has wrong prefix (not sha256:)', async () => {
    process.env['SHAREGRID_ROUTER_URL'] =
      'https://router.example.com:8443?fp=md5:' + 'a'.repeat(64) + '&key=testUserKey123';
    await expect(load()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when SHAREGRID_ROUTER_URL has fp but no key query param', async () => {
    process.env['SHAREGRID_ROUTER_URL'] = 'https://router.example.com:8443?fp=sha256:' + 'a'.repeat(64);
    await expect(load()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('parses correctly when SHAREGRID_ROUTER_URL has both fp and key params', async () => {
    process.env['SHAREGRID_ROUTER_URL'] = validUrl;
    const config = await load();
    expect(config.SHAREGRID_ROUTER_URL).toContain('key=testUserKey123');
  });

  // ── SHAREGRID_LISTEN_PORT ─────────────────────────────────────────────────

  describe('SHAREGRID_LISTEN_PORT', () => {
    it('defaults to 3000 when not set', async () => {
      process.env['SHAREGRID_ROUTER_URL'] = validUrl;
      const config = await load();
      expect(config.SHAREGRID_LISTEN_PORT).toBe(3000);
    });

    it('parses a valid port string as a number', async () => {
      process.env['SHAREGRID_ROUTER_URL'] = validUrl;
      process.env['SHAREGRID_LISTEN_PORT'] = '9090';
      const config = await load();
      expect(config.SHAREGRID_LISTEN_PORT).toBe(9090);
    });

    it('exits with code 1 for port 0 (below minimum)', async () => {
      process.env['SHAREGRID_ROUTER_URL'] = validUrl;
      process.env['SHAREGRID_LISTEN_PORT'] = '0';
      await expect(load()).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits with code 1 for port 65536 (above maximum)', async () => {
      process.env['SHAREGRID_ROUTER_URL'] = validUrl;
      process.env['SHAREGRID_LISTEN_PORT'] = '65536';
      await expect(load()).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits with code 1 for a non-numeric value', async () => {
      process.env['SHAREGRID_ROUTER_URL'] = validUrl;
      process.env['SHAREGRID_LISTEN_PORT'] = 'abc';
      await expect(load()).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ── SHAREGRID_MODE ────────────────────────────────────────────────────────

  describe('SHAREGRID_MODE', () => {
    it('defaults to "server" when not set', async () => {
      process.env['SHAREGRID_ROUTER_URL'] = validUrl;
      const config = await load();
      expect(config.SHAREGRID_MODE).toBe('server');
    });

    it('parses "server" correctly', async () => {
      process.env['SHAREGRID_ROUTER_URL'] = validUrl;
      process.env['SHAREGRID_MODE'] = 'server';
      const config = await load();
      expect(config.SHAREGRID_MODE).toBe('server');
    });

    it('parses "cli" correctly', async () => {
      process.env['SHAREGRID_ROUTER_URL'] = validUrl;
      process.env['SHAREGRID_MODE'] = 'cli';
      const config = await load();
      expect(config.SHAREGRID_MODE).toBe('cli');
    });

    it('exits with code 1 for an invalid mode value', async () => {
      process.env['SHAREGRID_ROUTER_URL'] = validUrl;
      process.env['SHAREGRID_MODE'] = 'web';
      await expect(load()).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
