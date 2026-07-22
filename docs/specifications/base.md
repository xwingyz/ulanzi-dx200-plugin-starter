# Lex Utility 基座技术规范

状态：持续维护  
最后代码核对：2026-07-22
事实源：`manifest.json`、`plugin/app.js`、`plugin/actions/index.js`、`property-inspector/inspector-shared.js`、`tests/`

**变更门槛：修改任何基座或共享层功能/技术实现前，必须先完整阅读本文件；修改完成后，必须在同一次任务中把必要的功能和技术变化同步到本文件，并更新“最后代码核对”日期。若同时影响 action，还必须读写对应 action 规格。**

## 1. 目标与边界

Lex Utility 采用“一个插件、一个 Node.js 进程、多个 action”的低资源架构。基座负责宿主连接、action 装配、实例隔离、设置归一化、持久化、渲染公共原语和事件分发；业务 action 只负责自己的状态机、I/O、私有设置与内容渲染。

当前生产 action：

| key | UUID | 业务模块 |
| --- | --- | --- |
| `speedtest` | `com.ulanzi.ulanzistudio.lexutility.speedtest` | `plugin/actions/speedtest.js` |
| `pomowave` | `com.ulanzi.ulanzistudio.lexutility.pomowave` | `plugin/actions/pomowave.js` |
| `latency` | `com.ulanzi.ulanzistudio.lexutility.latency` | `plugin/actions/latency.js` |
| `claudeusage` | `com.ulanzi.ulanzistudio.lexutility.claudeusage` | `plugin/actions/claudeusage.js` |
| `chatgptusage` | `com.ulanzi.ulanzistudio.lexutility.chatgptusage` | `plugin/actions/chatgptusage.js` |
| `bambustatus` | `com.ulanzi.ulanzistudio.lexutility.bambustatus` | `plugin/actions/bambustatus.js` |
| `systemstatus` | `com.ulanzi.ulanzistudio.lexutility.systemstatus` | `plugin/actions/systemstatus.js` |
| `healthbreak` | `com.ulanzi.ulanzistudio.lexutility.healthbreak` | `plugin/actions/healthbreak.js` |

插件 UUID 为 `com.ulanzi.ulanzistudio.lexutility`，主入口为 `plugin/app.js`。桌面宿主最低版本为 3.0.11，manifest 声明支持 Windows 10+ 与 macOS 10.11+。

### 1.1 设备面与不可寻址区

DX200 布局为 5 列 × 3 行（`Ulanzi Studio/config/device.json` 的 `DeviceType.Layout`）。其中存在一块**插件不可寻址**的宿主独占区，设计时不得把它计入可用面。

| 面 | 槽位 | 渲染尺寸 | 插件可写 |
| --- | --- | --- | --- |
| 普通方键 | 除 `3_2` 外全部 | 196 × 196 | 是（`state` 命令） |
| 视窗（LargeItem） | `3_2`，跨 2 列 1 行 | 458 × 196 | **否** |

视窗被宿主内置 action `com.ulanzi.ulanzideck.smallwindow.window`（面板标题「视窗：背景设置」）固定占用，`device.json` 同时把 `3_2` 列在 `FixedItem` 下。插件 action 无法拖入该槽位（已实测）。

不可写的判定依据：SDK 唯一渲染通道 `state` 按 `(uuid, key, actionid)` 路由到插件 action 实例，视窗上不存在插件实例，无 context 可寻址；宿主 WebSocket 命令全集为 `clear` / `keydown` / `keyup` / `openurl` / `paramfromapp` / `paramfromplugin` / `setactive` / `state` / `toast`，无任何视窗相关命令。

视窗可显示的内容由宿主面板提供，数据源均为宿主自身，插件无法接入：自定义背景图（458 × 196）、5 种时钟叠加（表盘时间 / 日期时间星期 / 时间星期 / 时间日期 / 时间）、CPU+RAM+GPU、纯背景、旋钮。设置项落在 `ActionParam.SmallViewMode`。自定义背景图由宿主哈希复制到 `Images/`，改写原文件不生效，因此不能用作实时信息通道。

