# Bambu 3D Printer Status 功能与技术规范

状态：首版已实现，等待真实 P2S 状态订阅验收  
最后代码核对：2026-07-27
action key：`bambustatus`  
UUID：`com.ulanzi.ulanzistudio.lexutility.bambustatus`

**变更门槛：修改 Bambu 3D Printer Status 的业务模块、manifest、Inspector、图标、设置、状态、I/O、持久化、交互、渲染或测试契约前，必须先完整阅读本文件；涉及基座时还必须读写 `../base.md`。**

## 1. 功能定位与边界

Bambu 3D Printer Status 是 Lex Utility 内的一键一机只读监控 action。首版只验证 Bambu Lab P2S，在同一局域网内读取实时打印状态，不发送暂停、继续、停止、温控或运动等控制命令。

四层实现：

- manifest：`manifest.json` 的 `Bambu 3D Printer Status`。
- 注册名称：英文 `Bambu 3D Printer Status`，简体中文 `Bambu 3D 打印机状态`。
- 业务：`plugin/actions/bambustatus.js`。
- Inspector：`property-inspector/bambustatus.html`、`bambustatus.js`。
- 静态图标：`assets/icons/actionBambustatus.svg`。

首版连接边界：打印机保持云端绑定，不要求启用 LAN Only 或 Developer Mode。若 P2S 固件在该模式下拒绝第三方本地 MQTT，action 必须显示明确兼容性错误；不得静默回退到云端 Token，也不得引导 action 自动更改打印机模式。

## 2. 用户功能

- 一个 action 实例只绑定一台打印机，各实例独立保存打印机名称、连接设置、连接状态和完成快照。
- 配置不完整时自动扫描一次；Inspector 提供“重新扫描”，手动配置始终可覆盖扫描结果。
- 单击立即请求当前状态；连接不可用时断开并重新连接。按下后中间信息区显示 `...`，反馈至少保持 650ms；品牌图标不变色、不增加高亮。
- 双击通过系统应用启动器打开 Bambu Studio。统一手势合同仍要求第一次短按先立即执行一次刷新，第二次短按成立后再打开应用。
- 长按按实例设置打开 MakerWorld 国际站 `https://makerworld.com/` 或中国站 `https://makerworld.com.cn/`。
- 打印完成后锁存完整显示快照，跨 Ulanzi Studio 重启保留；下一次任务开始、锁存到期或单击刷新时解除。
- 离线时不把旧进度冒充实时数据，改为显示离线与最后成功更新时间。

## 3. 自动发现与连接契约

### 3.1 Bambu Studio 配置

首版只读解析以下已知配置入口，不修改 Bambu Studio 文件：

- macOS：`~/Library/Application Support/BambuStudio/BambuStudio.conf`
- macOS Beta：`~/Library/Application Support/BambuStudioBeta/BambuStudio.conf`
- Windows：`%APPDATA%/BambuStudio/BambuStudio.conf`

JSON 的 `access_code` 是按设备序列号索引的映射。读取时只提取序列号与 LAN Access Code，不读取或记录账号密码、云端 Token。正式版优先于 Beta；同一序列号只保留首个有效 Access Code。

### 3.2 局域网发现

监听 Bambu SSDP 风格的局域网报文，识别：

- `Location`：打印机 IP。
- `USN`：设备序列号。
- `DevModel.bambu.com`：设备型号。
- `DevName.bambu.com`：设备名称（仅诊断，不在键面显示）。

发现结果按序列号与 Bambu Studio 的 Access Code 合并。配置不完整时扫描结果只回推 Inspector，不静默覆盖已有完整手动设置。扫描不得扩展为端口段暴力探测。

### 3.3 MQTT

```text
URL: mqtts://<printerIp>:8883
username: bblp
password: <accessCode>
subscribe: device/<serialNumber>/report
```

