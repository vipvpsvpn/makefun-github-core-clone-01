// ctx.ts — the request context every handler module shares. app.ts builds it
// per request; the handlers only read from it and reply through it.

import type { IncomingHttpHeaders } from 'node:http';
import type { Store } from './store.ts';

export interface Ctx {
  store: Store;
  method: string;
  /** Decoded path, no query string, no trailing slash (except the root "/"). */
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** The whole request body, already read. */
  body: Buffer;
  /** The body parsed as JSON when it parses, otherwise undefined. */
  json: unknown;
  /** Raw reply. `body` may be a Buffer, a string, or a plain object (JSON-encoded). */
  send: (status: number, body: Buffer | string | object, contentType?: string, extra?: Record<string, string>) => void;
  /** JSON reply with the standard request-id header already applied by app.ts. */
  sendJson: (status: number, obj: unknown, extra?: Record<string, string>) => void;
  /** JSON error reply: { "message": "<message>" }. */
  fail: (status: number, message: string) => void;
  /** The request id for this request (counter-based, deterministic). */
  requestId: string;
}
