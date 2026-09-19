# Network Speed Test 功能与技术规范

状态：持续维护  
最后代码核对：2026-09-19
action key：`speedtest`  
UUID：`com.ulanzi.ulanzistudio.lexutility.speedtest`

**变更门槛：修改 Network Speed Test 的业务模块、manifest、Inspector、图标、设置、节点/调度、外部依赖、持久化、交互、渲染或测试契约前，必须先完整阅读本文件；修改完成后，必须在同一次任务中同步必要的功能和技术变化，并更新“最后代码核对”日期。涉及基座时还必须读写 `../base.md`。**

## 1. 功能定位

Network Speed Test 调用官方 Ookla Speedtest CLI 测量下载、上传和网络质量，在 DX200 键面显示最近结果与趋势。它支持节点发现、地区筛选、固定节点/按延迟选点、自动测速时段、自动调度暂停、全插件带宽排队、取消、失败重试和 7 天历史。

四层实现：

- manifest：`manifest.json` 的 `Network Speed Test`。
- 注册名称：英文 `Network Speed Test`，简体中文 `网络测速`。
- 业务：`plugin/actions/speedtest.js`。
- Inspector：`property-inspector/speedtest.html`、`speedtest.js`。
- 静态图标：`assets/icons/actionSpeedtest.svg`。

## 2. 前置条件与外部依赖

- 用户必须自行下载、安装官方 Ookla `speedtest` 可执行文件，并在首次运行时接受其许可/GDPR 条款；插件不代为下载、安装或接受条款。
- 查找顺序：用户 `cliPath`、`/opt/homebrew/bin/speedtest`、`/usr/local/bin/speedtest`、当前 `PATH`。
- 测速命令：`speedtest --format=json --progress=no`；有选定节点时追加 `--server-id=<id>`。
- 节点目录优先请求 `https://www.speedtest.net/api/js/servers`。不带 `search` 的请求只按出口 IP 就近返回，从大陆看海外几乎只剩台湾/香港；大陆节点在该接口上几乎搜不到（`Beijing` 返回 0），只能靠就近列表。因此**按当前 `scope` 拉取**：就近列表（30）加上该区域的固定国家名搜索词（见 §5 区域表），每个搜索词的 `limit` 为 `clamp(floor(70 / 词数), 5, 30)`，总量控制在 100 条缓存上限内。请求并发上限 4，单个搜索词失败重试一次；各列表轮流取一条合并、按 ID 去重，再按国家、城市排序；单个搜索词最终失败不影响其他地区。目录整体失败时回退 CLI `--servers --format=json`。
- 可选 GeoIP 通过 DNS 和 `ipwho.is` 补充 IP 实际位置；失败只跳过增强，不阻止测速。
- 线路自动判定同样用 `ipwho.is` 查一次出口 IP（CLI `interface.externalIp`）的国家码；出口 IP 只在进程内存缓存，不进 result、不进任何持久化结构。

## 3. 用户功能与交互

- 键面单击：发起一次手动测速；手动测速不受自动测速活动窗口限制，窗口外按下也立即执行一次。
- 排队、测速或节点发现期间再次单击：取消当前实例的排队/运行任务。
- 键面双击：切换自动测速暂停状态。由于基座要求第一次短按立即执行，进入暂停时第二次短按会取消第一次短按刚发起或原本正在运行的任务；恢复自动测速时保留第一次短按发起的手动测速。
- 键面长按：使用系统默认浏览器打开 `https://www.speedtest.net/`；不修改测速历史、节点或调度设置。
- Inspector 可立即测速、重新获取节点、搜索/筛选节点和清除当前实例历史。
- 不勾节点：候选池是当前区域全部节点；勾选 2 个及以上：候选池是所选节点。两种情况每次测速前都按延迟选点（见 §5），和 speedtest.net 网页一致。
- 勾选 1 个节点：固定使用该节点，不探测。
- 勾选的节点全都不在当前区域时，退回该区域的缓存节点；不允许空池让 CLI 无视区域自动选点。
- 自动调度支持每 15/30/60 分钟或仅手动，并可限制自动测速时段；默认时段为 08:00 至次日 01:00。
- 失败后除 `CLI`、`LICENSE` 外最多在 60 秒后重试一次；重试前清除当日粘性节点（只影响探测失败时的每日随机退路）。

