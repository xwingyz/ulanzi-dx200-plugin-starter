# Claude Usage 功能与技术规范

状态：持续维护
最后代码核对：2026-07-28
action key：`claudeusage`
UUID：`com.ulanzi.ulanzistudio.lexutility.claudeusage`

**变更门槛：修改 Claude Usage 的业务模块、manifest、Inspector、图标、设置、状态、I/O、持久化、交互、渲染或测试契约前，必须先完整阅读本文件；修改完成后，必须在同一次任务中同步必要的功能和技术变化，并更新"最后代码核对"日期。涉及基座时还必须读写 `../base.md`。**

## 1. 功能定位

Claude Usage 在单个 DX200 键面上同时显示 Claude 订阅额度的 5 小时滚动限额、每周限额、以及（存在时）按模型划分的周限额，附带各自的重置倒计时。取数走只读接口，本身不消耗任何额度。

四层实现：

- manifest：`manifest.json` 的 `Claude Usage`。
- 业务：`plugin/actions/claudeusage.js`。
- Inspector：`property-inspector/claudeusage.html`、`claudeusage.js`。
- 静态图标：`assets/icons/actionClaudeusage.svg`。

**仅支持 macOS。** 凭据只从 macOS 钥匙串读取，非 mac 平台直接进入 `UNSUPPORTED` 显示态。插件级 `manifest.OS` 保持双平台不变，平台限制在 action 内部判定。

## 2. 用户功能

- 按设定间隔自动拉取额度，键面按更短的间隔本地重绘倒计时。
- 短按松开（正常态）：先亮起刷新角标、百分比暂置为 `...`，触发一次凭据刷新（见 §3.1）后立即拉取，带冷却保护；拉回后 `...` 换成新值。
- 短按松开（需要登录时）：不刷新，直接打开交互式 claude 终端让用户登录（见 §8 `openClaudeCli`）。
- 双击：打开交互式 claude 终端（`onDoublePress`）。与登出态单击共用同一入口，2 秒冷却去重避免双击开出两个窗口。
- 按住至少 600ms 显示反色确认，松开后打开官方用量页面。
- 三行数据按窗口时长排序，短窗口在前（5H → W → 模型周限）。
- 拉取失败时按失败原因显示不同的错误标识；已有历史数据时保留上次数值并叠加陈旧标记。**登出（`NO_TOKEN`）例外**：不显示陈旧数字，整块换成 Sign in 登录提示（见 §5）。

## 3. 取数契约

### 3.1 凭据

```text
security find-generic-password -s "Claude Code-credentials" -a <当前用户> -w
→ JSON.claudeAiOauth.accessToken
```

读取时**不写回钥匙串**。`accessToken` 生命周期约 1 小时；被动路径（自动轮询与 GET 拉取）只读取，读到即用、读不到即报错，不做任何刷新。

**主动刷新（仅短按触发，非轮询）**：`accessToken` 过期后若用户长时间不用 Claude Code，CLI 不会自行刷新，键面会一直停在过期 → `AUTH`/`STALE`。短按时后台跑一次

```text
claude -p "ping" --model haiku --max-turns 1   （cwd=临时目录，stdio 丢弃，45s 超时）
```

让 **CLI 自己**用 `refreshToken` 刷新钥匙串凭据（凭据生命周期仍归 CLI 管，插件从不写钥匙串、也从不直接用 `refreshToken` 换新），顺带真实消耗极小一点额度来「激活」。锁死 `haiku` 把消耗压到最小，`--max-turns 1` 杜绝工具循环。刷新为尽力而为：CLI 找不到 / 超时 / 非零退出都不抛，照常继续拉取（旧 token 也许仍可用，不行就照常降级 `STALE`）。

**未登录短路**：先读钥匙串判定 `accessToken` / `refreshToken` 是否双双为空（登出时二者清空，只剩 `scopes`、`subscriptionType` 等残留元数据）。皆空即视为 CLI 未登录，**直接跳过 spawn** 返回 `NOT_LOGGED_IN`，不浪费一次进程与额度——因为 `claude -p` 未登录时只打印 `Not logged in` 却仍以 0 退出，无法据退出码识别。随后的 GET 拉取会照常给出 `NO_TOKEN` / “Sign in”。注意 `accessToken` 过期时其字符串仍在（可被 CLI 刷新），故「任一存在」即值得尝试刷新，只有整串凭据皆空才是真正登出。

### 3.2 接口

```text
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <accessToken>
anthropic-beta: oauth-2025-04-20
```

这是非公开接口，Anthropic 可能随时变更结构。解析层必须容错：字段缺失或类型不符时降级为错误态，绝不抛出到框架兜底。

### 3.3 响应取值

