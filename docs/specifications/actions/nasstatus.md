# Synology NAS Status 功能与技术规范

状态：首版已实现；API 链路已在 DS923+（DSM 7.3.2-86009）真机验证在线态，键面三态待实机复核  
最后代码核对：2026-07-22  
action key：`nasstatus`  
UUID：`com.ulanzi.ulanzistudio.lexutility.nasstatus`

**变更门槛：修改 Synology NAS Status 的业务模块、manifest、Inspector、图标、设置、状态、I/O、持久化、交互、渲染或测试契约前，必须先完整阅读本文件；涉及基座时还必须读写 `../base.md`。**

## 1. 功能定位与边界

Synology NAS Status 是 Lex Utility 内的一键一机只读监控 action：通过 DSM Web API 轮询一台群晖 NAS 的在线状态、系统温度与指定卷的容量占用。只读，不发送任何控制、休眠、关机或唤醒命令（明确不做 WOL）。

四层实现：

- manifest：`manifest.json` 的 `Synology NAS Status`。
- 业务：`plugin/actions/nasstatus.js`。
- Inspector：`property-inspector/nasstatus.html`、`nasstatus.js`。
- 静态图标：`assets/icons/actionNasstatus.svg`。

账号边界：用户自建**免 2FA 的低权限专用账号**。存储卷数据来自存储管理器 API，若该账号无权访问，测试连接与运行态都必须显示明确的权限错误，不得引导提权或静默降级。

## 2. 用户功能

- 一个实例绑定一台 NAS；显示机器名（显示名 > API hostname > 型号）、系统温度（含历史图表）、最多两个卷的容量（背景进度条 + 已用/总量 + 百分比）。键面最多 3 行：温度行 + 至多两个存储行。
- 三态语义：**在线**（正常取数）/ **离线**（TCP 超时或拒连；不自称"关机"，插件无法证明关机）/ **异常**（能连通但认证失败、权限不足或 API 报错——必须与离线可区分，避免排查错方向）。
- 短按：立即刷新（带冷却，刷新中显示角标反馈）。
- 长按：用系统浏览器打开 DSM 管理页（URL 由地址 + 端口 + 协议拼出，不单独配置）。
- Inspector「测试连接」：用当前表单值（无需先保存）登录并拉取卷列表，回填卷下拉框；默认选中第一个卷。

## 3. DSM Web API 契约

全部经 HTTP(S) GET，走 `node:http` / `node:https`（HTTPS 允许自签证书 `rejectUnauthorized: false`；局域网场景下"加密但不验证书"是明确接受的取舍）。凭据（用户名/密码）明文保存在本机 action 设置中，与 bambustatus 的 Access Code 同一先例；日志、SVG、诊断回传不得包含密码与 sid。

请求序列（已按 DSM 7.3.2 实机校准，2026-07-22）：

1. `GET /webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth,SYNO.DSM.Info` — 发现 auth/dsm 的 path 与版本区间。**存储接口不走预发现**：DSM 7.3 未登录的 API.Info 不再暴露它。
2. `GET /webapi/<auth.path>?api=SYNO.API.Auth&version=<min(6,max)>&method=login&account=..&passwd=..&session=LexNasStatus&format=sid` — 登录取 `sid`。
3. `GET /webapi/<dsm.path>?api=SYNO.DSM.Info&version=<min(2,max)>&method=getinfo&_sid=..` — `model`、`temperature`、`temperature_warn`。**DSM 7.3 不再返回 `hostname`**：为空时尽力调 `SYNO.FileStation.Info`（entry.cgi v2 `get`）兜底取 `hostname`，失败忽略（render 侧还可退型号）。
4. 存储双名盲调 `entry.cgi` version 1 `method=load_info`：先试点号新名 `SYNO.Storage.CGI.Storage`（DSM 7.3 实名），返回 102 再回退下划线旧名 `SYNO.Storage.CGI_Storage`；命中的名字缓存进会话。返回 `volumes[]`（`id`、`size.total`、`size.used`、`status`），解析后按 id 数值序排序（DSM 返回顺序不稳定，实测 volume_2 会排前）。两名皆 102 判「接口异常」。