- 使用 `mqtt` npm 包，TLS 首版允许打印机自签名证书（`rejectUnauthorized: false`）。
- 不在日志中打印 URL 凭据、Access Code 或完整 MQTT payload。
- 状态上报是增量，action 在实例内维护 `print` 状态镜像。
- 连接后可向 `device/<serialNumber>/request` 发送只读 `pushall` 状态请求；不得发送任何设备控制 command。
- 连接失败后使用实例定时器退避重连，最长退避 60 秒；短按跳过等待立即重连。

## 4. 设置契约

| 字段 | 默认值 | 合法范围/选项 | 含义 |
| --- | --- | --- | --- |
| `printerName` | 空 | 字符串，最长 40 | 用户自定义打印机名称；发现到设备名称时可自动填充 |
| `printerIp` | 空 | IPv4 / 主机名，最长 253 | 打印机局域网地址 |
| `serialNumber` | 空 | ASCII，最长 64 | MQTT topic 设备标识 |
| `accessCode` | 空 | 字符串，最长 128 | LAN Access Code，明文本机保存 |
| `makerworldSite` | `china` | `global` / `china` | 长按打开 MakerWorld 国际站或中国站 |
| `theme` | `mint` | 公共主题 key | 键面主题 |
| `frameSize` | `optimal` | `optimal` / `max` | 安全显示范围 |
| `showFrame` | `true` | `true` / `false` | 是否显示公共边框 |

Inspector 不遮蔽 Access Code。所有设置由共享设置存储写入 `data/action-settings.json`；日志、SVG、诊断信息和测试 fixture 不得包含真实凭据值。

## 5. 状态解析

首版读取 `print` 下列字段（缺失均允许）：

- `gcode_state`：任务主状态。
- `mc_percent`：完成百分比。
- `mc_remaining_time`：剩余分钟数。
- `gcode_start_time`：任务开始时间，用于计算已用时间。
- `stg_cur` / `mc_print_stage`：准备与暂停的细分阶段。
- `subtask_name` / `gcode_file`：仅保留在完成快照，不挤入首版主画面。
- `mc_print_error_code` / `print_error` / `fail_reason`：失败判断与诊断。
- `dev_model_name` / 发现所得型号：设备实际型号。

用户态统一为：`CONNECTING`、`IDLE`、`PREPARING`、`RUNNING`、`PAUSED`、`FINISHED`、`FAILED`、`OFFLINE`、`INCOMPATIBLE`。

准备阶段优先按已知 `stg_cur` 数字映射为中文，例如自动调平、热床预热、机械模式检查、换料、喷嘴加热、流量校准、扫描热床、首层检查、识别热床、归位和清洁喷嘴。未知阶段显示设备返回的原始值；没有原始文本时显示 `阶段 <数值>`，不得吞成笼统“准备中”。

## 6. 键面显示

```text
┌──────────────┐
│[Bambu] 书房机│  顶部：38px 品牌标记 + 最终打印机名称
│▣ ███ 68% ░░░│  中部：打印动态图标 + ChatGPT Usage 同款计量行
│ ◷ 1 h / ⧖ 36 m│  底部：时钟预计总时长 / 沙漏剩余
└──────────────┘
```

