/**
 * CLI — the user-facing interface.
 *
 * Uses Node.js built-in `readline` for input. All user-visible output goes to
 * `process.stdout` via `process.stdout.write`. No external CLI framework.
 *
 * Responsibilities (Phase 1):
 *  - Render the host list and prompt for a selection.
 *  - Run the conversation loop, streaming responses chunk by chunk.
 *  - Handle errors per the plan spec (re-select, re-fetch, or exit).
 *  - Handle Ctrl+C (SIGINT) cleanly.
 *
 * See: docs/architecture_llmuser.md §2.3
 *      docs/implementation_plan_llmuser.md Phase 3C
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { Logger } from 'pino';
import type { HostListEntry } from '@sharegrid/shared/protocol';
import type { RouterClient } from './router-client.js';
import type { SessionClient } from './session-client.js';
import {
  SessionTimeoutError,
  PromptCancelledError,
  TlsFingerprintError,
  HostBusyError,
  InvalidTokenError,
  NotRegisteredError,
} from './session-client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface CliDeps {
  routerClient: RouterClient;
  sessionClient: SessionClient;
  logger: Logger;
}

export interface Cli {
  /** Start the full CLI flow: fetch hosts → select → conversation loop. */
  run(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createCli(deps: CliDeps): Cli {
  const { routerClient, sessionClient, logger } = deps;
  const log = logger.child({ component: 'cli' });

  let rl: ReadlineInterface | null = null;
  let sessionOpen = false;
  let generationInFlight = false;

  // ── Readline helpers ──────────────────────────────────────────────────────

  function getReadline(): ReadlineInterface {
    if (rl === null || rl.terminal === false) {
      rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });
      // Prevent readline from auto-closing on Ctrl+C. Without a listener here,
      // readline detects ^C in raw mode and calls this.close() before our
      // process SIGINT handler gets a chance to run, causing ERR_USE_AFTER_CLOSE
      // on the next readline.question() call. Re-emitting to process routes
      // control to our existing process.on('SIGINT') handler.
      rl.on('SIGINT', () => {
        process.emit('SIGINT');
      });
    }
    return rl;
  }

  function closeReadline(): void {
    if (rl !== null) {
      rl.close();
      rl = null;
    }
  }

  function prompt(question: string): Promise<string> {
    return new Promise<string>((resolve) => {
      getReadline().question(question, (answer) => {
        resolve(answer);
      });
    });
  }

  // ── Host list rendering ───────────────────────────────────────────────────

  function renderHostList(hosts: HostListEntry[]): void {
    if (hosts.length === 0) {
      process.stdout.write('\nNo hosts available.\n\n');
      return;
    }
    process.stdout.write('\nAvailable hosts:\n\n');
    hosts.forEach((h, i) => {
      process.stdout.write(
        `  [${i + 1}] ${h.modelName}  endpoint: ${h.endpoint}\n`,
      );
    });
    process.stdout.write('\n');
  }

  // ── Host selection ────────────────────────────────────────────────────────

  async function promptHostSelection(hosts: HostListEntry[]): Promise<HostListEntry> {
    while (true) {
      const raw = await prompt(`Select host [1-${hosts.length}]: `);
      const trimmed = raw.trim();
      if (trimmed === '') continue;
      const n = parseInt(trimmed, 10);
      if (Number.isNaN(n) || n < 1 || n > hosts.length) {
        process.stdout.write(`  Please enter a number between 1 and ${hosts.length}.\n`);
        continue;
      }
      return hosts[n - 1]!;
    }
  }

  // ── Conversation loop ─────────────────────────────────────────────────────

  async function conversationLoop(host: HostListEntry): Promise<'reselect' | 'refetch' | 'exit'> {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    process.stdout.write(`\nConnected to ${host.modelName}. Type a message, Ctrl+C to stop generation, Ctrl+C again to exit.\n\n`);

    while (true) {
      const input = await prompt('You: ');
      const trimmed = input.trim();
      if (trimmed === '') continue;

      messages.push({ role: 'user', content: trimmed });

      process.stdout.write('\nAssistant: ');

      let accumulated = '';
      try {
        generationInFlight = true;
        await sessionClient.sendPrompt(
          messages,
          (chunk) => {
            accumulated += chunk;
            process.stdout.write(chunk);
          },
          () => {
            // onEnd — trailing newline written below after await resolves.
          },
        );
        process.stdout.write('\n\n');
        messages.push({ role: 'assistant', content: accumulated });
      } catch (err) {
        process.stdout.write('\n');
        if (err instanceof PromptCancelledError) {
          process.stdout.write('[stopped]\n\n');
          // Discard partial response; do not add to history. Continue the loop.
        } else {
          return handlePromptError(err);
        }
      } finally {
        generationInFlight = false;
      }
    }
  }

  function handlePromptError(err: unknown): 'reselect' | 'refetch' | 'exit' {
    if (err instanceof SessionTimeoutError) {
      process.stdout.write('\n  Session timed out. Returning to host list.\n');
      return 'reselect';
    }
    if (err instanceof HostBusyError) {
      process.stdout.write('\n  Host is busy. Returning to host list.\n');
      return 'reselect';
    }
    if (err instanceof InvalidTokenError) {
      process.stdout.write('\n  Session token expired. Re-fetching host list.\n');
      return 'refetch';
    }
    if (err instanceof TlsFingerprintError) {
      process.stdout.write('\n  Host certificate mismatch. Returning to host list.\n');
      return 'reselect';
    }
    if (err instanceof NotRegisteredError) {
      process.stdout.write('\n  Host is not registered. Returning to host list.\n');
      return 'reselect';
    }
    // Generic network error.
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`\n  Connection error: ${message}. Returning to host list.\n`);
    return 'reselect';
  }

  // ── Re-select / re-fetch ──────────────────────────────────────────────────

  async function reselect(hosts: HostListEntry[]): Promise<void> {
    // Clear conversation history (new session, new context).
    renderHostList(hosts);
    if (hosts.length === 0) return;
    await runSession(hosts);
  }

  async function refetch(): Promise<void> {
    process.stdout.write('  Fetching updated host list...\n');
    let hosts: HostListEntry[];
    try {
      hosts = await routerClient.fetchHostList();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`  Failed to fetch host list: ${message}\n`);
      return;
    }
    renderHostList(hosts);
    if (hosts.length === 0) return;
    await runSession(hosts);
  }

  async function runSession(hosts: HostListEntry[]): Promise<void> {
    const host = await promptHostSelection(hosts);

    try {
      await sessionClient.openSession(host);
      sessionOpen = true;
    } catch (err) {
      sessionOpen = false;
      const action = handlePromptError(err);
      if (action === 'reselect') {
        await reselect(hosts);
      } else if (action === 'refetch') {
        await refetch();
      }
      return;
    }

    const action = await conversationLoop(host);
    sessionOpen = false;

    // Best-effort close; ignore errors (session may already be gone).
    try {
      await sessionClient.closeSession();
    } catch {
      // ignore
    }

    if (action === 'reselect') {
      await reselect(hosts);
    } else if (action === 'refetch') {
      await refetch();
    }
    // 'exit' → fall through and return
  }

  // ── SIGINT ────────────────────────────────────────────────────────────────

  function registerSigint(): void {
    process.on('SIGINT', () => {
      void (async () => {
        if (generationInFlight) {
          // Cancel the in-flight response without exiting.
          try {
            await sessionClient.cancelPrompt();
          } catch {
            // ignore — PromptCancelledError will surface through sendPrompt
          }
          return;
        }
        // Not generating — exit cleanly.
        process.stdout.write('\n\nGoodbye.\n');
        if (sessionOpen) {
          try {
            await sessionClient.closeSession();
          } catch {
            // ignore
          }
        }
        closeReadline();
        process.exit(0);
      })();
    });
  }

  // ── run ───────────────────────────────────────────────────────────────────

  async function run(): Promise<void> {
    registerSigint();

    process.stdout.write('ShareGrid LLMUser\n');
    process.stdout.write('Fetching host list...\n');

    let hosts: HostListEntry[];
    try {
      hosts = await routerClient.fetchHostList();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: could not connect to router: ${message}\n`);
      log.error({ err }, 'failed to fetch host list');
      process.exit(1);
    }

    renderHostList(hosts);

    if (hosts.length === 0) {
      process.stdout.write('No hosts available. Exiting.\n');
      return;
    }

    await runSession(hosts);

    closeReadline();
  }

  return { run };
}
