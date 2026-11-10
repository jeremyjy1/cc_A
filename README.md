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

历史按工作区和密钥保存。多个终端并用时，可以从 `claudec history` 复制 ID，再用 `--resume` 精确接回某次对话。换了密钥或项目目录，历史列表也会切换。`--simple` 兼容模式不写入上述历史。需要审批的操作请在交互会话中执行。

## 图片和网页

在交互终端把图片拖入输入框，看到图片标记后输入问题并回车。同一会话里可以继续追问另一处细节，无需再次拖入原图；附上新图后，后续追问会使用最新的一组。支持 PNG、JPEG、GIF 和 WebP，每轮最多 4 张，单张最多 4 MiB，总计最多 8 MiB。新会话或上下文压缩后需要重新附图。

读取、搜索和编辑项目文件使用 A 的工作区。网页搜索与抓取使用 C 上的原生工具，因此网页能否访问取决于 C 的网络环境。

## 配置与排查

- **连接失败**：用 `claudec config set-server` 核对并重新保存完整网关地址，再用 `claudec config set-key` 更新 A 密钥。密钥的目标池、轮换和撤销由 B 管理员控制。
- **临时切换配置**：用 `--url` 指定本次连接地址，用 `--key-file` 指定另一份密钥文件。地址选择顺序为命令行、环境变量 `CC_GATEWAY_URL`、已保存地址、内置地址。密钥文件选择顺序为命令行、`CC_A_KEY_FILE`、默认文件。
- **工作区被拒绝**：请选择具体项目目录，并将密钥放在工作区外。默认位置为 macOS/Linux 的 `~/.config/cc-a/access.key`，或 Windows 的 `%LOCALAPPDATA%\cc-a\access.key`。用 `config set-key` 保存时，客户端会设置文件权限。
- **查询用量**：B 管理员可在[管理控制台](https://8.153.176.226/admin/)按 A 密钥查看请求数和 token 用量。

运行 `claudec --help` 查看命令选项。工具清单、平台差异和测试命令见[工具与跨平台验收说明](GATEWAY.md)。
