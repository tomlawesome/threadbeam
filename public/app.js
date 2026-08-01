'use strict';

const POLL_INTERVAL_MS = 5000;

const el = {
  banner: document.getElementById('status-banner'),
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

function cell(label, text) {
  const td = document.createElement('td');
  td.dataset.label = label;
  td.textContent = text ?? '—';
  return td;
}

function renderLiveTasks(tasks) {
  clearChildren(el.liveBody);
  el.liveEmpty.hidden = tasks.length > 0;
  const now = Date.now();
  for (const task of tasks) {
    const row = document.createElement('tr');
    row.append(
      cell('Provider / model', `${task.provider} / ${task.model}`),
      cell('Task', taskLabel(task)),
      cell('Project', `${task.repo} / ${task.project}`),
      cell('Branch / worktree', `${task.branch} (${task.worktree})`),
    );
    const stateCell = cell('State', formatState(task.state));
    stateCell.className = `state state-${task.state}`;
    row.append(stateCell);
    row.append(
      cell('Started', formatTime(task.startedAt)),
      cell('Elapsed', formatElapsed(now - new Date(task.startedAt).getTime())),
      cell('Last update', formatTime(task.lastUpdateAt)),
    );
    el.liveBody.append(row);
  }
}

function renderCard(item, lines) {
  const li = document.createElement('li');
  li.className = 'card';
  const heading = document.createElement('p');
  heading.className = 'card-title';
  heading.textContent = `${item.provider} · ${taskLabel(item)}`;
  li.append(heading);
  for (const line of lines) {
    const p = document.createElement('p');
    p.textContent = line;
    li.append(p);
  }
  return li;
}

function renderBlockers(blockers) {
  clearChildren(el.blockersList);
  el.blockersEmpty.hidden = blockers.length > 0;
  for (const blocker of blockers) {
    el.blockersList.append(
      renderCard(blocker, [
        `Cause: ${blocker.blocker.cause}`,
        `Owner: ${blocker.blocker.owner}`,
        `Next action: ${blocker.blocker.nextAction}`,
        `Age: ${formatElapsed(Date.now() - new Date(blocker.lastUpdateAt).getTime())}`,
      ]),
    );
  }
}

function renderQuestions(questions) {
  clearChildren(el.questionsList);
  el.questionsEmpty.hidden = questions.length > 0;
  for (const question of questions) {
    el.questionsList.append(
      renderCard(question, [
        `Question: ${question.question.question}`,
        `Requested action: ${question.question.requestedAction}`,
      ]),
    );
  }
}

function renderCompleted(completed) {
  clearChildren(el.completedList);
  el.completedEmpty.hidden = completed.length > 0;
  for (const task of completed) {
    el.completedList.append(
      renderCard(task, [
        `Duration: ${formatElapsed(task.elapsedMs)}`,
        `Finished: ${formatTime(task.lastUpdateAt)}`,
      ]),
    );
  }
}

function renderTimeline(timeline) {
  clearChildren(el.timelineList);
  el.timelineEmpty.hidden = timeline.length > 0;
  for (const entry of timeline) {
    const li = document.createElement('li');
    li.textContent = `${formatTime(entry.timestamp)} — ${entry.provider} — ${entry.taskId} — ${formatState(entry.state)}`;
    el.timelineList.append(li);
  }
}

function setBanner(message, isError) {
  el.banner.textContent = message;
  el.banner.classList.toggle('status-banner-error', Boolean(isError));
}

async function refresh() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) {
      setBanner(`Status unavailable (HTTP ${response.status}).`, true);
      return;
    }
    const status = await response.json();
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
