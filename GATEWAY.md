# A 端客户端

`claudec` 从本仓库启动 Claude Code 终端界面。A 通过一把 A 角色的网关密钥连接 B。B 将请求送到密钥绑定的固定 C 虚拟机，C 使用自己的模型凭证执行推理。每台虚拟机有两个并发位置。macOS 和 Linux 客户端使用 Bun、Python 3 和 ripgrep。

## 启动

要保存 B 的连接地址，运行 `claudec config set-server` 并输入完整地址，例如 `wss://8.153.176.226/v1/ws`。地址和密钥可分别更新。启动时按 `--url`、`CC_GATEWAY_URL`、已保存的地址、内置地址的顺序选择。

首次使用或更换密钥时，运行 `claudec config set-key`，按提示粘贴 B 管理员签发的 A 密钥并回车。输入会隐藏。然后进入工作目录运行 `claudec`。

A 启动时使用本端网关密钥自动连接 B 的 WSS 入口，并验证 B 的公网 IP 和证书链。

已安装 `claudec` 启动命令的 Mac 用户可进入项目后输入 `claudec`，默认使用当前目录，由 B 根据接入密钥选择固定池。直接从源码启动时，在本仓库目录运行以下任一命令，把路径换为要操作的项目。

~~~sh
./claudec --workspace /absolute/path/to/project
./claudec --workspace /absolute/path/to/project -p '读取 README.md 并概述'
./claudec --workspace /absolute/path/to/project --continue
~~~

A 只提交本端凭证。绑定、轮换、撤销由 B 管理员通过服务器本地管理接口执行。默认密钥文件为 macOS/Linux 的 `~/.config/cc-a/access.key` 或 Windows 的 `%LOCALAPPDATA%\cc-a\access.key`。也可使用 `--key-file FILE`，文件需要归当前用户所有并限制为仅本人可读。工作区和凭证分开存放。自有网关地址通过 `--url` 设置，支持 WSS 或用于本地测试的回环 WS。

## 会话和执行位置

