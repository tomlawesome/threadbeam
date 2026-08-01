import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { appendEvent, readEvents, deriveStatus, eventsFilePath, ensureStoreDir } from '../lib/store.mjs';
import { validateEvent, SCHEMA_VERSION } from '../lib/contract.mjs';
import { run as emit } from '../bin/emit.mjs';

async function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'agent-dashboard-test-'));
}

function baseEvent(overrides = {}) {
  return validateEvent({
    schemaVersion: SCHEMA_VERSION,
    provider: 'claude',
    repo: 'example/project',
    project: 'example-project',
    taskId: 'issue-175',
    issueNumber: 175,
    title: 'Agent delivery dashboard',
    model: 'claude-sonnet-5',
    branch: 'codex/issue-175-agent-dashboard',
    worktree: 'issue-175-claude',
    timestamp: '2026-08-01T12:00:00Z',
    state: 'implementing',
    ...overrides,
  }).value;
}

test('appendEvent then readEvents round-trips a valid event', async () => {
  const dir = await makeTempDir();
  const event = baseEvent();
  await appendEvent(dir, event);
  const { events, parseErrors } = await readEvents(dir);
  assert.equal(parseErrors, 0);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], event);
});

test('missing store file reads as empty without throwing', async () => {
  const dir = await makeTempDir();
  const { events, parseErrors } = await readEvents(dir);
  assert.deepEqual(events, []);
  assert.equal(parseErrors, 0);
});

test('malformed lines are skipped and counted, valid lines still read', async () => {
  const dir = await makeTempDir();
  await ensureStoreDir(dir);
  const filePath = eventsFilePath(dir);
  const good = JSON.stringify(baseEvent());
  await fsp.writeFile(filePath, `${good}\nnot json\n${good}\n`, { mode: 0o600 });
  const { events, parseErrors } = await readEvents(dir);
  assert.equal(parseErrors, 1);
  assert.equal(events.length, 2);
});

test('valid JSON that violates the event contract is skipped and counted', async () => {
  const dir = await makeTempDir();
  await ensureStoreDir(dir);
  const good = JSON.stringify(baseEvent());
  const invalid = JSON.stringify({ ...baseEvent(), transcript: 'must never enter the store' });
  await fsp.writeFile(eventsFilePath(dir), `${good}\n${invalid}\n`, { mode: 0o600 });

  const { events, parseErrors } = await readEvents(dir);
  assert.equal(parseErrors, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].taskId, 'issue-175');
});

test('appendEvent refuses to follow a symlinked events file', async () => {
  const dir = await makeTempDir();
  const outsideDir = await makeTempDir();
  const target = path.join(outsideDir, 'target.jsonl');
  await fsp.writeFile(target, '');
  await ensureStoreDir(dir);
  await fsp.symlink(target, eventsFilePath(dir));

  await assert.rejects(() => appendEvent(dir, baseEvent()));
  const targetContent = await fsp.readFile(target, 'utf8');
  assert.equal(targetContent, '');
});

test('readEvents refuses to read through a symlinked events file', async () => {
  const dir = await makeTempDir();
  const outsideDir = await makeTempDir();
  const target = path.join(outsideDir, 'target.jsonl');
  await fsp.writeFile(target, `${JSON.stringify(baseEvent())}\n`);
  await ensureStoreDir(dir);
  await fsp.symlink(target, eventsFilePath(dir));

  await assert.rejects(() => readEvents(dir));
});

test('ensureStoreDir refuses a symlinked store directory', async () => {
  const parent = await makeTempDir();
  const realDir = await makeTempDir();
  const linkedDir = path.join(parent, 'linked');
  await fsp.symlink(realDir, linkedDir);

  await assert.rejects(() => ensureStoreDir(linkedDir));
});

test('store directory and events file are created with private permissions', async () => {
  const dir = await makeTempDir();
  await appendEvent(dir, baseEvent());
  const dirStat = await fsp.stat(dir);
  const fileStat = await fsp.stat(eventsFilePath(dir));
  assert.equal(dirStat.mode & 0o777, 0o700);
  assert.equal(fileStat.mode & 0o777, 0o600);
});

test('appendEvent repairs permissive owner-controlled store permissions', async () => {
  const parent = await makeTempDir();
  const dir = path.join(parent, 'store');
  await fsp.mkdir(dir, { mode: 0o755 });
  await fsp.writeFile(eventsFilePath(dir), '', { mode: 0o644 });

  await appendEvent(dir, baseEvent());

  assert.equal((await fsp.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fsp.stat(eventsFilePath(dir))).mode & 0o777, 0o600);
});

test('appendEvent refuses to grow the event store past its byte limit', async () => {
  const dir = await makeTempDir();
  await appendEvent(dir, baseEvent(), { maxStoreBytes: 10_000 });
  const currentSize = (await fsp.stat(eventsFilePath(dir))).size;

  await assert.rejects(
    () => appendEvent(dir, baseEvent({ taskId: 'second-task' }), { maxStoreBytes: currentSize + 1 }),
    /retention limit/u,
  );
});

