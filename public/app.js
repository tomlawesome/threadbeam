'use strict';

const POLL_INTERVAL_MS = 5000;
const KNOWN_PROVIDERS = ['codex', 'claude', 'mistral', 'ollama', 'luna'];

const THEME_STORAGE_KEY = 'agent-dashboard:theme';
const MODE_STORAGE_KEY = 'agent-dashboard:mode';
const THEMES = ['ocean', 'violet', 'amber', 'emerald', 'rose'];
const DEFAULT_THEME = 'ocean';
const MODES = ['dark', 'light'];
const DEFAULT_MODE = 'dark';
const DASHBOARD_FILTERS = {
  live: { singular: 'active task', plural: 'active tasks', section: 'liveSection' },
  blockers: { singular: 'blocker', plural: 'blockers', section: 'blockersSection' },
  questions: { singular: 'open question', plural: 'open questions', section: 'questionsSection' },
  completed: { singular: 'recently completed task', plural: 'recently completed tasks', section: 'completedSection' },
};

const STATE_SORT_ORDER = [
  'blocked',
  'question',
  'waiting_ci',
  'validating',
  'implementing',
  'queued',
  'awaiting_sol_review',
  'completed',
];

const LIVE_COLUMNS = [
  { key: 'provider', type: 'text', get: (t) => `${t.provider} ${t.model}` },
  { key: 'task', type: 'text', get: (t) => taskLabel(t) },
  { key: 'project', type: 'text', get: (t) => `${t.repo} / ${t.project}` },
  { key: 'branch', type: 'text', get: (t) => `${t.branch} (${t.worktree})` },
  { key: 'state', type: 'state', get: (t) => t.state },
  { key: 'started', type: 'timestamp', get: (t) => new Date(t.startedAt).getTime() },
  { key: 'elapsed', type: 'elapsed', get: (t) => Date.now() - new Date(t.startedAt).getTime() },
  { key: 'lastUpdate', type: 'timestamp', get: (t) => new Date(t.lastUpdateAt).getTime() },
];

let liveSort = { key: null, direction: 'asc' };
let lastLiveTasks = [];
let lastStatus = null;
let dashboardFilter = 'all';

const el = {
  liveDot: document.getElementById('live-dot'),
  banner: document.getElementById('status-banner'),
  summaryActive: document.getElementById('summary-active'),
  summaryBlockers: document.getElementById('summary-blockers'),
  summaryQuestions: document.getElementById('summary-questions'),
  summaryCompleted: document.getElementById('summary-completed'),
  summaryFilterAll: document.getElementById('summary-filter-all'),
  summaryFilterButtons: Array.from(document.querySelectorAll('.stat-filter')),
  summaryFilterStatus: document.getElementById('summary-filter-status'),
  blockersSection: document.getElementById('blockers-section'),
  liveSection: document.getElementById('live-tasks-section'),
  questionsSection: document.getElementById('questions-section'),
  completedSection: document.getElementById('completed-section'),
  timelineSection: document.getElementById('timeline-section'),
  liveBody: document.getElementById('live-tasks-body'),
  liveEmpty: document.getElementById('live-tasks-empty'),
  sortButtons: Array.from(document.querySelectorAll('#live-tasks-table .sort-button')),
  mobileSortKey: document.getElementById('mobile-sort-key'),
  mobileSortDirection: document.getElementById('mobile-sort-direction'),
  blockersList: document.getElementById('blockers-list'),
  blockersEmpty: document.getElementById('blockers-empty'),
  questionsList: document.getElementById('questions-list'),
  questionsEmpty: document.getElementById('questions-empty'),
  completedList: document.getElementById('completed-list'),
  completedEmpty: document.getElementById('completed-empty'),
  timelineList: document.getElementById('timeline-list'),
  timelineEmpty: document.getElementById('timeline-empty'),
  refreshButton: document.getElementById('refresh-button'),
  themeSwatches: Array.from(document.querySelectorAll('.theme-swatch')),
  modeToggle: document.getElementById('mode-toggle'),
  modeToggleLabel: document.getElementById('mode-toggle-label'),
};

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function formatClockTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatState(state) {
  return String(state ?? 'unknown').replaceAll('_', ' ');
}