- 交互和单个 `-p` 均使用原版 CLI。可把首条问题作为位置参数传入，也可使用 `--print` 从标准输入读取文本。`-c` 和 `-r` 分别对应 `--continue` 和 `--resume`。工作区信任、操作预览和审批出现在运行 A 的本地终端。单次打印模式下，需要手动确认的操作会被拒绝。六种权限模式的启动参数、审批与审查行为见 [README](README.md#权限模式)。
- 同一工作区和密钥下，`--continue` 恢复最近会话，`--resume SESSION` 恢复指定会话，交互中也可使用 `/resume`。macOS 和 Linux 将记录保存在密钥目录下的 .cc-a-state 私有子目录，Windows 使用当前用户的 LocalAppData。换密钥后使用独立的记录。A 每轮发送当前问题和能够放入 16,000 字节网关请求的最近文本历史。在交互终端中，将 PNG、JPEG、GIF 或 WebP 图片拖入输入框，看到图片标记后输入问题并回车。每轮最多 4 张，每张 4 MiB，合计 8 MiB。后续追问自动携带当前会话中最近一次附上的整组图片；附上新图会替换该组。新会话或上下文压缩后，需要重新附图。PDF 和其他二进制附件暂不支持。
- 当前 Mac 和 Linux 验收配置各可注册 35 个工作区工具，覆盖文件与 Bash、任务和子代理、计划、工作树、定时任务、工作流、LSP 和 MCP 资源。每轮仅注册当前会话可用的工具。PowerShell 未在这台 Mac 上启用。WebFetch 和 WebSearch 在 C 使用 Claude Code 原生实现。Notebook 和云端专属工具已排除。
- Read/Write/Edit 面向工作区内的 UTF-8 文件。macOS 和 Linux 的 Bash 在各自的工作区隔离环境执行，单次上限 55 秒。Monitor 支持工作区命令或回环 WebSocket。Workflow 使用独立 JavaScript 运行时，其模型调用经同一固定池。工作流和唤醒计时器随客户端进程结束。内置语言服务器支持 JavaScript 和 TypeScript。外部 MCP 资源可通过 `--mcp-config FILE` 显式接入。
- `--text-only` 禁用工具。macOS 和 Linux 的 `--simple` 启动兼容客户端，只提供六个文件、搜索和 Bash 工具。一次传入两个 `-p` 使用兼容模式并行执行独立请求。
- 在仓库目录运行 `bun test src/gateway` 可验证文件边界、隔离命令、多轮历史、工作流、并发和无交互审批。


## 跨平台验收

macOS、Linux 和 WSL 使用 `./claudec`。Linux 的 Bash 执行器使用 bubblewrap，启动时实际创建隔离环境来检测权限。容器限制用户命名空间时，Bash 不会注册，其余工具仍可使用。

Windows 原生入口为 `claudec.cmd`。Glob 和 Grep 默认使用 PATH 中的 `rg.exe`，Git Bash 使用 Git for Windows。使用 `--key-file` 指定当前 Windows 用户拥有的 NTFS 密钥文件，访问权限应限于本人、SYSTEM 和本机 Administrators。会话记录存储于当前用户的 LocalAppData。Windows 模式使用本机可用的 PowerShell 和 Windows 工作目录。已在这台 Mac 的 Docker Windows 11 ARM64 来宾中验证客户端启动、认证、原版终端审批和真实固定池编程任务。Windows 用户可从客户端目录启动交互会话。

~~~powershell
.\claudec.cmd --key-file "C:\Keys\access.key" --workspace "C:\Projects\demo"
~~~

在 macOS 和 Linux 的客户端目录运行 `bun test src/gateway`。Windows 使用 `bun test src/gateway/client.test.ts src/gateway/native.test.ts src/gateway/readTools.test.ts`。其中只读工具测试启动真实 CLI、本地 MCP 测试服务和 TypeScript 语言服务器，检查网关收到的工具结果。跨平台验收应分别记录安装、工具注册、实际调用和编程任务测试结果。

交互验收可从仓库目录运行：

~~~sh
python3 test/gateway/interactive.py operations
python3 test/gateway/interactive.py agent
~~~

以上两组用例在 macOS 和 ARM64 Linux 的原版终端中运行，使用临时项目和测试网关。第一组检查编辑、Bash 测试、任务、定时器、工作树、计划审批、技能和问答；第二组检查后台代理确实收到父任务的新消息，并在自己的结果中交还随机标记。另已通过真实 server05 验证两端 A 的 Edit 操作，分别在确认修改后独立运行 Python 断言。Windows 的真实 server05 测试则由模型读取 TypeScript 源码和测试，通过本地 Edit 审批将 `return n + n` 改为 `return n * n`，随后在 Windows 单独执行 3 个断言，并确认临时凭证已删除。

server05 的原生 WebSearch 已实际返回 Debian 搜索链接。原生 WebFetch 对 example.com 和 docs.python.org 的尝试均在域名预检阶段失败。从同一台 C 虚拟机访问 Anthropic 的域名验证接口返回 HTTP 403。此环境中，WebFetch 仍受上游域名验证服务的可访问性限制。

### 工具验收范围

下表的 35 个工具已在 macOS、本机 Docker Linux 和本机 Docker Windows 11 ARM64 全部实际调用成功。Windows 另通过 PowerShell，共 36 个。只读测试通过 `claudec -p` 启动客户端。交互测试在终端里确认编辑、命令和计划等操作，并检查工具返回值或工作区文件。

| 功能 | 三个平台均已调用成功的工具 |
| --- | --- |
| 文件、搜索与命令 | Read、Write、Edit、Glob、Grep、Bash |
| 工具发现、语言服务与 MCP 资源 | ToolSearch、LSP、WaitForMcpServers、ListMcpResourcesTool、ReadMcpResourceTool |
| 任务与子代理 | Task、ListAgents、SendMessage、SubagentHandback、TaskCreate、TaskGet、TaskUpdate、TaskList、TaskStop、TodoWrite |
| 工作区、计划与交互 | EnterWorktree、ExitWorktree、EnterPlanMode、ExitPlanMode、Skill、AskUserQuestion、ReportFindings、EndConversation |
| 定时与工作流 | CronCreate、CronList、CronDelete、ScheduleWakeup、Monitor、Workflow |

Windows 11 ARM64 的原生 `claudec.cmd -p` 已返回 11 个正确结果，覆盖 ListAgents、WaitForMcpServers、TaskList、CronList、ListMcpResourcesTool、ReadMcpResourceTool、Read、Glob、Grep、ToolSearch 和 LSP。Windows 的会话恢复用例也已通过，覆盖 `-c` 读取上轮历史、`--print` 接收管道中文输入、无本地审批时拒绝写文件，以及回归用临时目录的清理。Windows 的操作与子代理矩阵分别收到 28 和 5 个回执，其中计划模式下的工作区写入按预期拒绝。另在 Windows 原版交互界面确认 Write 和 Edit，将平方函数从加法改为乘法。PowerShell 运行改后的程序，通过 0、7 和 −3 三个输入的断言。Git Bash 返回了测试标记。上述两组测试通过本地测试网关逐项指定调用。真实固定池编程测试另行验证模型自主选择 Read 和 Edit、本地审批及编辑结果。

[三平台验收结果（JSON）](test/gateway/acceptance-results.json)

## 多终端和本地历史

在项目目录的不同终端分别运行 `claudec`，即可使用同一把 A 密钥开启独立对话。普通启动创建新会话。各终端可同时连接同一个固定池，池满时新任务会收到 `pool_busy`。

`claudec history` 离线列出当前密钥、当前工作区的原生会话，按最近更新时间排序。用 `claudec history --search 关键词` 按标题、首条提示、摘要或会话 ID 筛选。用 `claudec --resume 会话ID` 接回指定对话，或用 `claudec --continue` 接回最近一次。多终端并用时，指定 ID 可以避免接错对话。历史支持原来的 `--key-file` 和 `--workspace` 选项。`--simple` 会话不写入原生历史。
