#!/usr/bin/env bash
# Example docker run invocation for LLMUser.
# Replace <digest> with the SHA-256 digest of the image you built.
# Replace the SHAREGRID_ROUTER_URL value with the URL printed by your router
# at startup (includes the ?fp=sha256:... fingerprint).
#
# IMPORTANT: The -it flag is required — the LLMUser is an interactive CLI and
# needs a TTY to display prompts and stream responses correctly. Without -it
# the process will receive no input and exit immediately.
#
# See: docs/architecture_llmuser.md §2.4

## Build
cd sharegrid-user
docker build -t sharegrid-user .

## Run
docker run -it --rm -e SHAREGRID_ROUTER_URL="aHR0cHM6Ly8xNzIuMTcuMC4yOjg0NDM/ZnA9c2hhMjU2OjYwNTlhZGM4YTQ5N2JhMDA3MGYwZjEwYWY2Y2UxMzBhZTU4YTQ2YzgzZTcwYzRlZDk4ZTEyYjViZmQwMWY5OGUma2V5PTx1c2VyLXNlY3JldC1mcm9tLXJvdXRlci1iYW5uZXI+" sharegrid-user:latest
# Base64-encoded router URL — copy the SHAREGRID_USER_ROUTER_URL value from the router's startup output.