- 品牌标记尺寸与 ChatGPT Usage 的 38×38 标记一致；键面只显示最终打印机名称，不显示设备型号。
- 扫描发现的设备名自动填入 `printerName`，用户保存前可修改；手动名称始终覆盖发现名称。
- 扫描返回完整或部分设备信息后，Inspector 必须立即提交设备名、IP、序列号和 Access Code 并落入统一设置存储；只提交发现字段，由框架合并并保留主题、边框等既有设置，不得把尚未恢复的 Inspector 默认值写回。
- 鼠标选中 action、新开或重连 Inspector 时，先通过 `__requestSettings` 只读握手恢复打印机名称、连接字段和外观设置；握手不得触发 MQTT 重连、自动扫描或任何设置写盘。
- 权威回推带 `__settingsSync` 标记；切换 action 时即使宿主重放旧的表单同步消息，也不得把它当成用户提交覆盖打印机名称或连接字段。
- 人工输入和扫描发现后的完整字段保存经浏览器桥带 `__settingsSubmit` 标记；只有这种明确提交可更新本地设置，历史未标记快照没有写权限。
- 扫描结果由 action 主进程通过框架 `persistSettings` 直接保存，且空的发现字段不得覆盖已有人工值；Inspector 收到扫描结果只负责显示，不得再次提交。这样宿主重放历史扫描结果时不会产生二次写盘。
- 打印进度必须直接复用 ChatGPT Usage 的共享 `renderMeterRow`：主题面板底槽、`rx=3`、30% 透明度的完成色填充，以及数字和 `%` 的分级排版；Bambu 启用 `centerText`，向下做 10.7 个设计单位的光学校正，并因左侧打印动态图标把百分比向右偏移 12 个设计单位，使“图标 + 百分比”组合在槽内视觉平衡。偏移以宿主截图中的可见字形轮廓为验收依据，不以 SVG 基线盒代替视觉验收。
- 打印进度槽左侧叠加一个本地 SVG 打印机小图标。图标至少有三帧工具头位置，每收到一次打印状态刷新后前进一步；它只表达正在打印，不承担连接或告警语义。
- 下方用一行独立几何元素显示“时钟图标 `<预计总时长>` / 沙漏图标 `<剩余时间>`”：时钟取代字母 `E`，沙漏取代字母 `R`，两个图标均使用主题强调色；数字使用 26px 主文字色，`m` / `h` 使用 14px 主题弱化色，分隔符 `/` 使用更低一级的弱化色。两组时间与分隔符之间必须保留清晰留白，不得重新拼成拥挤的单段文本。动态数字使用等宽数字；数字与单位之间保留显式空格，例如 `35 m`、`2 h`。打印、准备和暂停时，预计总时长由当前已用时间与打印机剩余时间相加得到；完成态只居中显示“时钟图标 `<最终实际用时>`”。单项只显示一个最大时间单位；任一组成时间缺失时不得用另一项冒充预计总时长，应显示 `--`。
- 非打印状态不再另画第三行小字详情。稳定且不需要用户处理的 `IDLE`、`CONNECTING`、`FINISHED` 只显示“空闲”“连接中”“已完成”，禁止拼接等待提示、读取提示、任务名、模型名或文件名。`PREPARING` 有细分阶段时只显示子状态，例如“自动调平热床”，不得再加“准备中”前缀；没有细分阶段时才显示“准备中”。`PAUSED`、`FAILED`、`OFFLINE`、`INCOMPATIBLE` 保留必要详情并合并为一行；整行仍须限长。
- 离线隐藏旧进度，底部显示最后成功更新时间。
- 完成锁存显示 `已完成` 和最终实际用时，不显示任务名、模型名或会误导的剩余时间。快照保留 3 分钟，到期后自动清除并主动请求一次当前状态；用户也可随时单击立即清除并刷新。
- 全部内容经公共安全框与主题渲染能力输出；状态语义色取当前 theme 的 `ok` / `warn` / `crit`。
- 品牌标记是固定身份元素，可使用 Bambu Lab 官方标记的本地矢量版本；商标仅用于指代设备，不代表官方授权。

## 7. 生命周期与资源隔离

| 钩子 | 行为 |
| --- | --- |
| `createState` | 水合版本化完成快照，初始化连接与状态镜像 |
| `onReady` | 配置不完整时自动扫描；配置完整且尚无客户端时连接 MQTT，重复恢复现有实例不得重连 |
| `onRun` | 单击显示刷新反馈、清除完成锁存并立即请求当前状态；连接不可用时重新连接 |
| `onDoublePress` | 通过系统应用启动器打开 Bambu Studio |
| `onLongPress` | 按 `makerworldSite` 打开对应 MakerWorld 站点 |
| `onSettingsChanged` | 连接字段变化时断开旧连接并连接新目标 |
| `onParamFromPlugin` | 处理重新扫描控制命令并回推扫描结果/诊断 |
| `onDispose` | 关闭 MQTT/UDP socket、清理实例定时器并落盘完成快照 |
| `render` | 依据 settings + state 纯函数生成 SVG data URL |