## 4. 设置契约

| 字段 | 默认值 | 合法范围/选项 | 含义 |
| --- | --- | --- | --- |
| `title` | `Network Speed` | 最长 14 字符 | 共享标题设置，当前动态键面不直接显示；与宿主 action 名称分离 |
| `subtitle` | `Mainland` | 最长 18 字符 | 共享副标题设置，当前动态键面不直接显示 |
| `theme` | `signal` | 公共主题 key | 全局外观 |
| `frameSize` | `optimal` | `optimal` / `max` | 安全显示范围 |
| `showFrame` | `true` | `true` / `false` | 是否绘制公共边框 |
| `scope` | `china` | `any` / `china` / `japankorea` / `southeastasia` / `europe` / `useast` / `uswest` / `canada` / `oceania` | 节点区域，见 §5 区域表；旧值 `mainland` / `overseas` 归一化为默认 `china` |
| `intervalMin` | `30` | `15` / `30` / `60` / `manual` | 自动测速间隔 |
| `activeAllDay` | `false` | 字符串布尔值 | 是否忽略活动起止时间 |
| `activeStart` | `08:00` | 合法 24 小时时间 | 活动窗口起点 |
| `activeEnd` | `01:00` | 合法 24 小时时间 | 自动测速时段终点；早于起点时表示次日，支持跨午夜 |
| `timeoutSec` | `180` | `120` / `180` / `240` / `300` | CLI 硬超时 |
| `candidateServers` | `[]` | 最多 100 个净化后的节点对象 | 用户勾选的节点池 |
| `chartType` | `line` | `line` / `bar` | 下载/上传历史图表 |
| `geoIpEnabled` | `true` | 字符串布尔值 | 是否补充 IP 实际位置；关闭时线路自动判定也失去出口国家，只能给出“无法判定” |
| `proxyMode` | `auto` | `auto` / `direct` / `proxy` | 线路：auto 按每次结果自动判定，direct / proxy 为用户手动声明 |
| `cliPath` | 空 | 最长 300 字符 | 自定义 CLI 路径 |

`serverSearch` 是 Inspector 本地筛选字段，不进入设置或自动保存。

## 5. 节点发现与选择

- 区域表（`SPEEDTEST_REGIONS` / `SPEEDTEST_REGION_RULES`，Inspector 持有逐字相同的规则表副本，由测试锁定一致）：

| scope | 键面代号 | 国家/地区代码与经度界限 | 目录搜索词 |
| --- | --- | --- | --- |
| `any` | `GLOBAL` | 不筛选 | China、Hong Kong、Taiwan、Japan、Korea、Singapore、United States、United Kingdom、Germany、Australia |
| `china` | `CHINA` | CN、HK、MO、TW | China、Hong Kong、Macau、Taiwan |
| `japankorea` | `JP·KR` | JP、KR | Japan、Korea |
| `southeastasia` | `SE ASIA` | SG、MY、TH、VN、PH、ID | 同左国家名 |
| `europe` | `EUROPE` | GB、IE、DE、FR、NL、BE、LU、ES、PT、IT、CH、AT、SE、NO、DK、FI、PL、CZ | United Kingdom、Germany、France、Netherlands、Spain、Italy、Switzerland、Sweden、Poland |
| `useast` | `US EAST` | US，经度 > -100 | New York、Chicago、Dallas、Atlanta、Miami、Houston |
| `uswest` | `US WEST` | US，经度 ≤ -100 | Los Angeles、Seattle、Denver、Phoenix、Salt Lake、San Jose |
| `canada` | `CANADA` | CA | Canada、Toronto、Vancouver、Montreal |
| `oceania` | `OCEANIA` | AU、NZ | Australia、New Zealand |

  键面代号最长 8 字符；缩写只用 ISO 代码，不用带政治含义的简称。CLI 回退列表可能没有 `countryCode`，国家名为 China/中国 等写法时按 CN 处理。美东/美西以西经 100° 为界（达拉斯归东、丹佛归西），依赖官方目录的 `lon`；没有坐标的美国节点（CLI 回退）两边都不进，只在 `any` 出现。`Washington` 搜索词命中华盛顿州，不能用作美东搜索词。
