#!/usr/bin/env node
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const CONTAINER_ID = '[A-Za-z0-9_.-]+';
const API_VERSION = '/v[0-9]+(?:\\.[0-9]+)+';

const READ_PATHS = [
  /^\/_ping$/,
  /^\/version$/,
  /^\/containers\/json$/,
  new RegExp(`^/containers/${CONTAINER_ID}/stats$`),
  /^\/networks$/,
];

const CONTROL_PATHS = [
  new RegExp(`^/containers/${CONTAINER_ID}/start$`),
  new RegExp(`^/containers/${CONTAINER_ID}/stop$`),
];

function normalizedRequest(rawUrl) {
  try {
    const parsed = new URL(rawUrl, 'http://docker-proxy.local');
    const decoded = decodeURIComponent(parsed.pathname);
    return {
      path: decoded.replace(new RegExp(`^${API_VERSION}(?=/)`), ''),
      searchParams: parsed.searchParams,
    };
  } catch {
    return null;
  }
}

function hasOnlySearchParams(searchParams, allowed) {
  return [...searchParams.keys()].every(key => allowed.has(key));
}

function hasAllowedReadQuery(path, searchParams) {
  if (path === '/containers/json') {
    if (!hasOnlySearchParams(searchParams, new Set(['all', 'filters']))) return false;
    if (searchParams.getAll('all').length > 1 || searchParams.getAll('filters').length > 1) return false;
    if (searchParams.has('all') && !/^(?:0|1|true|false)$/.test(searchParams.get('all'))) return false;
    if (searchParams.has('filters')) {
      const filters = searchParams.get('filters');
      if (filters.length > 4096) return false;
      try {
        const parsed = JSON.parse(filters);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return false;
      } catch {
        return false;
      }
    }
    return true;
  }
  if (/^\/containers\/[A-Za-z0-9_.-]+\/stats$/.test(path)) {
    return hasOnlySearchParams(searchParams, new Set(['stream']))
      && searchParams.getAll('stream').length === 1
      && searchParams.get('stream') === 'false';
  }
  return searchParams.size === 0;
}

function hasAllowedControlQuery(path, searchParams) {
  if (path.endsWith('/stop')) {
    return hasOnlySearchParams(searchParams, new Set(['t']))
      && searchParams.getAll('t').length <= 1
      && (!searchParams.has('t') || /^\d{1,3}$/.test(searchParams.get('t')));
  }
  return searchParams.size === 0;
}

export function getAllowedDockerRequest(mode, method, rawUrl) {
  const normalized = normalizedRequest(rawUrl);
  const normalizedMethod = String(method || '').toUpperCase();
  if (!normalized) return null;
  const { path, searchParams } = normalized;
  let allowed = false;
  if (mode === 'read') {
    allowed = ['GET', 'HEAD'].includes(normalizedMethod)
      && READ_PATHS.some(pattern => pattern.test(path))
      && hasAllowedReadQuery(path, searchParams);
  } else if (mode === 'control') {
    allowed = normalizedMethod === 'POST'
      && CONTROL_PATHS.some(pattern => pattern.test(path))
      && hasAllowedControlQuery(path, searchParams);
  }
  if (!allowed) return null;
  const query = searchParams.toString();
  return { method: normalizedMethod, path: `${path}${query ? `?${query}` : ''}` };
}

export function isAllowedDockerRequest(mode, method, rawUrl) {
  return getAllowedDockerRequest(mode, method, rawUrl) !== null;
}

export function createDockerApiProxy({
  mode,
  socketPath = '/var/run/docker.sock',
} = {}) {
  if (!['read', 'control'].includes(mode)) throw new Error('REDMAN_DOCKER_PROXY_MODE must be read or control');

  return http.createServer((request, response) => {
    const allowedRequest = getAllowedDockerRequest(mode, request.method, request.url);
    if (!allowedRequest) {
      response.writeHead(403, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Docker API request denied' }));
      return;
    }
    if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) > 0) {
      response.writeHead(413, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Docker API request body denied' }));
      return;
    }

    const upstream = http.request({
      socketPath,
      method: allowedRequest.method,
      path: allowedRequest.path,
      headers: { accept: request.headers.accept || 'application/json' },
      timeout: 30_000,
    }, upstreamResponse => {
      const headers = {};
      for (const name of ['content-type', 'content-length']) {
        if (upstreamResponse.headers[name] !== undefined) headers[name] = upstreamResponse.headers[name];
      }
      response.writeHead(upstreamResponse.statusCode || 502, headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Docker API request timed out')));
    upstream.on('error', error => {
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    });
    request.on('aborted', () => upstream.destroy());
    upstream.end();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.env.REDMAN_DOCKER_PROXY_MODE;
  const port = Number.parseInt(process.env.PORT || '2375', 10);
  const host = process.env.HOST || '0.0.0.0';
  const socketPath = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  createDockerApiProxy({ mode, socketPath }).listen(port, host, () => {
    console.log(`[docker-api-proxy] ${mode} policy listening on ${host}:${port}`);
  });
}