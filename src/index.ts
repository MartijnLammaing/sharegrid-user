/**
 * LLMUser entry point — wires all components and starts the CLI.
 *
 * Startup sequence (tasks 3D-1, 3D-2):
 *  1. Load and validate configuration.
 *  2. Construct logger.
 *  3. Create RouterClient.
 *  4. Create SessionClient.
 *  5. Create CLI and run.
 *  6. Register SIGTERM handler (CLI handles SIGINT itself).
 *
 * See: docs/architecture_llmuser.md §3
 *      docs/implementation_plan_llmuser.md Phase 3D
 */

import { loadConfig } from './config.js';
import { createComponentLogger } from './logger.js';
import { createRouterClient } from './router-client.js';
import { createSessionClient } from './session-client.js';
import { createCli } from './cli.js';

async function main(): Promise<void> {
  // 1. Config — exits on invalid input.
  const config = loadConfig();

  // 2. Logger — writes to stderr so stdout stays clean for CLI output.
  const logger = createComponentLogger('main');

  // 3. Router client.
  const routerClient = createRouterClient({ config, logger });

  // 4. Session client.
  const sessionClient = createSessionClient({ logger });

  // 5. CLI.
  const cli = createCli({ routerClient, sessionClient, logger });

  // 6. SIGTERM — best-effort close any active session, then exit.
  // (CLI handles SIGINT itself per task 3C-6.)
  process.on('SIGTERM', () => {
    void sessionClient.closeSession().finally(() => process.exit(0));
  });

  // Run — this returns when the user exits cleanly.
  await cli.run();
}

main().catch((err: unknown) => {
  console.error('fatal error:', err);
  process.exit(1);
});