| 显示行 | 首选来源 | 回退来源 |
| --- | --- | --- |
| `W` | `limits[]` 中 `kind === 'weekly_all'` | `seven_day` |
| `5H` | `limits[]` 中 `kind === 'session'` | `five_hour` |
| `W?` | `limits[]` 中 `kind === 'weekly_scoped'` | 无（不显示该行） |

- 百分比取 `percent`（`limits[]`）或 `utilization`（顶层对象），统一归一化到 0..100 整数。
- 倒计时由 `resets_at`（ISO 8601）与本地时间差计算，**不依赖任何额外请求**。
- `weekly_scoped` 存在即显示，不看 `is_active`；同时存在多条时取 `percent` 最高的一条。
- 第四行标签为 `W` + `scope.model.display_name` 首字母大写（Fable → `WF`，Opus → `WO`）；取不到模型名时退化为 `W*`。
- 接口不返回绝对额度值（`limit_dollars` 等恒为 `null`），因此**只显示利用率百分比，不显示任何绝对配额数字**。

## 4. 设置契约

| 字段 | 默认值 | 合法范围/选项 | 含义 |
| --- | --- | --- | --- |
| `pollSec` | `300` | 60..3600 秒 | 网络拉取间隔 |
| `redrawSec` | `30` | 10..300 秒 | 键面本地重绘间隔 |
| `showWeekly` | `true` | `true` / `false` | 显示每周限额行 |
| `showFiveHour` | `true` | `true` / `false` | 显示 5 小时限额行 |
| `showScoped` | `true` | `true` / `false` | 存在时显示按模型周限额行 |
| `showBarBackground` | `true` | `true` / `false` | 行背景填充式进度条 |
| `severityColors` | `true` | `true` / `false` | 按 severity 着色；关闭则统一用 accent |
| `usageUrl` | `https://claude.ai/settings/usage` | HTTP/HTTPS | 长按打开的地址 |
| `theme` | `ember` | 公共主题 key | 全局外观 |
| `frameSize` | `optimal` | `optimal` / `max` | 安全显示范围 |
| `showFrame` | `true` | `true` / `false` | 是否绘制公共边框 |

Inspector 采用 400ms 自动保存，开关与主题按钮立即提交，并提供恢复默认。

`pollSec` 下限锁 60 秒：该接口对未认证请求即返回 429，高频轮询有被限流的实际风险。

## 5. 显示态与错误处理

| 态 | 触发 | 键面表现 |
| --- | --- | --- |
| `OK` | 拉取成功 | 正常数据行 |
| 刷新中 | `instance.refreshing`（短按刷新期间） | 百分比置为 `...`（倒计时不变）+ 右上角循环箭头角标 |
| `STALE` | 有历史数据，本次拉取失败（`NO_TOKEN` 除外） | 保留上次数值 + 右上角失败原因角标（AUTH/NO_TOKEN 用 crit，其余 warn） |
| 需要登录 | `displayState==='NO_TOKEN'` 或 `lastErrorKind==='NO_TOKEN'` | 钥匙图标 + `Sign in`；**即便有陈旧数据也不显示旧百分比**，不叠陈旧角标；单击直接打开 CLI 登录 |
| `AUTH` | HTTP 401 / 403 且无历史 | 感叹号 + `Re-auth` |
| `NETWORK` | 请求异常 / 超时且无历史 | 断线图标 + `Offline` |
| `RATE_LIMITED` | HTTP 429 且无历史 | 沙漏图标 + `Slow down` |
| `PENDING` | 首次拉取尚未返回 | 标记 + 占位横线 |
| `UNSUPPORTED` | 非 macOS | 标记 + `macOS only` |

只要曾成功拉取过，任何失败都优先降级为 `STALE` 而非错误页——额度不使用就不会上涨，陈旧值仍然有参考价值。**唯一例外是登出（`NO_TOKEN`）**：没有 token 就拉不到新值，继续显示旧百分比只会误导，因此 `needsLogin` 优先于陈旧数据，整块换成登录提示。`AUTH` 不算「需要登录」——token 可能只是过期、可被短按刷新恢复，仍走陈旧数字 + 角标。失败的**具体原因**始终写入日志并回显到 Inspector 诊断面板。

## 6. 品牌标记

Claude 官方标记，`viewBox="0 0 24 24"` 单 path，取自 simple-icons（收录的是官方标记）。渲染时等比缩放到 38px，位置与 [chatgptusage](chatgptusage.md) 的 OpenAI 标记完全对称。

固定品牌色 `#d97757`，**不跟随主题**——它是身份标识而非装饰，随主题变色即失效。以命名 token（`BRAND_CLAUDE`）定义，不在渲染代码里散落硬编码。