function taskLabel(task) {
  return task.issueNumber ? `#${task.issueNumber} — ${task.title || 'untitled'}` : task.title || task.taskId;
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function providerChipClass(provider) {
  const known = KNOWN_PROVIDERS.includes(provider) ? provider : 'other';
  return `chip chip-provider chip-provider-${known}`;
}

function cell(label, text) {
  const td = document.createElement('td');
  td.dataset.label = label;
  td.textContent = text ?? '—';
  return td;
}

function providerModelCell(task) {
  const td = document.createElement('td');
  td.dataset.label = 'Provider / model';
  const wrap = document.createElement('span');
  wrap.className = 'provider-model';
  const providerChip = document.createElement('span');
  providerChip.className = providerChipClass(task.provider);
  providerChip.textContent = task.provider;
  const model = document.createElement('span');
  model.className = 'model-name';
  model.textContent = task.model;
  wrap.append(providerChip, model);
  td.append(wrap);
  return td;
}

function stateChip(state) {
  const badge = document.createElement('span');
  badge.className = `chip state-chip state-${state}`;
  const dot = document.createElement('span');
  dot.className = 'chip-dot';
  dot.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.textContent = formatState(state);
  badge.append(dot, label);
  return badge;
}

function stateCell(state) {
  const td = document.createElement('td');
  td.dataset.label = 'State';
  td.append(stateChip(state));
  return td;
}

function stateRank(state) {
  const index = STATE_SORT_ORDER.indexOf(state);
  return index === -1 ? STATE_SORT_ORDER.length : index;
}

function compareLiveColumn(column, a, b) {
  const va = column.get(a);
  const vb = column.get(b);
  if (column.type === 'text') {
    return String(va).localeCompare(String(vb), undefined, { sensitivity: 'base', numeric: true });
  }
  if (column.type === 'state') {
    return stateRank(va) - stateRank(vb);
  }
  const na = Number.isFinite(va) ? va : Number.NEGATIVE_INFINITY;
  const nb = Number.isFinite(vb) ? vb : Number.NEGATIVE_INFINITY;
  return na - nb;
}

function sortLiveTasks(tasks) {
  if (!liveSort.key) return tasks;
  const column = LIVE_COLUMNS.find((c) => c.key === liveSort.key);
  if (!column) return tasks;
  const indexed = tasks.map((task, index) => ({ task, index }));
  indexed.sort((a, b) => {
    const cmp = compareLiveColumn(column, a.task, b.task);
    if (cmp !== 0) return liveSort.direction === 'asc' ? cmp : -cmp;
    return a.index - b.index;
  });
  return indexed.map((entry) => entry.task);
}

function updateSortIndicators() {
  for (const button of el.sortButtons) {
    const th = button.closest('th');
    const key = button.dataset.sortKey;
    th.setAttribute('aria-sort', liveSort.key === key ? (liveSort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
  }
  el.mobileSortKey.value = liveSort.key ?? '';
  el.mobileSortDirection.disabled = !liveSort.key;
  el.mobileSortDirection.textContent = liveSort.direction === 'desc' ? 'Descending' : 'Ascending';
  el.mobileSortDirection.setAttribute(
    'aria-label',
    liveSort.direction === 'desc' ? 'Sort descending; select to sort ascending' : 'Sort ascending; select to sort descending',
  );
}

function setLiveSort(key) {
  liveSort = liveSort.key === key
    ? { key, direction: liveSort.direction === 'asc' ? 'desc' : 'asc' }
    : { key, direction: 'asc' };
  updateSortIndicators();
  renderLiveTasks(lastLiveTasks);
}

function initLiveSortControls() {
  for (const button of el.sortButtons) {
    button.addEventListener('click', () => setLiveSort(button.dataset.sortKey));
  }
  el.mobileSortKey.addEventListener('change', () => {
    const key = el.mobileSortKey.value;
    liveSort = key ? { key, direction: liveSort.key === key ? liveSort.direction : 'asc' } : { key: null, direction: 'asc' };
    updateSortIndicators();
    renderLiveTasks(lastLiveTasks);
  });
  el.mobileSortDirection.addEventListener('click', () => {
    if (!liveSort.key) return;
    liveSort = { key: liveSort.key, direction: liveSort.direction === 'asc' ? 'desc' : 'asc' };
    updateSortIndicators();
    renderLiveTasks(lastLiveTasks);
  });

  const narrowViewport = window.matchMedia('(max-width: 640px)');
  const updateHeaderSortTabStops = () => {
    for (const button of el.sortButtons) button.tabIndex = narrowViewport.matches ? -1 : 0;
  };
  narrowViewport.addEventListener('change', updateHeaderSortTabStops);
  updateHeaderSortTabStops();
  updateSortIndicators();
}

function renderLiveTasks(tasks) {
  clearChildren(el.liveBody);
  el.liveEmpty.hidden = tasks.length > 0;
  const now = Date.now();
  for (const task of sortLiveTasks(tasks)) {
    const row = document.createElement('tr');
    row.className = 'live-row';
    row.append(
      providerModelCell(task),
      cell('Task', taskLabel(task)),
      cell('Project', `${task.repo} / ${task.project}`),
      cell('Branch / worktree', `${task.branch} (${task.worktree})`),
      stateCell(task.state),
      cell('Started', formatTime(task.startedAt)),
      cell('Elapsed', formatElapsed(now - new Date(task.startedAt).getTime())),
      cell('Last update', formatTime(task.lastUpdateAt)),
    );
    el.liveBody.append(row);
  }
}

function fieldRow(labelText, value, emphasize = false) {
  const p = document.createElement('p');
  p.className = emphasize ? 'field-line field-line-emphasis' : 'field-line';
  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = labelText;
  const val = document.createElement('span');
  val.className = 'field-value';
  val.textContent = value;
  p.append(label, val);
  return p;
}

function attentionRow(kickerText, kickerClass, item) {
  const li = document.createElement('li');
  li.className = `attn-row ${kickerClass}`;
  const primary = document.createElement('div');
  primary.className = 'attn-row-primary';
  const kicker = document.createElement('span');
  kicker.className = 'attn-row-kicker';
  kicker.textContent = kickerText;
  const heading = document.createElement('h3');
  heading.className = 'attn-row-title';
  heading.textContent = taskLabel(item);
  const meta = document.createElement('span');
  meta.className = 'attn-row-meta';
  meta.textContent = `${item.provider} · ${item.project}`;
  primary.append(kicker, heading, meta);

  const detail = document.createElement('div');
  detail.className = 'attn-row-detail';

  li.append(primary, detail);
  return { li, detail };
}

function renderBlockers(blockers) {
  clearChildren(el.blockersList);
  el.blockersEmpty.hidden = blockers.length > 0;
  for (const blocker of blockers) {
    const { li, detail } = attentionRow('Blocker', 'attn-row-blocker', blocker);
    detail.append(
      fieldRow('Cause:', blocker.blocker.cause),
      fieldRow('Owner:', blocker.blocker.owner),
      fieldRow('Next action:', blocker.blocker.nextAction, true),
      fieldRow('Age:', formatElapsed(Date.now() - new Date(blocker.lastUpdateAt).getTime())),
    );
    el.blockersList.append(li);
  }
}

function renderQuestions(questions) {
  clearChildren(el.questionsList);
  el.questionsEmpty.hidden = questions.length > 0;
  for (const question of questions) {
    const { li, detail } = attentionRow('Question', 'attn-row-question', question);
    detail.append(
      fieldRow('Question:', question.question.question),
      fieldRow('Requested action:', question.question.requestedAction, true),
    );
    el.questionsList.append(li);
  }
}

function renderCompleted(completed) {
  clearChildren(el.completedList);
  el.completedEmpty.hidden = completed.length > 0;
  for (const task of completed) {
    const li = document.createElement('li');
    li.className = 'feed-item';

    const primary = document.createElement('div');
    primary.className = 'feed-primary';
    const providerChip = document.createElement('span');
    providerChip.className = providerChipClass(task.provider);
    providerChip.textContent = task.provider;
    const title = document.createElement('span');
    title.className = 'feed-title';
    title.textContent = taskLabel(task);
    const project = document.createElement('span');
    project.className = 'feed-project';
    project.textContent = task.project;
    primary.append(providerChip, title, project);

    const meta = document.createElement('div');
    meta.className = 'feed-meta';
    meta.append(
      fieldRow('Duration:', formatElapsed(task.elapsedMs)),
      fieldRow('Finished:', formatTime(task.lastUpdateAt)),
    );

    li.append(primary, meta);
    el.completedList.append(li);
  }
}

function groupTimelineByDay(timeline) {
  const groups = [];
  let current = null;
  for (const entry of timeline) {
    const date = new Date(entry.timestamp);
    const key = Number.isNaN(date.getTime()) ? 'unknown' : date.toDateString();
    if (!current || current.key !== key) {
      current = { key, date, entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups;
}

function formatDayHeading(date) {
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function renderTimeline(timeline) {
  clearChildren(el.timelineList);
  el.timelineEmpty.hidden = timeline.length > 0;
  for (const group of groupTimelineByDay(timeline)) {
    const section = document.createElement('div');
    section.className = 'timeline-group';
    const heading = document.createElement('p');
    heading.className = 'timeline-group-heading';
    heading.textContent = formatDayHeading(group.date);

    const rail = document.createElement('ol');
    rail.className = 'timeline-rail';
    for (const entry of group.entries) {
      const li = document.createElement('li');
      li.className = 'timeline-node';
      const dot = document.createElement('span');
      dot.className = `timeline-dot state-${entry.state}`;
      dot.setAttribute('aria-hidden', 'true');

      const body = document.createElement('div');
      body.className = 'timeline-body';
      const time = document.createElement('span');
      time.className = 'timeline-time';
      const timePrimary = document.createElement('time');
      timePrimary.className = 'timeline-time-primary';
      const entryDate = new Date(entry.timestamp);
      if (!Number.isNaN(entryDate.getTime())) timePrimary.dateTime = entryDate.toISOString();
      timePrimary.textContent = formatClockTime(entry.timestamp);
      const timeFull = document.createElement('span');
      timeFull.className = 'timeline-time-full';
      timeFull.textContent = formatTime(entry.timestamp);
      time.append(timePrimary, timeFull);
      const badge = stateChip(entry.state);
      const desc = document.createElement('span');
      desc.className = 'timeline-desc';
      desc.textContent = entry.title
        ? `${entry.provider} · ${entry.taskId} · ${entry.title}`
        : `${entry.provider} · ${entry.taskId}`;
      body.append(time, badge, desc);

      li.append(dot, body);
      rail.append(li);
    }

    section.append(heading, rail);
    el.timelineList.append(section);
  }
}

function renderSummary(status) {
  el.summaryActive.textContent = String((status.live ?? []).length);
  el.summaryBlockers.textContent = String((status.blockers ?? []).length);
  el.summaryQuestions.textContent = String((status.questions ?? []).length);
  el.summaryCompleted.textContent = String((status.completed ?? []).length);
}

function filterCount(status, filter) {
  return filter === 'all' ? 0 : (status?.[filter] ?? []).length;
}

function applyDashboardFilter() {
  for (const [filter, config] of Object.entries(DASHBOARD_FILTERS)) {
    el[config.section].hidden = dashboardFilter !== 'all' && dashboardFilter !== filter;
  }
  el.timelineSection.hidden = dashboardFilter !== 'all';

  el.summaryFilterAll.setAttribute('aria-pressed', String(dashboardFilter === 'all'));
  for (const button of el.summaryFilterButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === dashboardFilter));
  }

  if (dashboardFilter === 'all') {
    el.summaryFilterStatus.textContent = 'Showing all activity.';
    return;
  }
  const config = DASHBOARD_FILTERS[dashboardFilter];
  const count = filterCount(lastStatus, dashboardFilter);
  const label = count === 1 ? config.singular : config.plural;
  el.summaryFilterStatus.textContent = `Showing ${count} ${label}. Select View all to restore every section.`;
}

function setDashboardFilter(filter) {
  if (filter !== 'all' && !Object.hasOwn(DASHBOARD_FILTERS, filter)) return;
  dashboardFilter = filter;
  applyDashboardFilter();
}

function initDashboardFilters() {
  el.summaryFilterAll.addEventListener('click', () => setDashboardFilter('all'));
  for (const button of el.summaryFilterButtons) {
    button.addEventListener('click', () => setDashboardFilter(button.dataset.filter));
  }
  applyDashboardFilter();
}

function setBanner(message, isError) {
  el.banner.textContent = message;
  el.banner.classList.toggle('status-banner-error', Boolean(isError));
  el.liveDot.classList.toggle('live-dot-error', Boolean(isError));
}

function readStoredPreference(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredPreference(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private browsing, quota, disabled); preference
    // simply will not persist across reloads.
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  for (const button of el.themeSwatches) {
    button.setAttribute('aria-pressed', String(button.dataset.theme === theme));
  }
}

function applyMode(mode) {
  document.documentElement.dataset.mode = mode;
  el.modeToggle.setAttribute('aria-pressed', String(mode === 'dark'));
  el.modeToggleLabel.textContent = mode === 'dark' ? 'Dark mode' : 'Light mode';
}

function initThemeControls() {
  const storedTheme = readStoredPreference(THEME_STORAGE_KEY);
  applyTheme(THEMES.includes(storedTheme) ? storedTheme : DEFAULT_THEME);

  const storedMode = readStoredPreference(MODE_STORAGE_KEY);
  applyMode(MODES.includes(storedMode) ? storedMode : DEFAULT_MODE);

  for (const button of el.themeSwatches) {
    button.addEventListener('click', () => {
      const theme = button.dataset.theme;
      applyTheme(theme);
      writeStoredPreference(THEME_STORAGE_KEY, theme);
    });
  }

  el.modeToggle.addEventListener('click', () => {
    const mode = document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark';
    applyMode(mode);
    writeStoredPreference(MODE_STORAGE_KEY, mode);
  });
}

async function refresh() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) {
      setBanner(`Status unavailable (HTTP ${response.status}).`, true);
      return;
    }
    const status = await response.json();
    lastStatus = status;
    renderSummary(status);
    lastLiveTasks = status.live ?? [];
    renderLiveTasks(lastLiveTasks);
    renderBlockers(status.blockers ?? []);
    renderQuestions(status.questions ?? []);
    renderCompleted(status.completed ?? []);
    renderTimeline(status.timeline ?? []);
    applyDashboardFilter();
    const generated = formatTime(status.generatedAt);
    const parseErrors = status.parseErrors ?? 0;
    setBanner(
      parseErrors > 0
        ? `Updated ${generated}. ${parseErrors} malformed event line(s) skipped.`
        : `Updated ${generated}.`,
      false,
    );
  } catch {
    setBanner('Unable to reach the dashboard server.', true);
  }
}

el.refreshButton.addEventListener('click', refresh);
initThemeControls();
initLiveSortControls();
initDashboardFilters();

refresh();
setInterval(refresh, POLL_INTERVAL_MS);
