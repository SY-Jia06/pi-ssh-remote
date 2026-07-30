<!--
Concise English documentation for pi-ssh-remote, covering its purpose, installation, essential commands, authentication, and security boundaries.
-->

# pi-ssh-remote

[中文文档](README.zh-CN.md) · [Community](https://linux.do/)

Use Pi's file and shell tools on a persistent remote SSH workspace. Supports multiple endpoints, remote working directories, reconnection, and local port forwarding.

## Install

```bash
pi install npm:pi-ssh-remote
```

## Use

```text
/remote ssh root@xx.xx.xx.xx -p xxxx  # save and connect
/remote cd /remote/project
/remote status
/remote off                     # return to local tools
```

While connected, Pi's footer status displays the remote endpoint and current working directory, for example `SSH remote user@host:22:/remote/project`. It updates after changing directories or reconnecting and disappears after disconnecting.

Add a note to the selected endpoint to make it easier to identify in `/remote config`, the footer, and status messages. Clear it with `--clear`:

```text
/remote config note GPU training server
/remote config note --clear
```

Remote command previews follow Pi's local Bash behavior and show the last 5 visual lines by default. Configure the default or override one `/remote exec` invocation:

```text
/remote config display-lines 10
/remote exec --lines 20 COMMAND
/remote exec --timeout 60 COMMAND
```

Every remote shell command has a timeout. `/remote exec`, remote Bash operations, and the `ssh_remote_control` tool's `exec` action default to 30 seconds when no timeout is supplied. The tool's `exec` action accepts `timeout` and `displayLines` parameters. Preview settings affect only the collapsed UI; model output keeps Pi's 2000-line/50KB safety limits, with oversized output saved to a temporary file.

Run `/remote config` to list endpoints and `/remote` to see all available subcommands.

## Authentication and security

Uses SSH agent authentication when available, otherwise prompts for a password. Passwords stay in process memory. New or changed host keys require confirmation and are stored separately from OpenSSH.

Only direct SSH commands with `-p` and `-l` are supported. `~/.ssh/config`, `IdentityFile`, and ProxyJump are not currently supported.

Requires Node.js 20+, Bash, SFTP, and GNU `timeout` on the remote host.

MIT licensed.