结论：所有业务信息展示只能落在普通方键上。本节结论对应宿主版本 3.0.11 一代；SDK 若开放视窗通道需重新核对。

## 2. 运行结构

```text
Ulanzi Studio :3906 / Simulator :39069
  -> libs/node/ulanzideckApi.js
  -> plugin/app.js
     -> actions/index.js
        -> actions/speedtest.js
        -> actions/pomowave.js
        -> actions/latency.js
        -> actions/claudeusage.js
        -> actions/chatgptusage.js
        -> actions/bambustatus.js
        -> actions/systemstatus.js
        -> actions/healthbreak.js
     -> INSTANCES Map<context, instance>
     -> data/action-settings.json
     -> data/action-state.json
  <-> property-inspector/<key>.html + <key>.js
      -> property-inspector/inspector-shared.js
```

桌面版由 Studio 自动拉起插件主服务；Simulator 工作流才由 `run-plugin` 启动。业务源码只编辑仓库副本，宿主插件目录是部署副本。

## 3. Action 模块契约

每个模块导出工厂 `create<Action>Action(runtime)`，返回：

```js
{
  key: '<actionKey>',
  config: {
    defaults,
    normalizeSettings?,
    createState,
    onRun,
    onLongPress?,
    longPressMs?,
    onReady?,
    onSettingsChanged?,
    onParamFromPlugin?,
    onDispose?,
    persist?,
    render,
  },
  testing?,
}
```

`actions/index.js` 是唯一业务注册点。`app.js` 从模块列表生成 `ACTION_CONFIGS`、完整 UUID 映射和测试导出，不维护第二套手写 action 表。

各 action 的 `testing` 由 `ACTION_TESTING = Object.freeze(Object.assign({}, ...ACTION_MODULES.map(m => m.testing)))` 合并成单一对象：**同名键后者静默覆盖前者**。因此可能重名的通用符号导出时必须加 action 前缀。测试隔离的完整要求见 `development-rules.md` §4「Action 与测试的代码隔离」。

模块边界：

- action 不得导入 `app.js`、兄弟 action、桥接对象或持久化路径。
- action 只能使用工厂参数显式注入的框架能力。
- `defaults` 只保存可序列化设置；`createState` 只创建当前 context 的运行态。
- `render(instance)` 必须保持纯渲染语义：读取已归一化的 `settings + state` 并返回 data URL，不做 I/O 或持久化。
- action 私有设置由自身 `normalizeSettings` 处理；框架只归一化共享字段。
- action 测试只碰自己的 `config` 与前缀化的 `testing` 符号，不硬编码共享原语（`renderMeterRow` / `formatCountdown` 等）的具体字号与几何。

## 4. 实例与事件生命周期

每个物理键位 context 对应 `INSTANCES` 中一个实例。实例至少包含 `context`、`actionUuid`、`settings`、`active`，业务运行态由 `createState` 合入。

| 宿主事件 | 基座行为 |
| --- | --- |
| `onAdd` / `onParamFromApp` | 以本地持久化设置为权威合并，归一化、必要时回写存储、渲染、调用 `onReady`，并无条件把完整权威设置回推新打开的 Inspector |
| `onParamFromPlugin` | 以 Inspector incoming 为权威；恢复默认由框架拦截，其余来件在合并后分发给 `onParamFromPlugin` |
| `onKeyDown` | 标记真实 key 事件，不提交插件缩放帧；声明 `onLongPress` 时登记默认 600ms 的实例定时器 |
| `onKeyUp` | 取消长按定时器并清除反馈；未达到阈值则调用短按业务 `onRun`，已达到阈值则在此时调用 `onLongPress` 并抑制 `onRun` |
| `onRun` | 只为不提供 keydown/keyup 的旧宿主执行短按兼容回退；当前实例观察到真实 key 事件后忽略该事件，避免重复执行 |
| 按压视觉 | 由 Studio / 设备宿主原生处理；`keydown` 不提交插件缩放帧，`keyup` 只绘制最新业务状态 |
| 长按反馈 | 达到阈值时只标记长按成立，并由基座提交一次同尺寸反色图保持到 `keyup`；实际长按业务在 `keyup` 执行，不得改变 `viewBox` 或几何 transform |
| `onSetActive` | 更新 `active`；重新激活时补一次渲染，非 active 实例禁止推送图标 |
| `onClear` | 先调用 `onDispose`，取消独占任务，清理登记定时器，再删除实例 |
| 进程退出 / SIGINT / SIGTERM | 对所有实例执行一次同步 dispose，给运行态最后一次落盘机会 |

