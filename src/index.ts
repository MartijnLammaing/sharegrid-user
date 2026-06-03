/**
 * LLMUser entry point — wires all components and starts in server or CLI mode.
 *
 * Startup sequence (Phase 2):
 *  1. Load and validate configuration.
 *  2. Construct logger.
 *  3. Create RouterClient.
 *  4. Create ModelRegistry (wraps RouterClient with a TTL cache).
 *  5. Create HostSessionPool (manages persistent TLS sessions to hosts).
 *  6. Branch on SHAREGRID_MODE:
 *       'server' → start ApiServer, print opencode.json snippet, await signals
 *       'cli'    → start interactive CLI, await completion
 *
 * See: docs/architecture_llmuser.md §1
 *      docs/implementation_plan_llmuser.md Phase 7
 */

import { loadConfig } from './config.js';
import { createComponentLogger } from './logger.js';
import { createRouterClient } from './router-client.js';
import { createModelRegistry } from './model-registry.js';
import { createHostSessionPool } from './host-session-pool.js';
import { createApiServer } from './api-server.js';
import { createCli } from './cli.js';

async function main(): Promise<void> {
  // 1. Config — exits on invalid input.
  const config = loadConfig();

  // 2. Logger — writes to stderr so stdout stays clean for CLI / snippet output.
  const logger = createComponentLogger('main');

  // 3. Router client — fetches the host list from the LLMRouter.
  const routerClient = createRouterClient({ config, logger });

  // 4. Model registry — maps HostListEntry → OpenAIModel with a 30-second cache.
  const modelRegistry = createModelRegistry({ routerClient });

  // 5. Host session pool — maintains persistent TLS sessions to LLMHosts.
  const sessionPool = createHostSessionPool({ logger });

  if (config.SHAREGRID_MODE === 'server') {
    // ── HTTP server mode (OpenCode provider adapter) ────────────────────────

    const apiServer = createApiServer({ config, modelRegistry, sessionPool, logger });
    await apiServer.start();

    const baseUrl = `http://localhost:${config.SHAREGRID_LISTEN_PORT}/v1`;
    const snippet = JSON.stringify(
      {
        provider: {
          sharegrid: {
            npm: '@ai-sdk/openai-compatible',
            name: 'ShareGrid',
            options: { baseURL: baseUrl },
          },
        },
      },
      null,
      2,
    );

    process.stdout.write(`ShareGrid provider adapter running on ${baseUrl}\n\n`);
    process.stdout.write('Add to your opencode.json:\n\n');
    process.stdout.write(snippet + '\n\n');

    const shutdown = async (): Promise<void> => {
      logger.info('shutting down');
      await sessionPool.closeAll();
      await apiServer.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => { void shutdown(); });
    process.on('SIGINT', () => { void shutdown(); });

    // Keep the process alive — the server drives execution from here.
    await new Promise<never>(() => { /* never resolves */ });

  } else {
    // ── CLI mode (standalone interactive terminal) ──────────────────────────

    const cli = createCli({ modelRegistry, sessionPool, logger });

    // SIGTERM: best-effort close all sessions, then exit.
    // (CLI handles SIGINT itself.)
    process.on('SIGTERM', () => {
      void sessionPool.closeAll().finally(() => process.exit(0));
    });

    await cli.run();

    // cli.run() returns when the user exits cleanly (empty host list or Ctrl+C at prompt).
    await sessionPool.closeAll();
  }
}

main().catch((err: unknown) => {
  console.error('fatal error:', err);
  process.exit(1);
});
