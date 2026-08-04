import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateEvent, SCHEMA_VERSION } from '../lib/contract.mjs';
import { appendEvent, eventsFilePath } from '../lib/store.mjs';
import { lastPathSegment, projectDisplay, relativeLastUpdate } from '../public/app.js';

async function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'threadbeam-privacy-test-'));
}

function baseEvent(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    provider: 'claude',
    repo: 'example/project',
    project: 'example-project',
    taskId: 'issue-42',
    model: 'claude-sonnet-5',
    branch: 'agent/issue-42-delivery-view',
    worktree: 'issue-42-implementation',
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

test('the dashboard ships a single palette (no accent theme picker) plus an accessible light/dark toggle', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const html = await fsp.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /theme-swatch/u);
  assert.doesNotMatch(html, /theme-picker/u);
  assert.match(html, /id="mode-toggle"/u);
  assert.match(html, /aria-pressed="true"/u);
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

// Enforces the token architecture from issue #17: a single palette, laid
// out in three layers (primitives -- semantic tokens -- component CSS),
// with two hard rules. Regressing either is exactly how the old five-theme
// system ended up with the accent tinting every neutral.
test('ships one palette: no per-theme blocks, and --theme-secondary is gone', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const css = await fsp.readFile(path.join(root, 'public', 'styles.css'), 'utf8');
  assert.doesNotMatch(css, /:root\[data-theme=/u);
  assert.doesNotMatch(css, /--theme-secondary/u);
});

test('hard rule: neutrals (bg/surface/border) never mix in the accent', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const css = await fsp.readFile(path.join(root, 'public', 'styles.css'), 'utf8');
  for (const token of ['--bg:', '--surface:', '--surface-raised:', '--border:', '--border-strong:']) {
    const line = css.split('\n').find((l) => l.trim().startsWith(token));
    assert.ok(line, `missing definition for ${token}`);
    assert.doesNotMatch(line, /accent/iu, `${token} must not reference the accent`);
  }
});

