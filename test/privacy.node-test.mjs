import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateEvent, SCHEMA_VERSION } from '../lib/contract.mjs';
import { appendEvent, eventsFilePath } from '../lib/store.mjs';

async function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'agent-dashboard-privacy-test-'));
}

function baseEvent(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    provider: 'claude',
    repo: 'example/project',
    project: 'example-project',
    taskId: 'issue-175',
    model: 'claude-sonnet-5',
    branch: 'codex/issue-175-agent-dashboard',
    worktree: 'issue-175-claude',
    timestamp: '2026-08-01T12:00:00Z',
    state: 'implementing',
    ...overrides,
  };
}

const SECRET_SHAPED_SAMPLES = [
  ['sk-', 'a'.repeat(24)].join(''),
  ['gh', 'p_', 'A'.repeat(30)].join(''),
  ['AK', 'IA', 'A'.repeat(16)].join(''),
  ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join(''),
  ['Bearer ', 'a'.repeat(24)].join(''),
  ['pass', 'word: ', 'not-a-real-value'.repeat(2)].join(''),
  '9f86d081'.repeat(8),
];

test('title rejects every secret-shaped sample', () => {
  for (const sample of SECRET_SHAPED_SAMPLES) {
    const result = validateEvent(baseEvent({ title: sample }));
    assert.equal(result.ok, false, `expected title "${sample}" to be rejected`);
  }
});

test('blocker fields reject secret-shaped content', () => {
  for (const sample of SECRET_SHAPED_SAMPLES) {
    const result = validateEvent(
      baseEvent({
        state: 'blocked',
        blocker: { cause: sample, owner: 'sol', nextAction: 'rotate credential' },
      }),
    );
    assert.equal(result.ok, false, `expected blocker.cause "${sample}" to be rejected`);
  }
});

test('question fields reject secret-shaped content', () => {
  for (const sample of SECRET_SHAPED_SAMPLES) {
    const result = validateEvent(
      baseEvent({
        state: 'question',
        question: { question: sample, requestedAction: 'rotate credential' },
      }),
    );
    assert.equal(result.ok, false, `expected question.question "${sample}" to be rejected`);
  }
});

test('multi-line transcript-shaped content is rejected in every free-text field', () => {
  const transcriptLike = 'Step 1: run tool\nStep 2: read file\nStep 3: leak output';
  assert.equal(validateEvent(baseEvent({ title: transcriptLike })).ok, false);
  assert.equal(
    validateEvent(
      baseEvent({ state: 'blocked', blocker: { cause: transcriptLike, owner: 'sol', nextAction: 'x' } }),
    ).ok,
    false,
  );
  assert.equal(
    validateEvent(
      baseEvent({ state: 'question', question: { question: transcriptLike, requestedAction: 'x' } }),
    ).ok,
    false,
  );
});

test('fields resembling tool/source/transcript identifiers are rejected as unknown keys', () => {
  for (const key of ['transcript', 'toolCalls', 'source', 'sessionFile', 'credentials', 'apiKey']) {
    const result = validateEvent(baseEvent({ [key]: 'anything' }));
    assert.equal(result.ok, false, `expected top-level key "${key}" to be rejected`);
    assert.ok(result.errors.some((e) => e.includes(`unknown_field: ${key}`)));
  }
});

test('the store file and directory are created with owner-only permissions', async () => {
  const dir = await makeTempDir();
  await appendEvent(dir, validateEvent(baseEvent()).value);
  const dirStat = await fsp.stat(dir);
  const fileStat = await fsp.stat(eventsFilePath(dir));
  assert.equal(dirStat.mode & 0o077, 0);
  assert.equal(fileStat.mode & 0o077, 0);
});

test('validated events never carry more than the closed field set', async () => {
  const result = validateEvent(baseEvent({ title: 'Concise title' }));
  assert.equal(result.ok, true);
  const allowed = new Set([
    'schemaVersion',
    'provider',
    'repo',
    'project',
    'taskId',
    'issueNumber',
    'title',
    'model',
    'branch',
    'worktree',
    'timestamp',
    'state',
    'blocker',
    'question',
  ]);
  for (const key of Object.keys(result.value)) {
    assert.ok(allowed.has(key), `unexpected persisted field: ${key}`);
  }
});

test('the UI renders status through textContent and includes blocker age and repository identity', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const app = await fsp.readFile(path.join(root, 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(app, /innerHTML/u);
  assert.match(app, /Age:/u);
  assert.match(app, /task\.repo/u);
});
