'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, screen } = require('electron');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');

const execFileAsync = promisify(execFile);

const EVENT_CHANNEL = 'studio:event';
const WINDOW_WIDTH = 1440;
const WINDOW_HEIGHT = 900;
const MIN_WINDOW_WIDTH = 900;
const MIN_WINDOW_HEIGHT = 600;
const MAX_TASK_LENGTH = 200_000;
const MAX_THREAD_ID_LENGTH = 200;

let mainWindow = null;
let activeRun = null;
let runSequence = 0;
let session = {
  threadId: null,
  workspace: null,
  startedAt: null
};

function isTrustedSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}

function sendStudioEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(EVENT_CHANNEL, payload);
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(WINDOW_WIDTH, workArea.width);
  const height = Math.min(WINDOW_HEIGHT, workArea.height);
  // Keep the three-column workspace usable on high-DPI Windows displays,
  // while never forcing the native window wider/taller than the work area.
  const minWidth = Math.min(MIN_WINDOW_WIDTH, workArea.width);
  const minHeight = Math.min(MIN_WINDOW_HEIGHT, workArea.height);

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth,
    minHeight,
    show: false,
    title: 'DSH x Codex Studio',
    backgroundColor: '#0a0e14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (url !== current) event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopActiveProcess();
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'public', 'index.html'));
}

function validThreadId(value) {
  return typeof value === 'string'
    && value.length >= 8
    && value.length <= MAX_THREAD_ID_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function findThreadId(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return null;
  seen.add(value);

  const directKeys = ['thread_id', 'threadId', 'conversation_id', 'conversationId'];
  for (const key of directKeys) {
    if (validThreadId(value[key])) return value[key];
  }

  for (const containerKey of ['thread', 'session', 'msg', 'item', 'data']) {
    const container = value[containerKey];
    if (container && typeof container === 'object') {
      for (const key of ['id', 'thread_id', 'threadId', 'conversation_id', 'conversationId']) {
        if (validThreadId(container[key])) return container[key];
      }
    }
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findThreadId(child, depth + 1, seen);
      if (found) return found;
    }
  }
  return null;
}

function rememberThreadId(record) {
  if (session.threadId) return;
  const candidate = findThreadId(record);
  if (!candidate) return;
  session.threadId = candidate;
  sendStudioEvent({
    type: 'session-updated',
    threadId: candidate,
    workspace: session.workspace,
    at: Date.now()
  });
}

function buildPrompt(task, dshCollaboration) {
  const boundaryInstruction = dshCollaboration
    ? [
        'DSH collaboration: ON.',
        'You are the Codex architect. DSH is the executor.',
        'Use the dsh MCP server when execution is needed. Send concise, explicit, workspace-scoped requests, and inspect each DSH result before continuing.'
      ].join(' ')
    : [
        'DSH collaboration: OFF.',
        'Do not call the dsh MCP server or any dsh tool during this run.',
        'Complete the task using Codex and the local workspace only.'
      ].join(' ');

  return `${boundaryInstruction}\n\n---\nUser task:\n${task}\n`;
}

async function resolveCodexCommand() {
  const override = typeof process.env.CODEX_CLI_PATH === 'string'
    ? process.env.CODEX_CLI_PATH.trim()
    : '';
  if (override) return override;

  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('where.exe', ['codex'], {
        windowsHide: true,
        timeout: 5000,
        encoding: 'utf8'
      });
      const candidates = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (candidates.length > 0) {
        const rank = (file) => {
          const lower = file.toLowerCase();
          if (lower.endsWith('.exe')) return 0;
          if (lower.endsWith('.cmd')) return 1;
          if (lower.endsWith('.bat')) return 2;
          return 3;
        };
        candidates.sort((a, b) => rank(a) - rank(b));
        return candidates[0];
      }
    } catch {
      // Fall through to the actionable error below.
    }
  }

  throw new Error('Codex CLI was not found on PATH. Install it or set CODEX_CLI_PATH to the executable.');
}

function commandForSpawn(codexCommand, args) {
  if (process.platform === 'win32') {
    const lower = codexCommand.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      // npm creates a .cmd shim. Spawn cmd.exe with an argument array rather than
      // enabling shell mode; prompts always travel over stdin, never the command line.
      return {
        file: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', codexCommand, ...args]
      };
    }
  }
  return { file: codexCommand, args };
}

