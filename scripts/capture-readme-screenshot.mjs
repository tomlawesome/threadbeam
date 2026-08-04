#!/usr/bin/env node
// Threadbeam-specific adapter for the reusable Chromium capture helper. It
// seeds only synthetic lifecycle data into a private temporary store, serves
// it on a loopback ephemeral port, captures the real dashboard, and cleans
// up the server and store on every path. It never reads the normal
// Threadbeam store, Git, credentials, prompts, source, diffs, or transcripts.

import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendEvent } from '../lib/store.mjs';
import { SCHEMA_VERSION } from '../lib/contract.mjs';
import { startServer } from '../server.mjs';
import { captureBrowserScreenshot } from './lib/capture-browser-screenshot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

export const CANONICAL_OUTPUT_PATH = 'docs/assets/threadbeam-dashboard.png';

// Deliberately spans multiple synthetic projects, all five providers, and
// every lifecycle state (including a resolved-then-recurring-style blocker
// history) so the captured screenshot represents the dashboard at a
// realistic, fully-populated scale -- not just the four-event minimum the
// contract requires. All repos/branches/titles are fabricated ("-demo"
// suffixed, "example/" prefixed) per the privacy requirements above.
export function synthesizeEvents(now) {
  const ago = (ms) => new Date(now - ms).toISOString();
  return [
    // threadbeam-demo: an in-progress task, an open question, and two
    // completed tasks (for the per-provider delivery metrics).
    {
      schemaVersion: SCHEMA_VERSION,
      provider: 'claude',
      repo: 'example/threadbeam-demo',
      project: 'threadbeam-demo',
      taskId: 'demo-active',
      issueNumber: 101,
      title: 'Add pagination to the delivery view',
      model: 'claude-sonnet-5',
      branch: 'agent/demo-active',
      worktree: 'demo-active',
      timestamp: ago(2 * 60 * 1000),
      state: 'implementing',
    },
    {
      schemaVersion: SCHEMA_VERSION,
      provider: 'mistral',
      repo: 'example/threadbeam-demo',
      project: 'threadbeam-demo',
      taskId: 'demo-question',
      issueNumber: 103,
      title: 'Support a compact table density option',
      model: 'mistral-large',
      branch: 'agent/demo-question',
      worktree: 'demo-question',
      timestamp: ago(3 * 60 * 1000),
      state: 'question',
      question: {
        question: 'Should compact density persist per browser or per user?',
        requestedAction: 'confirm the persistence scope',
      },
    },
    {
      schemaVersion: SCHEMA_VERSION,
      provider: 'ollama',
      repo: 'example/threadbeam-demo',
      project: 'threadbeam-demo',
      taskId: 'demo-completed',
      issueNumber: 100,
      title: 'Ship the initial dashboard layout',
      model: 'qwen2.5-coder:7b',
      branch: 'agent/demo-completed',
      worktree: 'demo-completed',
      timestamp: ago(20 * 60 * 1000),
      state: 'completed',
    },
    {
      schemaVersion: SCHEMA_VERSION,
      provider: 'luna',
      repo: 'example/threadbeam-demo',
      project: 'threadbeam-demo',
      taskId: 'demo-adapters',
      issueNumber: 104,
      title: 'Emit automatic provider lifecycle events',
      model: 'luna-1',
      branch: 'agent/demo-adapters',
      worktree: 'demo-adapters',
      timestamp: ago(50 * 60 * 1000),
      state: 'completed',
    },

    // mikroview-demo: an open blocker plus a completed task, so metrics
    // and blockers both have a second project's worth of data.
    {
      schemaVersion: SCHEMA_VERSION,
      provider: 'codex',
      repo: 'example/mikroview-demo',
      project: 'mikroview-demo',
      taskId: 'demo-blocked',
      issueNumber: 102,
      title: 'Fix flaky integration test',
      model: 'gpt-5-codex',
      branch: 'agent/demo-blocked',
      worktree: 'demo-blocked',
      timestamp: ago(5 * 60 * 1000),
      state: 'blocked',
      blocker: {
        cause: 'CI runner ran out of disk space',
        owner: 'sol',
        nextAction: 'clear the CI cache and retry',
      },
    },
    {
      schemaVersion: SCHEMA_VERSION,
      provider: 'claude',
      repo: 'example/mikroview-demo',
      project: 'mikroview-demo',
      taskId: 'demo-colorways',
      issueNumber: 105,
      title: 'Flesh out colorway theming',
      model: 'claude-sonnet-5',
      branch: 'agent/demo-colorways',
      worktree: 'demo-colorways',
      timestamp: ago(30 * 60 * 1000),
      state: 'completed',
    },

    // orbit-demo: a resolved blocker (blocked, then unblocked), giving the
    // delivery-metrics panel a blocker-resolution-time sample too.
    {
      schemaVersion: SCHEMA_VERSION,
      provider: 'mistral',
      repo: 'example/orbit-demo',
      project: 'orbit-demo',
      taskId: 'demo-renewals',
      issueNumber: 106,
      title: 'Add renewal reminders',
      model: 'mistral-large',
      branch: 'agent/demo-renewals',
      worktree: 'demo-renewals',
      timestamp: ago(75 * 60 * 1000),
      state: 'blocked',
      blocker: {
        cause: 'notification channel not yet decided',
        owner: 'sol',
        nextAction: 'pick email vs. SMS',
      },
    },
    {
      schemaVersion: SCHEMA_VERSION,
      provider: 'mistral',
      repo: 'example/orbit-demo',
      project: 'orbit-demo',
      taskId: 'demo-renewals',
      issueNumber: 106,
      title: 'Add renewal reminders',
      model: 'mistral-large',
      branch: 'agent/demo-renewals',
      worktree: 'demo-renewals',
      timestamp: ago(8 * 60 * 1000),
      state: 'implementing',
    },
  ];
}

