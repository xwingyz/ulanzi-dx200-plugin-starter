# Network Speed 功能与技术规范

状态：持续维护  
最后代码核对：2026-07-18  
action key：`speedtest`  
UUID：`com.ulanzi.ulanzistudio.lexutility.speedtest`

**变更门槛：修改 Network Speed 的业务模块、manifest、Inspector、图标、设置、节点/调度、外部依赖、持久化、交互、渲染或测试契约前，必须先完整阅读本文件；修改完成后，必须在同一次任务中同步必要的功能和技术变化，并更新“最后代码核对”日期。涉及基座时还必须读写 `../base.md`。**

## 1. 功能定位

Network Speed 调用官方 Ookla Speedtest CLI 测量下载、上传和网络质量，在 DX200 键面显示最近结果与趋势。它支持节点发现、地区筛选、固定/每日随机节点、活动时段调度、全插件带宽排队、取消、失败重试和 7 天历史。

四层实现：

- manifest：`manifest.json` 的 `Network Speed`。
- 业务：`plugin/actions/speedtest.js`。
- Inspector：`property-inspector/speedtest.html`、`speedtest.js`。
- 静态图标：`assets/icons/actionSpeedtest.svg`。

## 2. 前置条件与外部依赖

- 必须安装官方 Ookla `speedtest` 可执行文件，并接受其许可/GDPR 条款。
- 查找顺序：用户 `cliPath`、`/opt/homebrew/bin/speedtest`、`/usr/local/bin/speedtest`、当前 `PATH`。
- 测速命令：`speedtest --format=json --progress=no`；有选定节点时追加 `--server-id=<id>`。
- 节点目录优先请求 `https://www.speedtest.net/api/js/servers`，同时查询 China 与通用列表并按 ID 去重；目录失败时回退 CLI `--servers --format=json`。
- 可选 GeoIP 通过 DNS 和 `ipwho.is` 补充 IP 实际位置；失败只跳过增强，不阻止测速。

## 3. 用户功能与交互

- 键面单击：发起一次手动测速。
- 排队、测速或节点发现期间再次单击：取消当前实例的排队/运行任务。
- Inspector 可立即测速、重新获取节点、搜索/筛选节点和清除当前实例历史。
- 不勾节点：在当前区域全部候选中每日随机一个。
- 勾选 1 个节点：固定使用该节点。
- 勾选 2 个及以上：每天在所选节点中随机一个，当天保持粘性。
- 自动调度支持每 15/30/60 分钟或仅手动，并可限制活动时间段。
- 失败后除 `CLI`、`LICENSE` 外最多在 60 秒后重试一次；重试前清除当日粘性节点以争取换节点。

## 4. 设置契约

| 字段 | 默认值 | 合法范围/选项 | 含义 |
| --- | --- | --- | --- |
| `title` | `Network Speed` | 最长 14 字符 | 共享标题设置，当前动态键面不直接显示 |
| `subtitle` | `Mainland` | 最长 18 字符 | 共享副标题设置，当前动态键面不直接显示 |
| `theme` | `signal` | 公共主题 key | 全局外观 |
| `frameSize` | `optimal` | `optimal` / `max` | 安全显示范围 |
| `showFrame` | `true` | `true` / `false` | 是否绘制公共边框 |
| `scope` | `mainland` | `any` / `mainland` / `overseas` | 节点区域；海外含港澳台 |
| `intervalMin` | `30` | `15` / `30` / `60` / `manual` | 自动测速间隔 |
| `activeAllDay` | `false` | 字符串布尔值 | 是否忽略活动起止时间 |
| `activeStart` | `08:00` | 合法 24 小时时间 | 活动窗口起点 |
| `activeEnd` | `23:00` | 合法 24 小时时间 | 活动窗口终点；支持跨午夜 |
| `timeoutSec` | `180` | `120` / `180` / `240` / `300` | CLI 硬超时 |
| `candidateServers` | `[]` | 最多 100 个净化后的节点对象 | 用户勾选的节点池 |
| `chartType` | `line` | `line` / `bar` | 下载/上传历史图表 |
| `geoIpEnabled` | `true` | 字符串布尔值 | 是否补充 IP 实际位置 |
| `cliPath` | 空 | 最长 300 字符 | 自定义 CLI 路径 |

`serverSearch` 是 Inspector 本地筛选字段，不进入设置或自动保存。

## 5. 节点发现与选择

- 节点缓存有效期 24 小时；空缓存、过期缓存、旧 GeoIP 结构或当前 scope 无候选时需要发现。
- 自动发现失败后 10 分钟退避；用户“重新获取节点”会绕过退避。
- 只对当前候选前 12 个节点做 GeoIP 增强，控制网络开销。
- GeoIP 缓存有效期 30 天；官方节点城市/国家保留，IP 位置使用独立字段，不覆盖官方位置。
- `scope=mainland` 只保留 CN/中国大陆；`overseas` 取其补集；`any` 不筛选。
- 当日随机状态由 `dailyServerId + dailyServerDate` 持久化；只有一个候选时不写粘性选择。

## 6. 调度、排队与取消

测速和节点发现共用排他资源 `network-bandwidth`，所有实例串行执行。同一实例对同资源重复请求会复用现有任务。

