<!--
Concise English documentation for pi-ssh-remote, covering its purpose, installation, essential commands, authentication, and security boundaries.
-->

# pi-ssh-remote

[中文](README.zh-CN.md)

Use Pi's file and shell tools on a persistent remote SSH workspace. Supports multiple endpoints, remote working directories, reconnection, and local port forwarding.

## Install

```bash
pi install npm:pi-ssh-remote
```

## Use

```text
/remote config ssh ssh USER@HOST -p PORT
/remote                         # connect
/remote cd /remote/project
/remote status
/remote off                     # return to local tools
```

Run `/remote config` to list endpoints and `/remote` to see all available subcommands.

## Authentication and security

Uses SSH agent authentication when available, otherwise prompts for a password. Passwords stay in process memory. New or changed host keys require confirmation and are stored separately from OpenSSH.

Only direct SSH commands with `-p` and `-l` are supported. `~/.ssh/config`, `IdentityFile`, and ProxyJump are not currently supported.

Requires Node.js 20+, Bash, SFTP, and GNU `timeout` on the remote host.

MIT licensed.