// Tall enough to fit the whole dashboard (summary, blockers, questions,
// live tasks, completed history, timeline, delivery metrics) in one shot
// without scrolling -- captureBrowserScreenshot has no separate "full
// page" mode, so this is what stands in for one. If the page ever grows
// taller than this, the shot will crop rather than stretch; widen it here
// rather than adding a decorative empty margin below shorter content.
const README_CAPTURE_WINDOW_SIZE = '1280,3200';

export async function run({
  repoRoot = REPO_ROOT,
  outputPath = CANONICAL_OUTPUT_PATH,
  now = Date.now(),
  env,
  candidateNames,
  isExecutable,
  spawnFn,
  windowSize = README_CAPTURE_WINDOW_SIZE,
  timeoutMs,
  extraArgs,
} = {}) {
  const storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'threadbeam-capture-store-'));
  let server;
  try {
    for (const event of synthesizeEvents(now)) {
      await appendEvent(storeDir, event);
    }

    server = await startServer({ host: '127.0.0.1', port: 0, storeDir });
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/`;
    const overwritePath = outputPath === CANONICAL_OUTPUT_PATH ? CANONICAL_OUTPUT_PATH : undefined;

    return await captureBrowserScreenshot({
      repoRoot,
      url,
      outputPath,
      overwritePath,
      env,
      candidateNames,
      isExecutable,
      spawnFn,
      windowSize,
      timeoutMs,
      extraArgs,
    });
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await fsp.rm(storeDir, { recursive: true, force: true });
  }
}

export function isCliInvocation(argv1, moduleUrl) {
  return Boolean(argv1 && moduleUrl === pathToFileURL(path.resolve(argv1)).href);
}

if (isCliInvocation(process.argv[1], import.meta.url)) {
  run()
    .then((result) => {
      process.stdout.write(`threadbeam capture: wrote ${result.outputPath}\n`);
    })
    .catch((error) => {
      process.stderr.write(`threadbeam capture: ${error.message}\n`);
      process.exitCode = 1;
    });
}
