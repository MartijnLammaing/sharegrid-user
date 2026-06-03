/**
 * CLI — the standalone interactive interface for LLMUser.
 *
 * Uses Node.js built-in `readline` for input. All user-visible output goes to
 * `process.stdout` via `process.stdout.write`. No external CLI framework.
 *
 * Responsibilities:
 *  - Fetch the available model list via ModelRegistry and render it.
 *  - Prompt the user to select a model.
 *  - Run the conversation loop: acquire a session per prompt via HostSessionPool,
 *    stream raw SSE lines from the host, parse delta.content for display.
 *  - Handle Ctrl+C (SIGINT): abort in-flight generation cleanly; exit at prompt.
 *
 * See: docs/architecture_llmuser.md §2.6
 *      docs/implementation_plan_llmuser.md Phase 6
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { Logger } from 'pino';
import { HostBusyError, InvalidTokenError, HostNotFoundError } from '@sharegrid/shared/errors';
import {
  SessionTimeoutError,
  TlsFingerprintError,
  NotRegisteredError,
} from './session-client.js';
import type { ModelRegistry, OpenAIModel } from './model-registry.js';
import type { HostSessionPool } from './host-session-pool.js';
import type { HostListEntry } from '@sharegrid/shared/protocol';

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'Be direct and concise. Answer the question. Do not add unnecessary preamble, ' +
  'caveats, filler, or repetition. Do not restate what was already said. ' +
  'If the answer is short, keep it short.';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface CliDeps {
  modelRegistry: ModelRegistry;
  sessionPool: HostSessionPool;
  logger: Logger;
}

export interface Cli {
  /** Start the full CLI flow: fetch models → select → conversation loop. */
  run(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createCli(deps: CliDeps): Cli {
  const { modelRegistry, sessionPool, logger } = deps;
  const log = logger.child({ component: 'cli' });

  let rl: ReadlineInterface | null = null;
  let generationInFlight = false;
  // Set during an active sendInferenceRequest call so SIGINT can abort it.
  let currentAbortController: AbortController | null = null;

  // ── Readline helpers ──────────────────────────────────────────────────────

  function getReadline(): ReadlineInterface {
    if (rl === null) {
      rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      rl.on('SIGINT', () => { process.emit('SIGINT'); });
    }
    return rl;
  }

  function closeReadline(): void {
    if (rl !== null) { rl.close(); rl = null; }
  }

  function prompt(question: string): Promise<string> {
    return new Promise<string>((resolve) => {
      getReadline().question(question, (answer) => resolve(answer));
    });
  }

  // ── Model list rendering ──────────────────────────────────────────────────

  function renderModelList(models: OpenAIModel[]): void {
    if (models.length === 0) {
      process.stdout.write('\nNo hosts available.\n\n');
      return;
    }
    process.stdout.write('\nAvailable models:\n\n');
    models.forEach((m, i) => {
      process.stdout.write(`  [${i + 1}] ${m.id}\n`);
    });
    process.stdout.write('\n');
  }

  // ── Model selection ───────────────────────────────────────────────────────

  async function promptModelSelection(models: OpenAIModel[]): Promise<string> {
    while (true) {
      const raw = await prompt(`Select model [1-${models.length}]: `);
      const trimmed = raw.trim();
      if (trimmed === '') continue;
      const n = parseInt(trimmed, 10);
      if (Number.isNaN(n) || n < 1 || n > models.length) {
        process.stdout.write(`  Please enter a number between 1 and ${models.length}.\n`);
        continue;
      }
      return models[n - 1]!.id;
    }
  }

  // ── SSE parsing helper ────────────────────────────────────────────────────

  /**
   * Parse a raw SSE line (e.g. `"data: {...}"`) and extract the
   * `choices[0].delta.content` string. Returns `null` if the line carries no
   * displayable text (blank lines, `[DONE]`, tool-call deltas, etc.).
   *
   * Also writes `[tool call]` to stdout when the delta contains `tool_calls`.
   */
  function parseSseLine(line: string): string | null {
    if (!line.startsWith('data: ')) return null;
    const data = line.slice(6).trim();
    if (data === '[DONE]') return null;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const choices = parsed['choices'];
      if (!Array.isArray(choices) || choices.length === 0) return null;
      const delta = (choices[0] as Record<string, unknown>)['delta'];
      if (typeof delta !== 'object' || delta === null) return null;
      const d = delta as Record<string, unknown>;

      // Tool-call delta — note it briefly, return no content.
      if (Array.isArray(d['tool_calls']) && (d['tool_calls'] as unknown[]).length > 0) {
        process.stdout.write('[tool call]');
        return null;
      }

      const content = d['content'];
      return typeof content === 'string' ? content : null;
    } catch {
      return null; // malformed JSON — skip silently
    }
  }

  // ── Error classifier ──────────────────────────────────────────────────────

  function classifyError(err: unknown): 'reselect' | 'refetch' | 'exit' {
    if (err instanceof SessionTimeoutError) {
      process.stdout.write('\n  Session timed out. Returning to model list.\n');
      return 'reselect';
    }
    if (err instanceof HostBusyError) {
      process.stdout.write('\n  Host is busy. Returning to model list.\n');
      return 'reselect';
    }
    if (err instanceof InvalidTokenError) {
      process.stdout.write('\n  Session token expired. Re-fetching model list.\n');
      return 'refetch';
    }
    if (err instanceof TlsFingerprintError) {
      process.stdout.write('\n  Host certificate mismatch. Returning to model list.\n');
      return 'reselect';
    }
    if (err instanceof NotRegisteredError) {
      process.stdout.write('\n  Host is not registered. Returning to model list.\n');
      return 'reselect';
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`\n  Connection error: ${message}. Returning to model list.\n`);
    return 'reselect';
  }

  // ── Conversation loop ─────────────────────────────────────────────────────

  async function conversationLoop(host: HostListEntry): Promise<'reselect' | 'refetch' | 'exit'> {
    const messages: Array<{ role: 'user' | 'system' | 'assistant'; content: string }> = [];

    process.stdout.write(
      `\nConnected to ${host.modelName}. Type a message, Ctrl+C to stop generation, Ctrl+C again to exit.\n\n`,
    );

    while (true) {
      const input = await prompt('You: ');
      const trimmed = input.trim();
      if (trimmed === '') continue;

      messages.push({ role: 'user', content: trimmed });
      process.stdout.write('\nAssistant: ');

      // Acquire (or reuse) a session for this turn.
      let client: Awaited<ReturnType<typeof sessionPool.acquire>>;
      try {
        client = await sessionPool.acquire(host);
      } catch (err) {
        messages.pop(); // discard the user message — turn never happened
        return classifyError(err);
      }

      const controller = new AbortController();
      currentAbortController = controller;
      generationInFlight = true;

      let accumulated = '';
      try {
        await client.sendInferenceRequest(
          JSON.stringify({
            model: host.modelName,
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
            stream: true,
          }),
          (sseLine: string) => {
            const content = parseSseLine(sseLine);
            if (content !== null) {
              accumulated += content;
              process.stdout.write(content);
            }
          },
          controller.signal,
        );
      } catch (err) {
        // sendInferenceRequest rejects only on SessionTimeoutError.
        process.stdout.write('\n');
        messages.pop();
        return classifyError(err);
      } finally {
        generationInFlight = false;
        currentAbortController = null;
      }

      if (controller.signal.aborted) {
        // Ctrl+C during generation — discard partial turn and continue.
        process.stdout.write('\n[stopped]\n\n');
        messages.pop();
      } else {
        process.stdout.write('\n\n');
        if (accumulated.length > 0) {
          messages.push({ role: 'assistant', content: accumulated });
        }
      }
    }
  }

  // ── SIGINT ────────────────────────────────────────────────────────────────

  function registerSigint(): void {
    process.on('SIGINT', () => {
      void (async () => {
        if (generationInFlight && currentAbortController !== null) {
          // Abort the in-flight request — the signal listener inside
          // sendInferenceRequest will call session.abort() automatically.
          currentAbortController.abort();
          return;
        }
        // Not generating — exit cleanly.
        process.stdout.write('\n\nGoodbye.\n');
        await sessionPool.closeAll().catch(() => { /* best-effort */ });
        closeReadline();
        process.exit(0);
      })();
    });
  }

  // ── run ───────────────────────────────────────────────────────────────────

  async function run(): Promise<void> {
    registerSigint();
    process.stdout.write('ShareGrid LLMUser\n');

    while (true) {
      // Fetch (or reuse cached) model list.
      process.stdout.write('Fetching model list...\n');
      let models: OpenAIModel[];
      try {
        models = await modelRegistry.getModels();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: could not connect to router: ${message}\n`);
        log.error({ err }, 'failed to fetch model list');
        process.exit(1);
      }

      renderModelList(models);

      if (models.length === 0) {
        process.stdout.write('No hosts available. Exiting.\n');
        break;
      }

      // User selects a model.
      const modelId = await promptModelSelection(models);

      // Resolve the model ID to a HostListEntry.
      let host: HostListEntry;
      try {
        host = await modelRegistry.resolveHost(modelId);
      } catch (err) {
        if (err instanceof HostNotFoundError) {
          process.stdout.write('  Model no longer available. Re-fetching model list.\n');
        } else {
          const message = err instanceof Error ? err.message : String(err);
          process.stdout.write(`  Error resolving host: ${message}. Re-fetching model list.\n`);
        }
        continue; // loop back to getModels()
      }

      // Run the conversation. Both 'reselect' and 'refetch' loop back.
      const action = await conversationLoop(host);
      if (action === 'exit') break;
      // 'reselect' and 'refetch' → continue outer loop (getModels again)
    }

    closeReadline();
  }

  return { run };
}
