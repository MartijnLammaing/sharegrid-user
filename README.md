# sharegrid-user

The LLMUser is the consumer interface for ShareGrid — a CLI for discovering available hosts and running inference sessions against them.

## How it fits in

```
LLMRouter ──── host list (one-time) ────> LLMUser
                                              │
              direct TLS (pinned cert)        │
LLMHost <═════════════════════════════════════╝
  validates host key token → streams inference back
```

1. On startup, the user connects to the router, fetches the host list, and immediately disconnects. The router is never contacted again.
2. The user selects a host from the list.
3. The user opens a direct TLS connection to the chosen host (cert pinned to the host's fingerprint), presents the host key token, and enters a conversation loop.
4. Responses stream back chunk by chunk to the terminal.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `SHAREGRID_ROUTER_URL` | Yes | Router URL with `?fp=sha256:<hex>` fingerprint |

```sh
export SHAREGRID_ROUTER_URL="tls://router.example.com:8443?fp=sha256:<hex>"
npm run dev
```

## Development

```sh
npm install
npm run dev          # run with tsx (no build step)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run test:unit
npm run test:integration
npm run build        # bundle to dist/bundle.cjs
```

## Source overview

```
src/
  index.ts          # Entry point: wires components, handles SIGTERM
  config.ts         # Env var parsing and validation (zod)
  cli.ts            # Host list rendering, host selection, conversation loop, SIGINT handler
  router-client.ts  # Opens a TLS connection to the router, fetches host list, closes connection
  session-client.ts # Direct TLS connection to a host: handshake, prompt streaming, session close
  logger.ts         # Pino logger factory (writes to stderr to keep stdout clean for CLI output)
```

### Key design details

- **Router connection is one-shot.** `fetchHostList()` opens a fresh TLS connection, sends `host_list_request`, receives `host_list_response`, and destroys the socket. The router plays no further role.
- **Cert pinning.** Both the router connection (via `SHAREGRID_ROUTER_URL`) and the host connection (via `tlsFingerprint` in the host list entry) use fingerprint pinning. No CA infrastructure required.
- **Typed session errors.** `openSession()` throws `HostBusyError`, `InvalidTokenError`, or `NotRegisteredError` on rejection, allowing the CLI to present a clear message and offer re-selection.
- **Streaming.** `sendPrompt()` delivers `response_chunk` messages to an `onChunk` callback as they arrive, so responses print incrementally.
- **Graceful shutdown.** `SIGINT` (Ctrl+C) sends `session_close` to the host before exiting, so the host can tear down cleanly.
- **CLI built on `readline`.** No external CLI framework — only Node.js built-ins.
