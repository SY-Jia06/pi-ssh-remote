<!--
pi-ssh-remote 中文说明文档，重点介绍它面向 Pi Agent 的设计、主要能力、常见使用场景、命令和安全机制。
-->

# pi-ssh-remote

**让 Pi 像操作本地项目一样操作远程服务器。**

[English Docs](README.md) · [社区](https://linux.do/)

`pi-ssh-remote` 是一个专门面向 Pi Agent 的 SSH 远程开发插件。

它不只是帮你打开一个远程终端。连接服务器后，Pi 原有的 `read`、`write`、`edit`、`bash` 等工具会自动切换到远端。Agent 不需要反复拼接 SSH 命令，也不需要先把代码下载到本地再修改，可以直接在服务器上查看文件、分析日志、修改代码和运行任务。

例如，你可以直接对 Pi 说：

```text
连接 ssh root@gpu-box -p 2202，进入 /srv/training。
检查最近一次训练为什么失败，修复问题后在后台重新启动，
最后把 PID 和日志路径发给我。
```

Pi 会依次完成连接服务器、切换目录、读取日志、修改文件和启动任务。整个过程中，它使用的仍然是熟悉的 Pi 工具，只是执行位置变成了远程服务器。

## 为什么它更适合 Agent

### 不需要给每一步都套一层 SSH

普通做法通常是让 Agent 不断执行：

```bash
ssh user@host "cd /path && ..."
```

命令一多，目录、引号、环境变量和连接状态都很容易出错。使用本插件后，只需要连接一次，后续文件读写和 Shell 操作都会自动在远端执行。

### Agent 知道自己正在操作哪台服务器

插件会把当前远程目录和服务器信息写入 Pi 的上下文，并显示在底部状态栏：

```text
SSH remote H100 训练机 (root@gpu-box.example.com:2202):/srv/project
```

这样无论是用户还是 Agent，都能随时确认当前操作发生在本地还是远端，减少误操作。

### 服务器配置会保留

每台服务器都可以单独保存：

- SSH 地址；
- 默认工作目录；
- 服务器备注；
- 服务器特定记忆；
- 端口转发配置。

例如可以把几台机器分别备注为 `8xH100 训练机`、`预发布环境`、`线上只读机`。还可以为每个 `user@host:port` 保存独立记忆，例如指定 Python 环境、共享任务保护规则或部署约定。连接该 endpoint 并启用远端工具路由后，这段记忆会自动注入模型上下文；断开连接或切换到纯隧道模式后，后续请求不再注入。所有配置保存在本地，重启 Pi 后仍然存在。

### 断线后可以自动恢复

当前会话中如果 SSH 连接意外断开，插件会尝试自动重连，不需要 Agent 从头建立工作环境。

### 对 Agent 上下文更友好

远程命令默认 30 秒超时，避免某个前台任务长期占住 Agent。命令输出过大时，只会把受限内容放入模型上下文，完整输出会另外保存到临时文件，方便后续继续检查。

### 可以远端跑服务、本地改代码

端口转发模式下，可以把远端服务映射到 `localhost`，同时让 Pi 的文件和 Shell 工具继续操作本地项目。

这很适合下面这类场景：

- GPU 服务器运行模型，本地开发 Web UI；
- 远端启动 API，本地调试客户端；
- 远端运行训练监控，本地查看页面；
- 内网服务通过 SSH 隧道提供给本地工具使用。

## 和直接使用 SSH 有什么区别

| 直接执行 SSH | 使用 `pi-ssh-remote` |
|---|---|
| 每条命令都要重新拼接 SSH | 连接一次后，Pi 工具自动在远端执行 |
| 多次调用之间容易丢失目录 | 自动记住远程工作目录 |
| Agent 需要自己判断当前在哪台机器 | 系统上下文和底部状态栏会显示当前服务器 |
| 连接中断后需要手动恢复 | 当前会话内自动重连 |
| 文件修改、命令执行和端口转发各自处理 | 统一通过 `/remote` 和 Agent 工具管理 |
| 大量输出可能直接占满模型上下文 | 内置超时、折叠预览和输出上限 |

## 安装

```bash
pi install npm:pi-ssh-remote
```

本地要求 Node.js 20+。远程服务器需要提供 Bash、SFTP 和 GNU `timeout`。

## 快速开始

连接服务器：

```text
/remote ssh root@gpu-box.example.com -p 2202
```

设置远程工作目录和备注：

```text
/remote cd /srv/project
/remote config note H100 训练机
/remote config memory 使用 /opt/conda/bin/python，不要停止其他用户的共享任务。
```

查看当前状态：

```text
/remote status
```

连接成功后，Pi 的文件和 Shell 工具都会操作远程 `/srv/project`。

需要返回本地时执行：

```text
/remote off
```

## 常见用法

### 1. 让 Pi 直接排查远程服务故障

```text
连接 ubuntu@training.example.com，进入 /opt/app。
先检查部署日志和 Git 状态，找出失败原因。
如果需要修改代码，先说明原因，再做最小修改并运行相关测试，
最后把 diff 和测试结果发给我。
```

连接完成后，Pi 后续的读文件、查日志、改代码和跑测试都会直接在服务器上进行。

### 2. 启动长时间训练任务

```text
在当前远程服务器检查训练命令和配置。
确认无误后用 nohup 在后台启动，并从一开始就重定向 stdout 和 stderr。
把 PID、输出目录和日志路径发给我，再检查一次进程是否仍在运行、日志是否已经开始写入。
```

插件默认限制前台命令的执行时间，但通过 `nohup` 等方式启动的后台任务可以继续在服务器运行。

### 3. 管理多台服务器

先配置训练机：

```text
/remote ssh root@10.0.0.21 -p 22
/remote config note 8xH100 训练机
/remote config cwd /srv/train
```

再配置预发布服务器：

```text
/remote ssh ubuntu@staging.example.com -p 2222
/remote config note 预发布 API
/remote config cwd /opt/service
```

查看并切换服务器：

```text
/remote config
/remote use root@10.0.0.21:22
/remote
```

备注和默认目录会按 `user@host:port` 分别保存，不会互相覆盖。

### 4. 远端启动模型，本地开发界面

保存并启动端口转发：

```text
/remote config forward 7860:127.0.0.1:7860
/remote forward
```

现在访问本地 `localhost:7860`，实际连接的是远程服务器上的 7860 端口；与此同时，Pi 的文件和 Shell 工具会留在本地，方便继续修改前端或客户端代码。

停止转发：

```text
/remote unforward
```

### 5. 直接用自然语言操作

不想记命令时，可以直接告诉 Pi：

```text
连接已配置的远程服务器，进入 /srv/api，然后检查 Git 状态。
```

```text
把当前服务器备注为“线上只读机”，然后告诉我现在操作的是哪台服务器。
```

```text
把远端 8000 端口转发到本地 8000，但代码工具继续留在本地。
```

Pi 会通过插件提供的 `ssh_remote_control` 工具完成这些操作。

## 命令说明

| 命令 | 作用 |
|---|---|
| `/remote ssh USER@HOST -p PORT` | 保存并连接服务器 |
| `/remote` | 连接当前选中的服务器，或提示输入 SSH 地址 |
| `/remote config` | 查看已保存的服务器和配置 |
| `/remote use USER@HOST:PORT` | 切换到指定服务器 |
| `/remote config note TEXT` | 给当前服务器添加或修改备注 |
| `/remote config note --clear` | 清除当前服务器备注 |
| `/remote config memory TEXT` | 保存连接该服务器时自动注入上下文的记忆 |
| `/remote config memory --clear` | 清除当前服务器的特定记忆 |
| `/remote config cwd PATH` | 设置默认远程工作目录 |
| `/remote cd PATH` | 切换当前远程目录并保存 |
| `/remote config forward MAPPING...` | 保存端口转发配置，例如 `7860:127.0.0.1:7860` |
| `/remote forward [MAPPING...]` | 启动端口转发，并让 Pi 工具留在本地 |
| `/remote unforward` | 停止插件创建的端口转发 |
| `/remote exec COMMAND` | 在当前远程目录执行一次命令 |
| `/remote exec --timeout 60 COMMAND` | 单独设置本次命令的超时时间 |
| `/remote exec --lines 20 COMMAND` | 单独设置本次折叠显示的行数 |
| `/remote config display-lines 10` | 设置默认折叠显示行数 |
| `/remote status` | 查看当前连接和工作目录 |
| `/remote reload` | 重新连接当前服务器 |
| `/remote off` | 断开连接并返回本地 |
| `/remote forget` | 断开连接并清除内存中的密码 |

## 配置保存在哪里

服务器配置保存在本地：

```text
~/.pi/agent/ssh-remote-config.json
```

其中包括：

- 已保存的服务器；
- 当前选中的服务器；
- 服务器备注；
- 服务器特定记忆；
- 默认远程目录；
- 端口转发配置；
- 命令预览设置。

服务器记忆是由用户在本地配置的可信上下文，不会从远程服务器自动读取；仅当对应 endpoint 作为远端工作区启用时才会加入每次模型请求。

密码不会写入配置文件。插件会优先使用 SSH agent；如果需要手动输入密码，密码只会缓存在当前 Pi 进程的内存中。

## 安全与输出限制

- 第一次连接新服务器时，需要确认主机密钥；
- 主机密钥发生变化时，会再次要求确认；
- 远程命令默认 30 秒超时；
- 发送给模型的命令输出最多为 2,000 行或 50 KB；
- 超限的完整输出会保存到本地临时文件；
- 折叠显示行数只影响界面，不影响模型输出上限。

## 当前限制

目前只支持 SSH 直连，以及 `-p`、`-l` 参数。暂不读取 `~/.ssh/config`，也不支持 `IdentityFile` 和 ProxyJump。

## 版本发布

最新版本：[v0.1.5](https://github.com/petrichor20211/pi-ssh-remote/releases/tag/v0.1.5)

| 版本 | 日期 | 主要内容 |
|---|---|---|
| [0.1.5](CHANGELOG.md#015---2026-08-04) | 2026-08-04 | endpoint 级服务器记忆与自动上下文注入 |
| [0.1.4](CHANGELOG.md#014---2026-07-31) | 2026-07-31 | endpoint 备注与远程命令强制超时 |
| [0.1.3](CHANGELOG.md#013---2026-07-24) | 2026-07-24 | 可配置、可展开的命令输出预览 |

完整的新增内容、行为变更和 Bug 修复记录请查看 [CHANGELOG.md](CHANGELOG.md)。

MIT License。
