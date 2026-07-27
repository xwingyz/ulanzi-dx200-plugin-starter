# Web Latency Monitor 功能与技术规范

状态：持续维护  
最后代码核对：2026-07-27
action key：`latency`  
UUID：`com.ulanzi.ulanzistudio.lexutility.latency`

**变更门槛：修改 Latency 的业务模块、manifest、Inspector、图标、设置、状态、I/O、持久化、交互、渲染或测试契约前，必须先完整阅读本文件；修改完成后，必须在同一次任务中同步必要的功能和技术变化，并更新“最后代码核对”日期。涉及基座时还必须读写 `../base.md`。**

## 1. 功能定位

Web Latency Monitor 持续探测一个 HTTP/HTTPS URL，在 DX200 键面显示当前首跳响应延迟、在线状态、最近趋势、实际观测期 uptime、p95 和 HTTPS 证书到期提醒。它是轻量 Web 可用性监控，不下载响应正文，也不把宿主关闭期间推算为正常或故障。

四层实现：

- manifest：`manifest.json` 的 `Web Latency Monitor`。
- 注册名称：英文 `Web Latency Monitor`，简体中文 `网站延迟监测`。
- 业务：`plugin/actions/latency.js`。
- Inspector：`property-inspector/latency.html`、`latency.js`。
- 静态图标：`assets/icons/actionLatency.svg`。

## 2. 用户功能

- 按设定间隔自动探测 URL。
- 单击松开后立即刷新；Pause 中单击只执行一次手动探测，完成后仍保持暂停。
- 300ms 内双击切换 Pause / 恢复。运行中双击会使第一次单击发起的在途结果失效；Pause 中双击恢复轮询，并复用第一次单击仍在途的探测。
- 按住至少 600ms 时显示反色确认，松开后用系统默认浏览器打开配置的原始 URL；不改变暂停状态、监测历史或当前探测。
- 跟随最多 3 次 HTTP 重定向，以最终状态码判定可用性。
- 延迟口径为第一跳从请求开始到响应头到达的耗时；收到响应头后立即断连，不下载正文。
- HTTPS 使用禁用 TLS session cache 的专用 agent，保持冷连接口径并可靠读取首跳证书。
- 显示最近 24 个样本的柱状或折线趋势。
- 以 5 分钟桶聚合最多 24 小时实际观测，显示 uptime 和偏保守的 p95。
- SSL 健康时显示绿色 `SSL` 标识；进入提醒天数后显示剩余天数，7 天内或过期转红。

## 3. 设置契约

| 字段 | 默认值 | 合法范围/选项 | 含义 |
| --- | --- | --- | --- |
| `url` | `https://example.com` | 仅 HTTP/HTTPS；无 scheme 时补 `https://`，显式非 HTTP scheme 回退默认值 | 探测与长按打开的原始目标 |
| `intervalSec` | `30` | 3..3600 秒 | 自动探测间隔 |
| `warnMs` | `800` | 50..10000 ms | 超过后状态为 `slow` |
| `timeoutMs` | `8000` | 500..30000 ms | 一次完整重定向链总超时 |
| `sslWarnDays` | `30` | 1..365 天 | SSL 倒计时提醒阈值 |
| `theme` | `signal` | 公共主题 key | 全局外观 |
| `frameSize` | `optimal` | `optimal` / `max` | 安全显示范围 |
| `showFrame` | `true` | `true` / `false` | 是否绘制公共边框 |
| `graphMode` | `bars` | `bars` / `line` | 最近样本图表形式 |

Inspector 采用 400ms 自动保存，图表与主题按钮立即提交，并提供恢复默认。通用显示配置在本 action 中使用面向用户的 `Display range` / `Keep margins`（中文“显示范围”/“保留边距”），底层字段与 `optimal` / `max` 语义不变。

## 4. 探测与判定

单跳使用 GET，请求头为轻量通用客户端。每跳共享同一个截止时间，重定向目标必须继续是 HTTP/HTTPS。

结果判定：

- 最终状态码 200..399：`ok`。
- 网络异常、超时、非法 URL/重定向、超过重定向上限、最终失败状态：`down`。
- `ok` 且延迟大于 `warnMs`：`slow`。
- `ok` 且未越阈值：`up`。
- 探测中：`checking`；暂停：`paused`。

只保存首跳延迟和首跳证书；最终状态码只负责可用性判定。`requestId` 与实例存在性共同阻止已取消或旧请求提交结果。

## 5. 统计与持久化

运行态版本为 `v: 1`，保存在 `data/action-state.json`：

```text
paused
buckets[]: { t, ok, fail, bins[17] }
recent[]: { t, ok, ms }
certExpiresAt
```

