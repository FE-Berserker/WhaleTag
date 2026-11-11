import http from 'node:http';
import { Buffer } from 'node:buffer';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

/**
 * Electron-free core of the MCP server: bearer auth, JSON body reading and
 * the stateful Streamable-HTTP session model (one McpServer + transport per
 * `mcp-session-id`). Kept free of Electron imports so it can be exercised
 * end-to-end with the official client SDK under `node:test`
 * (mcp-http.test.ts). The Electron-facing shell (config, approval broadcast,
 * lifecycle) lives in mcp-server.ts.
 */

/** Maximum accepted JSON request body. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** A session with no traffic for this long is closed and forgotten. */
const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;
/** How often the idle-session sweeper runs. */
const DEFAULT_SESSION_SWEEP_MS = 60_000;

/** HTTP error carrying the status the request handler should answer with. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface McpHttpCoreOptions {
  /** Bearer token required on every request. */
  token: () => string;
  /** Registers the tool surface on each per-session server. */
  registerTools: (server: McpServer) => void;
  /** Server name/version reported in the initialize handshake. */
  serverInfo: { name: string; version: string };
  /** Instructions surfaced to the AI client. */
  instructions?: string;
  /**
   * Close sessions that saw no traffic for this long. A crashed client (or
   * one that never sends `DELETE /mcp`) would otherwise leak one McpServer +
   * transport per initialize for the lifetime of the app. `0` disables the
   * sweeper. Defaults to 30 minutes.
   */
  sessionIdleMs?: number;
  /** Sweeper cadence. Defaults to one minute. */
  sessionSweepMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

export interface McpHttpCore {
  /** Node http request handler (mount at any path prefix check first). */
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => void;
  /** Tear down all sessions (does not close the http.Server itself). */
  close: () => Promise<void>;
  sessionCount: () => number;
  /**
   * Close sessions idle for longer than `sessionIdleMs`; returns how many were
   * reaped. Exposed for tests and for a caller that wants to force a sweep.
   */
  reapIdleSessions: () => number;
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

function tokenMatches(expected: string, actual: string | undefined): boolean {
  // RFC 7235: the auth scheme is case-insensitive.
  if (!actual || !/^bearer /i.test(actual)) return false;
  const enc = new TextEncoder();
  const a = enc.encode(actual.slice(7).trimStart());
  const b = enc.encode(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createMcpHttpCore(opts: McpHttpCoreOptions): McpHttpCore {
  const now = opts.now ?? Date.now;
  const idleMs = opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const sweepMs = opts.sessionSweepMs ?? DEFAULT_SESSION_SWEEP_MS;
  const sessions = new Map<string, Session>();

  function newSessionServer(): McpServer {
    const server = new McpServer(opts.serverInfo, {
      instructions: opts.instructions,
    });
    opts.registerTools(server);
    return server;
  }

  /** Forget a session and close both halves of the pair (idempotent). */
  async function closeSession(id: string): Promise<void> {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    await session.transport.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
  }

  async function handlePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown
  ): Promise<void> {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string' && sessions.has(sessionId)) {
      // Existing session — reuse its transport.
      const session = sessions.get(sessionId)!;
      session.lastSeen = now();
      await session.transport.handleRequest(req, res, body);
      return;
    }
    if (sessionId === undefined && isInitializeRequest(body)) {
      // New session: fresh server + transport, registered under a new id.
      // (Stateful pattern: the transport outlives this single response; it
      // is torn down by the DELETE branch / idle sweeper / close(), not by
      // res 'close'.)
      const server = newSessionServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (initSessionId) => {
          sessions.set(initSessionId, {
            server,
            transport,
            lastSeen: now(),
          });
        },
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        // Failed handshake: the pair never (or only partly) entered the
        // session map, so close both here or they leak.
        sessions.forEach((s, id) => {
          if (s.transport === transport) sessions.delete(id);
        });
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        throw e;
      }
      return;
    }
    // Unknown/expired session or a non-initialize request without one.
    // Per the Streamable HTTP spec an unrecognized session id is a 404 so the
    // client knows to re-initialize instead of retrying forever.
    throw new HttpError(
      404,
      'Invalid or missing session ID. Send an InitializeRequest first.'
    );
  }

