// Private JSONL lifecycle-event store: append-only writes, bounded reads,
// and derivation of dashboard status from the raw event log.

import os from 'node:os';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import { PROVIDERS, TERMINAL_STATES, validateEvent } from './contract.mjs';

const EVENTS_FILE_NAME = 'events.jsonl';

const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_MAX_LINES = 5000;
const DEFAULT_MAX_STORE_BYTES = 8_000_000;
const DEFAULT_STALE_MS = 20 * 60 * 1000;
const DEFAULT_COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_COMPLETED = 20;
const DEFAULT_MAX_TIMELINE = 50;

export function defaultStoreDir(env = process.env) {
  if (env.THREADBEAM_STORE_DIR) return env.THREADBEAM_STORE_DIR;
  return path.join(os.homedir(), '.threadbeam');
}

export function eventsFilePath(dir) {
  return path.join(dir, EVENTS_FILE_NAME);
}

/**
 * Creates the private store directory if needed and refuses to operate
 * through a symlinked directory.
 */
export async function ensureStoreDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const flags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
  const handle = await fsp.open(dir, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      throw new Error('threadbeam store path must be a directory');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('threadbeam store directory must be owned by the current user');
    }
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

/**
 * Appends one validated event as a single JSON line. Uses O_NOFOLLOW so a
 * symlinked events file is refused at the syscall level rather than followed.
 */
export async function appendEvent(dir, event, options = {}) {
  const validated = validateEvent(event);
  if (!validated.ok) {
    throw new Error(`threadbeam event contract rejected: ${validated.errors.join(', ')}`);
  }
  await ensureStoreDir(dir);
  const filePath = eventsFilePath(dir);
  const line = Buffer.from(`${JSON.stringify(validated.value)}\n`, 'utf8');
  const maxStoreBytes = options.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES;
  const flags =
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW;
  const handle = await fsp.open(filePath, flags, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error('threadbeam events path must be a regular file');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('threadbeam events file must be owned by the current user');
    }
    await handle.chmod(0o600);
    if (stat.size + line.byteLength > maxStoreBytes) {
      throw new Error('threadbeam event store retention limit reached');
    }
    await handle.write(line, 0, line.byteLength);
  } finally {
    await handle.close();
  }
}

/**
 * Reads events bounded by byte window and line count so a large or
 * corrupted file cannot exhaust memory. Malformed lines are skipped and
 * counted rather than thrown.
 */
export async function readEvents(dir, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  await ensureStoreDir(dir);
  const filePath = eventsFilePath(dir);

  let handle;
  try {
    handle = await fsp.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ENOENT') return { events: [], parseErrors: 0 };
    throw err;
  }
  let text;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error('threadbeam events path must be a regular file');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('threadbeam events file must be owned by the current user');
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error('threadbeam events file permissions must be owner-only');
    }
    const readStart = Math.max(0, stat.size - maxBytes);
    const length = stat.size - readStart;
    if (length === 0) return { events: [], parseErrors: 0 };
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, readStart);
    text = buf.toString('utf8');
    if (readStart > 0) {
      // The window may start mid-line; drop the partial leading fragment.
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
  } finally {
    await handle.close();
  }

  const allLines = text.split('\n').filter((line) => line.length > 0);
  const lines = allLines.length > maxLines ? allLines.slice(allLines.length - maxLines) : allLines;

  const events = [];
  let parseErrors = 0;
  for (const line of lines) {
    try {
      const validated = validateEvent(JSON.parse(line));
      if (!validated.ok) {
        parseErrors += 1;
        continue;
      }
      events.push(validated.value);
    } catch {
      parseErrors += 1;
    }
  }
  return { events, parseErrors };
}

function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

/**
 * Folds the raw event log into per-task status, applying staleness,
 * retention and bounded-history rules. Absence of a recent update is never
 * treated as success: stale non-terminal tasks are surfaced as 'unknown'.
 */
