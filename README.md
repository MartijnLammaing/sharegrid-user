# sharegrid-user

The LLMUser is the consumer interface for ShareGrid — a dual-mode service that can run as an **OpenAI-compatible HTTP server** for OpenCode integration, or as a **standalone interactive CLI**.

## How it fits in

```
Server mode (default):

  OpenCode ── GET /v1/models ──> LLMUser ──> ModelRegistry ──> LLMRouter
               POST /v1/chat/comp > LLMUser ──> SessionPool ──> LLMHost
                                                              (direct TLS)

CLI mode:

  LLMRouter ──── host list (cached) ───> LLMUser
                                             │
               direct TLS (pinned cert)     │
  LLMHost <═════════════════════════════════╝
    validates host key → streams SSE back
```

1. The user connects to the router to fetch the available model list (cached with a 30s TTL).
2. In **server mode**: OpenCode calls `GET /v1/models` to discover models, then `POST /v1/chat/completions` to run inference. Sessions are pooled and reused across turns.
3. In **CLI mode**: the user selects a model from the list, then enters a conversation loop with streamed responses.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `SHAREGRID_ROUTER_URL` | Yes | Router URL with `?fp=sha256:<hex>` fingerprint and `key=<secret>` user access credential |
| `SHAREGRID_MODE` | No | `'server'` (default) or `'cli'` |
| `SHAREGRID_LISTEN_PORT` | No | Port for server mode (default: `3000`) |
| `SHAREGRID_LISTEN_HOST` | No | Bind address for server mode (default: `0.0.0.0`) |

```sh
# Server mode (default)
export SHAREGRID_ROUTER_URL="tls://router.example.com:8443?fp=sha256:<hex>&key=<secret>"
npm run dev

# CLI mode
SHAREGRID_MODE=cli npm run dev
```

## Development

```sh
npm install
npm run dev               # start server mode (default)
SHAREGRID_MODE=cli npm run dev   # start CLI mode
npm run typecheck         # tsc --noEmit
npm run lint              # eslint
npm run test:unit
npm run test:integration
npm run build             # bundle to dist/bundle.cjs
```

## Source overview

```
src/
  index.ts            # Entry point: wires components, branches on SHAREGRID_MODE
  config.ts           # Env var parsing and validation (zod)
  cli.ts              # Interactive terminal: model selection, conversation loop, SIGINT handler
  router-client.ts    # One-shot TLS connection to router: fetches host list, closes
  model-registry.ts   # Wraps RouterClient with a TTL cache; groups hosts by model, aggregates slots
  host-session-pool.ts# Persistent session management: reuses idle sessions, conversation affinity
  session-client.ts   # Direct TLS to a host: handshake, inference requests, SSE passthrough, abort
  api-server.ts       # HTTP server: GET /v1/models, POST /v1/chat/completions (SSE streaming)
  logger.ts           # Pino logger factory (writes to stderr to keep stdout clean)
```

### Key design details

- **Dual-mode.** `SHAREGRID_MODE` controls behavior: `server` starts an HTTP API for OpenCode; `cli` starts an interactive terminal session.
- **TTL-cached model registry.** `fetchHostList()` opens a fresh TLS connection to the router each time. `ModelRegistry` wraps this with a 30-second cache so repeated `GET /v1/models` calls don't hammer the router. Cache can be invalidated on connection errors (e.g. TLS fingerprint mismatch).
- **Cert pinning.** Both the router connection (via `SHAREGRID_ROUTER_URL`) and host connections (via `tlsFingerprint` from the registry) use fingerprint pinning. No CA infrastructure required.
- **Persistent session pool.** `HostSessionPool` maintains open TLS sessions to hosts. `acquire()` reuses an idle session for the same host (conversation affinity); opens a new one if none is available. Sessions stay open between inference turns for the lifetime of the process.
- **SSE passthrough.** `sendInferenceRequest()` forwards the full OpenAI request body to the host and streams raw SSE lines back. The adapter is a transparent tunnel — it does not inspect or modify the payload.
- **Typed session errors.** `openSession()` throws `HostBusyError`, `InvalidTokenError`, `NotRegisteredError`, or `TlsFingerprintError` on rejection, enabling precise error handling in both server and CLI modes.
- **Cancellation.** `abort()` destroys the TLS socket, which signals the host to cancel in-flight inference. In server mode, client disconnect triggers abort via `AbortController`. In CLI mode, Ctrl+C aborts generation; Ctrl+C again exits.
- **Graceful shutdown.** `SIGTERM`/`SIGINT` closes all sessions via `session_close` before exiting.
- **CLI built on `readline`.** No external CLI framework — only Node.js built-ins.
