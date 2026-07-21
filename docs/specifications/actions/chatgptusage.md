# ChatGPT Usage 功能与技术规范

状态：持续维护
最后代码核对：2026-07-19
action key：`chatgptusage`
UUID：`com.ulanzi.ulanzistudio.lexutility.chatgptusage`

**变更门槛：修改 ChatGPT Usage 的业务模块、manifest、Inspector、图标、设置、状态、I/O、持久化、交互、渲染或测试契约前，必须先完整阅读本文件；修改完成后，必须在同一次任务中同步必要的功能和技术变化，并更新"最后代码核对"日期。涉及基座时还必须读写 `../base.md`。与 `claudeusage.md` 是姊妹 action，改动其一时应检查另一个是否需要同步。**

## 1. 功能定位

ChatGPT Usage 在单个 DX200 键面上显示 Codex 的限额用量与重置倒计时，视觉与交互结构与 [claudeusage](claudeusage.md) 对称，供两键并排使用。

四层实现：

- manifest：`manifest.json` 的 `ChatGPT Usage`。
- 业务：`plugin/actions/chatgptusage.js`。
- Inspector：`property-inspector/chatgptusage.html`、`chatgptusage.js`。
- 静态图标：`assets/icons/actionChatgptusage.svg`。

### 1.1 命名与语义的已知偏差

键面字样写 **ChatGPT**，但显示的数据是 **Codex 的限额**（`limitId: "codex"`），不是整个 ChatGPT 账户的用量。`planType`（如 `plus`）才是 ChatGPT 订阅层级。这是明确的产品选择——ChatGPT 认知度更高——记录在此以免日后误读数字。

### 1.2 与 claudeusage 的对称与差异

| | claudeusage | chatgptusage |
| --- | --- | --- |
| 取数 | HTTPS GET 只读接口 | spawn `codex app-server` JSON-RPC |
| 凭据 | macOS 钥匙串 | `~/.codex/auth.json` |
| 分级 | 接口给 `severity` | **无此字段，自行按阈值判定** |
| 时间 | ISO 8601 | Unix 秒 |
| 平台 | 仅 macOS | 不设限制 |
| 品牌图形 | Claude 标记（矢量 path） | OpenAI 标记（矢量 path） |
| 默认主题 | `ember` | `mono` |

## 2. 用户功能

- 按设定间隔自动拉取限额，键面按更短间隔本地重绘倒计时。
- 短按立即拉取一次，带最小反馈时长与冷却保护。
- 长按打开 `usageUrl`。
- 限额行按窗口时长排序，短窗口在前；只有一条限额时用剩余空间显示限额重置券张数。
- 拉取失败时按失败原因显示不同标识；已有历史数据时保留上次数值并叠加陈旧标记。

## 3. 取数契约

### 3.1 可执行文件发现

默认 `codex`，按 PATH 解析。**插件进程由 Ulanzi Studio 拉起，其 PATH 未必包含 homebrew 等前缀**，因此在 PATH 之外补一份常见前缀兵库（`/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin` 等）。全部落空则进入 `NO_CLI`，由用户在 Inspector 的 `codexCommand` 里手填绝对路径。

**不做**官方插件那套 `npm root -g` / `npm ls -g` / `pnpm root -g` / `pnpm exec` 的完整发现——那是近百行与业务无关的探测代码，且每次发现都要 spawn 多个包管理器进程。可解释的 `NO_CLI` 加一个可填路径足以覆盖。

### 3.2 登录判定

读 `~/.codex/auth.json`，要求存在且 `tokens.access_token` 非空，否则 `NOT_LOGGED_IN`。**只读，不解析 token 内容、不刷新、不写回。**

先读文件再 spawn：这样"没登录"能在几毫秒内判定并给出准确原因，而不是等一个进程起来再超时。

### 3.3 JSON-RPC 协议

```text
spawn <codex> app-server        stdio: pipe/pipe/pipe, env.TERM 兜底为 dumb
→ {"method":"initialize","id":0,"params":{"clientInfo":{name,title,version}}}
← id:0
→ {"method":"initialized","params":{}}
→ {"method":"account/rateLimits/read","id":1}
← id:1 → result | error
```

逐行读 stdout 解析 JSON，非 JSON 行忽略。无论成功失败都必须 `stdin.end()` + `kill()`，避免留下孤儿进程。超时默认 12 秒。

`app-server` 被 codex 标记为 experimental，协议可能变更——这是已知风险，解析层必须容错并降级为错误态。