export function deriveStatus(events, options = {}) {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const completedRetentionMs = options.completedRetentionMs ?? DEFAULT_COMPLETED_RETENTION_MS;
  const maxCompleted = options.maxCompleted ?? DEFAULT_MAX_COMPLETED;
  const maxTimeline = options.maxTimeline ?? DEFAULT_MAX_TIMELINE;

  const byTask = new Map();
  for (const event of events) {
    if (!event || typeof event.taskId !== 'string' || typeof event.timestamp !== 'string') {
      continue;
    }
    const ms = Date.parse(event.timestamp);
    if (Number.isNaN(ms)) continue;
    const taskKey = `${event.repo}\0${event.taskId}`;
    const group = byTask.get(taskKey);
    if (!group) {
      byTask.set(taskKey, { first: event, firstMs: ms, last: event, lastMs: ms });
    } else {
      if (ms < group.firstMs) {
        group.first = event;
        group.firstMs = ms;
      }
      if (ms >= group.lastMs) {
        group.last = event;
        group.lastMs = ms;
      }
    }
  }

  const live = [];
  const completed = [];
  const blockers = [];
  const questions = [];

  for (const group of byTask.values()) {
    const rawState = group.last.state;
    const terminal = isTerminal(rawState);
    const stale = !terminal && now - group.lastMs > staleMs;
    const displayState = stale ? 'unknown' : rawState;

    const task = {
      taskId: group.last.taskId,
      provider: group.last.provider,
      model: group.last.model,
      repo: group.last.repo,
      project: group.last.project,
      issueNumber: group.last.issueNumber,
      title: group.last.title,
      branch: group.last.branch,
      worktree: group.last.worktree,
      state: displayState,
      rawState,
      startedAt: group.first.timestamp,
      lastUpdateAt: group.last.timestamp,
    };

    if (terminal) {
      if (now - group.lastMs <= completedRetentionMs) {
        completed.push({ ...task, elapsedMs: group.lastMs - group.firstMs });
      }
      continue;
    }

    live.push({ ...task, elapsedMs: now - group.firstMs });

    if (displayState === 'blocked' && group.last.blocker) {
      blockers.push({ ...task, blocker: group.last.blocker });
    }
    if (displayState === 'question' && group.last.question) {
      questions.push({ ...task, question: group.last.question });
    }
  }

  live.sort((a, b) => Date.parse(b.lastUpdateAt) - Date.parse(a.lastUpdateAt));
  completed.sort((a, b) => Date.parse(b.lastUpdateAt) - Date.parse(a.lastUpdateAt));
  const boundedCompleted = completed.slice(0, maxCompleted);

  const timeline = events
    .filter((event) => event && typeof event.timestamp === 'string' && !Number.isNaN(Date.parse(event.timestamp)))
    .slice()
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, maxTimeline)
    .map((event) => ({
      timestamp: event.timestamp,
      taskId: event.taskId,
      provider: event.provider,
      state: event.state,
      title: event.title,
    }));

  return {
    generatedAt: new Date(now).toISOString(),
    live,
    blockers,
    questions,
    completed: boundedCompleted,
    timeline,
  };
}

/**
 * Derives read-only delivery metrics (throughput and timing) from the same
 * event history deriveStatus uses. A separate pass rather than folded into
 * deriveStatus's per-task first/last grouping, since blocker duration needs
 * each task's full ordered event sequence, not just its first and last
 * event. Never mutates the input events.
 */
export function deriveMetrics(events, options = {}) {
  const now = options.now ?? Date.now();
  const completedRetentionMs = options.completedRetentionMs ?? DEFAULT_COMPLETED_RETENTION_MS;

  const byTask = new Map();
  for (const event of events) {
    if (!event || typeof event.taskId !== 'string' || typeof event.timestamp !== 'string') continue;
    const ms = Date.parse(event.timestamp);
    if (Number.isNaN(ms)) continue;
    const taskKey = `${event.repo}\0${event.taskId}`;
    const entry = { event, ms };
    const list = byTask.get(taskKey);
    if (list) list.push(entry);
    else byTask.set(taskKey, [entry]);
  }

  const byProvider = new Map(PROVIDERS.map((p) => [p, { completed: 0, totalCompletionMs: 0 }]));
  let resolvedBlockerCount = 0;
  let totalBlockerDurationMs = 0;

  for (const entries of byTask.values()) {
    entries.sort((a, b) => a.ms - b.ms);

    const first = entries[0];
    const last = entries[entries.length - 1];
    if (isTerminal(last.event.state) && now - last.ms <= completedRetentionMs) {
      const bucket = byProvider.get(last.event.provider);
      if (bucket) {
        bucket.completed += 1;
        bucket.totalCompletionMs += last.ms - first.ms;
      }
    }

    // Walks runs of consecutive 'blocked' events as one continuous span
    // (a blocker's cause/owner/nextAction can be updated without leaving
    // the blocked state) rather than treating each update as its own
    // resolution. A run with no later, differing-state event is a blocker
    // still open right now -- excluded from the resolved average, since it
    // has no duration to report yet.
    let i = 0;
    while (i < entries.length) {
      if (entries[i].event.state !== 'blocked') {
        i += 1;
        continue;
      }
      const startMs = entries[i].ms;
      let j = i + 1;
      while (j < entries.length && entries[j].event.state === 'blocked') j += 1;
      if (j < entries.length) {
        resolvedBlockerCount += 1;
        totalBlockerDurationMs += entries[j].ms - startMs;
      }
      i = j;
    }
  }

  const byProviderResult = {};
  for (const [provider, bucket] of byProvider) {
    byProviderResult[provider] = {
      completed: bucket.completed,
      avgCompletionMs: bucket.completed > 0 ? Math.round(bucket.totalCompletionMs / bucket.completed) : null,
    };
  }

  return {
    byProvider: byProviderResult,
    blockers: {
      resolvedCount: resolvedBlockerCount,
      avgDurationMs: resolvedBlockerCount > 0 ? Math.round(totalBlockerDurationMs / resolvedBlockerCount) : null,
    },
  };
}
