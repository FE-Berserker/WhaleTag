import http from 'node:http';
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

export interface McpHttpCoreOptions {
  /** Bearer token required on every request. */
  token: () => string;
  /** Registers the tool surface on each per-session server. */
  registerTools: (server: McpServer) => void;
  /** Server name/version reported in the initialize handshake. */
  serverInfo: { name: string; version: string };
  /** Instructions surfaced to the AI client. */
  instructions?: string;
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
  const sessions = new Map<
    string,
    { server: McpServer; transport: StreamableHTTPServerTransport }
  >();

  function newSessionServer(): McpServer {
    const server = new McpServer(opts.serverInfo, {
      instructions: opts.instructions,
    });
    opts.registerTools(server);
    return server;
  }

  async function handlePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown
  ): Promise<void> {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string' && sessions.has(sessionId)) {
      // Existing session — reuse its transport.
      await sessions.get(sessionId)!.transport.handleRequest(req, res, body);
      return;
    }
    if (sessionId === undefined && isInitializeRequest(body)) {
      // New session: fresh server + transport, registered under a new id.
      // (Stateful pattern: the transport outlives this single response; it
      // is torn down by the DELETE branch / close(), not by res 'close'.)
      const server = newSessionServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (initSessionId) => {
          sessions.set(initSessionId, { server, transport });
        },
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        // Failed handshake: the pair never entered the session map, so close
        // both here or they leak (the request-level catch only writes a 400).
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
    res.writeHead(400).end(
      'Invalid or missing session ID. Send an InitializeRequest first.'
    );
  }

  function readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      req.setEncoding('utf8');
      const chunks: string[] = [];
      let size = 0;
      req.on('data', (c: string) => {
        size += c.length;
        if (size > 4 * 1024 * 1024) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const raw = chunks.join('');
          resolve(raw ? JSON.parse(raw) : null);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      req.on('error', reject);
    });
  }

  const handler = (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void => {
    const url = req.url ?? '';
    if (!url.startsWith('/mcp')) {
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
        // Client-ended session: close and forget.
        const sid = req.headers['mcp-session-id'];
        if (typeof sid === 'string' && sessions.has(sid)) {
          const session = sessions.get(sid)!;
          sessions.delete(sid);
          await session.transport.close().catch(() => undefined);
          await session.server.close().catch(() => undefined);
        }
        res.writeHead(204).end();
        return;
      }
      // GET (server-initiated streams) is not offered — all traffic is
      // client-driven POSTs. Per spec, respond 405 Method Not Allowed.
      res.writeHead(405).end();
    })();
    task.catch(() => {
      // The socket may already be gone (client destroyed the request) —
      // writing to a dead stream throws ERR_STREAM_DESTROYED, which would
      // turn this handler into an unhandled rejection.
      try {
        if (!res.headersSent) res.writeHead(400);
        res.end('Bad request');
      } catch {
        /* socket gone */
      }
    });
  };

  const close = async (): Promise<void> => {
    for (const session of sessions.values()) {
      await session.transport.close().catch(() => undefined);
      await session.server.close().catch(() => undefined);
    }
    sessions.clear();
  };

  return {
    handler,
    close,
    sessionCount: () => sessions.size,
  };
}
