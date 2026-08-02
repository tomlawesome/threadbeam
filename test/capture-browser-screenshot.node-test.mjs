import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import {
  resolveChromiumExecutable,
  assertLoopbackUrl,
  resolveOutputPath,
  captureScreenshot,
  captureBrowserScreenshot,
} from '../scripts/lib/capture-browser-screenshot.mjs';

async function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'capture-browser-test-'));
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

function profileArgValue(args) {
  return args.find((a) => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
}

// --- browser resolution -----------------------------------------------

test('resolveChromiumExecutable returns the explicit path when it checks out as executable', () => {
  const result = resolveChromiumExecutable({
    env: { THREADBEAM_CHROMIUM_PATH: '/opt/fake/chromium' },
    isExecutable: (p) => p === '/opt/fake/chromium',
  });
  assert.equal(result, '/opt/fake/chromium');
});

test('an explicitly configured but invalid executable fails clearly without falling back to PATH', () => {
  const checkedPaths = [];
  assert.throws(
    () =>
      resolveChromiumExecutable({
        env: { THREADBEAM_CHROMIUM_PATH: '/opt/fake/not-executable', PATH: '/opt/fake' },
        candidateNames: ['not-executable'],
        isExecutable: (p) => {
          checkedPaths.push(p);
          return false;
        },
      }),
    /THREADBEAM_CHROMIUM_PATH/,
  );
  assert.deepEqual(checkedPaths, ['/opt/fake/not-executable']);
});

test('PATH discovery checks directories in order and returns the first matching candidate', () => {
  const checks = [];
  const result = resolveChromiumExecutable({
    env: { PATH: ['/first/bin', '/second/bin'].join(path.delimiter) },
    candidateNames: ['chromium', 'chrome'],
    isExecutable: (p) => {
      checks.push(p);
      return p === '/second/bin/chromium';
    },
  });
  assert.equal(result, '/second/bin/chromium');
  assert.deepEqual(checks, ['/first/bin/chromium', '/first/bin/chrome', '/second/bin/chromium']);
});

test('resolveChromiumExecutable throws when nothing on PATH matches', () => {
  assert.throws(
    () =>
      resolveChromiumExecutable({
        env: { PATH: '/empty/bin' },
        candidateNames: ['chromium'],
        isExecutable: () => false,
      }),
    /no Chromium executable found/,
  );
});

// --- loopback URL validation --------------------------------------------

test('loopback URLs are accepted, including IPv6 ::1', () => {
  for (const url of ['http://localhost:4317/', 'http://127.0.0.1:4317/', 'http://[::1]:4317/', 'https://localhost/']) {
    assert.doesNotThrow(() => assertLoopbackUrl(url), url);
  }
});

test('remote hosts, other schemes and embedded credentials are rejected', () => {
  for (const url of [
    'http://example.com/',
    'https://127.0.0.1.evil.com/',
    'file:///etc/passwd',
    'ftp://127.0.0.1/',
    'http://user:pass@127.0.0.1/',
    'not a url',
  ]) {
    assert.throws(() => assertLoopbackUrl(url), Error, url);
  }
});

// --- output path validation ---------------------------------------------

test('resolveOutputPath permits missing suffix directories', async () => {
  const root = await makeTempDir();
  const resolved = await resolveOutputPath(root, 'nested/does/not/exist/shot.png');
  assert.equal(resolved, path.join(root, 'nested/does/not/exist/shot.png'));
});

test('resolveOutputPath rejects a non-png suffix', async () => {
  const root = await makeTempDir();
  await assert.rejects(() => resolveOutputPath(root, 'shot.jpg'));
});

test('resolveOutputPath rejects traversal outside the repository root', async () => {
  const root = await makeTempDir();
  await assert.rejects(() => resolveOutputPath(root, '../outside.png'));
});

test('resolveOutputPath rejects an existing symlink path component', async () => {
  const root = await makeTempDir();
  const outsideDir = await makeTempDir();
  await fsp.symlink(outsideDir, path.join(root, 'linked'));
  await assert.rejects(() => resolveOutputPath(root, 'linked/shot.png'), /symlink/);
});

test('resolveOutputPath rejects an existing directory at the output path', async () => {
  const root = await makeTempDir();
  await fsp.mkdir(path.join(root, 'shot.png'));
  await assert.rejects(() => resolveOutputPath(root, 'shot.png'), /directory/);
});

test('resolveOutputPath refuses to overwrite an existing file without a matching overwrite path', async () => {
  const root = await makeTempDir();
  await fsp.writeFile(path.join(root, 'shot.png'), 'old');
  await assert.rejects(() => resolveOutputPath(root, 'shot.png'));
  await assert.rejects(() => resolveOutputPath(root, 'shot.png', { overwritePath: 'other.png' }));
});

test('resolveOutputPath permits overwrite only when the overwrite path exactly matches', async () => {
  const root = await makeTempDir();
  await fsp.writeFile(path.join(root, 'shot.png'), 'old');
  const resolved = await resolveOutputPath(root, 'shot.png', { overwritePath: 'shot.png' });
  assert.equal(resolved, path.join(root, 'shot.png'));
});

// --- process execution ----------------------------------------------------

test('captureScreenshot succeeds, spawns without a shell, and cleans up the temp profile', async () => {
  const dir = await makeTempDir();
  const outputPath = path.join(dir, 'shot.png');
  let profileDirSeen;
  let sawShellOption;
  const spawnFn = (command, args, options) => {
    sawShellOption = options.shell;
    profileDirSeen = profileArgValue(args);
    const child = makeFakeChild();
    queueMicrotask(async () => {
      await fsp.writeFile(screenshotArgValue(args), 'fake-png');
      child.emit('close', 0, null);
    });
    return child;
  };

  const result = await captureScreenshot({
    executablePath: '/fake/chromium',
    url: 'http://127.0.0.1:1234/',
    outputPath,
    spawnFn,
  });

  assert.equal(result.outputPath, outputPath);
  assert.equal(sawShellOption, false);
  await assert.rejects(() => fsp.stat(profileDirSeen));
});

test('captureScreenshot rejects and still cleans up on non-zero exit', async () => {
  const dir = await makeTempDir();
  const outputPath = path.join(dir, 'shot.png');
  let profileDirSeen;
  const spawnFn = (command, args) => {
    profileDirSeen = profileArgValue(args);
    const child = makeFakeChild();
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('render failed'));
      child.emit('close', 1, null);
    });
    return child;
  };

  await assert.rejects(
    () => captureScreenshot({ executablePath: '/fake/chromium', url: 'http://127.0.0.1:1234/', outputPath, spawnFn }),
    /render failed/,
  );
  await assert.rejects(() => fsp.stat(profileDirSeen));
});

