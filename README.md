# cc_A · 本地终端客户端

在要处理的项目目录运行 `claudec`，就能让模型读取代码、解释报错，或在你确认后修改文件。终端、工作区工具和操作审批都在本机（A）。网关（B）根据你的接入密钥选择固定的虚拟机池（C），由 C 调用模型。A 只需一把 B 签发的 **A 端接入密钥**，无需配置 SSH、Claude 订阅或模型服务的 API Key。

## 在已安装的 Mac 上开始使用

1. 首次使用时运行下方命令，按提示粘贴管理员发给你的 `gw1_` 密钥并回车。输入时终端会隐藏密钥。

   ```sh
   claudec config set-key
   ```

2. 当前部署的默认网关是 `wss://8.153.176.226/v1/ws`。使用默认地址可以直接进入下一步。要更换网关，运行 `claudec config set-server`，按提示输入管理员提供的完整 WSS 地址。

3. 进入要处理的项目目录，启动会话。下面的路径请换成自己的项目。

   ```sh
   cd ~/Projects/my-app
   claudec
   ```

   可以先问「请读取 README.md，告诉我这个项目怎么启动」。需要确认的编辑或命令会在当前终端显示审批提示。后续使用只需在项目目录运行 `claudec`。

## 从源码启动

新机器需要 Git 和 Bun 1.3 或更高版本。macOS 和 Linux 的工作区工具还会用到 Python 3 和 ripgrep（`rg`）。Linux 的隔离 Bash 需要可用的 bubblewrap；Windows 的文件搜索使用 `rg.exe`，Git Bash 工具需要 Git for Windows。

```sh
git clone https://github.com/jeremyjy1/cc_A.git
cd cc_A
bun install --frozen-lockfile
```

在客户端仓库中运行下面的命令。`--workspace` 指向你要处理的项目目录；也可以从项目目录用启动脚本的绝对路径运行，默认工作区就是当前目录。

**macOS、Linux 或 WSL**

```sh
./claudec config set-key
./claudec --workspace ~/Projects/my-app
```

**Windows PowerShell**

```powershell
.\claudec.cmd config set-key
.\claudec.cmd --workspace "C:\Projects\my-app"
```

以下示例使用已加入 PATH 的 `claudec`。从源码启动时，使用相应平台的启动脚本即可。

## 对话与历史

| 要做的事 | 命令 |
| --- | --- |
| 开启新会话并带入第一个问题 | `claudec "这个项目的入口在哪里？"` |
| 回答一次并退出，适合脚本或只读问题 | `claudec -p "读取 README.md，列出运行测试的步骤"` |
| 从标准输入提问，仅发送文本 | `printf '用一句话解释这个错误：文件不存在' \| claudec --text-only --print` |
| 离线列出当前工作区的本地会话 | `claudec history` |
| 按标题、首条提示、摘要或会话 ID 搜索 | `claudec history --search 登录` |
| 继续最近一次会话 | `claudec --continue` |
| 恢复指定会话 | `claudec --resume <会话ID>` |

同一把密钥可以在多个终端同时使用。每个终端运行一次 `claudec` 就会开启独立对话，工具请求和回复回到各自的终端。现有每个固定池可同时执行两个任务；遇到 `pool_busy` 时，等其中一个任务结束后重试即可。

历史按工作区和密钥保存。多个终端并用时，可以从 `claudec history` 复制 ID，再用 `--resume` 精确接回某次对话。换了密钥或项目目录，历史列表也会切换。`--simple` 兼容模式不写入上述历史。需要手动确认的操作请在交互会话中执行。

### 工作区与会话命令

| 命令 | 用法 |
| --- | --- |
| `/init` | 分析当前项目，在 A 端创建或完善 `CLAUDE.md`。文件写入遵循本轮权限模式。 |
| `/add-dir <路径>` | 确认后把另一个项目目录加入当前会话。也可输入 `/add-dir` 后选择。相对路径仍以主工作区为起点。 |
| `/btw <问题>` | 带上当前对话另开一次纯文本旁问，使用同一个池和当前模型设置。按 Esc 关闭；旁问和回答不加入主对话。 |
| `/rewind` 或 `/checkpoint` | 选择历史消息，恢复对话或已记录的文件编辑。支持 A 端 Write/Edit 的修改和新建文件；手动修改及 Bash 写入不在文件检查点内。 |

## 权限模式

用 `claudec --permission-mode plan` 指定启动模式。交互时按 `Shift+Tab` 在手动、接受编辑、计划及可用的可选模式之间切换。要让跳过审批出现在切换列表中，启动时加 `--allow-dangerously-skip-permissions`。Shift+Tab 确认的选择按本机接入密钥保存。新会话、`--continue` 和 `--resume` 都沿用最后一次选择；显式 `--permission-mode` 只覆盖本次启动。已选中的跳过审批模式也会被记住。无提示模式通过命令行选择。权限模式适用于原生会话，包括单个 `-p` 请求。

