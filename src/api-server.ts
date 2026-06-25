/**
 * API Server — OpenAI-compatible HTTP server for the LLMUser adapter.
 *
 * Binds to 0.0.0.0 inside the Docker container. The Docker port mapping
 * restricts host exposure to 127.0.0.1, so the server is not accessible from
 * the network. OpenCode connects to it as a custom provider using
 * @ai-sdk/openai-compatible. No authentication is required; the ShareGrid
 * credentials live in the adapter's environment.
 *
 * Endpoints:
 *   GET  /v1/models               — returns the active host list as OpenAI models
 *   POST /v1/chat/completions     — routes a streaming inference request to a host
 *
 * See: docs/architecture_llmuser.md §2.5
 *      docs/implementation_plan_llmuser.md Phase 5
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Logger } from 'pino';
import { HostNotFoundError, HostBusyError, TlsFingerprintError } from '@sharegrid/shared/errors';
import type { Config } from './config.js';
import type { ModelRegistry } from './model-registry.js';
import type { HostSessionPool } from './host-session-pool.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiServerDeps {
  config: Config;
  modelRegistry: ModelRegistry;
  sessionPool: HostSessionPool;
  logger: Logger;
}

export interface ApiServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createApiServer(deps: ApiServerDeps): ApiServer {
  const { config, modelRegistry, sessionPool, logger } = deps;
  const log = logger.child({ component: 'api-server' });

  let server: Server | null = null;

  // ── Body collection ────────────────────────────────────────────────────────

  function collectBody(req: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => { data += chunk; });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  // ── JSON response helpers ──────────────────────────────────────────────────

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function sendError(res: ServerResponse, status: number, message: string, type = 'api_error'): void {
    sendJson(res, status, { error: { message, type } });
  }

  // ── GET /v1/models ─────────────────────────────────────────────────────────

  async function handleGetModels(res: ServerResponse): Promise<void> {
    try {
      const models = await modelRegistry.getModels();
      sendJson(res, 200, { object: 'list', data: models });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to fetch models';
      log.error({ err }, 'GET /v1/models failed');
      sendError(res, 503, message, 'service_unavailable');
    }
  }

  // ── POST /v1/chat/completions ──────────────────────────────────────────────

  async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. Collect and parse the request body.
    let rawBody: string;
    try {
      rawBody = await collectBody(req);
    } catch {
      sendError(res, 400, 'failed to read request body', 'invalid_request');
      return;
    }

    let requestObj: Record<string, unknown>;
    try {
      requestObj = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      sendError(res, 400, 'request body must be valid JSON', 'invalid_request');
      return;
    }

    const model = requestObj['model'];
    if (typeof model !== 'string' || model.length === 0) {
      sendError(res, 400, 'request body must include a non-empty "model" field', 'invalid_request');
      return;
    }

    // 2. Force stream: true — the adapter always streams.
    requestObj['stream'] = true;
    const bodyString = JSON.stringify(requestObj);

    // 3. Resolve ordered list of hosts for this model.
    let hosts: Awaited<ReturnType<typeof modelRegistry.resolveHosts>>;
    try {
      hosts = await modelRegistry.resolveHosts(model);
    } catch (err) {
      if (err instanceof HostNotFoundError) {
        sendError(res, 404, `model '${model}' not found`, 'not_found');
      } else {
        log.error({ err }, 'error resolving hosts');
        sendError(res, 500, 'internal server error', 'internal_error');
      }
      return;
    }

    // 4. Acquire a session, trying hosts in order. HostBusyError means that
    //    host is full — try the next. Other errors (e.g. TlsFingerprintError)
    //    suggest stale registry data; invalidate the cache and continue.
    let session: Awaited<ReturnType<typeof sessionPool.acquire>> | null = null;
    let lastError: Error | null = null;
    for (const host of hosts) {
      try {
        session = await sessionPool.acquire(host);
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (err instanceof HostBusyError) {
          log.debug({ hostId: host.hostId }, 'host busy, trying next host');
          continue;
        }
        if (err instanceof TlsFingerprintError) {
          log.warn(
            { err, hostId: host.hostId },
            'host TLS fingerprint mismatch — invalidating cache and trying next host',
          );
          modelRegistry.invalidate();
          continue;
        }
        log.error({ err, hostId: host.hostId }, 'error acquiring session');
        sendError(res, 500, 'internal server error', 'internal_error');
        return;
      }
    }

    if (session === null) {
      const message = lastError instanceof HostBusyError
        ? 'all hosts are busy — try again later'
        : 'no host available for the requested model';
      sendError(res, 503, message, 'service_unavailable');
      return;
    }

    // 5. Commit headers — no more error status changes after this point.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // 6. Wire up cancellation for client disconnect.
    //    `res.on('close')` fires on both client disconnect AND after res.end(),
    //    so we only abort if inference hasn't already completed normally.
    const controller = new AbortController();
    let inferenceCompleted = false;
    res.on('close', () => {
      if (!inferenceCompleted && !controller.signal.aborted) {
        controller.abort();
      }
    });

    // 7. Stream inference — each raw SSE line from the host is forwarded.
    try {
      await session.sendInferenceRequest(
        bodyString,
        (sseLine: string) => {
          res.write(sseLine + '\n\n');
        },
        controller.signal,
      );
    } catch (err) {
      // Headers already sent — can only close the connection.
      log.error({ err }, 'error during inference streaming');
    }

    inferenceCompleted = true;
    res.end();
  }

  // ── Request dispatcher ─────────────────────────────────────────────────────

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const method = (req.method ?? 'GET').toUpperCase();

    log.debug({ method, url }, 'incoming request');

    try {
      if (method === 'GET' && url === '/v1/models') {
        await handleGetModels(res);
      } else if (method === 'POST' && url === '/v1/chat/completions') {
        await handleChatCompletions(req, res);
      } else {
        sendError(res, 404, `${method} ${url} not found`, 'not_found');
      }
    } catch (err) {
      log.error({ err }, 'unhandled request error');
      if (!res.headersSent) {
        sendError(res, 500, 'internal server error', 'internal_error');
      } else {
        res.end();
      }
    }
  }

  // ── Public interface ───────────────────────────────────────────────────────

  return {
    start(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        server = createServer((req, res) => { void handleRequest(req, res); });
        server.on('error', reject);
        server.listen(config.SHAREGRID_LISTEN_PORT, config.SHAREGRID_LISTEN_HOST, () => {
          log.info({ port: config.SHAREGRID_LISTEN_PORT }, 'API server listening');
          resolve();
        });
      });
    },

    stop(): Promise<void> {
      return new Promise<void>((resolve) => {
        if (server === null) { resolve(); return; }
        const fallback = setTimeout(() => resolve(), 3_000);
        server.close(() => { clearTimeout(fallback); resolve(); });
        server = null;
      });
    },
  };
}
