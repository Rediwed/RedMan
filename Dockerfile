# RedMan upgrade-readiness bridge
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS frontend-build
WORKDIR /build
COPY app/package.json app/package-lock.json ./
COPY app/backend/package.json ./backend/package.json
COPY app/frontend/package.json ./frontend/package.json
RUN npm ci --workspace=frontend --include-workspace-root=false
COPY app/frontend/ ./frontend/
RUN npm run build --workspace=frontend

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS backend-deps
WORKDIR /build
COPY app/package.json app/package-lock.json ./
COPY app/backend/package.json ./backend/package.json
COPY app/frontend/package.json ./frontend/package.json
RUN npm ci --omit=dev --workspace=backend --include-workspace-root=false && \
    rm -rf node_modules/ssh2/test node_modules/split-ca/test \
      backend/node_modules/ssh2/test backend/node_modules/split-ca/test

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
WORKDIR /app/backend
COPY --from=backend-deps /build/node_modules ./node_modules
COPY app/backend/package.json ./
COPY app/backend/src ./src
COPY scripts ./scripts
COPY --from=frontend-build /build/frontend/dist ./public
RUN mkdir -p /app/backend/data

VOLUME ["/app/backend/data"]
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8090/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
CMD ["node", "src/index.js"]
