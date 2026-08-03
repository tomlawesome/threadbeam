// Zero-dependency Chromium screenshot helper. Reusable by any local project
// (Threadbeam, Orbit, ...): it imports no product-specific module and takes
// every capability - browser discovery, process spawning, output location -
// as an explicit, injectable argument.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_CANDIDATE_NAMES = Object.freeze([
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'chrome',
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DEFAULT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function defaultIsExecutable(filePath) {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a Chromium-family executable. An explicit THREADBEAM_CHROMIUM_PATH
 * is authoritative and never falls back to PATH search when invalid.
 */
export function resolveChromiumExecutable({
  env = process.env,
  candidateNames = DEFAULT_CANDIDATE_NAMES,
  isExecutable = defaultIsExecutable,
} = {}) {
  const explicitPath = env.THREADBEAM_CHROMIUM_PATH;
  if (explicitPath) {
    if (!isExecutable(explicitPath)) {
      throw new Error(
        `THREADBEAM_CHROMIUM_PATH is set to a path that is not an executable file: ${explicitPath}`,
      );
    }
    return explicitPath;
  }

  const searchDirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of searchDirs) {
    for (const name of candidateNames) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  throw new Error('no Chromium executable found on PATH; set THREADBEAM_CHROMIUM_PATH explicitly');
}

export function assertLoopbackUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('capture URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('capture URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('capture URL must not carry credentials');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error('capture URL must target localhost, 127.0.0.1 or ::1');
  }
  return url;
}

/**
 * Validates a .png output path under repoRoot: missing parent directories
 * are fine, but traversal, symlinked path components and directories are
 * refused, and an existing file is refused unless overwritePath names that
 * exact file.
 */
export async function resolveOutputPath(repoRoot, outputPath, { overwritePath } = {}) {
  if (typeof outputPath !== 'string' || !outputPath.toLowerCase().endsWith('.png')) {
    throw new Error('output path must end with .png');
  }
  if (outputPath.split(/[\\/]/).includes('..')) {
    throw new Error('output path must not contain traversal segments');
  }

  const resolvedRoot = path.resolve(repoRoot);
  const resolvedOutput = path.resolve(resolvedRoot, outputPath);
  if (resolvedOutput !== resolvedRoot && !resolvedOutput.startsWith(resolvedRoot + path.sep)) {
    throw new Error('output path must stay under the repository root');
  }

  const relative = path.relative(resolvedRoot, resolvedOutput);
  const segments = relative.split(path.sep);
  let current = resolvedRoot;
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    const isLast = i === segments.length - 1;
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`output path contains a symlink component: ${current}`);
    }
    if (isLast) {
      if (stat.isDirectory()) {
        throw new Error('output path must not be an existing directory');
      }
      const overwriteResolved = overwritePath ? path.resolve(resolvedRoot, overwritePath) : undefined;
      if (overwriteResolved !== resolvedOutput) {
        throw new Error('output file already exists; no matching overwrite authorisation was supplied');
      }
    } else if (!stat.isDirectory()) {
      throw new Error(`output path component is not a directory: ${current}`);
    }
  }

  return resolvedOutput;
}

function runChromiumProcess(spawnFn, executablePath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(executablePath, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // process already gone
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      resolve(result);
    };

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      finish({ code, signal, stdout, stderr, timedOut });
    });
  });
}

/**
 * Spawns Chromium headlessly against outputPath (already validated by the
 * caller). Always uses a private temporary profile and always cleans it up.
 */
export async function captureScreenshot({
  executablePath,
  url,
  outputPath,
  windowSize = '1280,800',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  extraArgs = [],
  spawnFn = spawn,
} = {}) {
  if (!executablePath) {
    throw new Error('executablePath is required');
  }
  if (typeof outputPath !== 'string' || !outputPath.toLowerCase().endsWith('.png')) {
    throw new Error('output path must end with .png');
  }
  assertLoopbackUrl(url);

  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'capture-browser-profile-'));
  try {
    const args = [
      `--user-data-dir=${profileDir}`,
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-sync',
      '--no-first-run',
      '--hide-scrollbars',
      `--window-size=${windowSize}`,
      ...extraArgs,
      `--screenshot=${outputPath}`,
      url,
    ];

    const result = await runChromiumProcess(spawnFn, executablePath, args, timeoutMs);

    if (result.timedOut) {
      throw new Error(`chromium capture timed out after ${timeoutMs}ms`);
    }
    if (result.signal) {
      throw new Error(`chromium exited via signal ${result.signal}`);
    }
    if (result.code !== 0) {
      throw new Error(`chromium exited with code ${result.code}${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
    }

    const stat = await fsp.stat(outputPath).catch(() => null);
    if (!stat || !stat.isFile() || stat.size === 0) {
      throw new Error('chromium reported success but wrote no screenshot file');
    }

    return { outputPath };
  } finally {
    await fsp.rm(profileDir, { recursive: true, force: true });
  }
}

/**
 * Composes discovery, output validation and process execution into one call.
 */
export async function captureBrowserScreenshot({
  repoRoot,
  url,
  outputPath,
  overwritePath,
  env = process.env,
  candidateNames = DEFAULT_CANDIDATE_NAMES,
  isExecutable = defaultIsExecutable,
  windowSize,
  timeoutMs,
  extraArgs,
  spawnFn = spawn,
} = {}) {
  const executablePath = resolveChromiumExecutable({ env, candidateNames, isExecutable });
  const resolvedOutputPath = await resolveOutputPath(repoRoot, outputPath, { overwritePath });
  await captureScreenshot({
    executablePath,
    url,
    outputPath: resolvedOutputPath,
    windowSize,
    timeoutMs,
    extraArgs,
    spawnFn,
  });
  return { outputPath: resolvedOutputPath, executablePath };
}
