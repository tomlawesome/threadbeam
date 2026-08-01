// Read-only local dashboard server. Defaults to loopback and may bind to an
// explicitly selected trusted-network interface. It serves the static UI and
// a GET-only JSON status API. No write, launch, approval,
// merge, stop, Docker, shell or GitHub capability exists in this service.

import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEvents, deriveStatus, defaultStoreDir } from './lib/store.mjs';

const DEFAULT_HOST = '127.0.0.1';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
]);

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function withSecurityHeaders(res) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
}

function sendJson(res, method, status, body) {
  withSecurityHeaders(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.writeHead(status);
  res.end(method === 'HEAD' ? undefined : JSON.stringify(body));
}

async function sendStatic(res, method, entry) {
  withSecurityHeaders(res);
  const resolved = path.resolve(PUBLIC_DIR, entry.file);
  const withinPublicDir =
    resolved === PUBLIC_DIR || resolved.startsWith(PUBLIC_DIR + path.sep);
  if (!withinPublicDir) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const data = await fsp.readFile(resolved);
    res.setHeader('Content-Type', entry.type);
    res.writeHead(200);
    res.end(method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

function createServer(options = {}) {
  const storeDir = options.storeDir ?? defaultStoreDir();

  return http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      withSecurityHeaders(res);
      res.writeHead(400);
      res.end();
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      withSecurityHeaders(res);
      res.setHeader('Allow', 'GET, HEAD');
      res.writeHead(405);
      res.end();
      return;
    }

    if (url.pathname === '/api/status') {
      try {
        const { events, parseErrors } = await readEvents(storeDir);
        const status = deriveStatus(events, { now: Date.now() });
        status.parseErrors = parseErrors;
        sendJson(res, method, 200, status);
      } catch {
        sendJson(res, method, 500, { error: 'status_unavailable' });
      }
      return;
    }

    const entry = STATIC_FILES.get(url.pathname);
    if (entry) {
      await sendStatic(res, method, entry);
      return;
    }

    withSecurityHeaders(res);
    res.writeHead(404);
    res.end();
  });
}

export function startServer(options = {}) {
  const port = options.port ?? 4317;
  const host = options.host ?? DEFAULT_HOST;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    return Promise.reject(new Error('invalid port'));
  }
  if (typeof host !== 'string' || net.isIP(host) === 0) {
    return Promise.reject(new Error('invalid host: use an explicit IP address'));
  }
  const server = createServer(options);
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function isMain() {
  return Boolean(
    process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href,
  );
}

if (isMain()) {
  const port = Number(process.env.AGENT_DASHBOARD_PORT ?? 4317);
  const host = process.env.AGENT_DASHBOARD_HOST ?? DEFAULT_HOST;
  startServer({ host, port })
    .then((server) => {
      const address = server.address();
      const displayHost = address.address.includes(':') ? `[${address.address}]` : address.address;
      console.log(`agent-dashboard listening on http://${displayHost}:${address.port}`);
    })
    .catch((error) => {
      process.stderr.write(`agent-dashboard: ${error.message}\n`);
      process.exitCode = 1;
    });
}
