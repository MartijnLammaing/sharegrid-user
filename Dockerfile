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
# The LLMUser is an interactive CLI. It MUST be run with `docker run -it`
# to attach a TTY — without one, readline has no terminal to prompt and the
# process exits immediately.
# =============================================================================
FROM node:22-slim AS runtime

# Create a dedicated non-root user/group.
RUN groupadd --gid 1001 sharegrid \
    && useradd --uid 1001 --gid sharegrid --no-create-home sharegrid

WORKDIR /app

COPY --from=builder /app/dist/bundle.cjs /app/bundle.cjs

USER sharegrid

CMD ["node", "/app/bundle.cjs"]
