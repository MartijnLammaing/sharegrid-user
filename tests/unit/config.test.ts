import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const validUrl = 'tls://router.example.com:8443?fp=sha256:' + 'a'.repeat(64);

describe('loadConfig', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number): never => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['SHAREGRID_ROUTER_URL'];
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
    process.env['SHAREGRID_ROUTER_URL'] = 'tls://router.example.com:8443';
    await expect(load()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when fp value has wrong prefix (not sha256:)', async () => {
    process.env['SHAREGRID_ROUTER_URL'] =
      'tls://router.example.com:8443?fp=md5:' + 'a'.repeat(64);
    await expect(load()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
