<!--
pi-ssh-remote 的简明中文文档，说明扩展用途、安装方式、必要命令、认证机制和安全边界。
-->

# pi-ssh-remote

[English](README.md)

让 Pi 的文件与 Shell 工具在持久化 SSH 远程工作区中运行。支持多个服务器、远程工作目录、自动重连和本地端口转发。

## 安装

```bash
pi install npm:pi-ssh-remote
```

## 使用

```text
/remote ssh USER@HOST -p PORT  # 保存并连接
/remote cd /remote/project
/remote status
/remote off                     # 返回本地工具
```

使用 `/remote config` 查看服务器，使用 `/remote` 查看全部子命令。

## 认证与安全

优先使用 SSH agent，否则提示输入密码。密码仅缓存在进程内存中。首次连接或主机密钥变化时必须确认；主机密钥独立于 OpenSSH 存储。

目前仅支持带 `-p` 和 `-l` 的直连 SSH 命令，暂不支持 `~/.ssh/config`、`IdentityFile` 和 ProxyJump。

要求 Node.js 20+；远程服务器需提供 Bash、SFTP 和 GNU `timeout`。

采用 MIT 许可证。
