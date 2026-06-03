# =============================================================================
# Stage 1 — Builder
#
# Installs dependencies and builds the TypeScript sources into a single
# self-contained CJS bundle via esbuild.
# =============================================================================
FROM node:22-slim AS builder

WORKDIR /app

# Build @sharegrid/shared first — it is a file: dependency and must be
# compiled before npm ci can install it correctly.
COPY sharegrid-shared/package.json sharegrid-shared/package-lock.json \
     ./sharegrid-shared/
RUN cd sharegrid-shared && npm ci --ignore-scripts
COPY sharegrid-shared/src       ./sharegrid-shared/src
COPY sharegrid-shared/tsconfig.json \
     sharegrid-shared/tsconfig.build.json \
     ./sharegrid-shared/
RUN cd sharegrid-shared && npm run build

# Build the user bundle.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src         ./src
COPY tsconfig.json tsconfig.build.json ./
RUN npm run build

# =============================================================================
# Stage 2 — Runtime
#
# Two operating modes, selected via the SHAREGRID_MODE environment variable:
#
#   Server mode (default — OpenCode provider adapter):
#     docker run -d -p 3000:3000 \
#       -e SHAREGRID_ROUTER_URL="https://..." \
#       sharegrid-user
#
#   CLI mode (standalone interactive terminal, requires a TTY):
#     docker run -it \
#       -e SHAREGRID_MODE=cli \
#       -e SHAREGRID_ROUTER_URL="https://..." \
#       sharegrid-user
# =============================================================================
FROM node:22-slim AS runtime

# Create a dedicated non-root user/group.
RUN groupadd --gid 1001 sharegrid \
    && useradd --uid 1001 --gid sharegrid --no-create-home sharegrid

WORKDIR /app

ENV NODE_ENV=production

# Port published by the HTTP server in server mode.
EXPOSE 3000

COPY --from=builder /app/dist/bundle.cjs /app/bundle.cjs

USER sharegrid

CMD ["node", "/app/bundle.cjs"]