- 节点缓存有效期 24 小时；空缓存、过期缓存、旧 GeoIP 结构、缓存记录的 `serverCacheScope` 与当前 scope 不同，或当前 scope 无候选时需要发现。切换 scope 会绕过 10 分钟退避直接重新发现；仅改勾选不绕过。
- 自动发现失败后 10 分钟退避；用户“重新获取节点”会绕过退避。
- 只对当前候选前 12 个节点做 GeoIP 增强，控制网络开销。
- GeoIP 缓存有效期 30 天；官方节点城市/国家保留，IP 位置使用独立字段，不覆盖官方位置。
- 筛选按区域表的国家代码；未归入任何大区的国家只在 `any` 里出现；`any` 不筛选。
- 选点流程（`selectSpeedtestServer`，在排他任务内执行）：
  1. 历史反馈剔除：候选里 24 小时内有成功结果、且下行不到池内最好成绩 1/10 的节点先剔除（只比同一池，不设绝对阈值）；剔除会清空池时不剔除。
  2. 剩 1 个直接用；≥2 个对每个节点串行请求 `http://<host>[:8080]/hi` 3 次（节点间并发 4，单次超时 3 秒），取均值作延迟；一次失败即停止采样、剩余按超时计价；全部失败为不可达。用均值而非最小值是为了把抖动算进去。
  3. 选延迟最低的可达节点；全部不可达（如 `/hi` 被拦）退回每日随机（`chooseSpeedtestServer`：先随机国家/地区再随机节点，当天粘性）。
  4. 依据（2026-09-19 真机）：勾选多个大陆节点时每日随机抽到苏州 JSQY(16204)，一整天下行 0.4–0.77 Mbps；同一分钟上海电信(3633) 131 Mbps。JSQY 的 `/hi` 延迟约三成时间尖峰到 290 ms、其余与 3633 相当，单靠延迟探测仍会周期性选中它，所以叠加历史反馈。
- 加坐标之前保存的勾选没有 `lat`/`lon`（为 `null`），`speedtestCandidates` 按 ID 从缓存补坐标后再做区域筛选，不要求用户重新勾选。
- 当日随机状态由 `dailyServerId + dailyServerDate` 持久化；只有一个候选时不写粘性选择。

## 6. 调度、排队与取消

测速和节点发现共用排他资源 `network-bandwidth`，所有实例串行执行。同一实例对同资源重复请求会复用现有任务。

- phase：`idle`、`queued`、`running`、`discovering`、`error`。
- 自动调度以持久化的 `nextDueAt` 为准。
- `autoPaused=true` 时清除 `speedtestSchedule`、`speedtestRetry` 和 `nextDueAt`，不触发自动测速；手动测速仍可使用。恢复后从当前时间重新计算下一次计划。
- 首次或过期启动不会立刻造成带宽尖峰，而是在未来 30..90 秒随机抖动后执行。
- 定时器若因睡眠等原因晚触发超过 5 秒，不补跑旧任务，重新安排 30..90 秒后的新任务。
- 每次生成或恢复 `nextDueAt` 时立即校验活动窗口；候选时间落在窗口外就直接收敛到下一次 `activeStart`，不先持久化无效时间再等定时器触发后改期。起止相同视为全天，跨午夜窗口受支持。
- 活动窗口只约束自动调度；键面单击与 Inspector“立即测速”均绕过窗口限制。
- interval 为 manual 时清空 `nextDueAt`。
- 取消会通过 `AbortSignal` 终止 CLI/任务，并清理硬超时定时器。

定时器 slot：`speedtestSchedule`、`speedtestRetry`、`speedtestHardTimeout`。

## 7. 结果、错误与持久化

CLI JSON 转换为：

