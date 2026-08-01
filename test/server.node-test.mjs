import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { startServer } from '../server.mjs';

async function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'agent-dashboard-server-test-'));
}

async function withServer(t, fn) {
  const storeDir = await makeTempDir();
  const server = await startServer({ storeDir, port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  await fn({ port, storeDir });
}

function request(port, { method = 'GET', path: reqPath = '/' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: reqPath },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('server defaults to the loopback address', async (t) => {
  const storeDir = await makeTempDir();
  const server = await startServer({ storeDir, port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
});

test('the server accepts an explicit trusted-network bind address', async (t) => {
  const storeDir = await makeTempDir();
  const server = await startServer({ storeDir, host: '0.0.0.0', port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(server.address().address, '0.0.0.0');
});

test('the server rejects invalid ports and ambiguous hostnames', async () => {
  await assert.rejects(() => startServer({ port: -1 }), /invalid port/u);
  await assert.rejects(() => startServer({ port: 65_536 }), /invalid port/u);
  await assert.rejects(() => startServer({ port: Number.NaN }), /invalid port/u);
  await assert.rejects(() => startServer({ host: 'example.com' }), /invalid host/u);
});

test('GET /api/status requires no login and returns 200 JSON with a bounded shape', async (t) => {
  await withServer(t, async ({ port }) => {
    const res = await request(port, { path: '/api/status' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.live));
    assert.ok(Array.isArray(body.blockers));
    assert.ok(Array.isArray(body.questions));
    assert.ok(Array.isArray(body.completed));
    assert.ok(Array.isArray(body.timeline));
  });
});

test('every response carries no-store and strong security headers', async (t) => {
  await withServer(t, async ({ port }) => {
    const res = await request(port, { path: '/api/status' });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  });
});

test('GET / serves the static index page', async (t) => {
  await withServer(t, async ({ port }) => {
    const res = await request(port, { path: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /Agent Delivery Dashboard/);
  });
});

test('GET / serves the reordered sections plus theme, mode and sort controls', async (t) => {
  await withServer(t, async ({ port }) => {
    const res = await request(port, { path: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /class="theme-swatch/);
    assert.match(res.body, /id="mode-toggle"/);
    assert.match(res.body, /aria-sort="none"/);
    assert.ok(
      res.body.indexOf('id="blockers-heading"') < res.body.indexOf('id="questions-heading"'),
      'blockers section must precede questions',
    );
    assert.ok(
      res.body.indexOf('id="questions-heading"') < res.body.indexOf('id="live-tasks-heading"'),
      'questions section must precede live tasks',
    );
  });
});

test('HEAD is permitted and returns no body', async (t) => {
  await withServer(t, async ({ port }) => {
    const res = await request(port, { method: 'HEAD', path: '/api/status' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '');
  });
});

test('only GET and HEAD are permitted; other methods are rejected', async (t) => {
  await withServer(t, async ({ port }) => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await request(port, { method, path: '/api/status' });
      assert.equal(res.statusCode, 405, `expected ${method} to be rejected`);
      assert.equal(res.headers.allow, 'GET, HEAD');
    }
  });
});

test('unknown and traversal-shaped paths return 404, never a file outside public/', async (t) => {
  await withServer(t, async ({ port }) => {
    for (const reqPath of ['/../../etc/passwd', '/../server.mjs', '/does-not-exist', '/%2e%2e/server.mjs']) {
      const res = await request(port, { path: reqPath });
      assert.equal(res.statusCode, 404, `expected ${reqPath} to be rejected`);
    }
  });
});

test('no write, launch, or GitHub-shaped endpoints exist', async (t) => {
  await withServer(t, async ({ port }) => {
    for (const reqPath of ['/api/launch', '/api/approve', '/api/merge', '/api/stop', '/api/write']) {
      const res = await request(port, { path: reqPath });
      assert.equal(res.statusCode, 404);
    }
  });
});