  function readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      req.setEncoding('utf8');
      const chunks: string[] = [];
      let bytes = 0;
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      req.on('data', (chunk: string) => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > MAX_BODY_BYTES) {
          // Keep the connection alive for the 413 response: stop buffering
          // here and let the request handler drain the rest.
          fail(new HttpError(413, 'Request body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (settled) return;
        settled = true;
        try {
          const raw = chunks.join('');
          resolve(raw ? JSON.parse(raw) : null);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      req.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))));
    });
  }

  const handler = (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void => {
    // Exact endpoint match: `/mcp`, or `/mcp/` — not `/mcpfoo`.
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== '/mcp' && pathname !== '/mcp/') {
      res.writeHead(404).end('Not found. The MCP endpoint is /mcp.');
      return;
    }
    // DNS-rebinding defense (docs/21): only the loopback listener's own host
    // may reach the endpoint same-origin from a browser. Checked BEFORE the
    // token gate so a rebound page can't even harvest the 401 challenge.
    const hostHeader = Array.isArray(req.headers.host)
      ? req.headers.host[0]
      : req.headers.host;
    const hostName = (hostHeader ?? '').replace(/:\d+$/, '');
    if (
      hostName !== '127.0.0.1' &&
      hostName !== 'localhost' &&
      hostName !== '[::1]'
    ) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (!tokenMatches(opts.token(), req.headers.authorization)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end('Unauthorized');
      return;
    }
    const task = (async () => {
      if (req.method === 'POST') {
        const body = await readBody(req);
        await handlePost(req, res, body);
        return;
      }
      if (req.method === 'DELETE') {
        const sid = req.headers['mcp-session-id'];
        if (typeof sid === 'string') await closeSession(sid);
        res.writeHead(204).end();
        return;
      }
      // GET (server-initiated streams) is not offered — all traffic is
      // client-driven POSTs. Per spec, respond 405 Method Not Allowed.
      res.writeHead(405).end();
    })();
    task.catch((e: unknown) => {
      // The socket may already be gone (client destroyed the request) —
      // writing to a dead stream throws ERR_STREAM_DESTROYED, which would
      // turn this handler into an unhandled rejection.
      const status = e instanceof HttpError ? e.status : 400;
      const message =
        e instanceof HttpError
          ? e.message
          : e instanceof Error
            ? `Bad request: ${e.message}`
            : 'Bad request';
      try {
        if (!res.headersSent) {
          res.writeHead(
            status,
            status === 413 ? { Connection: 'close' } : undefined
          );
        }
        res.end(message);
        // Consume whatever is left of an oversized body so the socket can
        // close cleanly instead of resetting mid-response.
        if (status === 413) req.resume();
      } catch {
        /* socket gone */
      }
    });
  };

  const close = async (): Promise<void> => {
    if (sweeper) clearInterval(sweeper);
    for (const id of Array.from(sessions.keys())) {
      await closeSession(id);
    }
    sessions.clear();
  };

  const reapIdleSessions = (): number => {
    if (idleMs <= 0) return 0;
    const cutoff = now() - idleMs;
    const stale = Array.from(sessions)
      .filter(([, session]) => session.lastSeen <= cutoff)
      .map(([id]) => id);
    for (const id of stale) void closeSession(id);
    return stale.length;
  };

  // No unref'd timer keeping the app alive: a 30-minute idle session must not
  // prevent Electron from quitting.
  const sweeper =
    idleMs > 0
      ? setInterval(
          () => {
            reapIdleSessions();
          },
          Math.max(1_000, Math.min(sweepMs, idleMs))
        )
      : null;
  sweeper?.unref();

  return {
    handler,
    close,
    sessionCount: () => sessions.size,
    reapIdleSessions,
  };
}
