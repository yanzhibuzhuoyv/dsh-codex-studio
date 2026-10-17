'use strict';

const MAX_DSH_ENTRIES = 400;
const MAX_CODEX_ENTRIES = 900;
const WORKSPACE_STORAGE_KEY = 'dsh-codex-studio:last-workspace';

const state = {
  running: false,
  busy: false,
  phase: 'idle',
  threadId: null,
  currentRunId: null,
  mcpEntries: 0,
  codexEntries: 0,
  taskDirty: false
};

const els = {
  sessionPill: document.getElementById('sessionPill'),
  statusPill: document.getElementById('statusPill'),
  statusText: document.getElementById('statusText'),
  newSessionBtn: document.getElementById('newSessionBtn'),
  stopBtn: document.getElementById('stopBtn'),
  workspaceInput: document.getElementById('workspaceInput'),
  browseBtn: document.getElementById('browseBtn'),
  dshToggle: document.getElementById('dshToggle'),
  dshModeState: document.getElementById('dshModeState'),
  modeHint: document.getElementById('modeHint'),
  notice: document.getElementById('notice'),
  noticeText: document.getElementById('noticeText'),
  noticeClose: document.getElementById('noticeClose'),
  dshLog: document.getElementById('dshLog'),
  dshEmpty: document.getElementById('dshEmpty'),
  dshCount: document.getElementById('dshCount'),
  relayFeed: document.getElementById('relayFeed'),
  relayEmpty: document.getElementById('relayEmpty'),
  taskInput: document.getElementById('taskInput'),
  startBtn: document.getElementById('startBtn'),
  codexLog: document.getElementById('codexLog'),
  codexEmpty: document.getElementById('codexEmpty'),
  codexCount: document.getElementById('codexCount'),
  footerStatus: document.getElementById('footerStatus'),
  footerCounts: document.getElementById('footerCounts')
};