test('readEvents bounds the number of parsed lines', async () => {
  const dir = await makeTempDir();
  await ensureStoreDir(dir);
  const filePath = eventsFilePath(dir);
  const lines = [];
  for (let i = 0; i < 20; i += 1) {
    lines.push(JSON.stringify(baseEvent({ taskId: `task-${i}`, timestamp: `2026-08-01T12:00:${String(i).padStart(2, '0')}Z` })));
  }
  await fsp.writeFile(filePath, `${lines.join('\n')}\n`, { mode: 0o600 });
  const { events } = await readEvents(dir, { maxLines: 5 });
  assert.equal(events.length, 5);
  assert.equal(events[events.length - 1].taskId, 'task-19');
});

test('stale non-terminal tasks are derived as unknown, never as success', () => {
  const now = Date.parse('2026-08-01T13:00:00Z');
  const event = baseEvent({ timestamp: '2026-08-01T12:00:00Z', state: 'implementing' });
  const status = deriveStatus([event], { now, staleMs: 10 * 60 * 1000 });
  assert.equal(status.live.length, 1);
  assert.equal(status.live[0].state, 'unknown');
  assert.equal(status.live[0].rawState, 'implementing');
  assert.equal(status.completed.length, 0);
});

test('fresh non-terminal tasks keep their real state', () => {
  const now = Date.parse('2026-08-01T12:05:00Z');
  const event = baseEvent({ timestamp: '2026-08-01T12:00:00Z', state: 'implementing' });
  const status = deriveStatus([event], { now, staleMs: 10 * 60 * 1000 });
  assert.equal(status.live[0].state, 'implementing');
});

test('completed tasks age out after the retention window', () => {
  const now = Date.parse('2026-08-02T12:00:00Z');
  const event = baseEvent({ timestamp: '2026-08-01T12:00:00Z', state: 'completed' });
  const status = deriveStatus([event], { now, completedRetentionMs: 60 * 60 * 1000 });
  assert.equal(status.completed.length, 0);
});

test('completed history is bounded to maxCompleted entries', () => {
  const now = Date.parse('2026-08-01T12:00:00Z');
  const events = [];
  for (let i = 0; i < 10; i += 1) {
    events.push(
      baseEvent({
        taskId: `task-${i}`,
        state: 'completed',
        timestamp: `2026-08-01T11:${String(i).padStart(2, '0')}:00Z`,
      }),
    );
  }
  const status = deriveStatus(events, { now, maxCompleted: 3 });
  assert.equal(status.completed.length, 3);
});

test('blockers and questions surface only while state remains fresh', () => {
  const now = Date.parse('2026-08-01T12:05:00Z');
  const blocked = baseEvent({
    taskId: 'blocked-task',
    state: 'blocked',
    timestamp: '2026-08-01T12:00:00Z',
    blocker: { cause: 'flaky CI', owner: 'sol', nextAction: 'retry' },
  });
  const question = baseEvent({
    taskId: 'question-task',
    state: 'question',
    timestamp: '2026-08-01T12:00:00Z',
    question: { question: 'which region?', requestedAction: 'confirm' },
  });
  const status = deriveStatus([blocked, question], { now, staleMs: 60 * 60 * 1000 });
  assert.equal(status.blockers.length, 1);
  assert.equal(status.questions.length, 1);
  assert.equal(status.blockers[0].blocker.cause, 'flaky CI');
  assert.equal(status.questions[0].question.question, 'which region?');
});

test('absence of any event is never reported as a live or completed task', () => {
  const status = deriveStatus([], { now: Date.now() });
  assert.deepEqual(status.live, []);
  assert.deepEqual(status.completed, []);
});

test('the same task identifier in different repositories remains distinct', () => {
  const now = Date.parse('2026-08-01T12:05:00Z');
  const status = deriveStatus([
    baseEvent({ repo: 'example/project', taskId: 'issue-175' }),
    baseEvent({ repo: 'example/another-project', taskId: 'issue-175' }),
  ], { now, staleMs: 60 * 60 * 1000 });

  assert.equal(status.live.length, 2);
  assert.deepEqual(
    status.live.map((task) => task.repo).sort(),
    ['example/another-project', 'example/project'],
  );
});

test('emit() validates and appends a stdin-shaped event, rejecting invalid ones', async () => {
  const dir = await makeTempDir();
  const validPayload = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    provider: 'claude',
    repo: 'example/project',
    project: 'example-project',
    taskId: 'issue-175',
    model: 'claude-sonnet-5',
    branch: 'codex/issue-175-agent-dashboard',
    worktree: 'issue-175-claude',
    timestamp: '2026-08-01T12:00:00Z',
    state: 'queued',
  });

  const acceptedResult = await emit({ input: validPayload, storeDir: dir });
  assert.equal(acceptedResult.ok, true);

  const rejectedResult = await emit({ input: JSON.stringify({ nonsense: true }), storeDir: dir });
  assert.equal(rejectedResult.ok, false);

  const emptyResult = await emit({ input: '   ', storeDir: dir });
  assert.equal(emptyResult.ok, false);

  const notJsonResult = await emit({ input: 'not json', storeDir: dir });
  assert.equal(notJsonResult.ok, false);

  const oversizedResult = await emit({ input: 'x'.repeat(20_000), storeDir: dir });
  assert.equal(oversizedResult.ok, false);
  assert.deepEqual(oversizedResult.errors, ['stdin_too_large']);

  const { events } = await readEvents(dir);
  assert.equal(events.length, 1);
});
