# dsh-obu-loader

面向 **Windows + DeepSeek Harness 0.1.1-rc.2** 的按会话、按需 Open Browser Use 加载器。

插件启动时只注册轻量 `/obu` 命令。用户在某个 DSH 会话执行 `/obu` 后，它才会为当前 Agent 启动独立的 `open-browser-use mcp` 子进程、注册 MCP 浏览器工具，并注入 Open Browser Use Skill。不同 Agent 使用不同的浏览器 session id 和 MCP 工具命名空间。

## 它如何工作

```text
/obu
  → dsh-obu-loader
  → 当前 Agent 的动态 Cordis Fiber
  → @deepseek-ai/dsh-mcp-client
  → open-browser-use mcp --session-id dsh-obu-<agent-id>
  → 本机 OBU socket / Native Host / Chrome 扩展
  → 用户当前 Chrome
```

这个仓库只提供 DSH 集成层，不包含 Chrome 扩展、OBU CLI、浏览器账号或配对数据。

## 当前支持范围

- Windows 10/11
- Node.js 20 或更高版本
- DeepSeek Harness `0.1.1-rc.2`
- Open Browser Use CLI 与对应 Chrome 扩展

其他系统尚未作为本项目的发布目标验证。

## 新电脑安装

### 1. 安装并配置 Open Browser Use

```powershell
npm install -g open-browser-use
open-browser-use setup
```

按照 Chrome 打开的页面安装或启用 Open Browser Use 扩展，并允许必要的 Chrome 提示。然后验证：

```powershell
open-browser-use version
open-browser-use ping --session-id installation-test
open-browser-use user-tabs --session-id installation-test
```

`ping` 应返回 `pong`，`user-tabs` 应能列出当前 Chrome 标签页。

### 2. 从 GitHub 安装 DSH 插件

仓库发布后，把下面的 `<owner>` 换成 GitHub 用户名：

```powershell
dsh plugin --profile web add github:Horo-33/dsh-obu-loader#v0.1.0
```

也可以安装主分支，但稳定迁移更推荐版本标签：

```powershell
dsh plugin --profile web add github:Horo-33/dsh-obu-loader
```

GitHub 依赖包含已经编译的 `lib/`，正常安装不需要在目标电脑重新编译 TypeScript。

安装后需要重启 DSH Web，再硬刷新浏览器页面。

### 3. 在 DSH 中验证

在任意会话输入：

```text
/obu
/obu status
```

成功时应看到：

- 状态为 `active`
- 独立的 Browser session id
- `mcp__obu_...` 工具前缀
- 可见 MCP 工具数量大于 0

完成浏览器工作后：

```text
/obu off
```

## Windows 命令自动发现

默认不写死用户名或绝对路径。插件按以下顺序寻找 `open-browser-use.exe`：

1. `%LOCALAPPDATA%\OpenBrowserUse\native-host\open-browser-use.exe`
2. `npm_config_prefix` / `NPM_CONFIG_PREFIX` 指向的全局 npm 目录
3. 默认 `%APPDATA%\npm\node_modules\open-browser-use\native\windows-amd64\open-browser-use.exe`
4. ARM64 Windows 对应 `windows-arm64` 目录
5. PATH 中真实的 `obu.exe` / `open-browser-use.exe`（不使用 `.cmd` shim）

如果使用自定义安装位置，可在 DSH profile 的插件配置中指定：

```yaml
- id: obu-loader
  name: dsh-obu-loader
  config:
    command: 'C:/Tools/OpenBrowserUse/open-browser-use.exe'
    baseArgs: [mcp]
```

不要把某台电脑的用户名路径提交到公开仓库。

## 使用命令

```text
/obu          # 启用，等同 /obu on
/obu on       # 当前会话启动 OBU MCP，并注入 Skill
/obu status   # 查看状态、browser session、工具前缀和工具数
/obu off      # finalize-tabs 后卸载 MCP、工具和 Skill
```

## 可选配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `command` | Windows 自动发现 | 自定义 OBU 原生 exe 路径 |
| `baseArgs` | `[mcp]` | MCP 子命令及固定前置参数 |
| `browser` | 未设置 | 可选 browser selector，如 `chrome` |
| `profile` | 未设置 | 可选 Chrome profile，如 `Default` |
| `socketDir` | 未设置 | 可选 socket registry 目录，通常无需设置 |
| `toolCallTimeoutMs` | `60000` | MCP 单工具调用超时 |
| `finalizeTimeoutMs` | `15000` | `finalize-tabs` 最长等待时间；超时后通过 DSH subprocess seam 终止整个进程树 |
| `failOnStartupError` | `true` | MCP 初始化失败时回滚激活 |
| `reconnect` | 内置指数退避 | MCP 断线重连设置 |
| `skillPath` | 包内 Skill | 仅用于开发时覆盖 Skill 路径 |

如果一台电脑存在多个 Chrome profile，可以固定目标：

```yaml
- id: obu-loader
  name: dsh-obu-loader
  config:
    browser: chrome
    profile: Default
```

## 从源码开发

```powershell
git clone https://github.com/Horo-33/dsh-obu-loader.git
cd dsh-obu-loader
pnpm install --frozen-lockfile
pnpm run check
npm pack --dry-run
```

本地安装测试：

```powershell
dsh plugin --profile web add .
```

相对路径由 DSH CLI 锚定到当前目录。安装或更新 Host 插件后需要重启 DSH。

## 发布前检查

```powershell
pnpm run check
npm pack --dry-run
git status --short
```

确认 npm 包只包含：

- `lib/`
- `skills/`
- `cordis.patch.yml`
- `README.md`
- `LICENSE`
- `package.json`

以下内容不会发布，也不应提交 Git：

- `node_modules/`
- `.env*`
- 日志文件
- 浏览器数据
- OBU socket、Cookie、Token 或账号信息

## 生命周期与安全

- 同一 Agent 的 start/stop 操作严格串行；重复 `/obu` 幂等，重复 `/obu off` 共享唯一 stop Promise。
- Agent 在 `starting` 阶段销毁或执行 `/obu off` 会取消激活，并等待已创建 Fiber 清理完成。
- `/obu off` 会先执行带超时的 `finalize-tabs --keep []`，无论 finalize 成功、失败或超时都关闭 MCP Fiber；超时走 DSH `ctx.subprocess` 的进程树终止 fallback。
- finalize 子进程使用 DSH 0.1.1-rc.2 公开 subprocess seam 的脱敏父环境，不隐式继承 `DSH_*` 或凭据形环境变量。
- Agent 销毁时会 best-effort 清理对应的 OBU browser session。
- Skill 明确禁止读取 Cookie、密码和无关浏览数据。
- 上传文件、剪贴板、提交表单、购买、删除或发送等外部可见操作仍需用户明确许可。

## 常见问题

### `/obu` 提示找不到 Open Browser Use

重新执行：

```powershell
npm install -g open-browser-use
open-browser-use setup
```

然后检查：

```powershell
Test-Path "$env:LOCALAPPDATA\OpenBrowserUse\native-host\open-browser-use.exe"
open-browser-use ping --session-id repair-test
```

### Chrome 扩展与 CLI 版本不匹配

更新 CLI 后重新运行 setup，并按提示更新扩展：

```powershell
npm update -g open-browser-use
open-browser-use setup
```

### `/obu status` 中工具数量为 0

先确认 Chrome 正在运行、扩展已启用，且 `open-browser-use ping` 返回 `pong`。然后执行 `/obu off`，再执行 `/obu` 重试。

## License

MIT
