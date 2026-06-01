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
docker run -it --rm -e SHAREGRID_ROUTER_URL="https://172.17.0.2:8443?fp=sha256:6059adc8a497ba0070f0f10af6ce130ae58a46c83e70c4ed98e12b5bfd01f98e" sharegrid-user:latest