test('hard rule: color-mix() only appears in the layer-1/2 token definitions, never in component CSS', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const css = await fsp.readFile(path.join(root, 'public', 'styles.css'), 'utf8');
  const totalColorMix = (css.match(/color-mix\(/gu) ?? []).length;

  const rootBlock = css.match(/:root\s*\{[\s\S]*?\n\}/u);
  const lightBlock = css.match(/:root\[data-mode="light"\]\s*\{[\s\S]*?\n\}/u);
  assert.ok(rootBlock, 'missing :root token block');
  assert.ok(lightBlock, 'missing :root[data-mode="light"] token block');
  const tokenColorMix =
    (rootBlock[0].match(/color-mix\(/gu) ?? []).length +
    (lightBlock[0].match(/color-mix\(/gu) ?? []).length;

  assert.equal(totalColorMix, tokenColorMix, 'color-mix() found outside the token layer');
});

test('provider and state colours stay defined for both modes and never rely on colour alone', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const css = await fsp.readFile(path.join(root, 'public', 'styles.css'), 'utf8');
  const app = await fsp.readFile(path.join(root, 'public', 'app.js'), 'utf8');
  for (const provider of ['codex', 'claude', 'mistral', 'ollama', 'luna']) {
    assert.match(css, new RegExp(`--provider-${provider}:`, 'u'));
  }
  for (const state of ['implementing', 'validating', 'awaiting-review', 'unknown']) {
    assert.match(css, new RegExp(`--state-${state}:`, 'u'));
  }
  // Chips pair colour with a text label (chip-dot/state-chip render text
  // content, not just a coloured swatch) -- verified structurally here
  // since it's a rendering contract, not a static string in the source.
  assert.match(app, /label\.textContent = formatState\(state\)/u);
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

test('every live-task column header is a keyboard-operable, aria-sort-annotated control exposing the seven logical sort keys in order', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const html = await fsp.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const headerCells = [...html.matchAll(/<th scope="col" aria-sort="none">\s*<button type="button" class="sort-button" data-sort-key="([a-zA-Z]+)">/gu)];
  const keys = headerCells.map((m) => m[1]);
  assert.deepEqual(keys, ['provider', 'model', 'task', 'project', 'branch', 'state', 'activity']);
});

test('the mobile live-task sort select exposes the same seven logical keys in the same order', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const html = await fsp.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const select = html.match(/<select id="mobile-sort-key">([\s\S]*?)<\/select>/u)[1];
  const optionValues = [...select.matchAll(/<option value="([a-zA-Z]*)"/gu)].map((m) => m[1]);
  assert.deepEqual(optionValues, ['', 'provider', 'model', 'task', 'project', 'branch', 'state', 'activity']);
});

test('provider and model render as separate cells and neither value is duplicated', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const app = await fsp.readFile(path.join(root, 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(app, /providerModelCell/u);
  const providerFn = app.match(/function providerCell\(task\) \{([\s\S]*?)\n\}/u)[1];
  const modelFn = app.match(/function modelCell\(task\) \{([\s\S]*?)\n\}/u)[1];
  assert.match(providerFn, /task\.provider/u);
  assert.doesNotMatch(providerFn, /task\.model/u);
  assert.match(modelFn, /task\.model/u);
  assert.doesNotMatch(modelFn, /task\.provider/u);
  assert.match(app, /providerCell\(task\),\s*modelCell\(task\),/u);
});

test('lastPathSegment returns the final non-empty path segment', () => {
  assert.equal(lastPathSegment('foo/bar/baz'), 'baz');
  assert.equal(lastPathSegment('foo/bar/'), 'bar');
  assert.equal(lastPathSegment(''), '');
  assert.equal(lastPathSegment('///'), '');
  assert.equal(lastPathSegment(undefined), '');
});

test('projectDisplay uses the final segment of task.project, falling back to task.repo', () => {
  assert.equal(projectDisplay({ project: 'a/b/example-project', repo: 'org/example' }), 'example-project');
  assert.equal(projectDisplay({ project: '', repo: 'org/example-repo' }), 'example-repo');
  assert.equal(projectDisplay({ project: undefined, repo: 'org/example-repo' }), 'example-repo');
  assert.equal(projectDisplay({ project: undefined, repo: undefined }), '');
});

test('the project cell tooltip is exactly the accepted repo value with no composed identity', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const app = await fsp.readFile(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(app, /if \(task\.repo\) td\.title = task\.repo;/u);
});

test('relativeLastUpdate renders now, seconds, minutes, hours, days and an em dash for invalid input, never NaN', () => {
  const now = Date.parse('2026-08-02T12:00:00Z');
  assert.equal(relativeLastUpdate('2026-08-02T12:00:00Z', now), 'now');
  assert.equal(relativeLastUpdate('2026-08-02T11:59:59Z', now), '1s ago');
  assert.equal(relativeLastUpdate('2026-08-02T11:55:00Z', now), '5m ago');
  assert.equal(relativeLastUpdate('2026-08-02T09:00:00Z', now), '3h ago');
  assert.equal(relativeLastUpdate('2026-07-30T12:00:00Z', now), '3d ago');
  assert.equal(relativeLastUpdate('2026-08-02T12:05:00Z', now), 'now');
  assert.equal(relativeLastUpdate('not-a-date', now), '—');
  assert.equal(relativeLastUpdate(undefined, now), '—');
  assert.doesNotMatch(relativeLastUpdate('not-a-date', now), /NaN/u);
});

test('the activity cell renders a prominent relative time, exact time and a subdued started/elapsed line with semantic time elements', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const app = await fsp.readFile(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(app, /activity-relative/u);
  assert.match(app, /activity-exact/u);
  assert.match(app, /activity-started/u);
  assert.match(app, /createElement\('time'\)/u);
  assert.match(app, /'Started '/u);
  assert.match(app, /elapsed`/u);
});

test('#live-tasks-table scopes a fixed layout with a coherent width allocation where Task is substantially the largest', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const css = await fsp.readFile(path.join(root, 'public', 'styles.css'), 'utf8');
  assert.match(css, /#live-tasks-table\s*\{[^}]*table-layout:\s*fixed/u);
  const widthEntries = [...css.matchAll(/#live-tasks-table col\.col-([a-z]+)\s*\{\s*width:\s*(\d+(?:\.\d+)?)%;\s*\}/gu)];
  const widths = Object.fromEntries(widthEntries.map((m) => [m[1], Number(m[2])]));
  const expectedColumns = ['provider', 'model', 'task', 'project', 'branch', 'state', 'activity'];
  for (const col of expectedColumns) assert.ok(col in widths, `missing width for ${col}`);
  const total = Object.values(widths).reduce((sum, value) => sum + value, 0);
  assert.ok(total <= 100, `total width ${total} exceeds 100%`);
  const maxOther = Math.max(...expectedColumns.filter((c) => c !== 'task').map((c) => widths[c]));
  assert.ok(widths.task > maxOther * 1.5, 'task column must be substantially the largest');
});

test('the live-task Task column wraps long text safely, scoped to #live-tasks-table', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const css = await fsp.readFile(path.join(root, 'public', 'styles.css'), 'utf8');
  const html = await fsp.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  assert.match(css, /#live-tasks-table \.live-task-cell\s*\{[^}]*overflow-wrap:\s*anywhere/u);
  assert.doesNotMatch(html, /style\s*=/iu);
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
