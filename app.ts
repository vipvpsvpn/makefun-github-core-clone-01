// app.ts — the HTTP server: one process, one store, four surfaces.
//
// Routing: /healthz (no token), /api/v3/* (REST), /api/graphql, /mcp, and the
// git smart-HTTP paths /{owner}/{repo}.git/*. Every reply carries a
// non-empty X-GitHub-Request-Id header. Every request except /healthz needs
// `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` when that variable is set (the
// trial always sets it, and the kit's git client sends it on every smart-HTTP
// request too); with no token configured the server accepts any caller, which
// is the local smoke-test mode only.
//
// The trial clock comes from MAKEFUN_TRIAL_NOW: server-made commits and
// timestamps use that instant, never the wall clock, so a trial and its replay
// export byte-identical state.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import type { Ctx } from './ctx.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_EPOCH = 1735689600;

export function createApp(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  const epochRaw = Number(process.env.MAKEFUN_TRIAL_NOW ?? '');
  const epoch = Number.isFinite(epochRaw) && epochRaw > 0 ? Math.floor(epochRaw) : DEFAULT_EPOCH;
  const store = new Store(epoch);
  let requestCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {
      try {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"message":"Bad Request"}');
      } catch {
        // The socket is already gone.
      }
    });
    req.on('end', () => {
      if (tooBig) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Request body too large' }));
        return;
      }
      handleRequest(req, res, Buffer.concat(chunks));
    });
  });

  function handleRequest(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    const requestId = `req-${++requestCounter}`;

    const send = (status: number, data: Buffer | string | object, contentType?: string, extra?: Record<string, string>): void => {
      let payload: Buffer;
      let type = contentType;
      if (Buffer.isBuffer(data)) {
        payload = data;
        type = type ?? 'application/octet-stream';
      } else if (typeof data === 'string') {
        payload = Buffer.from(data, 'utf8');
        type = type ?? 'text/plain; charset=utf-8';
      } else {
        payload = Buffer.from(JSON.stringify(data), 'utf8');
        type = type ?? 'application/json';
      }
      const headers: Record<string, string> = {
        'Content-Type': type,
        'X-GitHub-Request-Id': requestId,
        ...extra,
      };
      try {
        res.writeHead(status, headers);
        res.end(payload);
      } catch {
        // The socket is already gone.
      }
    };

    const sendJson = (status: number, obj: unknown, extra?: Record<string, string>): void => {
      send(status, obj as Record<string, unknown>, 'application/json', extra);
    };

    const fail = (status: number, message: string): void => {
      sendJson(status, { message });
    };

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendJson(400, { message: 'Bad Request' });
      return;
    }
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      sendJson(400, { message: 'Bad Request' });
      return;
    }
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

    let json: unknown;
    if (body.length > 0) {
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        json = undefined;
      }
    }

    const ctx: Ctx = {
      store,
      method: req.method ?? 'GET',
      path,
      query: url.searchParams,
      headers: req.headers,
      body,
      json,
      send,
      sendJson,
      fail,
      requestId,
    };

    try {
      // Authentication: everything except the boot check needs the trial token
      // when one is configured.
      if (token !== undefined && path !== '/healthz') {
        const presented = req.headers.authorization ?? '';
        if (presented !== `Bearer ${token}`) {
          fail(401, 'Bad credentials');
          return;
        }
      }
      if (path === '/healthz') {
        if (ctx.method === 'GET') sendJson(200, { ok: true });
        else fail(404, 'Not Found');
        return;
      }
      if (path.startsWith('/api/v3')) {
        if (handleRest(ctx)) return;
      } else if (path === '/api/graphql') {
        if (handleGraphql(ctx)) return;
      } else if (path === '/mcp') {
        if (handleMcp(ctx)) return;
      } else {
        const gitMatch = /^\/([^/]+)\/([^/]+?)(?:\.git)?(\/.*)?$/.exec(path);
        if (gitMatch) {
          const owner = gitMatch[1]!;
          const repoName = gitMatch[2]!;
          const tail = gitMatch[3] ?? '/';
          if (handleGit(ctx, owner, repoName, tail)) return;
        }
      }
      fail(404, 'Not Found');
    } catch (err) {
      // A handler bug must never take the server down mid-trial.
      console.error(`[forge] ${ctx.method} ${path} failed: ${(err as Error).message}`);
      if (!res.writableEnded) fail(500, 'Internal Server Error');
    }
  }

  return server;
}