### 3.4 响应取值

实测结构（2026-07-19）：

```text
rateLimits.primary   { usedPercent, windowDurationMins, resetsAt }   ← Unix 秒
rateLimits.secondary 同上，或 null
rateLimits.credits   { hasCredits, unlimited, balance }
rateLimits.planType  "plus" 等
rateLimitResetCredits{ availableCount, credits[] }
rateLimitsByLimitId  { <limitId>: {...} }
```

- 优先读 `rateLimitsByLimitId[limitId]`，回退 `rateLimits`。`limitId` 默认 `codex`。
- 百分比取 `usedPercent`，归一化到 0..100 整数。
- 倒计时由 `resetsAt`（**Unix 秒，需 ×1000**）与本地时间差计算。
- 行标签由 `windowDurationMins` 换算：10080 → `W`（周）、300 → `5H`、其余 → `{n}H` / `{n}D`。
- 两条限额都读不出可用百分比时视为失败。

## 4. 设置契约

| 字段 | 默认值 | 合法范围/选项 | 含义 |
| --- | --- | --- | --- |
| `codexCommand` | `codex` | 非空字符串 | 可执行文件名或绝对路径 |
| `limitId` | `codex` | 非空字符串 | 读取哪一组限额 |
| `pollSec` | `300` | 60..3600 秒 | 拉取间隔 |
| `redrawSec` | `30` | 10..300 秒 | 键面本地重绘间隔 |
| `timeoutSec` | `12` | 3..60 秒 | app-server 单次超时 |
| `showSecondary` | `true` | `true` / `false` | secondary 存在时是否占一行 |
| `showResetCredits` | `true` | `true` / `false` | 是否显示重置券张数 |
| `showBarBackground` | `true` | `true` / `false` | 行背景填充式进度条 |
| `severityColors` | `true` | `true` / `false` | 分级配色 |
| `usageUrl` | `https://chatgpt.com/#settings/Usage` | HTTP/HTTPS | 长按打开的地址 |
| `theme` | `mono` | 公共主题 key | 全局外观 |
| `frameSize` | `optimal` | `optimal` / `max` | 安全显示范围 |
| `showFrame` | `true` | `true` / `false` | 是否绘制公共边框 |

`usageUrl` 默认值由使用者提供确认。注意它是 **hash 路由**（`#settings/Usage`），框架的 `normalizeUrl` 会保留 fragment 并在缺 scheme 时补 `https://`——已验证。

## 5. 分级阈值

接口不返回 `severity`，因此完全由本地阈值判定（**已用**百分比口径）：

| 已用 | 级别 | token |
| --- | --- | --- |
| < 75% | normal | `theme.ok` |
| ≥ 75% | warning | `theme.warn` |
| ≥ 90% | critical | `theme.crit` |

同一套阈值**同步应用到 claudeusage 的回退逻辑**（原为 85/95），使两键在同一百分比下呈现同色。注意：claudeusage 在接口提供 `severity` 时仍以官方判断为准，因此两者并非严格同源——这是无法消除的差异，已知并接受。

官方 Codex 插件用的是「剩余」口径的 25/10，等价于已用 75/90，本 action 与之数值一致但口径表述不同。

## 6. 显示态与错误处理

| 态 | 触发 | 键面表现 |
| --- | --- | --- |
| `OK` | 拉取成功 | 正常数据行 |
| `STALE` | 有历史数据，本次失败 | 保留上次数值 + 陈旧点 |
| `NO_CLI` | 找不到可执行文件 | 终端字形 + `No codex` |
| `NOT_LOGGED_IN` | auth.json 缺失或无 token | 钥匙字形 + `codex login` |
| `TIMEOUT` | app-server 超时 | 沙漏字形 + `Timeout` |
| `RPC_ERROR` | JSON-RPC 返回 error 或结构不可解析 | 感叹号 + `Error` |
| `PENDING` | 首次拉取未返回 | 标记 + 占位横线 |

只要曾成功拉取过，任何失败都优先降级为 `STALE`。具体原因写入日志并回显 Inspector 诊断面板。

## 7. 品牌资产

OpenAI 标记，`viewBox="0 0 24 24"` 单 path，取自 simple-icons（收录的是官方标记）。渲染时等比缩放进行1 区域，**固定白色**、不跟随主题——与 claudeusage 的标记固定 `#d97757` 对称处理。