- `downloadMbps`、`uploadMbps`：从 bytes/s × 8 转为 Mbps，保留两位小数。
- `pingMs`、`jitterMs`、`packetLoss`、`dataBytes`。
- 服务端 ID、host、名称、城市、国家和 IP；不保存客户端公网 IP。
- `viaVpn`（仅运行态）：CLI `interface.isVpn === true` 或接口名匹配 `utun|tun|tap|wg|ppp`。Clash TUN 下实测 isVpn=true、接口 utun5、内网 198.18.0.1。
- `viaProxy`：`true` / `false` / `null`。规则：没走 VPN/TUN 接口 → `false`；走了且出口国家码非 CN → `true`；走了但出口国家未知 → `null`。TUN 接管全部路由时走 DIRECT 规则的国内流量同样经 utun 出去，所以不能只看 isVpn。
- `exitCountryCode`：出口 IP 的国家码（最长 3 字符），随历史持久化；出口 IP 本身不保存。旧记录缺字段时 `viaProxy` 归一为 `null`。
- 节点对象另含官方目录的 `lat` / `lon`（数字，缺失为 `null`），由基座 `sanitizeServerList` 净化；目前只有本 action 使用。

错误码：

| 错误码 | 语义 |
| --- | --- |
| `CLI` | 未找到可执行文件 |
| `LICENSE` | 许可/GDPR 尚未接受 |
| `NODE` | 节点或 server ID 无效 |
| `TIMEOUT` | CLI 超过配置硬超时 |
| `NET` | 其他网络或执行错误 |

运行态版本为 `version: 2`，保存 7 天内最多 672 条 history、最后成功结果、完成时间、下一次计划、自动测速暂停状态、每日节点选择、节点缓存、节点缓存时间、节点缓存所属 scope（`serverCacheScope`，旧状态缺省为空）和 GeoIP 缓存。成功与失败都进入历史；清除历史同时清空最后结果和错误显示，但保留节点缓存与调度。

每次测速完成/失败、调度变化、节点刷新和 dispose 时 flush。状态损坏或旧字段会经净化降级。

## 8. 生命周期与 Inspector 回传

| 钩子 | 行为 |
| --- | --- |
| `createState` | 初始化 phase、排队和重试字段，并水合历史/调度/节点缓存 |
| `onReady` | 初始化调度、回传 Inspector runtime、按需发现节点 |
| `onRun` | 空闲时测速；忙碌时取消 |
| `onDoublePress` | 切换自动测速暂停状态；进入暂停时取消当前带宽任务 |
| `onLongPress` | 使用系统默认浏览器打开 Speedtest 官网 |
| `onSettingsChanged` | scope/候选变化清除每日选择并发现（scope 变化强制发现）；调度字段变化重排 |
| `onParamFromPlugin` | 处理刷新节点、确保节点、立即测速、清历史 |
| `onDispose` | 同步 flush 当前状态；框架取消队列任务 |
| `render` | 生成速度与趋势 SVG data URL |

插件通过 `speedtestRuntime` JSON 回传 phase、错误、排队位置、最近结果、最近 12 个历史点、节点缓存、CLI 可用性、`nextDueAt`、`autoPaused`、`proxyState`（`proxy` / `direct` / 空）和 `exitCountryCode`。`proxyState` 由 `speedtestProxyState` 计算：`proxyMode` 为手动值时直接用它，auto 时取最近一次成功结果的 `viaProxy`。Inspector 状态区显示“线路：经代理 · 出口 US / 直连 / 线路无法判定”。Inspector 用它渲染状态与节点列表；它不是持久化设置字段。

## 9. 键面显示

- 标题行左侧是区域代号（见 §5 区域表，如 `CHINA` / `EUROPE` / `SE ASIA`），右侧是上次测速距今多久（`now` / `>15m` / `>1h` / `>3d`）。
  时间戳用 `>` 前缀而不是 ` ago` 后缀：短 3 个字符，8 字符的区域全称才放得下；
  刻度本来就是向下取整的，`>15m` 字面意思正好等于它的真实含义。天数封顶 99 以约束宽度。
  曾经把区域缩成 `CN` / `INTL` 来腾地方，但这类简写带政治含义，不能为了排版采用。
- 排队、测速、发现或错误时，带底色的状态块替代区域：`QUEUE n`、`TESTING`、`NODES` 或错误码；
  错误用 `#ef4444` 红底以区别于 accent 色的进行中状态。此时右侧时间让位，否则会被色块盖住。
