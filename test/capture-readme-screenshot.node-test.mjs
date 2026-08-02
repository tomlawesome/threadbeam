import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { validateEvent } from '../lib/contract.mjs';
import { run, synthesizeEvents, CANONICAL_OUTPUT_PATH, isCliInvocation } from '../scripts/capture-readme-screenshot.mjs';

async function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'capture-readme-test-'));
}

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

function screenshotArgValue(args) {
  return args.find((a) => a.startsWith('--screenshot=')).slice('--screenshot='.length);
}

function successSpawnFn(onUrl) {
  return (command, args) => {
    const child = makeFakeChild();
    const url = args[args.length - 1];
    queueMicrotask(async () => {
      if (onUrl) await onUrl(url);
      await fsp.writeFile(screenshotArgValue(args), 'fake-png');
      child.emit('close', 0, null);
    });
    return child;
  };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

const fakeChromiumOptions = {
  env: { THREADBEAM_CHROMIUM_PATH: '/fake/chromium' },
  isExecutable: (p) => p === '/fake/chromium',
};

// --- synthetic-only fixtures ------------------------------------------

test('synthetic fixtures cover active, blocked, question and completed states and pass the strict contract', () => {
  const events = synthesizeEvents(Date.parse('2026-08-02T00:00:00Z'));
  const states = events.map((event) => event.state);
  assert.ok(states.includes('blocked'));
  assert.ok(states.includes('question'));
  assert.ok(states.includes('completed'));
  assert.ok(
    states.some((state) => !['blocked', 'question', 'completed'].includes(state)),
    'expected a non-terminal active state',
  );
  for (const event of events) {
    const result = validateEvent(event);
    assert.equal(result.ok, true, result.errors.join(', '));
  }
});

// --- ephemeral port and end-to-end wiring -------------------------------

test('run() starts the server on an ephemeral loopback port and serves the synthetic dashboard before cleanup', async () => {
  const root = await makeTempDir();
  let observedUrl;
  let observedStatus;
  const spawnFn = successSpawnFn(async (url) => {
    observedUrl = url;
    observedStatus = await fetchJson(`${url}api/status`);
  });

  const result = await run({
    repoRoot: root,
    outputPath: 'shot.png',
    ...fakeChromiumOptions,
    spawnFn,
  });

  assert.equal(result.outputPath, path.join(root, 'shot.png'));
  assert.match(observedUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.ok(!observedUrl.includes(':4317/'), 'must not reuse the default Threadbeam port');
  assert.equal(observedStatus.blockers.length, 1);
  assert.equal(observedStatus.questions.length, 1);
  assert.equal(observedStatus.completed.length, 1);
  assert.equal(observedStatus.live.length, 3);
});

// --- overwrite controls --------------------------------------------------

test('run() authorises overwrite only for its canonical screenshot asset path', async () => {
  const root = await makeTempDir();
  await fsp.mkdir(path.dirname(path.join(root, CANONICAL_OUTPUT_PATH)), { recursive: true });
  await fsp.writeFile(path.join(root, CANONICAL_OUTPUT_PATH), 'old');

  const result = await run({
    repoRoot: root,
    ...fakeChromiumOptions,
    spawnFn: successSpawnFn(),
  });
  assert.equal(result.outputPath, path.join(root, CANONICAL_OUTPUT_PATH));

  const customPath = 'custom.png';
  await fsp.writeFile(path.join(root, customPath), 'old');
  await assert.rejects(() =>
    run({
      repoRoot: root,
      outputPath: customPath,
      ...fakeChromiumOptions,
      spawnFn: successSpawnFn(),
    }),
  );
});

// --- CLI invocation guard -----------------------------------------------

test('isCliInvocation is true only for a direct node invocation of this module', () => {
  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const scriptPath = path.join(repoRoot, 'scripts', 'capture-readme-screenshot.mjs');
  const moduleUrl = pathToFileURL(scriptPath).href;
  assert.equal(isCliInvocation(scriptPath, moduleUrl), true);
  assert.equal(isCliInvocation('some/other/file.mjs', moduleUrl), false);
  assert.equal(isCliInvocation(undefined, moduleUrl), false);
});