- phase：`idle`、`queued`、`running`、`discovering`、`error`。
- 自动调度以持久化的 `nextDueAt` 为准。
- 首次或过期启动不会立刻造成带宽尖峰，而是在未来 30..90 秒随机抖动后执行。
- 定时器若因睡眠等原因晚触发超过 5 秒，不补跑旧任务，重新安排 30..90 秒后的新任务。
- 活动窗口外触发时，推迟到下一次 `activeStart`；起止相同视为全天，跨午夜窗口受支持。
- interval 为 manual 时清空 `nextDueAt`。
- 取消会通过 `AbortSignal` 终止 CLI/任务，并清理硬超时定时器。

定时器 slot：`speedtestSchedule`、`speedtestRetry`、`speedtestHardTimeout`。

## 7. 结果、错误与持久化

CLI JSON 转换为：

- `downloadMbps`、`uploadMbps`：从 bytes/s × 8 转为 Mbps，保留两位小数。
- `pingMs`、`jitterMs`、`packetLoss`、`dataBytes`。
- 服务端 ID、host、名称、城市、国家和 IP；不保存客户端公网 IP。

错误码：

| 错误码 | 语义 |
| --- | --- |
| `CLI` | 未找到可执行文件 |
| `LICENSE` | 许可/GDPR 尚未接受 |
| `NODE` | 节点或 server ID 无效 |
| `TIMEOUT` | CLI 超过配置硬超时 |
| `NET` | 其他网络或执行错误 |

运行态版本为 `version: 1`，保存 7 天内最多 672 条 history、最后成功结果、完成时间、下一次计划、每日节点选择、节点缓存、节点缓存时间和 GeoIP 缓存。成功与失败都进入历史；清除历史同时清空最后结果和错误显示，但保留节点缓存与调度。

每次测速完成/失败、调度变化、节点刷新和 dispose 时 flush。状态损坏或旧字段会经净化降级。

## 8. 生命周期与 Inspector 回传

| 钩子 | 行为 |
| --- | --- |
| `createState` | 初始化 phase、排队和重试字段，并水合历史/调度/节点缓存 |
| `onReady` | 初始化调度、回传 Inspector runtime、按需发现节点 |
| `onRun` | 空闲时测速；忙碌时取消 |
| `onSettingsChanged` | scope/候选变化清除每日选择并发现；调度字段变化重排 |
| `onParamFromPlugin` | 处理刷新节点、确保节点、立即测速、清历史 |
| `onDispose` | 同步 flush 当前状态；框架取消队列任务 |
| `render` | 生成速度与趋势 SVG data URL |

插件通过 `speedtestRuntime` JSON 回传 phase、错误、排队位置、最近结果、最近 12 个历史点、节点缓存、CLI 可用性和 `nextDueAt`。Inspector 用它渲染状态与节点列表；它不是持久化设置字段。

## 9. 键面显示

- 标题行左侧是区域 `MAINLAND` / `OVERSEAS` / `GLOBAL`，右侧是上次测速距今多久（`now` / `>15m` / `>1h` / `>3d`）。
  时间戳用 `>` 前缀而不是 ` ago` 后缀：短 3 个字符，8 字符的区域全称才放得下；
  刻度本来就是向下取整的，`>15m` 字面意思正好等于它的真实含义。天数封顶 99 以约束宽度。
  曾经把区域缩成 `CN` / `INTL` 来腾地方，但这类简写带政治含义，不能为了排版采用。
- 排队、测速、发现或错误时，带底色的状态块替代区域：`QUEUE n`、`TESTING`、`NODES` 或错误码；
  错误用 `#ef4444` 红底以区别于 accent 色的进行中状态。此时右侧时间让位，否则会被色块盖住。
- 上下两条速度带分别是下载 `↓`、上传 `↑`：数值右对齐到同一条基线，右侧是固定的 `Mbps` 单位列，
  图表以最近最多 12 个成功样本作为背景层（折线带面积填充，或柱状），压在数值下方。
- 图表无论样本数多少都铺满同一宽度，x 轴随样本数动态分配；单点折线以圆点表示。
- 忙碌态不画内框线（会压住首字母），改由状态色块表达；旧结果降低不透明度但仍可参考。
- 相对时间由每分钟一次的重绘节拍保持新鲜，否则两次测速之间标签会停在测完那一刻。

## 10. 已覆盖的关键验证

- Mbps 转换且不保留 client IP。
- 7 天/672 条裁剪、活动窗口与跨午夜。
- 地区筛选、勾选节点覆盖、固定/每日随机选择。
- 官方目录映射、缓存过期判断与 GeoIP 不覆盖官方位置。
- 不同样本数下图表宽度与默认产品契约。
- 键面渲染：数值右对齐与单位列、相对时间四档格式与让位规则、状态色块与无内框线、区域代号映射。
- Inspector 的调度、节点选择、图表、即时测速和空列表请求。

修改 CLI 参数、错误分类、节点数据模型、调度/队列或状态版本时，应同步本文件并扩充 `tests/speedtest-action.test.js`；修改 Inspector runtime 或控制命令时还应更新 `tests/inspector-lifecycle.test.js`。