function extractResultText(result) {
  if (result == null) return null;
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return String(result);

  const chunks = [];
  const collect = (value) => {
    if (value == null) return;
    if (typeof value === 'string') {
      chunks.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (typeof value === 'object') {
      if (typeof value.text === 'string') {
        chunks.push(value.text);
        return;
      }
      if (typeof value.content === 'string') {
        chunks.push(value.content);
        return;
      }
      if (Array.isArray(value.content)) {
        value.content.forEach(collect);
        return;
      }
      try {
        chunks.push(JSON.stringify(value, null, 2));
      } catch {
        chunks.push(String(value));
      }
    }
  };

  if (Array.isArray(result.content)) {
    result.content.forEach(collect);
  } else if (typeof result.text === 'string') {
    chunks.push(result.text);
  } else if (typeof result.output === 'string') {
    chunks.push(result.output);
  } else {
    collect(result);
  }

  return chunks.length > 0 ? chunks.join('\n') : null;
}

function formatArguments(args) {
  if (args == null) return '(no arguments in event)';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function findDshMcpCalls(value, output = [], seen = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return output;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) findDshMcpCalls(item, output, seen, depth + 1);
    return output;
  }

  if (value.type === 'mcp_tool_call' && String(value.server || '').toLowerCase() === 'dsh') {
    output.push(value);
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      findDshMcpCalls(child, output, seen, depth + 1);
    }
  }
  return output;
}

function deriveDshEvents(run, record) {
  const calls = findDshMcpCalls(record);
  for (const call of calls) {
    let callKey = call.id ?? call.call_id ?? call.item_id;
    if (callKey == null && call.item && typeof call.item === 'object') callKey = call.item.id;
    if (callKey == null) callKey = `anonymous-${++run.anonymousMcpSequence}`;
    callKey = String(callKey);

    let state = run.mcpCalls.get(callKey);
    if (!state) {
      state = { requestSent: false, resultSent: false };
      run.mcpCalls.set(callKey, state);
    }

    const tool = typeof call.tool === 'string' && call.tool.trim() ? call.tool.trim() : 'unknown';
    const args = call.arguments ?? call.args;
    const requestText = args && typeof args === 'object' && typeof args.prompt === 'string'
      ? args.prompt
      : formatArguments(args);

    if (!state.requestSent) {
      state.requestSent = true;
      sendStudioEvent({
        type: 'mcp-request',
        runId: run.id,
        at: Date.now(),
        server: 'dsh',
        tool,
        text: requestText,
        status: call.status || 'requested',
        source: 'codex-jsonl:mcp_tool_call'
      });
    }

    const status = typeof call.status === 'string' ? call.status.toLowerCase() : '';
    const hasResultPayload = call.result != null || call.error != null;
    const isTerminal = status === 'completed' || status === 'failed' || status === 'error';
    const hasResult = isTerminal || hasResultPayload;

    if (hasResult && !state.resultSent) {
      state.resultSent = true;
      const resultText = extractResultText(call.result)
        || (call.error && (call.error.message || String(call.error)))
        || `DSH MCP call reported status "${call.status || 'unknown'}" without a textual result payload.`;

      sendStudioEvent({
        type: 'mcp-result',
        runId: run.id,
        at: Date.now(),
        server: 'dsh',
        tool,
        text: resultText,
        status: call.status || 'completed',
        source: 'codex-jsonl:mcp_tool_call'
      });
    }
  }
}

function handleStdoutLine(run, line) {
  if (!line.trim()) return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    sendStudioEvent({
      type: 'codex-raw',
      runId: run.id,
      stream: 'stdout',
      text: line,
      at: Date.now()
    });
    return;
  }

  const records = Array.isArray(parsed) ? parsed : [parsed];
  for (const record of records) {
    if (!record || typeof record !== 'object') {
      sendStudioEvent({
        type: 'codex-raw',
        runId: run.id,
        stream: 'stdout',
        text: line,
        at: Date.now()
      });
      continue;
    }

    rememberThreadId(record);
    sendStudioEvent({
      type: 'codex-record',
      runId: run.id,
      record,
      at: Date.now()
    });
    deriveDshEvents(run, record);
  }
}

