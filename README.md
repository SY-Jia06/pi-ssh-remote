<!--
Agent-first English documentation for pi-ssh-remote. It explains the extension's design, transparent tool routing, persistent workspace model, safety boundaries, compelling workflows, commands, and installation requirements.
-->

# pi-ssh-remote

**SSH designed for agents—not just for terminals.**

[中文文档](README.zh-CN.md) · [Community](https://linux.do/)

`pi-ssh-remote` turns a remote machine into Pi's active workspace. After connecting, the agent keeps using its normal `read`, `write`, `edit`, and `bash` tools, but those operations run on the remote server. There is no need to wrap every action in `ssh ...`, copy files back and forth, or make the model reason about two unrelated shells.

```text
You: Connect to ssh root@gpu-box -p 2202, open /srv/training,
     find why the latest run failed, fix it, and restart it in the
     background. Return the PID and log path.

Pi:  connects → changes the persistent remote cwd → reads logs →
     edits remote files → launches the job on the GPU server
```

## Designed for agent workflows

### The remote machine becomes the agent's workspace

Once connected, Pi's file tools, shell tool, and `!` user shell commands are transparently routed over SSH. The agent can inspect a repository, search logs, edit code, and run tests with the same tool interface it uses locally.

### Agent control plane, human control plane

The extension exposes `ssh_remote_control` for the agent and `/remote` for the user. You can ask Pi to connect, inspect status, change directory, add a server note, execute a command, create a tunnel, or return to local work in natural language—and still take direct control whenever you want.

### Stateful endpoints instead of disposable SSH commands

Each `user@host:port` endpoint remembers its remote working directory, note, server-specific memory, and port-forward configuration locally. Notes such as `H100 training`, `staging`, or `customer demo` appear in configuration, status messages, and Pi's footer, so the active execution environment stays visible. Server memory is automatically injected into the model context whenever that endpoint is connected as the active remote workspace.

### Resilient and bounded by default

Dropped connections are automatically re-established during the active session. Remote commands have a 30-second default timeout, oversized output is bounded before it reaches the model context, and full truncated output is preserved in a temporary file.

### Hybrid local/remote workflows

Tunnel mode forwards remote services to localhost while returning Pi's tools to the local machine. This is useful when the backend runs on a GPU server but the client, browser automation, or integration code lives locally.

## Why not just run `ssh` in Bash?

| Plain SSH command | `pi-ssh-remote` |
|---|---|
| Each tool call must wrap or reconstruct SSH | All agent file and shell tools route automatically |
| Working directory is easy to lose between calls | Remote cwd is persistent and visible |
| The model must track whether it is local or remote | Pi's prompt and footer identify the active workspace |
| Disconnects break the workflow | Active-session connections automatically reconnect |
| Tunneling and remote editing are separate setups | Workspace routing and port forwarding share one control plane |
| Large output can flood context | Preview and model-output limits are built in |

## Install

```bash
pi install npm:pi-ssh-remote
```

Requires Node.js 20+. The remote server must provide Bash, SFTP, and GNU `timeout`.

## Quick start

```text
/remote ssh root@gpu-box.example.com -p 2202
/remote cd /srv/project
/remote config note H100 training server
/remote config memory Use /opt/conda/bin/python and never stop shared jobs.
/remote status
```

From this point, normal Pi operations target `/srv/project` on the remote server. The footer makes that routing explicit:

```text
SSH remote H100 training server (root@gpu-box.example.com:2202):/srv/project
```

Return to local tools with:

```text
/remote off
```

## Examples

### 1. Let the agent investigate and repair a remote failure

```text
Connect to ssh ubuntu@training.example.com -p 22 and work in /opt/app.
Inspect the failed deployment, trace the error through the logs and source,
make the smallest safe fix, run the relevant tests, and show me the diff.
```

The connection is established once. Subsequent reads, searches, edits, and tests are ordinary Pi tool calls routed to the server.

### 2. Launch a long GPU job without blocking the agent

```text
On the current remote server, validate the training command first. Then launch
it with nohup in the background, redirect stdout and stderr from process start,
and report the PID, output directory, and log path. Verify that the process is
still alive and that the log has started.
```

The default foreground timeout prevents an accidental long-running command from occupying the agent indefinitely, while an explicitly backgrounded job continues on the server.

### 3. Keep several machines understandable

```text
/remote ssh root@10.0.0.21 -p 22
/remote config note 8xH100 training
/remote config cwd /srv/train

/remote ssh ubuntu@staging.example.com -p 2222
/remote config note staging API
/remote config cwd /opt/service

/remote config
/remote use root@10.0.0.21:22
/remote
```

Endpoint notes, working directories, and server-specific memories survive Pi restarts because they are stored in the local remote configuration. When Pi connects to an endpoint, its memory is added to the system context on every agent run while remote tool routing remains active. Disconnecting or switching to tunnel-only mode removes it from subsequent model requests.

### 4. Expose a remote service while editing locally

```text
/remote config forward 7860:127.0.0.1:7860
/remote forward
```

Now `localhost:7860` reaches the service on the SSH server, while Pi's file and shell tools remain local. This is ideal for a remote model server paired with a local UI or client repository.

Stop the tunnels with:

```text
/remote unforward
```

### 5. Ask Pi directly

```text
Connect to my configured remote, switch to /srv/api, and inspect its Git status.
```

```text
Add the note "production read-only" to this endpoint and tell me which remote
workspace is active.
```

```text
Forward the remote service on port 8000 to localhost:8000, but keep my coding
tools on the local repository.
```

These requests are handled through the agent-facing `ssh_remote_control` tool; slash commands are optional.

## Command reference

| Command | Purpose |
|---|---|
| `/remote ssh USER@HOST -p PORT` | Save, select, and connect to an endpoint |
| `/remote` | Connect to the selected endpoint or prompt for one |
| `/remote config` | List saved endpoints and settings |
| `/remote use USER@HOST:PORT` | Select a saved endpoint |
| `/remote config note TEXT` | Persist a note for the selected endpoint |
| `/remote config note --clear` | Clear its note |
| `/remote config memory TEXT` | Persist context that is injected while working on this endpoint |
| `/remote config memory --clear` | Clear its server-specific memory |
| `/remote config cwd PATH` | Persist its default remote working directory |
| `/remote cd PATH` | Change the connected remote cwd and persist it |
| `/remote config forward MAPPING...` | Persist port forwards such as `7860:127.0.0.1:7860` |
| `/remote forward [MAPPING...]` | Start tunnels and keep Pi's tools local |
| `/remote unforward` | Stop extension-managed tunnels |
| `/remote exec COMMAND` | Run one command in the remote cwd |
| `/remote exec --timeout 60 COMMAND` | Override the command timeout |
| `/remote exec --lines 20 COMMAND` | Override collapsed preview lines |
| `/remote config display-lines 10` | Set default collapsed preview lines |
| `/remote status` | Show the active workspace |
| `/remote reload` | Reconnect the active workspace |
| `/remote off` | Disconnect and return tools to local execution |
| `/remote forget` | Disconnect and clear the in-memory password |

## Persistence, output, and security

Endpoint configuration is stored locally in:

```text
~/.pi/agent/ssh-remote-config.json
```

Saved values include endpoints, active endpoint, notes, server-specific memories, remote working directories, forwards, and preview settings. Server memory is user-configured trusted context and is inserted into each model request only while that endpoint is the active remote workspace; it is not read from the remote server. Passwords are **never written to this file**: SSH agent authentication is preferred, and prompted passwords remain only in process memory.

New or changed host keys require interactive confirmation and are stored separately from OpenSSH. Remote output sent to the model is limited to 2,000 lines or 50 KB; oversized complete output is written to a temporary local file. Preview-line settings affect only the collapsed UI.

## Current SSH scope

The extension currently supports direct SSH commands with `-p` and `-l`. It does not yet consume `~/.ssh/config`, `IdentityFile`, or ProxyJump settings.

## Releases

Latest release: [v0.1.5](https://github.com/petrichor20211/pi-ssh-remote/releases/tag/v0.1.5)

| Version | Date | Highlights |
|---|---|---|
| [0.1.5](CHANGELOG.md#015---2026-08-04) | 2026-08-04 | Endpoint-specific server memory and automatic context injection |
| [0.1.4](CHANGELOG.md#014---2026-07-31) | 2026-07-31 | Endpoint notes and enforced remote command timeouts |
| [0.1.3](CHANGELOG.md#013---2026-07-24) | 2026-07-24 | Configurable and expandable command-output previews |

See [CHANGELOG.md](CHANGELOG.md) for the complete release history, including additions, behavior changes, and bug fixes.

MIT licensed.