单个 action 异常经 `guardAction` 隔离，错误只写入该实例并渲染 `ERR / <actionKey>`；宿主事件处理器另由 `safeHandler` 兜底。进程级 rejection/exception 监听仅是最后防线。

## 5. 设置与持久化

### 5.1 共享设置

框架统一处理：

- `title`：有默认标题的 action 才启用，最长 14 字符。
- `subtitle`：有默认副标题的 action 才启用，最长 18 字符。
- `theme`：必须是公共主题 key。
- `frameSize`：`optimal` 或 `max`。
- `showFrame`：字符串布尔值 `true` / `false`。

### 5.2 设置存储

- 文件：`data/action-settings.json`。
- 键：宿主 context 解码后的 `actionid::key`。
- 默认持久化完整的归一化设置；action 可通过 `persist` 关闭或筛选。
- 只有持久化语义变化才写盘，采用同目录临时文件 + rename 原子替换。
- 新存储损坏时转为只读并保留现场；仅新文件明确不存在时才迁移 legacy latency 设置。
- Inspector 的 `__resetDefaults: 'true'` 是框架控制参数，不进入设置、不转发给业务 action。
- Inspector 的 `__requestSettings: 'true'` 是只读握手：按 persisted 语义回推完整权威设置，不写盘、不渲染、不调用 `onReady`、不转发给业务 action。
- 权威设置回推必须带 `__settingsSync: 'true'`；宿主重放或广播这条 `PARAMFROMPLUGIN` 时，主进程只识别为 Inspector 同步回声，不得据此覆盖 persisted 设置。
- Inspector 的完整用户设置提交必须由浏览器桥附带 `__settingsSubmit: 'true'`。无控制参数且无提交标记的历史 `PARAMFROMPLUGIN` 不具备写权限，框架必须忽略。

### 5.3 运行态存储

- 文件：`data/action-state.json`。
- 键仍为 `actionid::key`，内容结构由各 action 版本化管理。
- 框架只注入 `readPersistedState`、`writePersistedState`、`dropPersistedState`。
- 运行态缺失、版本不符或损坏必须降级为空；不得阻止 action 启动。
- action 应在语义边界批量落盘，并在 `onDispose` 同步 flush，禁止高频逐 tick/逐探测写盘。

测试通过 `ULANZI_PLUGIN_DATA_DIR` 把数据放到仓库外的隔离目录；应使用 `npm test`，不要绕过 `tests/setup.mjs` 直接运行 `node --test`。

## 6. 并发与资源隔离

- action 不得直接使用 `setTimeout` / `setInterval`；统一使用实例定时器 API，slot 在同一实例内唯一。
- 定时器回调自动经过 action 错误边界，实例销毁时统一取消。
- 排他资源使用 `createExclusiveTaskQueue()`。当前 `speedtest` 用资源名 `network-bandwidth` 串行测速和节点发现。
- 队列提供同实例去重、排队位置、运行/排队取消和 `AbortSignal`；action 不另建模块级 busy 标志。
- 异步 `onRun` / `onLongPress` 必须返回 Promise，使 rejection 留在框架错误边界内。

## 7. 主题、画布与公共渲染

动态按钮 SVG 的坐标系为 `viewBox="0 0 256 256"`，渲染尺寸声明为 `width/height="392"`，最后编码为 `data:image/svg+xml;base64,...`。业务内容以 40..216 为设计箱，通过 `frameContent` 缩放进安全区域。