function appendLines(run, stream, chunk) {
  const key = stream === 'stdout' ? 'stdoutBuffer' : 'stderrBuffer';
  run[key] += chunk;
  const parts = run[key].split(/\r?\n/);
  run[key] = parts.pop() || '';

  for (const line of parts) {
    if (stream === 'stdout') {
      handleStdoutLine(run, line);
    } else if (line.trim()) {
      sendStudioEvent({
        type: 'codex-raw',
        runId: run.id,
        stream: 'stderr',
        text: line,
        at: Date.now()
      });
    }
  }
}

function flushBuffers(run) {
  if (run.stdoutBuffer.trim()) handleStdoutLine(run, run.stdoutBuffer);
  if (run.stderrBuffer.trim()) {
    sendStudioEvent({
      type: 'codex-raw',
      runId: run.id,
      stream: 'stderr',
      text: run.stderrBuffer,
      at: Date.now()
    });
  }
  run.stdoutBuffer = '';
  run.stderrBuffer = '';
}

function finishRun(run, phase, message, extra = {}) {
  if (run.finished) return;
  run.finished = true;
  flushBuffers(run);
  if (run.safetyTimer) clearTimeout(run.safetyTimer);
  if (activeRun === run) activeRun = null;
  sendStudioEvent({
    type: 'status',
    runId: run.id,
    phase,
    message,
    at: Date.now(),
    ...extra
  });
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore'
      });
      killer.on('error', () => {
        try { child.kill(); } catch { /* Process already ended. */ }
      });
      return;
    } catch {
      // Fall back to killing the direct child below.
    }
  }
  try { child.kill(); } catch { /* Process already ended. */ }
}

function stopActiveProcess() {
  if (!activeRun) return;
  killProcessTree(activeRun.child);
}

