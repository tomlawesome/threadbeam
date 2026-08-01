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
  assert.doesNotMatch(app, /innerHTML|outerHTML|document\.write|insertAdjacentHTML/u);
  assert.match(app, /Age:/u);
  assert.match(app, /task\.repo/u);
});

test('the UI renders every required blocker and question field label', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const app = await fsp.readFile(path.join(root, 'public', 'app.js'), 'utf8');
  for (const label of ['Cause:', 'Owner:', 'Next action:', 'Question:', 'Requested action:']) {
    assert.match(app, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
});

test('the dashboard references no external assets, fonts or remote resources', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const files = ['index.html', 'app.js', 'styles.css'];
  for (const file of files) {
    const content = await fsp.readFile(path.join(root, 'public', file), 'utf8');
    assert.doesNotMatch(content, /https?:\/\//u, `${file} must not reference remote resources`);
    assert.doesNotMatch(content, /@import/u, `${file} must not import external stylesheets`);
  }
});

test('the dashboard never uses inline style attributes or element.style mutation', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const html = await fsp.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const app = await fsp.readFile(path.join(root, 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(html, /\sstyle\s*=/iu);
  assert.doesNotMatch(app, /\.style\s*[.[]/u);
});

test('the dashboard exposes exactly five accessible accent theme controls plus a light/dark toggle', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const html = await fsp.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const swatchMatches = [...html.matchAll(/<button[^>]*class="theme-swatch[^"]*"[^>]*>/gu)];
  assert.equal(swatchMatches.length, 5);
  for (const match of swatchMatches) {
    assert.match(match[0], /data-theme="[^"]+"/u);
    assert.match(match[0], /aria-label="[^"]+"/u);
  }
  assert.match(html, /aria-pressed="true"/u);
  assert.match(html, /id="mode-toggle"/u);
});

test('theme and mode preferences persist through guarded localStorage access', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const app = await fsp.readFile(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(app, /localStorage\.getItem/u);
  assert.match(app, /localStorage\.setItem/u);
  assert.match(app, /function readStoredPreference[\s\S]*?catch/u);
  assert.match(app, /function writeStoredPreference[\s\S]*?catch/u);
  const fetchCalls = app.match(/fetch\([^)]*\)/gu) ?? [];
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0], /\/api\/status/u);
});

test('each accent theme changes the dashboard palette rather than one control', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const css = await fsp.readFile(path.join(root, 'public', 'styles.css'), 'utf8');
  for (const theme of ['ocean', 'violet', 'amber', 'emerald', 'rose']) {
    const block = css.match(new RegExp(`:root\\[data-theme="${theme}"\\] \\{([\\s\\S]*?)\\}`, 'u'));
    assert.ok(block, `missing ${theme} theme`);
    assert.match(block[1], /--accent:/u);
    assert.match(block[1], /--theme-secondary:/u);
  }
  assert.match(css, /radial-gradient[\s\S]*--theme-secondary/u);
  assert.match(css, /--surface:[^;]*--accent/u);
  assert.match(css, /--border:[^;]*--accent/u);
});

test('summary counters are accessible filters with an explicit all-activity reset', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const html = await fsp.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const app = await fsp.readFile(path.join(root, 'public', 'app.js'), 'utf8');
  const filters = [...html.matchAll(/class="stat stat-filter[^"]*"[^>]*data-filter="([a-z]+)"[^>]*aria-pressed="false"[^>]*aria-controls="([^"]+)"/gu)];
  assert.deepEqual(filters.map((match) => match[1]), ['live', 'blockers', 'questions', 'completed']);
  assert.equal(new Set(filters.map((match) => match[2])).size, 4);
  assert.match(html, /id="summary-filter-all"[^>]*aria-pressed="true"/u);
  assert.match(app, /function setDashboardFilter/u);
  assert.match(app, /Select View all to restore every section\./u);
});

test('every live-task column header is a keyboard-operable, aria-sort-annotated control', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const html = await fsp.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const headerCells = [...html.matchAll(/<th scope="col" aria-sort="none">\s*<button type="button" class="sort-button" data-sort-key="([a-zA-Z]+)">/gu)];
  const keys = headerCells.map((m) => m[1]);
  assert.deepEqual(keys, ['provider', 'task', 'project', 'branch', 'state', 'started', 'elapsed', 'lastUpdate']);
});

test('mobile live-task sorting remains visible while hidden header controls leave the tab order', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const html = await fsp.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const app = await fsp.readFile(path.join(root, 'public', 'app.js'), 'utf8');
  const css = await fsp.readFile(path.join(root, 'public', 'styles.css'), 'utf8');
  assert.match(html, /id="mobile-sort-key"/u);
  assert.match(html, /id="mobile-sort-direction"/u);
  assert.match(app, /matchMedia\('\(max-width: 640px\)'\)/u);
  assert.match(app, /button\.tabIndex = narrowViewport\.matches \? -1 : 0/u);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.mobile-sort-controls[\s\S]*display: grid/u);
});

test('the UI reorders operational sections with blockers first, questions second, live tasks third', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const html = await fsp.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const blockersIndex = html.indexOf('id="blockers-heading"');
  const liveIndex = html.indexOf('id="live-tasks-heading"');
  const questionsIndex = html.indexOf('id="questions-heading"');
  assert.ok(blockersIndex > -1 && liveIndex > -1 && questionsIndex > -1);
  assert.ok(blockersIndex < questionsIndex, 'blockers must precede questions');
  assert.ok(questionsIndex < liveIndex, 'questions must precede live tasks');
});

test('the timeline shows a prominent local HH:MM:SS time alongside the full date/time', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const app = await fsp.readFile(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(app, /function formatClockTime/u);
  assert.match(app, /timeline-time-primary/u);
  assert.match(app, /timeline-time-full/u);
});