| 参数值 | A 端行为 |
| --- | --- |
| `default` | 工作区编辑和命令请求本地审批。 |
| `acceptEdits` | 使用原生工具规则自动接受普通工作区编辑，需确认的操作仍会询问。 |
| `plan` | 可以探索工作区和编写本轮计划文件，项目写入被拒绝。 |
| `auto` | A 直接放行本机规则允许的只读命令。普通工作区编辑和需要审核的沙箱 Bash 命令交给 C 宿主机；仅在 C 明确允许后执行。显式人工确认规则、本地安全检查和禁止规则仍由 A 执行。Windows 上未被判定为只读的原生 Shell 命令仍在 A 确认。 |
| `dontAsk` | 运行已许可的操作，拒绝需要询问的操作。 |
| `bypassPermissions` | 跳过常规审批，仍执行工作区边界、沙箱以及原生工具强制规则。 |

Auto 使用本项目的审查实现。审核和原工具调用关联，五台 VM 共用宿主机的一份审核 API 凭证。宿主机向 DeepSeek 发送相关用户请求、工具名和参数（可能含待写入的代码），费用计入审核 API 账号。审核不占 VM 推理位置；审核服务未启用、超时、返回不明确或客户端取消时，该项操作会被拒绝。C 上的原生网页工具由 C 管理。

## 图片和网页

在交互终端把图片拖入输入框，看到图片标记后输入问题并回车。同一会话里可以继续追问另一处细节，无需再次拖入原图；附上新图后，后续追问会使用最新的一组。支持 PNG、JPEG、GIF 和 WebP，每轮最多 4 张，单张最多 4 MiB，总计最多 8 MiB。新会话或上下文压缩后需要重新附图。

读取、搜索和编辑项目文件使用 A 的工作区。网页搜索与抓取使用 C 上的原生工具，因此网页能否访问取决于 C 的网络环境。

## 配置与排查

- **连接失败**：用 `claudec config set-server` 核对并重新保存完整网关地址，再用 `claudec config set-key` 更新 A 密钥。密钥的目标池、轮换和撤销由 B 管理员控制。
- **临时切换配置**：用 `--url` 指定本次连接地址，用 `--key-file` 指定另一份密钥文件。地址选择顺序为命令行、环境变量 `CC_GATEWAY_URL`、已保存地址、内置地址。密钥文件选择顺序为命令行、`CC_A_KEY_FILE`、默认文件。
- **工作区被拒绝**：请选择具体项目目录，并将密钥放在工作区外。默认位置为 macOS/Linux 的 `~/.config/cc-a/access.key`，或 Windows 的 `%LOCALAPPDATA%\cc-a\access.key`。用 `config set-key` 保存时，客户端会设置文件权限。
- **查询用量**：B 管理员可在[管理控制台](https://8.153.176.226/admin/)按 A 密钥查看请求数和 token 用量。

运行 `claudec --help` 查看命令选项。工具清单、平台差异和测试命令见[工具与跨平台验收说明](GATEWAY.md)。

### 切换模型和推理强度

在交互会话输入 `/model` 打开选择菜单，也可以直接输入 `/model sonnet` 或 `/model <完整模型 ID>`。输入 `/effort` 查看当前推理强度，用 `/effort high` 修改。可选档位为 `low`、`medium`、`high`、`xhigh`、`max`。设置从下一条消息生效；`/model default` 和 `/effort auto` 分别恢复 C 池的默认值。

启动时也可指定，例如 `claudec --model opus --effort high -p "解释这个项目的结构"`。模型可用性及实际支持的强度由该池的 Claude Code 版本、模型和登录账号决定。使用自选参数需要更新 C 宿主机的控制器及对应虚拟机的启动脚本。Auto 权限审核继续使用宿主机配置的审核模型。

`/model` 和模型快捷键每次打开时都通过当前连接读取绑定 C 池的 Claude Code 模型菜单。菜单保留池端的别名、大小写和默认模型说明；能否实际调用由该账号和提供方决定。池离线、繁忙或控制器版本过旧时会提示列表不可用，可退出后再打开。

### 在 C 上恢复对话

使用 `/resume`、`claudec --continue` 或 `claudec --resume <A 会话 ID>` 即可。首次成功回复后，A 在该回复的本地记录中保存一个由 B 分配的远端检查点。后续主对话只发送这个检查点之后的新内容和工作区说明；图片已保存在 C 的对话中时也无需重传。C 的 Claude Code 用原生 `--resume` 读取对应历史，并把新的一轮保存为独立分支。两个终端从同一条历史继续时，各自保留自己的后续内容。

旧历史没有远端检查点时，首次仍按原有网关窗口传递最近历史。未升级的池可继续按原方式工作。恢复已有远端检查点需要原 A 密钥、原池以及 VM 上保存的 Claude 会话文件。清理这些文件或更换密钥后，请新建会话；旁问、子任务和模型目录查询独立运行。