const phaseLabels = {
  idle: 'Idle',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  completed: 'Completed',
  error: 'Error',
  stopped: 'Stopped'
};

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function formatClock(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function nearBottom(container) {
  return container.scrollHeight - container.scrollTop - container.clientHeight < 80;
}

function stickToBottom(container, shouldStick) {
  if (!shouldStick) return;
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}

function trimChildren(container, emptyElement, selector, maxEntries) {
  const entries = Array.from(container.children).filter((child) => child !== emptyElement && child.matches(selector));
  while (entries.length > maxEntries) {
    entries.shift()?.remove();
  }
}

function appendToLog(container, emptyElement, selector, maxEntries, node) {
  const shouldStick = nearBottom(container);
  emptyElement.hidden = true;
  container.appendChild(node);
  trimChildren(container, emptyElement, selector, maxEntries);
  stickToBottom(container, shouldStick);
}

function showNotice(message) {
  els.noticeText.textContent = String(message || 'An unknown error occurred.');
  els.notice.hidden = false;
}

function clearNotice() {
  els.noticeText.textContent = '';
  els.notice.hidden = true;
}

function updateModeUI() {
  const enabled = els.dshToggle.checked;
  els.dshModeState.textContent = enabled ? 'ON' : 'OFF';
  els.dshModeState.classList.toggle('on', enabled);
  els.dshModeState.classList.toggle('off', !enabled);
  els.dshToggle.setAttribute('aria-checked', String(enabled));
  els.modeHint.classList.toggle('on', enabled);
  els.modeHint.classList.toggle('off', !enabled);
  els.modeHint.textContent = enabled
    ? 'DSH collaboration is ON: Codex is instructed to architect and delegate execution to DSH via dsh MCP, and CLI approval requests are routed through Codex automatic review.'
    : 'DSH collaboration is OFF: Codex is instructed not to call dsh MCP.';
}

function updateSessionUI() {
  if (state.threadId) {
    const shortId = state.threadId.length > 24
      ? `${state.threadId.slice(0, 10)}…${state.threadId.slice(-8)}`
      : state.threadId;
    els.sessionPill.textContent = `Thread ${shortId}`;
    els.sessionPill.title = state.threadId;
  } else {
    els.sessionPill.textContent = 'New session';
    els.sessionPill.title = 'No Codex thread yet';
  }
}

function updateCounts() {
  els.dshCount.textContent = String(state.mcpEntries);
  els.codexCount.textContent = String(state.codexEntries);
  els.footerCounts.textContent = `${state.mcpEntries} MCP boundary entries · ${state.codexEntries} events`;
}

function updateControls() {
  const hasTask = els.taskInput.value.trim().length > 0;
  const hasWorkspace = els.workspaceInput.value.trim().length > 0;
  const active = state.running || state.phase === 'starting' || state.phase === 'running' || state.phase === 'stopping';

  els.startBtn.disabled = state.busy || active || !hasTask || !hasWorkspace;
  els.startBtn.textContent = active ? 'Running…' : state.threadId ? 'Resume run' : 'Start run';
  els.stopBtn.disabled = !active || state.phase === 'stopping' || state.busy;
  els.newSessionBtn.disabled = active || state.busy;
  els.browseBtn.disabled = active || state.busy;
  els.workspaceInput.disabled = active;
  els.dshToggle.disabled = active;
  updateSessionUI();
}

function setPhase(phase, message) {
  state.phase = phase;
  state.running = phase === 'starting' || phase === 'running' || phase === 'stopping';
  els.statusPill.dataset.phase = phase;
  els.statusText.textContent = phaseLabels[phase] || phase;
  if (message) els.footerStatus.textContent = message;
  updateControls();
}

function resetView() {
  state.threadId = null;
  state.currentRunId = null;
  state.mcpEntries = 0;
  state.codexEntries = 0;
  state.running = false;
  state.busy = false;
  state.phase = 'idle';
  state.taskDirty = false;
  els.taskInput.value = '';
  els.dshEmpty.hidden = false;
  els.relayEmpty.hidden = false;
  els.codexEmpty.hidden = false;
  els.dshLog.querySelectorAll('.log-entry').forEach((node) => node.remove());
  els.relayFeed.querySelectorAll('.relay-row, .relay-daymark').forEach((node) => node.remove());
  els.codexLog.querySelectorAll('.event-entry').forEach((node) => node.remove());
  updateCounts();
  setPhase('idle', 'Ready. DSH collaboration defaults to OFF.');
  clearNotice();
  updateModeUI();
}

function addDshEntry(event) {
  const isResult = event.type === 'mcp-result';
  const shouldStick = nearBottom(els.dshLog);
  els.dshEmpty.hidden = true;

  const entry = makeElement('article', `log-entry${isResult ? ' result' : ''}`);
  const head = makeElement('div', 'entry-head');
  head.appendChild(makeElement('span', 'entry-chip', isResult ? 'MCP RESULT' : 'MCP REQUEST'));
  head.appendChild(makeElement('span', 'entry-tool', `dsh.${event.tool || 'unknown'}`));
  head.appendChild(makeElement('span', 'entry-time', formatClock(event.at)));
  entry.appendChild(head);
  entry.appendChild(makeElement('div', 'entry-boundary', isResult
    ? 'server dsh · result content · parsed from Codex JSONL'
    : 'server dsh · arguments.prompt · parsed from Codex JSONL'));

  const body = makeElement('pre', 'entry-text', event.text || '(empty payload)');
  entry.appendChild(body);

  els.dshLog.appendChild(entry);
  trimChildren(els.dshLog, els.dshEmpty, '.log-entry', MAX_DSH_ENTRIES);
  stickToBottom(els.dshLog, shouldStick);
  state.mcpEntries += 1;
  updateCounts();
}

function addRelayBubble(event) {
  const isResult = event.type === 'mcp-result';
  const shouldStick = nearBottom(els.relayFeed);
  els.relayEmpty.hidden = true;

  const isOutgoing = !isResult;
  const row = makeElement('div', `relay-row ${isOutgoing ? 'outgoing' : 'incoming'}`);
  row.appendChild(makeElement('span', 'relay-avatar', isOutgoing ? 'CX' : 'DSH'));

  const bubble = makeElement('article', 'relay-bubble');
  const head = makeElement('div', 'bubble-head');
  head.appendChild(makeElement('span', 'bubble-direction', isOutgoing ? 'Codex → DSH' : 'DSH → Codex'));
  head.appendChild(makeElement('span', 'bubble-meta', `dsh.${event.tool || 'unknown'} · ${formatClock(event.at)}`));
  bubble.appendChild(head);
  bubble.appendChild(makeElement('pre', 'bubble-text', event.text || '(empty payload)'));
  bubble.appendChild(makeElement('div', 'bubble-status', isResult
    ? `MCP result · status: ${event.status || 'completed'}`
    : `MCP request · status: ${event.status || 'requested'}`));

  row.appendChild(bubble);
  els.relayFeed.appendChild(row);
  while (els.relayFeed.querySelectorAll('.relay-row').length > MAX_DSH_ENTRIES) {
    els.relayFeed.querySelector('.relay-row')?.remove();
  }
  stickToBottom(els.relayFeed, shouldStick);
}

function codexEventLabel(record) {
  if (record.type === 'item.completed' && record.item && record.item.type) {
    return `item.completed · ${record.item.type}`;
  }
  if (record.type === 'mcp_tool_call') {
    const server = record.server ? `${record.server}.` : '';
    return `mcp_tool_call · ${server}${record.tool || 'unknown'}`;
  }
  if (typeof record.type === 'string' && record.type) return record.type;
  if (typeof record.event === 'string' && record.event) return record.event;
  return 'jsonl event';
}

function addCodexRecord(event) {
  const shouldStick = nearBottom(els.codexLog);
  els.codexEmpty.hidden = true;

  const entry = makeElement('article', 'event-entry');
  const head = makeElement('div', 'event-head');
  head.appendChild(makeElement('span', 'event-type', codexEventLabel(event.record || {})));
  head.appendChild(makeElement('span', 'event-time', formatClock(event.at)));
  entry.appendChild(head);

  let json;
  try {
    json = JSON.stringify(event.record, null, 2);
  } catch {
    json = '[Event could not be serialized]';
  }
  entry.appendChild(makeElement('pre', 'event-body', json));

  els.codexLog.appendChild(entry);
  trimChildren(els.codexLog, els.codexEmpty, '.event-entry', MAX_CODEX_ENTRIES);
  stickToBottom(els.codexLog, shouldStick);
  state.codexEntries += 1;
  updateCounts();
}

function addCodexRaw(event) {
  const shouldStick = nearBottom(els.codexLog);
  els.codexEmpty.hidden = true;

  const stream = event.stream === 'stderr' ? 'stderr' : event.stream === 'process' ? 'process' : 'raw';
  const label = stream === 'stderr'
    ? 'stderr'
    : stream === 'process'
      ? 'process'
      : 'non-JSON stdout';

  const entry = makeElement('article', `event-entry ${stream}`);
  const head = makeElement('div', 'event-head');
  head.appendChild(makeElement('span', 'event-type', label));
  head.appendChild(makeElement('span', 'event-time', formatClock(event.at)));
  entry.appendChild(head);
  entry.appendChild(makeElement('pre', 'event-body', event.text || ''));

  els.codexLog.appendChild(entry);
  trimChildren(els.codexLog, els.codexEmpty, '.event-entry', MAX_CODEX_ENTRIES);
  stickToBottom(els.codexLog, shouldStick);
  state.codexEntries += 1;
  updateCounts();
}

function handleStudioEvent(event) {
  if (!event || typeof event !== 'object') return;

  switch (event.type) {
    case 'run-meta':
      state.currentRunId = event.runId || null;
      els.footerStatus.textContent = event.resume
        ? 'Codex process launched in resume mode.'
        : 'Codex process launched for a new thread.';
      break;

    case 'status':
      if (event.runId) state.currentRunId = event.runId;
      setPhase(event.phase || 'running', event.message || '');
      if (event.phase === 'error') showNotice(event.message || 'Codex run failed.');
      break;

    case 'session-updated':
      state.threadId = event.threadId || null;
      updateSessionUI();
      if (event.threadId) {
        els.footerStatus.textContent = 'Codex thread observed; future starts will resume this session.';
      }
      updateControls();
      break;

    case 'session-reset':
      resetView();
      break;

    case 'mcp-request':
    case 'mcp-result':
      addDshEntry(event);
      addRelayBubble(event);
      break;

    case 'codex-record':
      addCodexRecord(event);
      break;

    case 'codex-raw':
      addCodexRaw(event);
      break;

    default:
      break;
  }
}

async function startRun() {
  if (state.busy || state.running) return;
  clearNotice();

  const task = els.taskInput.value.trim();
  const workspace = els.workspaceInput.value.trim();
  if (!task) {
    showNotice('Enter a task before starting a run.');
    els.taskInput.focus();
    return;
  }
  if (!workspace) {
    showNotice('Choose a workspace directory first.');
    els.workspaceInput.focus();
    return;
  }

  const dshCollaboration = els.dshToggle.checked;
  state.busy = true;
  updateControls();
  els.footerStatus.textContent = 'Starting Codex…';

  try {
    const result = await window.dshStudio.startRun({ task, workspace, dshCollaboration });
    if (!result || !result.ok) {
      showNotice(result?.error || 'Unable to start Codex.');
      state.busy = false;
      if (!state.running) setPhase('idle', 'Ready.');
      updateControls();
      return;
    }

    state.currentRunId = result.runId || null;
    state.threadId = result.threadId || state.threadId;
    state.busy = false;
    state.running = true;
    setPhase('starting', result.resume ? 'Resuming Codex session…' : 'Starting new Codex session…');
  } catch (error) {
    state.busy = false;
    showNotice(`Start request failed: ${error.message}`);
    if (!state.running) setPhase('idle', 'Ready.');
    updateControls();
  }
}

async function stopRun() {
  if (state.busy) return;
  state.busy = true;
  updateControls();
  try {
    const result = await window.dshStudio.stopRun();
    if (!result || !result.ok) {
      showNotice(result?.error || 'Unable to stop the Codex run.');
    }
  } catch (error) {
    showNotice(`Stop request failed: ${error.message}`);
  } finally {
    state.busy = false;
    updateControls();
  }
}

async function newSession() {
  if (state.busy || state.running) return;
  state.busy = true;
  updateControls();
  try {
    const result = await window.dshStudio.newSession();
    if (!result || !result.ok) {
      showNotice(result?.error || 'Unable to start a new session.');
      return;
    }
    resetView();
    els.footerStatus.textContent = 'New session ready. DSH collaboration is OFF.';
  } catch (error) {
    showNotice(`New session request failed: ${error.message}`);
  } finally {
    state.busy = false;
    updateControls();
  }
}

async function browseWorkspace() {
  if (state.busy || state.running) return;
  state.busy = true;
  updateControls();
  try {
    const result = await window.dshStudio.selectWorkspace();
    if (result && result.ok && result.path) {
      els.workspaceInput.value = result.path;
      try {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, result.path);
      } catch {
        // Workspace persistence is optional.
      }
      updateControls();
    } else if (result && !result.ok) {
      showNotice(result.error || 'Unable to open the directory picker.');
    }
  } catch (error) {
    showNotice(`Directory picker failed: ${error.message}`);
  } finally {
    state.busy = false;
    updateControls();
  }
}

