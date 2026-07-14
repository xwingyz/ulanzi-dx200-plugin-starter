# 基座架构分析

目标需求：**一个基座 = 一个插件框架 + 一个运行实例，承载多个子功能集合。**

这份文档回答三件事：当前仓库如何映射这个需求、哪些地方已经达标、哪些地方需要继续收敛。长期规则仍以 [development-rules.md](development-rules.md) 为唯一权威，本文只做架构层面的分析与路线记录。

## 1. 需求到仓库的映射

| 需求概念 | 仓库对应物 | 说明 |
| --- | --- | --- |
| 插件框架 | `template/` 母版 + `libs/`（宿主桥接）+ `inspector-shared.js` + `plugin/app.js` 里的框架段（`THEMES`、`normalizeSettings`、`INSTANCES`、事件分发、`renderScreenFrame`） | 框架不含业务，负责连接宿主、实例管理、设置归一化、渲染骨架 |
| 运行实例 | 每个插件一个 Node.js 主服务进程（`plugin/app.js`，经 `run-plugin.mjs` 或宿主拉起） | 单进程内用 `INSTANCES: Map<context, instance>` 管理所有按键实例 |
| 子功能集合 | `ACTION_CONFIGS` 注册表中的各 action（当前 6 个：counter / badge / swatch / fontprobe / latency / pomowave） | 每个 action 通过 `defaults + createState + onRun + render` 四件套接入框架 |
| 复制基座 | `scripts/create-plugin.mjs` 从 `template/` 生成新插件 | 一套框架可派生多个独立插件 |

结论：**架构方向与需求一致，不需要推倒重来。** 仓库本身就是按“一个框架、一个运行实例、多个 action 子功能”设计的。

## 2. 分层结构（现状）

```text
桌面宿主 Ulanzi Studio                     官方 Simulator
  │  WebSocket ws://127.0.0.1:3906          │  WebSocket ws://127.0.0.1:39069
  │  自动拉起插件主服务                      │  由 run-plugin 启动插件主服务
  └──────────────────────┬───────────────────┘
  ▼
运行实例 plugin/app.js（一个插件一个 Node 进程）
  ├── 框架层：$UD 事件分发 → ensureInstance → normalizeSettings → 通用 persist → render → setBaseDataIcon
  ├── 注册表：ACTION_CONFIGS / ACTIONS / ACTION_KEY_BY_UUID（自动注册，勿手写第二套映射）
  ├── 实例层：INSTANCES（运行态唯一容器，active 标记控制是否推送渲染）
  └── 子功能层：各 action 的必选能力与可选生命周期钩子
配置层 property-inspector/<key>.{html,js} → inspector-shared.js（连接/回填/提交协议）
静态层 manifest.json + assets/icons/（宿主未拉起运行态前的默认展示）
```

## 3. 达标项

- 子功能以 `ACTION_CONFIGS` 注册表接入，四层命名（UUID / configs / inspector / icon）由规则约束，新增 action 不改框架。
- 运行态集中在 `INSTANCES`，不跨 context 共享可变状态。
- 主题走 `THEMES` token（mint/ember/mono/signal），渲染共用 `renderScreenFrame` 骨架。
- Inspector 协议统一收口在 `inspector-shared.js`，action 入口只调 `initInspector`。
- 设置持久化由框架统一收口到 `data/action-settings.json`，action 不再各自维护文件读写分支。
- 脚手架、同步、运行脚本与业务完全分离（`scripts/` 无业务逻辑）。

## 4. 当前收敛状态

### 4.1 生命周期钩子化与通用持久化（已完成）

`ACTION_CONFIGS` 保留 `defaults`、`createState`、`onRun`、`render` 四个必选能力，并支持以下可选能力：

- `onReady(instance)`：实例完成本轮设置合并与渲染后的准备工作。
- `onSettingsChanged(instance, previousSettings)`：响应归一化后的设置变化。
- `onParamFromPlugin(instance, param)`：处理 Property Inspector 传来的 action 私有参数语义。
- `persist`：默认持久化归一化后的完整设置；设为 `false` 可关闭，传入筛选函数可只保存指定字段。

框架事件处理只做通用的设置合并、持久化、回推、生命周期分发和实例清理，不含 `latency`、`pomowave` 等业务 action key。实例销毁仍由定时器登记表与 `disposeInstance` 统一处理，不增加逐 action 清理分支。持久化与事件优先级的长期约束见 [development-rules.md](development-rules.md) §4。

### 4.2 单文件体量与拆分时机

`plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/app.js` 已超过 1200 行。生命周期钩子化已经完成，下一步可按 `plugin/actions/<key>.js` 拆文件，让 `plugin/app.js` 只保留框架与注册表；此项仍待办。

### 4.3 模板与插件的共享层漂移（已处理一轮）

`inspector-shared.js` 在业务插件里演进出的通用修复（checkbox 支持、context 感知的 `sendParamFromPlugin`、onAdd/onParamFromApp/onParamFromPlugin 统一 apply），以及 `renderInstance` 的 `active === false` 守卫，此前未回流 `template/`。本轮已回灌。

**长期规则**：共享层（`libs/`、`inspector-shared.js`、app.js 框架段）在业务插件里做出的通用修复，验证后必须回流 `template/`；`libs/node/utils.js` 里的 `__PLUGIN_NAME__` 是脚手架占位符，属预期差异，不算漂移。可用 `diff -rq template/.../libs plugins/<plugin>/libs` 做例行核对。

### 4.4 领域边界

`lexutility` 当前 6 个 action 仍属“工具集”同一领域。若后续出现明显不同领域（如设备控制、IM 通知），按 [development-rules.md](development-rules.md) §9 拆新插件（即新的运行实例），而不是无限堆 action——基座的复制单位是插件，不是 action。

## 4.5 进程内隔离层（已落地）

设计前提：**单进程是硬约束（低系统占用），隔离在进程内由框架保证**。框架提供：

- `guardAction(instance, phase, fn)`：所有进入 action 代码的入口（onRun / render / createState / 定时器回调）统一异常兜底，出错只影响该实例，键位显示 ERR 状态图（`renderErrorState`）。
- `safeHandler(name, fn)`：宿主事件处理器整体兜底，坏消息不杀进程。
- 实例定时器登记表：`setInstanceTimeout` / `clearInstanceTimeout` / `hasInstanceTimeout` / `disposeInstance`，action 不再持有裸 `setTimeout` 句柄，`onClear` 由框架统一回收。
- 进程级 `unhandledRejection` / `uncaughtException` 记日志并存活，仅作最后兜底。

详细规则见 [development-rules.md](development-rules.md) §4「进程内隔离」。

## 5. 路线小结

1. ~~文档旧路径与模板回灌~~（完成）
2. ~~框架隔离层：异常隔离 + 定时器隔离（guardAction / safeHandler / 定时器登记表）~~（完成）
3. ~~桥接层连接自愈（5 秒重连、不裸崩）+ `dev-desktop.mjs` restart 孤儿进程修复~~（完成）
4. ~~`ACTION_CONFIGS` 生命周期钩子化 + 通用设置持久化，消除框架事件中的业务 action key~~（完成）
5. 按 `plugin/actions/<key>.js` 拆分子功能文件（待办）
6. action 超过 8 个时补 `docs/action-catalog.md`（沿用 development-rules.md §13 的既有建议）