坐标系与渲染尺寸刻意解耦。按键实际显示尺寸为 196 × 196（见 §1.1），392 = 196 × 2。

**宿主按声明的 `width`/`height` 先渲成位图，再缩放到 196**——已于 2026-07-18 实机确认：声明从 256 改为 392 后，边框与细描边的锐利度有可见提升。因此声明尺寸必须是 196 的整数倍，392 → 196 为精确的 0.5 降采样；此前声明 256 时缩放比为 0.766，非整数比会引入重采样损失。**不得把声明尺寸改回 256 或其他非整数倍值。**

坐标仍在 256 空间，因此**代码里的数值不等于实机像素**，换算为 × 0.766。描边宽度经此换算后普遍落在非整数像素上（如 `stroke-width="1.5"` → 1.15px），细线锐利度仍有余量未吃满。若要让几何精确对齐 196 像素栅格，需把坐标系整体迁移到 392 空间（× 1.53125）并重算全部坐标、字号与描边，此后换算关系简化为「代码数值 ÷ 2 = 实机像素」。该迁移涉及约 223 个坐标字面量、44 处插值与 23 条测试断言，属未完成的候选优化。

### 7.1 静态图标(manifest `Icon` / 插件 / 分类)与"模糊"归因

`assets/icons/` 下的静态图标是与运行时按键面**无关的另一条链路**:插件只提供文件,由宿主(Electron)渲染,用于 app 内 action 列表、插件/分类标识。约定全部图标(6 个 action + `pluginIcon` + `categoryIcon`)统一声明 `width/height="512"`,`viewBox` 各自保持不变(矢量放大零画质/体积代价),消除尺寸不一致这个排查干扰项。

**2026-07-21 实机排查结论(computer-use 直接对比,勿重复走弯路):**

- 用户反馈的"预览图标模糊"实指**设备网格里的运行时按键面**,不是 action 列表小图标。实机对比:我们的 speedtest 键面比参考插件(Claude Code 用量)的键面明显偏软,小字(标签/单位)与细网格线发虚。
- **按键面渲染与 manifest `Icon`/`States.Image` 的格式(PNG 还是 SVG)完全无关**:已实测把 manifest 全组在 PNG↔SVG 间来回切换并重启,键面渲染**零变化**。因为设备网格显示的是插件经 `state` 命令实时推送的 SVG data URL,不读 manifest 静态图。曾尝试把 manifest 换 PNG / 抬 SVG 声明尺寸,均是在改静态图标链路,对按键面**无效**——不要再走这条路。
- 按键面偏软的真因就是本节 §7 上文那条:256 坐标空间 × 0.766 的非整数换算,细描边落在分数像素、小字在 392→196 降采样后发虚;参考键用更粗字重与更简单几何,降采样后更锐。
- **决策(用户 2026-07-21 拍板):插件侧不改渲染管线**(§7 的 392 坐标系迁移、原生 196 声明、加粗描边等实验一律不做),保持高清矢量源,由 app 侧改进渲染方式解决。§7 末尾列的坐标系迁移仍是候选优化,但暂不推进。

公共主题：`mint`、`ember`、`mono`、`signal`、`neon`、`ice`、`sunset`、`forest`、`sand`。每个主题提供 `accent`、`canvas`、`panel`、`shell`、`text`、`muted`、`low`、`contrast`，以及语义告警色 `ok`、`warn`、`crit`。颜色只能由 theme 这一条轴驱动。

语义告警色供需要分级预警的 action 使用，不进 `THEME_SWATCHES`（色卡只展示 canvas / panel / low / accent / text 五个角色）。`sunset` 的 `accent` 是玫红、`forest` 的 `accent` 是绿，这两套下 `crit` / `ok` 与 `accent` 同色系，分级预警必须同时提供非颜色信号。一致性由 `tests/inspector-bridge.test.js` 锁定：两份各自的 token 合法性与三色互异，以及 `THEMES` 在业务插件与 template 之间完全一致。

公共渲染能力：