function wireUi() {
  els.dshToggle.addEventListener('change', updateModeUI);
  els.taskInput.addEventListener('input', updateControls);
  els.workspaceInput.addEventListener('input', () => {
    updateControls();
    try {
      if (els.workspaceInput.value.trim()) {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, els.workspaceInput.value.trim());
      }
    } catch {
      // Workspace persistence is optional.
    }
  });
  els.taskInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      startRun();
    }
  });
  els.startBtn.addEventListener('click', startRun);
  els.stopBtn.addEventListener('click', stopRun);
  els.newSessionBtn.addEventListener('click', newSession);
  els.browseBtn.addEventListener('click', browseWorkspace);
  els.noticeClose.addEventListener('click', clearNotice);
}

async function initialize() {
  wireUi();
  els.dshToggle.checked = false;
  updateModeUI();

  try {
    const savedWorkspace = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (savedWorkspace) els.workspaceInput.value = savedWorkspace;
  } catch {
    // Workspace persistence is optional.
  }

  window.dshStudio.onStudioEvent(handleStudioEvent);

  try {
    const current = await window.dshStudio.getSession();
    if (current && current.ok) {
      state.threadId = current.threadId || null;
      if (current.running) {
        state.running = true;
        setPhase('running', 'A Codex run is already active.');
      }
    }
  } catch {
    // The renderer can still start a new run if session hydration fails.
  }

  updateCounts();
  setPhase(state.running ? 'running' : 'idle', 'Ready. DSH collaboration defaults to OFF.');
  updateControls();
  els.taskInput.focus();
}

initialize();