test('captureScreenshot rejects and cleans up when the process is killed by a signal', async () => {
  const dir = await makeTempDir();
  const outputPath = path.join(dir, 'shot.png');
  let profileDirSeen;
  const spawnFn = (command, args) => {
    profileDirSeen = profileArgValue(args);
    const child = makeFakeChild();
    queueMicrotask(() => child.emit('close', null, 'SIGSEGV'));
    return child;
  };

  await assert.rejects(
    () => captureScreenshot({ executablePath: '/fake/chromium', url: 'http://127.0.0.1:1234/', outputPath, spawnFn }),
    /SIGSEGV/,
  );
  await assert.rejects(() => fsp.stat(profileDirSeen));
});

test('captureScreenshot times out, kills the process, and cleans up', async () => {
  const dir = await makeTempDir();
  const outputPath = path.join(dir, 'shot.png');
  let profileDirSeen;
  const killSignals = [];
  const spawnFn = (command, args) => {
    profileDirSeen = profileArgValue(args);
    const child = makeFakeChild();
    child.kill = (signal) => {
      killSignals.push(signal);
      setTimeout(() => child.emit('close', null, 'SIGTERM'), 5);
      return true;
    };
    return child;
  };

  await assert.rejects(
    () =>
      captureScreenshot({
        executablePath: '/fake/chromium',
        url: 'http://127.0.0.1:1234/',
        outputPath,
        spawnFn,
        timeoutMs: 20,
      }),
    /timed out/,
  );
  assert.ok(killSignals.includes('SIGTERM'));
  await assert.rejects(() => fsp.stat(profileDirSeen));
});

test('captureScreenshot rejects when chromium exits 0 but writes no file', async () => {
  const dir = await makeTempDir();
  const outputPath = path.join(dir, 'shot.png');
  const spawnFn = () => {
    const child = makeFakeChild();
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };
  await assert.rejects(
    () => captureScreenshot({ executablePath: '/fake/chromium', url: 'http://127.0.0.1:1234/', outputPath, spawnFn }),
    /wrote no screenshot file/,
  );
});

// --- composed helper --------------------------------------------------

test('captureBrowserScreenshot composes discovery, output validation and process execution', async () => {
  const root = await makeTempDir();
  const spawnFn = (command, args) => {
    const child = makeFakeChild();
    queueMicrotask(async () => {
      await fsp.writeFile(screenshotArgValue(args), 'fake-png');
      child.emit('close', 0, null);
    });
    return child;
  };

  const result = await captureBrowserScreenshot({
    repoRoot: root,
    url: 'http://127.0.0.1:9999/',
    outputPath: 'shot.png',
    env: { THREADBEAM_CHROMIUM_PATH: '/fake/chromium' },
    isExecutable: (p) => p === '/fake/chromium',
    spawnFn,
  });

  assert.equal(result.outputPath, path.join(root, 'shot.png'));
  assert.equal(result.executablePath, '/fake/chromium');
  const written = await fsp.readFile(result.outputPath, 'utf8');
  assert.equal(written, 'fake-png');
});