MQTT client、UDP socket、状态镜像、退避计数都只存在于当前 instance，不跨 context 共享。业务 action 不直接使用 `setTimeout` / `setInterval`。

状态连接以 MQTT 上报为主；打印、准备和暂停期间额外每 10 秒发送一次只读 `pushall`，提高进度、阶段和剩余时间的可见刷新率。其他状态只保留 30 秒本地重绘，不主动高频轮询；手动单击仍立即请求。

每当状态白名单字段发生变化时，通过框架 `appendDiagnosticLog` 追加一条 `data/bambustatus-status.jsonl`。日志最多 512 KiB，超限轮换为同目录 `.1` 文件；只记录时间、归一化状态、原始任务状态、进度、剩余分钟、开始时间、阶段代码/名称、任务名、型号与错误代码/文本。禁止记录序列号、IP、Access Code、摄像头字段或完整 MQTT payload。相同白名单快照不重复记录；该日志仅供状态映射分析，不参与键面渲染和状态恢复。

## 8. 运行态持久化

运行态版本 `v: 1`，写入 `data/action-state.json`：

```text
completedSnapshot: {
  model,
  progress,
  elapsedSec,
  remainingSec,
  taskName,
  completedAt
}
suppressFinishedUntilNextTask: boolean
```

只在打印完成、下一任务解除锁存、3 分钟到期、单击清除或 dispose 时按语义变化写盘；不得逐条 MQTT 消息写盘。到期或单击后用 `suppressFinishedUntilNextTask` 记住不再锁存同一次已完成任务，直到收到下一次 `PREPARING` / `RUNNING`。完成时间缺失、快照已超过 3 分钟、版本不符或内容损坏时降级为无快照，不阻止 action 启动。

## 9. 错误与兼容性语义

- 配置缺失：显示 `待配置`，Inspector 标出缺少字段。
- DNS/网络/TLS/认证失败：显示离线，并在 Inspector 返回不含凭据的错误类别。
- MQTT 已连接但状态请求/订阅持续无数据：显示 `不兼容`，明确提示 P2S 当前云端模式可能不开放本地状态。
- JSON payload 损坏或字段缺失：忽略该增量并保留连接，不抛到进程级错误边界。
- 任一实例异常不得影响 Lex Utility 的其他 action。

## 10. 完成与验收

- manifest、action 模块、Inspector、图标四层齐全并完成注册。
- 专项测试覆盖配置发现、SSDP 解析、增量合并、状态映射、时间计算、完成锁存、3 分钟自动过期、单击刷新与全显示态渲染。
- 根目录 `npm test` 全绿。
- 使用 `restart` 同步到 Ulanzi Studio，删除旧实例后重新拖入验证 UUID。
- Inspector 扫描、保存、手动覆盖和重新扫描符合契约。
- 必须在保持云端绑定且不开 LAN Only/Developer Mode 的真实 P2S 上收到状态数据，才可宣告 action 完成；否则交付兼容性报告，状态保持“受阻”，不改走云端。

## 多语言契约

- Inspector 默认英文；静态文案使用 `data-localize`，自定义控制器通过共享 helper 处理 `uiLanguage`、权威设置回读和语言切换。
- 扫描、连接、打印阶段和设备状态按实例 `uiLanguage` 翻译；打印机名称、序列号、进度、温度和 MQTT 原始详情保持原始数据。
- 业务层保存稳定的英文阶段标识，翻译只发生在 Inspector 和 render 边界；新增键由 `tests/i18n.test.js` 锁定覆盖。
- 用户可见注册名称固定为英文 `Bambu 3D Printer Status`、简体中文 `Bambu 3D 打印机状态`。