- `frameFor(settings)`：计算 `optimal` / `max` 的背景、安全区、圆角和缩放。
- `renderScreenFrame` / `renderThemeBackdrop`：绘制公共背景和框架。
- `frameContent`：把 action 内容装入设计箱。
- `frameHighlight`：为告警、等待或运行状态绘制一致的内框高亮。
- `renderMeterRow`：计量行——整行背景按百分比横向填充，三段文字叠在其上（左标签 / 中数值 / 右附注）。用量类 action 共用，保证并排摆放时行高、字号与填充观感必然一致。填充用矩形宽度实现，**禁止 clipPath**（宿主渲染器支持不可靠，会静默失效）。只负责几何与排版，颜色由调用方传入（`color` 给标签与填充，`tailColor` 给右侧附注）。数字与单位自动拆成不同字号的 `<tspan>`：数字随行高自适应，单位固定 15px——单位是恒定量纲标注，不该随行数抖动。
- `formatCountdown(resetsAt, now?)`：重置倒计时格式化。**只保留最大的那一个单位**（`6d` / `5h` / `45m` / `now`），不写 `1d23h` 这种复合形式——键面上这一栏是最次要的信息，粗粒度足够，省下的宽度留给百分比。用量类 action 共用，两个键并排时同样的剩余时长必须写成同样的字样。
- `themeFor`、`mixHex`、`escapeXml`、`toDataUrl`：主题和 SVG 安全辅助。

`showFrame` 只控制边框显示，不改变内容几何。静态 manifest 图标表达 action 类型，运行态 SVG 表达实时状态。

## 8. Property Inspector 协议

每个 action 有独立 `<key>.html + <key>.js`，但连接、字段读写、主题按钮、checkbox 映射、400ms 自动保存、恢复默认与反馈条由 `inspector-shared.js` 提供。

Inspector 规则：

- 页面字段与 action defaults/normalize 必须一一对应。
- 本地搜索等纯 UI 状态不得进入 action 设置。
- 控制命令（例如试听、跳过阶段、立即测速）与设置提交分开发送。
- `onAdd`、`onParamFromApp`、`onParamFromPlugin` 都应用插件回传的权威设置或运行态。
- Inspector WebSocket 每次连接成功后主动发送一次 `__requestSettings`；该握手兜住 PI 晚于宿主恢复事件加载的竞态，在收到权威回推前不提交 HTML 初始值。
- 重连不得重复绑定 DOM 事件；pagehide 只 flush 仍待提交的尾值。

## 9. 基座变更影响矩阵

| 变更 | 必须同步 |
| --- | --- |
| action key / UUID | manifest、action 模块、注册、Inspector UUID、文件名、图标、测试、3 份 action 文档与索引；桌面 `rebind`/`restart` |
| 新主题或主题 token | 业务插件和 template 的 `THEMES`、两份 `inspector-shared.js` 色卡、所有主题测试、本文 |
| 框架注入能力 | 业务插件和 template 的 `app.js` / `actions/index.js`，受影响 action、结构测试、本文 |
| 共享 Inspector 协议 | 业务插件和 template 两份共享文件、相关 Inspector 生命周期测试、本文 |
| 设置/运行态格式 | 存储兼容与损坏降级测试、受影响 action 文档；必要时增加版本/迁移 |
| 安全框或公共渲染 | 业务插件和 template 的共享层、所有 action 状态渲染测试、本文 |

## 10. 验证基线

文档所述实现完成至少要经过：

1. `npm test` 全绿。
2. `manifest.json`、模块、Inspector、图标四层一致。
3. action 模块无反向或横向 import，所有状态可从模块闭包独立渲染。
4. 改 `plugin/app.js` 或 `plugin/actions/*.js` 后以 `restart` 验证；纯 Inspector/静态资源可 `sync` 后重开面板。
5. 实机检查按钮渲染、Inspector 提交与回填、删除重拖后的 UUID 绑定。

候选调整可以继续提出，但在实现前只能写在任务或设计提案中；落地后再更新本规格的“当前行为”。
