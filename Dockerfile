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

# Install util-linux (lsblk, umount) and download immich-go
RUN apk add --no-cache util-linux curl && \
    ARCH=$(uname -m) && \
    case "$ARCH" in \
      x86_64) GOARCH="amd64" ;; \
      aarch64) GOARCH="arm64" ;; \
      *) GOARCH="amd64" ;; \
    esac && \
    IMMICH_GO_VERSION=$(curl -sL "https://api.github.com/repos/simulot/immich-go/releases/latest" | grep '"tag_name"' | head -1 | cut -d'"' -f4) && \
    curl -sL "https://github.com/simulot/immich-go/releases/download/${IMMICH_GO_VERSION}/immich-go_Linux_${GOARCH}.tar.gz" | tar xz -C /usr/local/bin immich-go && \
    chmod +x /usr/local/bin/immich-go

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

CMD ["node", "src/index.js"]
