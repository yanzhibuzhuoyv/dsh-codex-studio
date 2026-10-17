# DSH x Codex Studio

[![Build Windows portable](https://github.com/yanzhibuzhuoyv/dsh-codex-studio/actions/workflows/build-win.yml/badge.svg)](https://github.com/yanzhibuzhuoyv/dsh-codex-studio/actions/workflows/build-win.yml)

Prebuilt Windows x64 portable build: [Releases](https://github.com/yanzhibuzhuoyv/dsh-codex-studio/releases/latest).

A small Electron desktop shell for a DSH/Codex collaboration loop. It runs the real
`codex exec --json` CLI, resumes a thread with `codex exec resume --json <thread-id> -`,
and turns actual `dsh` MCP tool events into two views:

- **DSH run log** — MCP boundary request/result payloads parsed from Codex JSONL.
- **Relay** — DSH → Codex (MCP result/response) on the left, Codex → DSH (MCP request/arguments) on the right.
- **Codex event log** — raw stdout JSONL, non-JSON stdout, and stderr.

This is not an embed of the DSH app UI or a source of model reasoning. The relay only
shows MCP boundary data that Codex actually emitted.

## Requirements

For the packaged portable app:

- Windows x64
- Codex CLI installed, logged in, and configured with the `dsh` MCP server as needed
- The Codex CLI available on the user's `PATH` (or `CODEX_CLI_PATH` set to its executable)

The portable app does not include Node.js, Electron, or Codex. Electron is bundled by
the packager; Codex remains a separate user-installed CLI and may use the network
according to its own configuration.

For development and building from source:

- Windows with Node.js 24+
- Electron 44 and electron-builder installed with `npm install`

The app does not modify Codex or DSH configuration and makes no network requests itself.
Codex is allowed to use the workspace folder chosen by the user even when it is not a Git repository.

## Setup (development)

```powershell
cd C:\path\to\dsh-codex-studio
npm install
npm start
```

Or double-click `launch.cmd` after dependencies are installed. The launcher only starts
the local Electron executable; it does not install packages or contact the network.

If Codex is not exposed on `PATH`, set `CODEX_CLI_PATH` to the executable path before
launching:

```powershell
$env:CODEX_CLI_PATH = 'C:\path\to\codex.exe'
npm start
```

## Build portable Windows x64 app

From the project directory, after `npm install`:

```powershell
npm run build:win
```

The build uses electron-builder's Windows `portable` target and writes artifacts to
`dist/`. This is an unsigned portable application with no installer; Windows may show
a SmartScreen warning when it is first run. The expected executable name is:

```text
dist\DSH x Codex Studio-0.1.0-x64-portable.exe
```

This is a single self-contained application executable that starts the Electron app
when double-clicked; no installation is required. The first build may download
Electron/build tooling and therefore needs network access.

The same build runs on GitHub Actions (`.github/workflows/build-win.yml`) on every
push to `main` and can be started manually with **workflow_dispatch**; the resulting
portable `.exe` is uploaded as the `dsh-codex-studio-portable` workflow artifact.

The app still resolves and runs the user's Codex CLI from `PATH` at runtime. The
packaged app does not bundle or alter the user's Codex CLI, login, or global
configuration. DSH collaboration also requires the user's Codex `dsh` MCP server
configuration to be present.

## Usage

1. Select a workspace with **Browse…** (or type a path).
2. Leave **DSH collaboration** OFF (the default) to instruct Codex not to call the
   dsh MCP server. Turn it ON to send the Codex-architect / DSH-executor instruction;
   DSH mode also routes CLI approval requests through Codex automatic review.
3. Enter a task and press **Start run** (or `Ctrl+Enter`).
4. Use **Stop** to terminate the Codex process tree. Use **New session** to forget the
   current Codex thread and clear the view.
5. The first run starts a new Codex thread. When a thread id appears in the JSONL stream,
   later runs resume it automatically.

## Current limitations

- One Codex run at a time; logs are kept in memory only and are not exported.
- Only `mcp_tool_call` records for server `dsh` are promoted to the DSH log and relay.
  Other events remain visible in the raw Codex event log.
- The relay depends on the Codex JSONL event shape and on the dsh MCP server actually
  returning textual result content.
- Long-running or malformed CLI output is shown raw or truncated only by the UI's
  rolling in-memory view limits.
- No native DSH UI is embedded, and no model reasoning is inferred or displayed.
- No tests are included in this source drop.

## Source map

- `src/main.js` — Electron main process, Codex process lifecycle, JSONL parsing, IPC.
- `src/preload.js` — narrow `contextBridge` API.
- `public/` — renderer HTML, CSS, and DOM-only JavaScript.
- `launch.cmd` — Windows development launcher that uses the locally installed Electron.
- `package.json` — development scripts and electron-builder portable build configuration.

## License

[MIT](LICENSE) © 2026 yanzhibuzhuoyv