- 统计窗口为 24 小时，5 分钟一桶，最多 288 桶。
- 延迟直方图有 17 个固定分箱；p95 取命中分箱上沿，避免低报。
- uptime 分母只包含实际完成的探测。`observedMs` 按有样本的桶数计算，标签如 `40m 97.5%`。
- 真实失败存在时，显示值最多 99.9%，不会四舍五入成 100%。
- `recent` 只保留最近 24 个、且仍在 24 小时窗口内的样本。
- 新桶产生时批量落盘；当前桶由 `onDispose` 补 flush。
- URL 改变代表监控对象改变，立即清空历史、证书和已持久化运行态；间隔、阈值、超时或主题变化不清空同目标历史。
- 版本不符或内容损坏时降级为空历史。

## 6. 生命周期

| 钩子 | 行为 |
| --- | --- |
| `createState` | 初始化检查状态，并水合 pause、统计桶、最近样本和证书 |
| `onReady` | Pause 时不调度；否则安排下次探测，无最近样本时立即首探 |
| `onRun` | 单击立即探测；Pause 中只探测一次且不恢复轮询 |
| `onDoublePress` | 切换 Pause；进入时作废在途探测，退出时复用第一次单击的探测或立即首探 |
| `onLongPress` | 用系统默认浏览器打开配置的原始 HTTP/HTTPS URL |
| `onSettingsChanged` | URL 变化清历史；URL、间隔或超时变化重启探测调度 |
| `onDispose` | 同步写入当前运行态 |
| `render` | 生成当前状态 SVG data URL |

定时器 slot：`latency`（轮询）、`latencyFeedback`（手动刷新最小反馈时长）、`latencyOpenError`（浏览器打开失败后约 1.2 秒恢复键面）。

系统休眠期间不会按错过的 30 秒周期累计探测。恢复后，休眠前到期的 `latency` 回调由基座等待稳定窗口并错峰执行一次；结果提交后重新从当前时刻安排下一周期。恢复窗口内同一键位的检查态和结果态由基座合帧，避免宿主连续重绘整个设备画面。

默认浏览器启动使用无 shell 的平台命令：macOS 为 `/usr/bin/open`，Windows 为 `rundll32.exe url.dll,FileProtocolHandler`。URL 无效、scheme 不受支持或进程启动失败时，由框架错误边界写日志并显示 `ERR`，约 1.2 秒后恢复原监测画面。

## 7. 键面显示

- 顶部：状态圆点与短状态词；英文统一为 `UP` / `SLOW` / `DOWN` / `CHECK` / `PAUSE`（最长 5 个字符），中文为“正常 / 偏高 / 离线 / 检测 / 暂停”，右侧为 SSL 标识。
- 中部：目标 host 和当前 ms；Pause / DOWN 以文字替代数值。
- 下部：最近样本图，以及实际观测期 uptime 与 p95。
- `down` 使用红色内框高亮；`slow` 使用琥珀色；正常状态取主题 accent。
- host 超长时从中间省略，保留开头和包含 TLD 的尾部。

## 8. 已覆盖的关键验证

- 重定向最终状态、第一跳延迟、死目标和循环上限。
- 5 分钟聚合、24 小时淘汰、诚实 uptime、p95 分箱上沿。
- 运行态水合/损坏降级与 SSL 倒计时。
- Pause 显示、单击手动探测、双击暂停/恢复及在途结果作废。
- 长按打开原始 URL、平台命令选择、非法 scheme 与打开失败后的错误恢复。
- 安全框背景与告警高亮。
- 事件循环长时间停顿后，旧轮询只错峰执行一次，瞬时长按 timer 不补执行。

修改探测口径、状态字段、桶宽/窗口、交互或显示时，应同步本文件并扩充 `tests/app-framework.test.js` 的 latency 用例；涉及真实 socket 时序的修改还应做本地 HTTP/HTTPS 冒烟验证。

## 多语言契约

- Inspector 默认英文；静态文案使用 `data-localize`，自定义控制器通过共享 helper 处理 `uiLanguage`、权威设置回读和语言切换。
- action 的英文名称为 `Web Latency Monitor`，简体中文名称为“网站延迟监测”，明确限定 HTTP/HTTPS 网站探测，不与 ICMP 或一般链路延迟混淆。
- 暂停、等待、正常和异常等键面状态按实例 `uiLanguage` 翻译；目标地址、证书日期、延迟值和探测结果保持原始数据。
- `en.json` 与 `zh_CN.json` 的 action 名称/说明顺序必须与 manifest 一致，新增键由 `tests/i18n.test.js` 锁定覆盖。
