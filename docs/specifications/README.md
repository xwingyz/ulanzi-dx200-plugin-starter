# Lex Utility 规格文档

状态：持续维护  
最后代码核对：2026-07-21
适用插件：`plugins/com.ulanzi.lexutility.ulanziPlugin/`

本目录统一保存 Lex Utility 当前基座和生产 action 的功能、技术与维护规范。它们是**可更新的实现规格**，用于描述当前代码和后续变更的同步要求；仓库长期硬约束仍以 [`../development-rules.md`](../development-rules.md) 为唯一权威。

## 文档索引

| 文档 | 范围 |
| --- | --- |
| [`base.md`](base.md) | 插件基座：模块边界、实例生命周期、设置/状态持久化、隔离、渲染、Inspector 与部署 |
| [`actions/latency.md`](actions/latency.md) | Latency Monitor：URL 探测、24 小时统计、SSL、交互与显示 |
| [`actions/pomowave.md`](actions/pomowave.md) | PomoWave：阶段状态机、无漂移计时、提示音、交互与显示 |
| [`actions/speedtest.md`](actions/speedtest.md) | Network Speed：Ookla CLI、节点发现、调度、排队、历史与显示 |
| [`actions/bambustatus.md`](actions/bambustatus.md) | Bambu P2S Status：局域网发现、MQTT 状态、完成锁存与显示 |
| [`actions/systemstatus.md`](actions/systemstatus.md) | System Status：CPU/RAM/GPU/温度/网络实时状态与跨平台降级 |

## 文档与规则的边界

- `development-rules.md` 回答“所有插件和 action 必须遵守什么”。
- 本目录回答“Lex Utility 当前如何实现、对外表现是什么、改动时要同步哪些位置”。
- 源代码与自动化测试是运行事实源。文档与代码冲突时，应先确认变更意图，再在同一次任务中同步文档；不要让文档反向掩盖代码缺陷。
- `docs/base-architecture.md` 保留架构分析和演进记录；本目录提供维护时可直接执行的规格。

## 统一维护规则

### 修改前：先读对应规格

- 修改基座或共享层之前，必须先完整阅读 [`base.md`](base.md)。
- 修改某个 action 之前，必须先完整阅读该 action 的规格：[`latency`](actions/latency.md)、[`pomowave`](actions/pomowave.md) 或 [`speedtest`](actions/speedtest.md)。
- 同时影响基座和 action 时，两类文档都要读；影响多个 action 时，逐份读取全部受影响规格。
- 新增 action 时，先读 `base.md`，再在编码前创建该 action 的初始规格并明确功能与技术边界。

### 修改后：同步对应规格

发生下列变化时，必须更新对应文档的“最后代码核对”日期和相关章节：

1. `manifest.json` 中名称、UUID、路径、平台或宿主最低版本变化。
2. action 的默认值、取值范围、状态机、按键语义、Inspector 控件或持久化结构变化。
3. `plugin/app.js` 的注入契约、生命周期、存储、渲染原语或隔离语义变化。
4. 新增、删除或重命名 action；同时更新本索引和 `base.md` 的生产 action 清单。
5. 测试门槛或部署验证步骤变化。

规格同步必须与代码修改处于同一次任务，不能留作后续补写。纯内部重构若经逐项核对后确实不改变功能或技术契约，可以不改正文，但交付时必须明确说明已经核对且无需更新。

每次更新优先写“当前行为”，历史原因只保留会影响维护判断的部分。尚未实现的设想必须标为“候选调整”，不得混入当前规范。
