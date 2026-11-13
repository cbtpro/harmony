import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import type { Dispatch } from './engine';

const host = '127.0.0.1';
const maxRequestBytes = 512 * 1024;
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function reject(response: ServerResponse, status: number) {
  response.writeHead(status).end();
}

export async function startWebServer(dispatch: Dispatch, assets: string, devUrl?: string) {
  const token = randomBytes(32).toString('base64url');
  const dev = devUrl ? new URL(devUrl) : undefined;
  let authority = '';
  let active = 0;

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy',
      "script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (request.headers.host !== authority) return reject(response, 403);
    try {
      const url = new URL(request.url ?? '/', 'http://' + authority);
      if (url.origin !== 'http://' + authority) return reject(response, 403);
      if (url.pathname === '/api/request') {
        if (request.method !== 'POST') return reject(response, 405);
        if (request.headers.origin !== url.origin || request.headers.authorization !== 'Bearer ' + token) {
          return reject(response, 403);
        }
        if (active >= 12) return reject(response, 429);
        active++;
        try {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > maxRequestBytes) {
              response.setHeader('Connection', 'close');
              return reject(response, 413);
            }
            chunks.push(chunk);
          }
          let input: { name?: unknown; args?: unknown } | null;
          try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { return reject(response, 400); }
          if (typeof input?.name !== 'string' || !Array.isArray(input.args) || input.args.length > 4) {
            return reject(response, 400);
          }
          const result = await dispatch(input.name, input.args);
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify(result));
        } finally {
          active--;
        }
        return;
      }
      if (request.method !== 'GET') return reject(response, 405);

      if (dev) {
        const upstream = new URL(dev);
        upstream.pathname = url.pathname;
        upstream.search = url.search;
        const asset = await fetch(upstream, { redirect: 'error', signal: AbortSignal.timeout(30000) });
        const type = asset.headers.get('content-type');
        if (type) response.setHeader('Content-Type', type);
        response.statusCode = asset.status;
        if (asset.body) {
          const stream = Readable.fromWeb(asset.body as unknown as ReadableStream);
          response.on('close', () => stream.destroy());
          stream.on('error', () => response.destroy()).pipe(response);
        } else response.end();
        return;
      }

      const path = resolve(assets, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      const type = types[extname(path)];
      if (!path.startsWith(assets + sep) || !type || !(await stat(path).catch(() => null))?.isFile()) {
        return reject(response, 404);
      }
      response.setHeader('Content-Type', type);
      const stream = createReadStream(path);
      response.on('close', () => stream.destroy());
      stream.on('error', () => response.destroy()).pipe(response);
    } catch {
      if (!response.headersSent) reject(response, 500);
      else response.destroy();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, host, () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取网页服务地址。');
  authority = host + ':' + address.port;
  return {
    url: `http://${authority}/#connect=${token}`,
    close: () => { server.close(); server.closeAllConnections(); },
  };
}
