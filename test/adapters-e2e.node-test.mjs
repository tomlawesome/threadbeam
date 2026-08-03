// End-to-end proof: real adapter subprocesses (the actual Node binary and
// the actual bin/emit.mjs, no injected fakes) feeding a private temp store,
// read back the same way server.mjs's /api/status does -- proving
// representative bounded tasks appear and transition without any table
// editing, purely by invoking the adapters as another repository's hook
// script would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readEvents, deriveStatus } from '../lib/store.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = path.resolve(__dirname, '../adapters');

async function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'threadbeam-adapters-e2e-'));
}

function runAdapter(provider, flags, env) {
  const args = Object.entries(flags).map(([key, value]) => `--${key}=${value}`);
  return execFileAsync(process.execPath, [path.join(ADAPTERS_DIR, `${provider}.mjs`), ...args], { env });
}

test('a representative task transitions from queued to completed via the codex adapter, with no table editing', async () => {
  const storeDir = await makeTempDir();
  const env = { ...process.env, THREADBEAM_STORE_DIR: storeDir };
  const task = {
    repo: 'example/threadbeam-demo',
    project: 'threadbeam-demo',
    'task-id': 'issue-201',
    'issue-number': 201,
    title: 'Fix flaky integration test',
    model: 'gpt-5-codex',
    branch: 'agent/issue-201',
    worktree: 'issue-201-impl',
  };

  try {
    await runAdapter('codex', { ...task, state: 'queued', timestamp: '2026-08-02T00:00:00Z' }, env);
    await runAdapter('codex', { ...task, state: 'implementing', timestamp: '2026-08-02T00:01:00Z' }, env);
    await runAdapter('codex', { ...task, state: 'completed', timestamp: '2026-08-02T00:05:00Z' }, env);

    const { events, parseErrors } = await readEvents(storeDir);
    assert.equal(parseErrors, 0);
    assert.equal(events.length, 3);

    const status = deriveStatus(events, { now: Date.parse('2026-08-02T00:06:00Z') });
    assert.equal(status.live.length, 0);
    assert.equal(status.completed.length, 1);
    assert.equal(status.completed[0].taskId, 'issue-201');
    assert.equal(status.completed[0].rawState, 'completed');
  } finally {
    await fsp.rm(storeDir, { recursive: true, force: true });
  }
});

test('a blocked task from the mistral adapter surfaces as a live blocker with its cause and next action', async () => {
  const storeDir = await makeTempDir();
  const env = { ...process.env, THREADBEAM_STORE_DIR: storeDir };

  try {
    await runAdapter(
      'mistral',
      {
        repo: 'example/threadbeam-demo',
        project: 'threadbeam-demo',
        'task-id': 'issue-202',
        model: 'mistral-large',
        branch: 'agent/issue-202',
        worktree: 'issue-202-impl',
        state: 'blocked',
        'blocker-cause': 'CI runner ran out of disk space',
        'blocker-owner': 'sol',
        'blocker-next-action': 'clear the CI cache and retry',
        timestamp: '2026-08-02T00:00:00Z',
      },
      env,
    );

    const { events } = await readEvents(storeDir);
    const status = deriveStatus(events, { now: Date.parse('2026-08-02T00:01:00Z') });

    assert.equal(status.live.length, 1);
    assert.equal(status.blockers.length, 1);
    assert.equal(status.blockers[0].taskId, 'issue-202');
    assert.equal(status.blockers[0].blocker.cause, 'CI runner ran out of disk space');
  } finally {
    await fsp.rm(storeDir, { recursive: true, force: true });
  }
});

test('a question from the ollama adapter surfaces live with its requested action', async () => {
  const storeDir = await makeTempDir();
  const env = { ...process.env, THREADBEAM_STORE_DIR: storeDir };

  try {
    await runAdapter(
      'ollama',
      {
        repo: 'example/threadbeam-demo',
        project: 'threadbeam-demo',
        'task-id': 'issue-203',
        model: 'qwen2.5-coder:7b',
        branch: 'agent/issue-203',
        worktree: 'issue-203-impl',
        state: 'question',
        question: 'Should compact density persist per browser or per user?',
        'question-requested-action': 'confirm the persistence scope',
        timestamp: '2026-08-02T00:00:00Z',
      },
      env,
    );

    const { events } = await readEvents(storeDir);
    const status = deriveStatus(events, { now: Date.parse('2026-08-02T00:01:00Z') });

    assert.equal(status.questions.length, 1);
    assert.equal(status.questions[0].question.requestedAction, 'confirm the persistence scope');
  } finally {
    await fsp.rm(storeDir, { recursive: true, force: true });
  }
});

test('an adapter invocation with an unknown flag exits non-zero and writes nothing to the store', async () => {
  const storeDir = await makeTempDir();
  const env = { ...process.env, THREADBEAM_STORE_DIR: storeDir };

  try {
    await assert.rejects(
      runAdapter(
        'luna',
        {
          repo: 'example/threadbeam-demo',
          project: 'threadbeam-demo',
          'task-id': 'issue-204',
          model: 'luna-1',
          branch: 'agent/issue-204',
          worktree: 'issue-204-impl',
          state: 'implementing',
          timestamp: '2026-08-02T00:00:00Z',
          transcript: 'leaked tool output',
        },
        env,
      ),
    );
    const { events } = await readEvents(storeDir);
    assert.equal(events.length, 0);
  } finally {
    await fsp.rm(storeDir, { recursive: true, force: true });
  }
});
