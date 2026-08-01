'use strict';

const POLL_INTERVAL_MS = 5000;
const KNOWN_PROVIDERS = ['codex', 'claude', 'mistral', 'ollama', 'luna'];

const el = {
  liveDot: document.getElementById('live-dot'),
  banner: document.getElementById('status-banner'),
  summaryActive: document.getElementById('summary-active'),
  summaryBlockers: document.getElementById('summary-blockers'),
  summaryQuestions: document.getElementById('summary-questions'),
  summaryCompleted: document.getElementById('summary-completed'),
  liveBody: document.getElementById('live-tasks-body'),
  liveEmpty: document.getElementById('live-tasks-empty'),
  blockersList: document.getElementById('blockers-list'),
  blockersEmpty: document.getElementById('blockers-empty'),
  questionsList: document.getElementById('questions-list'),
  questionsEmpty: document.getElementById('questions-empty'),
  completedList: document.getElementById('completed-list'),
  completedEmpty: document.getElementById('completed-empty'),
  timelineList: document.getElementById('timeline-list'),
  timelineEmpty: document.getElementById('timeline-empty'),
  refreshButton: document.getElementById('refresh-button'),
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

function renderLiveTasks(tasks) {
  clearChildren(el.liveBody);
  el.liveEmpty.hidden = tasks.length > 0;
  const now = Date.now();
  for (const task of tasks) {
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

function fieldRow(labelText, value) {
  const p = document.createElement('p');
  p.className = 'field-line';
  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = labelText;
  const val = document.createElement('span');
  val.className = 'field-value';
  val.textContent = value;
  p.append(label, val);
  return p;
}

function attentionCard(kickerText, kickerClass, item) {
  const li = document.createElement('li');
  li.className = `card ${kickerClass}`;
  const kicker = document.createElement('p');
  kicker.className = 'card-kicker';
  kicker.textContent = kickerText;
  const heading = document.createElement('h4');
  heading.className = 'card-title';
  heading.textContent = taskLabel(item);
  const meta = document.createElement('p');
  meta.className = 'card-meta';
  meta.textContent = `${item.provider} · ${item.project}`;
  li.append(kicker, heading, meta);
  return li;
}

function renderBlockers(blockers) {
  clearChildren(el.blockersList);
  el.blockersEmpty.hidden = blockers.length > 0;
  for (const blocker of blockers) {
    const li = attentionCard('Blocker', 'card-blocker', blocker);
    li.append(
      fieldRow('Cause:', blocker.blocker.cause),
      fieldRow('Owner:', blocker.blocker.owner),
      fieldRow('Next action:', blocker.blocker.nextAction),
      fieldRow('Age:', formatElapsed(Date.now() - new Date(blocker.lastUpdateAt).getTime())),
    );
    el.blockersList.append(li);
  }
}

function renderQuestions(questions) {
  clearChildren(el.questionsList);
  el.questionsEmpty.hidden = questions.length > 0;
  for (const question of questions) {
    const li = attentionCard('Question', 'card-question', question);
    li.append(
      fieldRow('Question:', question.question.question),
      fieldRow('Requested action:', question.question.requestedAction),
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
      time.textContent = formatTime(entry.timestamp);
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

function setBanner(message, isError) {
  el.banner.textContent = message;
  el.banner.classList.toggle('status-banner-error', Boolean(isError));
  el.liveDot.classList.toggle('live-dot-error', Boolean(isError));
}

async function refresh() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) {
      setBanner(`Status unavailable (HTTP ${response.status}).`, true);
      return;
    }
    const status = await response.json();
    renderSummary(status);
    renderLiveTasks(status.live ?? []);
    renderBlockers(status.blockers ?? []);
    renderQuestions(status.questions ?? []);
    renderCompleted(status.completed ?? []);
    renderTimeline(status.timeline ?? []);
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

refresh();
setInterval(refresh, POLL_INTERVAL_MS);