DSM 7.3.2 实机事实（DS923+，非管理员账号）：`SYNO.DSM.Info` 与点号存储接口均可由普通 users 组账号调用，无需 administrators；`SYNO.Core.System` 也可用（`sys_temp`），保留为候选不使用。

会话管理：

- 登录一次复用 `sid`（仅内存，不落盘）；收到会话失效错误码（105/106/107/119）时重登一次再重试本轮，仍失败按认证异常处理。
- `onDispose` 尽力而为发一次 `method=logout`，失败忽略。
- 错误分类：请求层失败（超时/拒连/DNS）→ `OFFLINE`；HTTP 通但 `success:false` → `ERROR`（按错误码细分认证失败/权限不足/接口异常）；HTTP 非 2xx → `ERROR`。

## 4. 设置契约

| 字段 | 默认值 | 合法范围/选项 | 含义 |
| --- | --- | --- | --- |
| `displayName` | 空 | 字符串，最长 40 | 显示名覆盖；留空用 API hostname |
| `nasHost` | 空 | IPv4 / 主机名，最长 253 | NAS 地址 |
| `nasPort` | `5001` | 1–65535 | DSM 端口 |
| `useHttps` | `true` | `true` / `false` | HTTPS 开关（允许自签） |
| `username` | 空 | 字符串，最长 64 | 专用低权限账号 |
| `password` | 空 | 字符串，最长 128 | 明文本机保存 |
| `volumeId` | 空 | 字符串，最长 32 | 卷 1 的 id（如 `volume_1`）；空 = 第一个卷 |
| `volumeId2` | 空 | 字符串，最长 32 | 卷 2 的 id；空 = 不显示第二行；与卷 1 相同则去重 |
| `tempChart` | `line` | `line` / `bars` | 温度历史图表样式（折线默认 / 柱状） |
| `pollSec` | `60` | 15–3600 | 轮询间隔（秒） |
| `theme` | `mint` | 公共主题 key | 键面主题 |
| `frameSize` | `optimal` | `optimal` / `max` | 安全显示范围 |
| `showFrame` | `true` | `true` / `false` | 是否显示公共边框 |

配置完整判定：`nasHost`、`username`、`password` 三者非空。

## 5. 轮询与退避

- 在线：按 `pollSec`（默认 60s）轮询。
- 失败（离线或异常）：指数退避 60s → 120s，**封顶 120s**；恢复成功后回到 `pollSec`。
- 短按手动刷新：5s 冷却；冷却内忽略。刷新期间 `refreshing` 置真并渲染刷新角标。
- 全部定时器走框架实例定时器 API；`onDispose` 清理。

## 6. 键面显示

```text
┌──────────────┐
│Synology xwing│  头部：Synology 官方 wordmark（矢量，基线 59）+ 机器名 16px 亮色右对齐（截 9 字符，避开 wordmark）
│[🌡]DS923+ 78°│  行1：温度——行面板背景画温度历史图表（折线默认/柱状可选）+
│              │       温度计图标 + 型号 15px 左置(x=78) + 温度数值 22px 右对齐(x=200，不贴边)
│[💾]41% 6.5T/1│  行2：卷 1——按百分比背景填充 + 硬盘图标 +
│              │       百分比 13px 左置(x=78) + 已用/总量 18px 右对齐(x=212)
│[💾]0%  3.1G/1│  行3：卷 2（可选，settings.volumeId2）
└──────────────┘
```