标记是静态的，不随 severity 变化；键面也不画 critical 内框（外框与显示范围一律由 `showFrame` / `frameSize` 配置决定，action 不主动加框）。这意味着**分级预警只有颜色一条通道**——`sunset` 与 `forest` 两套主题下 `crit`/`ok` 与 `accent` 同色系，区分度弱，目前没有非颜色的补充信号。

**商标提示**：该标记是 Anthropic 的商标，此处仅用于指代其产品。自用与开源展示尚可，不得用于商业发行。

## 7. 键面显示

```text
┌──────────────┐
│  ✳ Claude    │  行1：标记 + 字样，下沿为分隔线
├──────────────┤
│ 5H  57%   2h │  行2：5 小时限额（短窗口在前）
│ W   66%   1d │  行3：每周限额
│ WF  75%   1d │  行4（条件）：按模型的周限额
└──────────────┘
```

- 行1 下沿的分隔线横贯内容箱，与 chatgptusage 同位置。
- 标记尺寸（38px）与 chatgptusage 的 OpenAI 标记一致，两键并排时视觉重量对等。
- 内容箱为 `42..214`，即基座规范的设计箱范围，不额外内缩。
- 数据行按窗口时长排序，短窗口在前：`5H` → `W` → `W?`。
- 倒计时按临近程度递进高亮：`m` 用 `theme.text`（最亮）、`h` 用 `muted`、`d` 用 `low`（最暗），`now` 同 `m`。**方向不能反**——短倒计时是好消息（额度快恢复），因此绝不套用 `warn`/`crit`，否则会与同一行百分比的红黄撞成同一种「紧急」暗示。
- 数字与单位分属不同字号：数字随行高自适应（`fontSize × 1.26`），`%` 与 `d/h/m` 固定 15px。
- 数据行为**行背景填充式**进度条：整行背景按百分比横向填充，文字叠加其上。填充区文字需加深描边或降低填充不透明度以保证对比度。`showBarBackground` 关闭时仅保留文字。
- 数据行 2..3 行，行高等比分配，字号随行数自适应。
- 背景填充与告警色一律走 theme token，**禁止 clipPath**（宿主渲染器支持不可靠），用矩形宽度实现填充。
- 全部内容经 `renderScreenFrame(..., frame)` 或 `frameContent(frame, inner)` 输出，不绕过安全边框。

### 7.1 主题语义色扩展（前置基础设施）

当前 9 套主题只有 `accent / canvas / panel / shell / text / muted / low / contrast`，没有告警语义色，无法表达 severity。本 action 依赖以下扩展，**必须先于 action 实现单独完成**：

- 为 `mint`、`ember`、`mono`、`signal`、`neon`、`ice`、`sunset`、`forest`、`sand` 各增加 `ok` / `warn` / `crit` 三个 token，按各自色调调和。
- 业务插件与 `template/` **两份同步**。
- **不进 `THEME_SWATCHES`**：色卡只展示 canvas / panel / low / accent / text 五个角色，语义色不参与其中。
- 由 `tests/inspector-bridge.test.js` 三条测试锁定：两份各自的 token 合法性与三色互异、以及 `THEMES` 在两份之间完全一致。

状态：**已完成**（2026-07-19）。sunset 的 accent 本身是玫红、forest 的 accent 本身是绿，这两套主题下 crit / ok 与 accent 同色系，颜色区分度弱；标记为静态矢量且不画 critical 内框，因此这两套主题下分级预警没有非颜色的补充信号。

severity 映射：`normal → ok`，`warning → warn`，`critical → crit`。`severity` 字段缺失时按已用百分比回退：**≥75% warning、≥90% critical**。

该阈值与 [chatgptusage](chatgptusage.md) 共用——那个 action 的接口不返回 `severity`，只能靠阈值判定，两键并排时同一百分比必须呈现同一颜色。注意本 action 在 `severity` 字段存在时仍以官方判断为准，因此两者并非严格同源，这是无法消除的差异。

## 8. 生命周期

| 钩子 | 行为 |
| --- | --- |
| `createState` | 初始化显示态，水合上次成功数据 |
| `onReady` | 安排拉取与重绘两个独立定时器；无历史时立即首拉 |
| `onRun` | 短按：需要登录时 `openClaudeCli`；否则亮刷新角标（百分比→`...`）→ 跑一次凭据刷新（见 §3.1，未登录则跳过）→ 立即拉取，10 秒冷却 |
| `onDoublePress` | `openClaudeCli`：打开交互式 claude 终端；2 秒冷却去重 |
| `onLongPress` | 打开 `usageUrl` |
| `onParamFromPlugin` | 收到 `__claudeusageProbe` 控制命令时跑一次诊断并回推 `__claudeusageDiag` |
| `onSettingsChanged` | 间隔变化重启对应定时器；其余仅触发重绘 |
| `onDispose` | 取消在途请求与两个定时器，落盘当前运行态 |
| `render` | 依据 settings + state 纯函数产出 SVG data URL |