function workspaceComparisonKey(workspace) {
  const resolved = path.resolve(workspace);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function startRun(payload) {
  if (activeRun) {
    return { ok: false, error: 'A Codex run is already active. Stop it before starting another.' };
  }

  const task = typeof payload?.task === 'string' ? payload.task.trim() : '';
  const workspace = typeof payload?.workspace === 'string' ? payload.workspace.trim() : '';
  const dshCollaboration = payload?.dshCollaboration === true;

  if (!task) return { ok: false, error: 'Enter a task before starting a run.' };
  if (task.length > MAX_TASK_LENGTH) {
    return { ok: false, error: `Task is too large. Keep it under ${MAX_TASK_LENGTH.toLocaleString()} characters.` };
  }
  if (!workspace) return { ok: false, error: 'Choose a workspace directory first.' };

  let workspaceStat;
  try {
    workspaceStat = await fs.stat(workspace);
  } catch {
    return { ok: false, error: 'Workspace directory does not exist or is not accessible.' };
  }
  if (!workspaceStat.isDirectory()) {
    return { ok: false, error: 'Workspace must be a directory.' };
  }

  const resolvedWorkspace = path.resolve(workspace);
  const requestedWorkspaceKey = workspaceComparisonKey(resolvedWorkspace);
  const boundWorkspaceKey = session.workspace ? workspaceComparisonKey(session.workspace) : null;
  const resumeThreadId = session.threadId;
  const isResume = Boolean(resumeThreadId);

  if (isResume && requestedWorkspaceKey !== boundWorkspaceKey) {
    return {
      ok: false,
      error: session.workspace
        ? `This Codex thread is bound to "${session.workspace}". Start a new session to use a different workspace.`
        : 'This Codex thread is bound to a previous workspace. Start a new session to use a different workspace.'
    };
  }

  if (!isResume) session.workspace = resolvedWorkspace;

  let codexCommand;
  try {
    codexCommand = await resolveCodexCommand();
  } catch (error) {
    return { ok: false, error: error.message };
  }

  if (activeRun) {
    return { ok: false, error: 'A Codex run is already active. Stop it before starting another.' };
  }

  const args = isResume
    ? ['exec', ...(dshCollaboration ? ['--approve-for-me'] : []), '--skip-git-repo-check', 'resume', '--json', resumeThreadId, '-']
    : dshCollaboration
      ? ['exec', '--approve-for-me', '--skip-git-repo-check', '--json', '-']
      : ['exec', '--skip-git-repo-check', '--json', '-'];
  const launch = commandForSpawn(codexCommand, args);
  const run = {
    id: `run-${++runSequence}`,
    child: null,
    startedAt: Date.now(),
    stopping: false,
    finished: false,
    stdoutBuffer: '',
    stderrBuffer: '',
    anonymousMcpSequence: 0,
    mcpCalls: new Map(),
    safetyTimer: null
  };

  let child;
  try {
    child = spawn(launch.file, launch.args, {
      cwd: workspace,
      env: { ...process.env },
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    return { ok: false, error: `Unable to launch Codex CLI: ${error.message}` };
  }

  activeRun = run;
  run.child = child;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => appendLines(run, 'stdout', chunk));
  child.stderr.on('data', (chunk) => appendLines(run, 'stderr', chunk));

  child.on('error', (error) => {
    sendStudioEvent({
      type: 'codex-raw',
      runId: run.id,
      stream: 'process',
      text: `Codex process error: ${error.message}`,
      at: Date.now()
    });
    finishRun(run, 'error', `Unable to run Codex: ${error.message}`);
  });

  child.on('close', (code, signal) => {
    if (run.stopping) {
      finishRun(run, 'stopped', 'Run stopped by user.', { code, signal });
      return;
    }
    if (code === 0) {
      const suffix = session.threadId
        ? 'Codex run completed.'
        : 'Codex run completed; no thread id was observed, so the next run will start a new thread.';
      finishRun(run, 'completed', suffix, { code, signal });
      return;
    }
    finishRun(run, 'error', `Codex exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`, { code, signal });
  });

  child.stdin.on('error', (error) => {
    if (!run.stopping && !run.finished) {
      sendStudioEvent({
        type: 'codex-raw',
        runId: run.id,
        stream: 'process',
        text: `Prompt stdin closed before Codex accepted the full task: ${error.message}`,
        at: Date.now()
      });
    }
  });

  sendStudioEvent({
    type: 'run-meta',
    runId: run.id,
    resume: isResume,
    threadId: resumeThreadId,
    workspace,
    dshCollaboration,
    at: Date.now()
  });

  sendStudioEvent({
    type: 'status',
    runId: run.id,
    phase: 'starting',
    message: isResume ? 'Launching Codex in resume mode...' : 'Launching a new Codex session...',
    at: Date.now()
  });

  child.stdin.end(buildPrompt(task, dshCollaboration), 'utf8');
  return {
    ok: true,
    runId: run.id,
    resume: isResume,
    threadId: resumeThreadId
  };
}

function stopRun() {
  if (!activeRun) return { ok: false, error: 'No active Codex run to stop.' };
  const run = activeRun;
  if (run.stopping) return { ok: true };
  run.stopping = true;
  sendStudioEvent({
    type: 'status',
    runId: run.id,
    phase: 'stopping',
    message: 'Stopping Codex process tree...',
    at: Date.now()
  });
  killProcessTree(run.child);
  run.safetyTimer = setTimeout(() => {
    finishRun(run, 'stopped', 'Run stopped by user.', { signal: 'forced' });
  }, 4000);
  run.safetyTimer.unref?.();
  return { ok: true };
}

function registerIpc() {
  ipcMain.handle('workspace:pick', async (event) => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Untrusted IPC sender.' };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Codex workspace',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: true, path: null };
    return { ok: true, path: result.filePaths[0] };
  });

  ipcMain.handle('session:get', (event) => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Untrusted IPC sender.' };
    return {
      ok: true,
      threadId: session.threadId,
      workspace: session.workspace,
      running: Boolean(activeRun)
    };
  });

  ipcMain.handle('session:new', (event) => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Untrusted IPC sender.' };
    if (activeRun) return { ok: false, error: 'Stop the active run before starting a new session.' };
    session = { threadId: null, workspace: null, startedAt: null };
    sendStudioEvent({ type: 'session-reset', at: Date.now() });
    return { ok: true };
  });

  ipcMain.handle('run:start', async (event, payload) => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Untrusted IPC sender.' };
    return startRun(payload);
  });

  ipcMain.handle('run:stop', (event) => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Untrusted IPC sender.' };
    return stopRun();
  });
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    stopActiveProcess();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