- 行布局对齐 systemstatus：行区间 80..214、gap 6、行数 2（单卷）或 3（双卷）均分行高，行面板 `x=44 w=170 rx=7`（panel 填充 + low 描边）、图标 x=54。
- 机器名在头部右上角（`theme.text` 亮色、16px、右锚 214，wordmark 收在 x≈122 前互不重叠，截 9 字符）。
- 型号与温度同一行：型号在前（左置 x=78、muted 15px），温度数值在后（右对齐 x=200、22px，留出面板内边距不贴边）。
- 温度历史：每次取数成功追加内存数组（上限 24 点，与 systemstatus `HISTORY_LIMIT` 对齐，不持久化），画在温度行面板内；纵轴刻度 `max(90, 峰值)`；折线含面积底纹，柱状 0.28 透明度，几何与 systemstatus `renderMetricHistory` 同构（各自持有）。
- 温度分级：`temperatureSeverity` —— **>75°C `warn`、≥90°C `crit`**，DSM `temperature_warn` 兜底强制至少 warn；图标与图表恒取分级色，数值仅在告警/危险档改色（常温保持正文色）。
- 容量填充色按用量分级：≥90% `crit`、≥80% `warn`、其余 `accent`；已用/总量为主文字（18px、右对齐 x=212、同温度改色规则），百分比为 muted 小字（13px、左置 x=78，紧跟硬盘图标）。填充为行面板内的矩形宽度（禁 clipPath）。
- 容量单位二进制换算，`T`/`G` 一位小数（如 `6.5T/15.7T`）。
- 刷新反馈：wordmark 左侧的圆形高亮（systemstatus 同款样式）。
- `OFFLINE`：键面置灰语义——名称保留，主区显示「离线」（muted），底部显示最后成功更新的相对时间。
- `ERROR`：主区显示「异常」（crit）+ 原因短语（认证失败 / 权限不足 / 接口异常），并画 `frameHighlight` crit 内框。
- `CONFIG_REQUIRED`：显示「待配置」；`PENDING`（配置完整、首轮取数中）：显示「连接中」。
- 全部内容经公共安全框与主题渲染能力输出。
- Synology wordmark 为固定身份元素（本地矢量，取自 simple-icons 收录的官方标记）；商标仅用于指代设备，个人自用；若插件公开发布需替换为通用 NAS 图标。

## 7. 生命周期与资源隔离

| 钩子 | 行为 |
| --- | --- |
| `createState` | 水合持久化的 hostname/model/lastSeenAt（缺失降级为空），初始化会话与退避计数 |
| `onReady` | 配置完整则启动首轮取数与轮询；不完整显示待配置 |
| `onRun` | 短按手动刷新（5s 冷却） |
| `onLongPress` | 打开 DSM 管理页（macOS `open`；其余平台跳过） |
| `onSettingsChanged` | 连接字段变化→清空会话、重置退避、立即重取；`volumeId`/`pollSec` 变化→重渲染/重排定时器 |
| `onParamFromPlugin` | 处理 `__nasstatusProbe`（测试连接）并以 `__nasstatusProbeResult` 回推卷列表与诊断 |
| `onDispose` | 清定时器、尽力 logout、flush 运行态 |
| `render` | 纯函数：settings + state → SVG data URL |

## 8. 运行态持久化

版本 `v: 1`，写 `data/action-state.json`：`{ v, hostname, model, lastSeenAt }`。只在 hostname/model 身份变化时落盘，`onDispose` 再 flush 一次（捕获最终 `lastSeenAt`）。卷容量与温度不持久化——重启后旧值无参考意义。缺失/损坏降级为空。

## 9. 错误语义

- 配置缺失：`CONFIG_REQUIRED`，键面「待配置」。
- 网络层失败（超时/拒连/DNS）：`OFFLINE`，退避重试。
- 认证失败（登录错误码 400 = 账号不存在或密码错，及重登后仍失败）：`ERROR` / 「认证失败」。
- 权限不足（登录码 401/402/403/404/406/407 = 账号无 DSM 登录权限、被禁用、需/未配置 2FA、被封锁；存储 API 105）：`ERROR` / 「权限不足」。402 实测出现在「新 NAS 上账号存在、密码对，但未授权登录 DSM」的场景——归权限而非认证，避免误导用户查密码。
- 其余 API 错误或响应损坏：`ERROR` / 「接口异常」。
- Inspector 测试连接回传的诊断只含错误类别与提示文案，不含凭据。
- 任一实例异常不得影响其他 action。

## 10. 完成与验收

- manifest、action 模块、Inspector、图标四层齐全并完成注册；本文档与 `base.md` 生产清单、`README.md` 索引同步。
- 专项测试 `tests/nasstatus-action.test.js` 覆盖：API 响应解析（info/login/dsm/storage）、错误分类三态、卷选择、容量格式化、退避序列、短按冷却、长按 URL 拼装、各显示态渲染结构；`testing` 导出全部加 `nas` 前缀防撞。
- 根目录 `npm test` 全绿。
- `restart` 同步宿主后实机验证：在线渲染、拔线/停 DSM 的离线态、错密码的异常态、测试连接回填卷下拉。
