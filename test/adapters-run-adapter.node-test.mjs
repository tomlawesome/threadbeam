import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runAdapter } from '../adapters/lib/run-adapter.mjs';

function baseArgv(overrides = {}) {
  const fields = {
    repo: 'example/project',
    project: 'example-project',
    'task-id': 'issue-42',
    model: 'claude-sonnet-5',
    branch: 'agent/issue-42-delivery-view',
    worktree: 'issue-42-implementation',
    timestamp: '2026-08-01T12:00:00Z',
    state: 'implementing',
    ...overrides,
  };
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `--${key}=${value}`);
}

function fakeSpawn({ exitCode = 0, stderr = '' } = {}) {
  const writes = [];
  let ended = false;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      end(data) {
        writes.push(data);
        ended = true;
        queueMicrotask(() => {
          if (stderr) child.stderr.emit('data', Buffer.from(stderr));
          child.emit('close', exitCode);
        });
      },
    };
    return child;
  };
  return { spawnFn, writes, wasEnded: () => ended };
}

test('runAdapter rejects a provider outside the closed PROVIDERS list without spawning anything', async () => {
  let spawned = false;
  const spawnFn = () => {
    spawned = true;
    throw new Error('should not spawn');
  };
  const result = await runAdapter({ provider: 'gpt-5-raw', argv: baseArgv(), spawnFn });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /unknown_provider/);
  assert.equal(spawned, false);
});

test('runAdapter rejects an unknown flag without spawning anything, even alongside otherwise-valid flags', async () => {
  let spawned = false;
  const spawnFn = () => {
    spawned = true;
    throw new Error('should not spawn');
  };
  const result = await runAdapter({
    provider: 'claude',
    argv: [...baseArgv(), '--transcript=leaked tool output'],
    spawnFn,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('transcript')));
  assert.equal(spawned, false);
});

test('runAdapter pipes exactly one JSON-shaped event to the emitter stdin and reports success on exit 0', async () => {
  const { spawnFn, writes, wasEnded } = fakeSpawn({ exitCode: 0 });
  const result = await runAdapter({ provider: 'codex', argv: baseArgv({ state: 'queued' }), spawnFn });

  assert.equal(result.ok, true);
  assert.equal(wasEnded(), true);
  assert.equal(writes.length, 1);
  const emitted = JSON.parse(writes[0]);
  assert.equal(emitted.provider, 'codex');
  assert.equal(emitted.state, 'queued');
  assert.equal(emitted.schemaVersion, 1);
});

test('runAdapter surfaces the emitter rejection when bin/emit.mjs exits non-zero', async () => {
  const { spawnFn } = fakeSpawn({ exitCode: 1, stderr: 'threadbeam emit: rejected event\ninvalid_state' });
  const result = await runAdapter({ provider: 'mistral', argv: baseArgv({ state: 'not-a-real-state' }), spawnFn });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /invalid_state/);
});