定时器 slot：`claudeusagePoll`（网络拉取）、`claudeusageRedraw`（本地重绘）。

`onRun` / `onLongPress` 为异步时必须 return Promise。

**双击的框架语义**：框架在第一拍即执行 `onRun`，双击窗口（默认 300ms）内的第二拍再补派 `onDoublePress`（见 [base.md](../base.md) 派发逻辑）。故正常态双击会先跑一次刷新再开 CLI（可接受，与 bambustatus 同构）；登出态双击第一拍 `onRun` 已开 CLI，第二拍 `onDoublePress` 由 `openClaudeCli` 的 2 秒冷却吞掉，不会开出第二个窗口。

`openClaudeCli`：写一个临时 `.command`（内容 `exec "<claude 绝对路径>"`）用系统 `open` 拉起，走 LaunchServices 打开交互式 claude 终端——刻意不用 `osascript` 控制 Terminal，避免 Automation 授权这一失败面。未登录时交互式 claude 会自行引导登录，故「登录」与「打开 CLI」共用同一入口。

长按打开网页、打开 CLI 均走系统 `open` 命令而非 SDK：桥接层只有 `send` / `sendParamFromPlugin` / `setBaseDataIcon` / `toast`，`openurl` 是宿主→插件方向的命令，**插件没有主动打开 URL 的通道**。该 action 本就仅支持 macOS，且已经要 spawn `security` 读钥匙串，`open` 属同类系统调用。

`usageUrl` 默认值 `https://claude.ai/settings/usage` 已实测：会重定向到 `claude.ai/new#settings/usage` 并打开设置内的 Usage 面板，其中 Current session / All models / <模型名> 三行恰好对应本 action 的 `5H` / `W` / `W?`。

## 9. 持久化

运行态版本 `v: 1`，保存在 `data/action-state.json`：

```text
lastSuccess: { weekly, fiveHour, scoped, fetchedAt }
  其中每项: { percent, severity, resetsAt, label }
lastErrorKind
```

- 仅在数据语义变化时写盘，不按对象引用判断。
- 写盘走同目录临时文件 + rename 替换。
- 版本不符或内容损坏时降级为空，进入 `PENDING` 而非报错。
- 历史是增益不是前置条件。

## 10. 已覆盖的关键验证

`tests/claudeusage-action.test.js` 19 条，另有渲染与端到端人工验证（2026-07-19：真实拉取成功，键面 15 个状态全部渲染正确，数值与 claude.ai 设置内 Usage 面板逐行对应）。

- 钥匙串缺失 / JSON 损坏 / 无 `claudeAiOauth` 三种凭据异常。
- 响应缺字段、`limits[]` 为空、`utilization` 非数值时的容错降级。
- `weekly_scoped` 存在 / 缺失 / 多条并存时的行数与标签生成。
- 401 有历史 → `STALE`；401 无历史 → `AUTH`。
- 倒计时跨天、跨零、已过期（显示 `now`）。
- severity 缺失时的百分比回退阈值。
- 品牌标记固定色，不随主题变化。
- 拉取与重绘两个定时器互不干扰；`onDispose` 后无残留定时器与在途请求。
- 非 macOS 进入 `UNSUPPORTED` 且不执行任何 spawn。
- 主题语义色两份一致性（并入既有主题一致性测试）。

## 11. 已知风险

1. `/api/oauth/usage` 非公开，结构变更会静默失效——解析层容错是硬要求，不是可选项。
2. 官方标记属于 Anthropic 商标，仅用于指代其产品，不得商业发行。
3. 本 action 同时承载多错误态与完整可配 PI，复杂度明显高于 latency。单文件超过约 700 行时按规则第 9 节拆为 `plugin/actions/claudeusage/` 下的 `state.js` / `render.js` / `service.js`，由该目录的 `index.js` 统一对外暴露。

## 多语言契约

- Inspector 默认英文；静态文案使用 `data-localize`，自定义控制器通过共享 helper 处理 `uiLanguage`、权威设置回读和语言切换。
- 诊断、凭据、加载、配额和错误状态按实例 `uiLanguage` 翻译；账户标识、用量数值、时间和服务端错误详情保持原始数据。
- `en.json` 与 `zh_CN.json` 的 action 名称/说明顺序必须与 manifest 一致，新增键由 `tests/i18n.test.js` 锁定覆盖。