- 自动测速暂停且无更高优先级运行态时，标题行显示 `PAUSED` 状态块；Inspector 状态区显示“自动测速已暂停”。
- 上下两条速度带分别是下载 `↓`、上传 `↑`：数值右对齐到同一条基线，右侧是固定的 `Mbps` 单位列，
  图表以最近最多 12 个成功样本作为背景层（折线带面积填充，或柱状），压在数值下方。
- 图表无论样本数多少都铺满同一宽度，x 轴随样本数动态分配；单点折线以圆点表示。
- 忙碌态不画内框线（会压住首字母），改由状态色块表达；旧结果降低不透明度但仍可参考。
- 相对时间由每分钟一次的重绘节拍保持新鲜，否则两次测速之间标签会停在测完那一刻。
- 线路标志：下载带顶部右侧（y 72–86）一个 14 高的小标签，`PROXY` 用强调色实底、`DIRECT` 只描边；`proxyState` 为空时不画。那一带只有图表背景（数值基线 120、字高 46，顶到 86 左右；标题行在 60 以上），是键面上唯一放得下标签的位置。简体中文键面显示“代理”/“直连”。

## 10. 已覆盖的关键验证

- Mbps 转换且不保留 client IP。
- 7 天/672 条裁剪、活动窗口、跨午夜，以及候选计划时间越过窗口终点时立即改期。
- 窗口外的手动按键仍立即发起一次测速。
- 各区域筛选、勾选节点覆盖、缺坐标勾选补坐标、勾选全部出区域时退回缓存池；固定节点、延迟探测（均值/提前停止/不可达）、历史反馈剔除、探测全失败退回每日随机；每日随机先按国家再按节点抽取。
- 目录发现按 scope 选择搜索词、每词限量、去重、排序、并发上限、单词重试与单地区失败容错；缓存 scope 不符触发重发现。
- Inspector 国家表与插件逐字一致，下拉选项与 `SPEEDTEST_REGIONS` 键一一对应；键面区域代号不超过 8 字符。
- 官方目录映射、缓存过期判断与 GeoIP 不覆盖官方位置。
- 不同样本数下图表宽度与默认产品契约。
- 双击暂停/恢复自动测速、暂停时取消当前任务并持久化；长按的平台浏览器启动参数。
- 键面渲染：数值右对齐与单位列、相对时间四档格式与让位规则、状态色块与无内框线、区域代号映射。
- Inspector 的调度、节点选择、图表、即时测速和空列表请求。
- 线路：`viaVpn` 解析、`resolveSpeedtestProxy` 三态判定、`speedtestProxyState` 手动优先、键面标签位置与显隐、历史保留判定但不含出口 IP、`proxyMode` 默认值与归一化、Inspector 持久化与状态区文案。

修改 CLI 参数、错误分类、节点数据模型、调度/队列或状态版本时，应同步本文件并扩充 `tests/speedtest-action.test.js`；修改 Inspector runtime 或控制命令时还应更新 `tests/inspector-lifecycle.test.js`。

## 多语言契约

- Inspector 默认英文；静态文案使用 `data-localize`，自定义控制器通过共享 helper 处理 `uiLanguage`、权威设置回读和语言切换。
- 测速阶段、节点模式、即时测速状态和键面运行态文案按实例 `uiLanguage` 翻译；简体中文界面的 `China` 选项及键面全部区域代号保留英文（`GLOBAL` 译为“不限”）；日韩、东南亚、欧洲、美国东部/西部、加拿大、大洋洲选项使用中文。测速值、服务器名称、地区代码和外部错误详情保持原始数据；唯一例外是节点清单里的国家名：China 区域内 CN / HK / MO / TW 分别显示为 Mainland / Hong Kong / Macao / Taiwan（简体中文：大陆 / 香港 / 澳门 / 台湾），四地对等，大陆节点不显示 China 与香港并列；其他区域（Any 等）统一显示 China Mainland / China Hong Kong / China Macao / China Taiwan（中国大陆 / 中国香港 / 中国澳门 / 中国台湾），港澳台不单独出现；其他国家沿用目录原始国家名。
- `en.json` 与 `zh_CN.json` 的 action 名称/说明顺序必须与 manifest 一致，新增键由 `tests/i18n.test.js` 锁定覆盖。
- 用户可见注册名称固定为英文 `Network Speed Test`、简体中文 `网络测速`。
