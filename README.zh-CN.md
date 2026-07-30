<!--
pi-ssh-remote 的简明中文文档，说明扩展用途、安装方式、必要命令、认证机制和安全边界。
-->

# pi-ssh-remote

[English Docs](README.md) · [社区](https://linux.do/)

让 Pi 的文件与 Shell 工具在持久化 SSH 远程工作区中运行。支持多个服务器、远程工作目录、自动重连和本地端口转发。

## 安装

```bash
pi install npm:pi-ssh-remote
```

## 使用

```text
/remote ssh root@xx.xx.xx.xx -p xxxx  # 保存并连接
/remote cd /remote/project
/remote status
/remote off                     # 返回本地工具
```

连接后，Pi 底部状态栏会显示远程地址和当前工作目录，例如 `SSH remote user@host:22:/remote/project`。切换目录或重连后会自动更新，断开连接后则会消失。

可以为当前选中的服务器添加备注，方便在 `/remote config`、状态栏和状态消息中识别；使用 `--clear` 清除：

```text
/remote config note GPU 训练服务器
/remote config note --clear
```

远程命令预览与 Pi 本地 Bash 一致，默认展示最后 5 个视觉行。可以修改默认值，或只覆盖某一次 `/remote exec`：

```text
/remote config display-lines 10
/remote exec --lines 20 COMMAND
/remote exec --timeout 60 COMMAND
```

所有远程 Shell 命令都有超时限制。若未提供 timeout，`/remote exec`、远程 Bash 操作以及 `ssh_remote_control` 工具的 `exec` 操作均默认使用 30 秒。工具的 `exec` 操作支持 `timeout` 和 `displayLines` 参数。预览设置只影响折叠界面；提供给模型的输出仍采用 Pi 的 2000 行／50KB 安全限制，超限完整输出会保存到临时文件。

使用 `/remote config` 查看服务器，使用 `/remote` 查看全部子命令。

## 认证与安全

优先使用 SSH agent，否则提示输入密码。密码仅缓存在进程内存中。首次连接或主机密钥变化时必须确认；主机密钥独立于 OpenSSH 存储。

目前仅支持带 `-p` 和 `-l` 的直连 SSH 命令，暂不支持 `~/.ssh/config`、`IdentityFile` 和 ProxyJump。

要求 Node.js 20+；远程服务器需提供 Bash、SFTP 和 GNU `timeout`。

采用 MIT 许可证。