在 `sand` 浅色主题下白色标记不可见，因此该 action 的标记颜色改为：浅色主题（`canvas` 亮度高）取 `theme.text`，其余取白色。

**商标提示**：OpenAI 标记是 OpenAI 的注册商标，此处仅用于指代其产品。自用与开源展示尚可，不得用于商业发行。

## 8. 键面显示

```text
┌──────────────┐
│  ✳ ChatGPT   │  行1：标记 + 字样，下沿为分隔线
├──────────────┤
│ 5H  12%   2h │  行2：短窗口在前（存在时）
│ W   30%   5d │  行3：周限额
│ RESET 3      │  行4：重置券（showResetCredits 且有券时）
└──────────────┘
```

- 行数 1..3，行高等比分配，字号随行数自适应。
- 限额行按 `windowDurationMins` 升序排列，短窗口在前，与 claudeusage 的 `5H`/`W` 顺序一致；接口没有规定 `primary` 一定是长窗口，因此按时长排而不是按字段名，缺时长的排最后。
- 内容箱为 `42..214`，即基座规范的设计箱范围，不额外内缩。
- 数据行为行背景填充式进度条，填充用矩形宽度实现，**禁止 clipPath**。
- 倒计时配色与字号规则与 [claudeusage](claudeusage.md) 完全一致（`m`/`h`/`d` 递进高亮，数字大、单位固定 15px）。
- 重置券行不是限额，不画进度填充（`percent` 传 null），但**底槽跟随 `showBarBackground` 一起保留**——否则这一行比上面少一层背景，在键面上会显得空落落地贴着边。文字用 `theme.muted`。
- 全部内容经 `renderScreenFrame` / `frameContent` 输出，不绕过安全边框。
- 复用 `theme.ok/warn/crit` 语义色（由 claudeusage 那次改动引入）。

## 9. 生命周期

| 钩子 | 行为 |
| --- | --- |
| `createState` | 初始化显示态，水合上次成功数据 |
| `onReady` | 安排拉取与重绘两个定时器；立即首拉 |
| `onRun` | 短按立即拉取，10 秒冷却 |
| `onLongPress` | 打开 `usageUrl`（按平台选 `open` / `start` / `xdg-open`） |
| `onParamFromPlugin` | `__chatgptusageProbe` 控制命令触发诊断并回推 `__chatgptusageDiag` |
| `onSettingsChanged` | 间隔变化重启对应定时器；`codexCommand` / `limitId` 变化立即重拉 |
| `onDispose` | 作废在途请求、杀掉可能仍在运行的子进程、取消定时器、落盘 |
| `render` | 依据 settings + state 纯函数产出 SVG data URL |

定时器 slot：`chatgptusagePoll`、`chatgptusageRedraw`、`chatgptusageFeedback`。

## 10. 持久化

运行态版本 `v: 1`，保存在 `data/action-state.json`：

```text
primary / secondary: { label, percent, resetsAt, windowMins } | null
resetCredits: number | null
planType: string | null
fetchedAt, lastErrorKind
```

仅在语义变化时写盘；同目录临时文件 + rename 替换；版本不符或损坏降级为空并进入 `PENDING`。

## 11. 已覆盖的关键验证

`tests/chatgptusage-action.test.js` 22 条，另有渲染与端到端人工验证（2026-07-19：真实拉取成功，键面 13 个状态渲染正确，与 claudeusage 并排比对行位、字号、填充与倒计时格式完全对齐）。

- `auth.json` 缺失 / 无 tokens / JSON 损坏三种未登录路径。
- JSON-RPC 返回 error、非 JSON 行、超时、进程启动失败。
- `rateLimitsByLimitId` 命中与回退 `rateLimits`。
- `secondary` 为 null / 有值时的行数与标签。
- `windowDurationMins` → 标签换算（10080→W、300→5H、其他）。
- Unix 秒 → 倒计时，含跨天与已过期。
- 阈值 75/90 分级。
- 有历史失败 → `STALE`；无历史失败 → 具体 kind。
- `onDispose` 后无残留定时器与子进程。

## 12. 已知风险

1. `codex app-server` 是 experimental 接口，协议变更会让本 action 失效——容错是硬要求。
2. 每次拉取 spawn 一个进程，比 claudeusage 的 HTTP GET 重；间隔下限锁 60 秒。
3. `secondary` 在当前账户恒为 null，**双行布局无法实机验证**，只能靠构造数据覆盖。
4. OpenAI 标记的商标属性（见 §7）。
