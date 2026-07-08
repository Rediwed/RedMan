# ============================================================
# RedMan — Unified Dockerfile (frontend + backend)
# ============================================================

# ---- Stage 1: Build the React frontend ----
FROM node:20-alpine AS frontend-build
WORKDIR /build
COPY app/frontend/package.json app/frontend/package-lock.json* ./
RUN npm ci || npm install
COPY app/frontend/ .
RUN npm run build

# ---- Stage 2: Install backend dependencies ----
FROM node:20-alpine AS backend-deps
WORKDIR /build
COPY app/backend/package.json app/backend/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# ---- Stage 3: Final runtime image ----
FROM node:20-alpine

# Pinned immich-go version. Bump + re-verify checksums.txt when upgrading.
# Upstream publishes a checksums.txt alongside each release; we verify the tarball
# against it before extraction to mitigate supply-chain tampering.
ARG IMMICH_GO_VERSION=v0.31.0

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
    tar xzf "${TARBALL}" -C /usr/local/bin immich-go && \
    chmod +x /usr/local/bin/immich-go && \
    rm -f "${TARBALL}" checksums.txt

# Store rclone config in the persisted data volume
ENV RCLONE_CONFIG=/app/backend/data/rclone.conf

WORKDIR /app/backend

# Backend node_modules
COPY --from=backend-deps /build/node_modules ./node_modules
COPY app/backend/package.json ./
COPY app/backend/src ./src

# Built frontend → served as static files by Express
COPY --from=frontend-build /build/dist ./public

# Data directory for SQLite (mounted as volume for persistence)
RUN mkdir -p /app/backend/data

VOLUME ["/app/backend/data"]
EXPOSE 8090 8091

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8090/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]
