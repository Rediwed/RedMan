# ============================================================
# RedMan — Unified Dockerfile (frontend + backend)
# ============================================================

# ---- Stage 1: Build the React frontend ----
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS frontend-build
WORKDIR /build
COPY app/package.json app/package-lock.json ./
COPY app/backend/package.json ./backend/package.json
COPY app/frontend/package.json ./frontend/package.json
RUN npm ci --workspace=frontend --include-workspace-root=false
COPY app/frontend/ ./frontend/
RUN npm run build --workspace=frontend

# ---- Stage 2: Install backend dependencies ----
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS backend-deps
WORKDIR /build
RUN apk add --no-cache python3 make g++
COPY app/package.json app/package-lock.json ./
COPY app/backend/package.json ./backend/package.json
COPY app/frontend/package.json ./frontend/package.json
RUN npm ci --omit=dev --workspace=backend --include-workspace-root=false && \
    rm -rf \
      node_modules/ssh2/test \
      node_modules/split-ca/test \
      backend/node_modules/ssh2/test \
      backend/node_modules/split-ca/test

# ---- Stage 3: Exact-path Docker API proxy ----
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS docker-api-proxy
WORKDIR /proxy
COPY app/backend/scripts/dockerApiProxy.js ./dockerApiProxy.js
EXPOSE 2375
ENTRYPOINT ["node", "dockerApiProxy.js"]

# ---- Stage 4: Final runtime image ----
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

# Pinned immich-go version. Bump + re-verify checksums.txt when upgrading.
# Upstream publishes a checksums.txt alongside each release; we verify the tarball
# against it before extraction to mitigate supply-chain tampering.
# v0.32.0 is the first release that speaks the Immich V3 API; older builds fail
# against a V3 server with an unparseable-response error.
ARG IMMICH_GO_VERSION=v0.32.0

# Install util-linux (lsblk, umount), rsync, openssh-client (ssh for rsync transport), librsync (rdiff for delta versioning), rclone (cloud remotes) and download+verify immich-go
RUN apk add --no-cache util-linux curl rsync openssh-client librsync openssh-keygen rclone tzdata && \
    ARCH=$(uname -m) && \
    case "$ARCH" in \
      x86_64) GOARCH="x86_64" ;; \
      aarch64) GOARCH="arm64" ;; \
      *) GOARCH="x86_64" ;; \
    esac && \
    TARBALL="immich-go_Linux_${GOARCH}.tar.gz" && \
    BASE="https://github.com/simulot/immich-go/releases/download/${IMMICH_GO_VERSION}" && \
    cd /tmp && \
    curl -fsSL -o "${TARBALL}" "${BASE}/${TARBALL}" && \
    curl -fsSL -o checksums.txt "${BASE}/checksums.txt" && \
    grep " ${TARBALL}\$" checksums.txt | sha256sum -c - && \
    (tar xzf "${TARBALL}" -C /usr/local/bin immich-go || (rm -f /usr/local/bin/immich-go && exit 1)) && \
    chmod +x /usr/local/bin/immich-go && \
    rm -f "${TARBALL}" checksums.txt

# Store rclone config in the persisted data volume
ENV RCLONE_CONFIG=/app/backend/data/rclone.conf

WORKDIR /app/backend

# Backend node_modules
COPY --from=backend-deps /build/node_modules ./node_modules
COPY --from=backend-deps /build/backend/node_modules ./node_modules
COPY app/backend/package.json ./
COPY app/backend/src ./src
COPY app/backend/scripts ./scripts

# Built frontend → served as static files by Express
COPY --from=frontend-build /build/frontend/dist ./public

# Data directory for SQLite (mounted as volume for persistence)
RUN mkdir -p /app/backend/data

VOLUME ["/app/backend/data"]
EXPOSE 8090 8091

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8090/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]
