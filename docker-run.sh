#!/usr/bin/env bash
# docker-run.sh — Build and start the sharegrid-user container.
#
# Usage: ./docker-run.sh [--no-build] [--server]
#
# Builds the Docker image, stops any existing user container, then starts a
# new one. Two modes:
#
#   CLI mode (default): Interactive foreground session. Requires a TTY.
#   Server mode (--server): Background HTTP adapter on port 3000 for use as
#                           an OpenCode provider.
#
# Environment (required):
#   SHAREGRID_ROUTER_URL — User access URL from the router banner
#
# Environment (optional):
#   SHAREGRID_USER_PORT   — Host port to publish         (default: 3000)
#   SHAREGRID_USER_IMAGE  — Docker image name            (default: sharegrid-user)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT="${SHAREGRID_USER_PORT:-3000}"
IMAGE="${SHAREGRID_USER_IMAGE:-sharegrid-user}"
CONTAINER=sharegrid-user

BUILD=1
SERVER_MODE=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --server)   SERVER_MODE=1 ;;
    *) echo "[user] WARNING: unknown flag: $arg" ;;
  esac
done

if [[ -z "${SHAREGRID_ROUTER_URL:-}" ]]; then
  echo "[user] ERROR: SHAREGRID_ROUTER_URL is not set."
  echo "[user] Run sharegrid-router/docker-run.sh first, then export the USER ACCESS URL."
  exit 1
fi

# Decode base64-encoded router URL.
SHAREGRID_ROUTER_URL=$(printf '%s' "$SHAREGRID_ROUTER_URL" | openssl base64 -A -d)

log() { echo "[user] $*"; }

# ── Build ─────────────────────────────────────────────────────────────────────

if [[ "$BUILD" -eq 1 ]]; then
  log "Building ${IMAGE}..."
  docker build -t "$IMAGE" "$SCRIPT_DIR"
else
  log "Skipping build (--no-build)."
fi

# ── Cleanup ───────────────────────────────────────────────────────────────────

docker rm -f "$CONTAINER" 2>/dev/null || true

# ── Start ─────────────────────────────────────────────────────────────────────

if [[ "$SERVER_MODE" -eq 1 ]]; then
  log "Starting ${CONTAINER} in server mode on port ${PORT}..."
  docker run -d \
    --name "$CONTAINER" \
    -p "127.0.0.1:${PORT}:${PORT}" \
    -e SHAREGRID_ROUTER_URL="$SHAREGRID_ROUTER_URL" \
    -e SHAREGRID_MODE=server \
    "$IMAGE"

  log "Provider adapter running on http://localhost:${PORT}/v1"
  log ""
  log "Add to your opencode.json:"
  echo ""
  echo "{ \"provider\": { \"sharegrid\": { \"npm\": \"@ai-sdk/openai-compatible\", \"name\": \"ShareGrid\", \"options\": { \"baseURL\": \"http://localhost:${PORT}/v1\" } } } }"
  echo ""
  log "Stop: docker rm -f ${CONTAINER}"
else
  log "Launching ${CONTAINER} (CLI mode)..."
  docker run -it --rm \
    -e SHAREGRID_ROUTER_URL="$SHAREGRID_ROUTER_URL" \
    -e SHAREGRID_MODE=cli \
    "$IMAGE"
fi
