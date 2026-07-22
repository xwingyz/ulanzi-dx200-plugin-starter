# Ulanzi 插件开发规则

这份文档是本仓库（当前位于 `/Users/yuanlei/Documents/Lab/Ulanzi`）的长期开发约束，目标是让多个智能体可以在同一套基座上并行扩展多个 action，而不反复改坏宿主兼容性、目录结构或调试流程。

## 1. 目标与边界

- source of truth 只有当前仓库，任何新 action、共享逻辑、图标和调试脚本都先落在仓库内，再同步到宿主目录。
- 先对照 SDK 和已验证参考实现，再决定图标、字体、Property Inspector 和运行态渲染方案，不先猜 Ulanzi Studio 支持边界。
- 默认以“一个插件内多个 action 共用同一套渲染规范和设置协议”为前提，不为单个 action 发明独立框架。
- `~/Library/Application Support/Ulanzi/UlanziDeck/Plugins/` 里的同步副本不是可编辑源。

## 2. 仓库职责

```text
.
├── README.md
├── docs/
│   └── development-rules.md
├── scripts/
│   ├── create-plugin.mjs
│   ├── dev-desktop.mjs
│   ├── run-plugin.mjs
│   └── sync-plugin.mjs
├── template/
│   └── com.example.hello.ulanziPlugin/
│       ├── manifest.json
│       ├── plugin/
│       │   ├── app.js
│       │   └── actions/<key>.js
│       ├── property-inspector/
│       ├── assets/icons/
│       └── libs/
└── plugins/
    └── com.ulanzi.<plugin>.ulanziPlugin/
```

- `template/` 是脚手架母版。想让以后新插件自动带上某个规范，改这里。
- `plugins/` 是真实业务插件目录。只在这里实现具体 action 功能。
- `scripts/` 只负责生成、同步、重启和本地运行，不塞业务逻辑。
- `docs/` 只写长期规则、调试方法、决策边界和协作约束。

## 3. 命名规范

- 插件目录固定为 `com.ulanzi.<pluginSegment>.ulanziPlugin`。
- 插件 UUID 固定为 `com.ulanzi.ulanzistudio.<pluginSegment>`。
- action UUID 固定为 `com.ulanzi.ulanzistudio.<pluginSegment>.<actionKey>`。
- `actionKey` 只用小写 ASCII 字母和数字，必要时用单词直连，不用中划线。
- `manifest.json`、`plugin/actions/<key>.js`、`property-inspector/*.js` 里的 action identity 必须完全一致。

## 4. Action 设计约束

每个 action 必须同时具备这四层：

1. `manifest.json` 里的 action 声明。
2. `plugin/actions/<key>.js` 导出的 action 定义，并由 `plugin/actions/index.js` 注册。
3. `property-inspector/<action>.html` 和 `<action>.js`。
4. `assets/icons/` 里的静态图标。

每个 `ACTION_CONFIGS` 条目至少包含：

- `defaults`
- `createState`
- `onRun`
- `render`

每个 action 模块必须通过工厂函数返回 `{ key, config }`；测试辅助能力可额外放在 `testing`，由注册层统一汇总。`plugin/app.js` 只向工厂显式注入框架能力，不允许 action 直接 import `app.js`，也不允许 action 之间互相 import。

规则：

- `defaults` 只放可序列化设置，不放运行态临时值。
- `createState(instance)` 只初始化实例态，例如计数、开关、轮播步进；调用时 `instance` 的 `context` 与归一化后的 `settings` 已就绪，可据此水合持久化运行态（见「运行态持久化」），但不得在此发起探测、定时器或任何 I/O 以外的副作用。
- `onRun` 只处理按键行为，不直接写死 SVG 字符串。
- `onRun` 表示短按业务；长按业务声明在可选 `onLongPress`，不得在 action 内自行维护双击窗口或裸长按定时器。
- `render` 必须是纯渲染函数输入，依赖 `settings + state` 产出图标。
- 所有设置都先经 `normalizeSettings` 归一化，再进入 `render`。
- 通用字段（`title` / `subtitle` / `theme` / `frameSize` / `showFrame`）由框架归一化；action 私有字段由该 action 的可选 `normalizeSettings(settings, defaults)` 返回，框架不得持有 action 私有枚举或字段分支。
- 同一个 action 的运行态不跨 context 共享可变状态，统一放 `INSTANCES`。

### Action 与测试的代码隔离（强制项）

action 之间的隔离不止于业务代码，测试同样要隔离。以下每条都对应过真实回归：

- **每个 action 一份测试文件**：`tests/<key>-action.test.js`，只经 `ACTION_CONFIGS.<key>` 与该 action 自己 `testing` 导出的符号访问被测对象，不去碰兄弟 action 的 config 或 testing。
- **`testing` 导出名必须防撞**：所有 action 的 `testing` 由 `ACTION_TESTING = Object.freeze(Object.assign({}, ...))` 合并成一个对象，**同名键后者静默覆盖前者，没有任何报错**。后果极隐蔽——被覆盖那一方的测试仍会通过，但测的已经是别人的函数。因此凡是可能重名的通用符号（`applyResult` / `visibleRows` / `hydrateState` / `parseUsage` / `severityFromPercent` 等），导出时必须加 action 前缀（如 `chatgptApplyResult`）。新增 action 时先 grep 既有 `testing` 键名。
- **action 测试不得硬编码共享原语的渲染细节**：字号、几何、`renderMeterRow` / `formatCountdown` / `frameContent` 产出的具体数值属于共享层，共享层一改，所有硬编码它的 action 测试都会连带变红。断言应针对结构（元素个数、标签存在性、行数），而不是共享层的确切像素/字号。确有必要 pin 共享输出时，在断言处注明"随共享层一起变，非本 action 回归"，改共享原语时一并更新，不要当成 bug 排查。
- **测试必须确定性，不依赖实时钟**：`render` 或业务逻辑依赖 `Date.now()` 时，断言不能落在整数分钟等取整边界上——全量跑比单跑慢，执行耗时会让 `36m` 掉成 `35m`。**「单独跑绿、全量跑红」优先怀疑共享状态污染或实时钟依赖，而不是业务逻辑**。理想做法是给依赖时间的函数支持注入时钟（`render(instance, { now })`），使测试可控。
- **测试落盘必须隔离到仓库外**：靠 `npm test` 经 `--import ./tests/setup.mjs` 在模块加载前注入 `ULANZI_PLUGIN_DATA_DIR`（按 `PLUGIN_UUID` 分子目录，业务插件与 template 同进程 import 不互撞）。**不要直接 `node --test`**——路径常量是 import 期求值的，晚了就写进仓库 `data/`。`tests/test-isolation.test.js` 会在隔离失效时报错。

### 可选生命周期钩子与框架边界

action 可按需声明以下可选能力，未声明时框架直接跳过：

- `normalizeSettings(settings, defaults)`：只归一化本 action 的私有字段，返回的新对象与框架通用字段合并。
- `onReady(instance)`：实例完成本轮设置合并与渲染后的准备工作。
- `onLongPress(instance)`：按住达到基座阈值后标记成立，并在随后的 `keyup` 执行的业务。基座使用 SDK `keydown` / `keyup` 判定，默认阈值 600ms；同一次按压不再调用 `onRun`。
- `longPressMs`：可选长按阈值；没有明确交互理由时沿用 600ms 默认值。
- `onSettingsChanged(instance, previousSettings)`：响应归一化后的设置变化。
- `onParamFromPlugin(instance, param)`：处理 Property Inspector 来件中的 action 私有语义。
- `onDispose(instance)`：实例被宿主移除（`onClear`）或进程退出前的最后一次回调，用于把攒在内存里的运行态 flush 落盘。框架在此之后统一回收定时器，因此 `onDispose` 内不得再登记定时器或发起异步续作——只做同步落盘。
- `persist`：默认保存归一化后的完整设置；设为 `false` 关闭该 action 的持久化，或提供筛选函数只返回需要保存的字段。

### 运行态持久化（与设置持久化分离）

settings 与运行态是两套东西，不得混用同一个存储：

- 设置写 `data/action-settings.json`，由框架在设置合并后自动落盘，action 不经手。
- 运行态（如 latency 的 uptime 聚合桶）写 `data/action-state.json`，同样按 `actionid::key` 归档，但**由 action 自己决定何时读写**，框架只提供 `readPersistedState(context)` / `writePersistedState(context, data)` 两个通用入口。框架事件处理器不得自动读写运行态，也不得感知任何 action 的运行态结构。
- 运行态必须能在缺失或损坏时降级为空，action 不得因为读不到历史而报错——历史是增益，不是前置条件。
- 运行态落盘频率由 action 控制，但不得逐次探测就写盘；按语义边界（如聚合桶滚动）批量写，并在 `onDispose` 补一次 flush。
- 两个存储共用 `createSettingsStorage` 工厂：传 `storePath` 指定文件，传 `legacyPath: null` 关闭 legacy 迁移（legacy 迁移只对设置存储有意义）。
- 数据目录默认在插件目录下，`ULANZI_PLUGIN_DATA_DIR` 可覆盖（按 `PLUGIN_UUID` 分子目录）。宿主永远不设它，**它只服务于测试隔离**：多个测试会 import 真实 `app.js` 并触发真实落盘，不隔离就会把测试键写进仓库的 `plugins/*/data/`，再被 `install-plugin` 带到用户机器上。因此**用 `npm test` 跑测试，不要直接 `node --test`**——隔离靠 `--import ./tests/setup.mjs` 在模块加载前注入环境变量，路径常量是 import 期求值的，等测试跑起来再改已经晚了。`tests/test-isolation.test.js` 会在隔离失效时直接报错。

框架事件处理器只负责通用的实例管理、设置合并、持久化、回推和钩子分发，不得出现任何具体业务 action key，也不得为某个 action 新增专属分支。action 特有常量、I/O、状态机、渲染与字段归一化必须全部留在对应的 `plugin/actions/<key>.js`。

### 共享框架持久化

- 所有 action 的设置统一写入插件目录下的 `data/action-settings.json`，记录键固定为宿主 context 解码后的 `actionid::key`，不同 action、键位和实例不得共用可变记录。
- 宿主恢复事件（`onAdd` / `onParamFromApp`）以本地 persisted 设置为权威；合并并归一化后，框架必须无条件把完整权威设置回推给 Property Inspector。不能因宿主来件内容相同而省略回推：新 Inspector 可能在原始事件之后才完成加载，否则会停留在 HTML 默认值并在后续提交时污染持久化。
- Property Inspector 提交事件（`onParamFromPlugin`）以 incoming 设置为权威，使用户刚提交的值覆盖旧 persisted 值；随后再归一化、持久化并渲染。
- 写盘前必须比较**归一化后的持久化语义**；语义未变化时不重复写盘，不能只按原始来件或对象引用判断。
- 文件更新必须在目标文件同目录写临时文件，再用 rename 替换正式文件，避免半写入状态。
- 若新的 `action-settings.json` 存在但无法读取或解析，本次进程将存储置为只读并保留原文件，不得用空对象、默认值或 legacy 数据覆盖它。
- legacy 存储只允许在新的 `action-settings.json` 明确返回 `ENOENT` 时迁移；其他读取错误一律不得触发迁移。
- “恢复默认配置”走框架保留控制参数 `__resetDefaults: 'true'`（PI 发送、框架在 `pluginSubmit` 入口拦截）：框架把设置重置为 `defaults` 的归一化结果，按持久化语义变化决定是否写盘，随后触发 `onSettingsChanged`、渲染并把权威设置回推 PI 刷新表单。控制参数不进入设置合并、不落盘，也不透传给 action 的 `onParamFromPlugin`。
- Inspector WebSocket 连接成功后必须发送 `__requestSettings: 'true'`。框架用 persisted 语义创建或读取实例并回推完整权威设置，但不得写盘、渲染、调用 `onReady` 或转发业务钩子；该握手用于覆盖 PI 晚于宿主恢复事件加载的竞态。
- 框架回推完整设置时必须附带 `__settingsSync: 'true'`。宿主会把主进程发出的 `PARAMFROMPLUGIN` 广播回主进程；带此标记的消息只用于填充 Inspector，框架不得把广播回声合并、持久化、渲染或转发给 action 钩子。
- Inspector 通过浏览器桥提交完整设置时必须附带 `__settingsSubmit: 'true'`，框架在合并前移除该标记。没有控制参数、也没有此提交标记的 `PARAMFROMPLUGIN` 视为宿主缓存的旧同步快照，只读忽略；这保证升级后首次切换 action 也不会用旧表单值覆盖磁盘。

### 进程内隔离（单进程约束下的强制规则）

为控制系统占用，一个插件的所有 action 共用一个 Node 进程；隔离由框架层在进程内保证：

- action 代码不得直接调用 `setTimeout` / `setInterval`。统一使用框架的 `setInstanceTimeout(instance, slot, fn, ms)` / `clearInstanceTimeout(instance, slot)` / `hasInstanceTimeout(instance, slot)`，定时器句柄按实例登记，回调自动带异常兜底；实例被 `onClear` 移除时由框架 `disposeInstance` 统一回收，action 不需要（也不允许）自己维护裸句柄。
- 多实例争用同一排他资源（例如带宽测速）时，统一使用框架 `createExclusiveTaskQueue()` 创建的共享队列；资源名由业务定义，框架只负责同资源串行、同实例去重、排队/运行取消和 `AbortSignal`。不得在 action 内另造模块级 busy 标志或私有队列，`disposeInstance` 必须取消该实例仍在排队或运行的任务。
- 框架对所有进入 action 代码的入口统一兜底：`onRun`、`onLongPress`、`render`、`createState`、定时器回调、宿主事件处理均经 `guardAction` / `safeHandler` 包裹。单个 action 抛错只影响该实例：记日志、该键位显示 ERR 状态图（`renderErrorState`），进程与其他 action 不受影响。
- 异步 `onRun` / `onLongPress` 必须 return Promise（箭头函数省略大括号，或显式 `return`），否则 rejection 逃逸出框架兜底。
- 进程级 `unhandledRejection` / `uncaughtException` 只是最后一道网：记日志并维持进程存活，不作为常规错误处理途径；正常路径的错误必须在 `guardAction` 层被拦下。

## 5. 图标与按钮 UI 规范

按钮 UI 分成两层：

- 静态层：`manifest.json` 和 `States[].Image` 使用 `assets/icons/*.svg`，用于宿主未拉起运行态前的默认图标。
- 动态层：`plugin/app.js` 用 `setBaseDataIcon` 推送运行态 `data:image/svg+xml;base64,...`。

实体按压视觉由 Ulanzi Studio / 设备宿主原生实现，行为以官方 Codex Usage 插件为参考：插件不得在 `keydown` 时通过 SVG 矩阵、`viewBox` 或额外 `STATE` 图标模拟缩放，否则会与宿主动画叠加成两次缩放。共享基座只使用 SDK `keydown` / `keyup` 维护长按状态；按下期间不为按压反馈提交图标。达到长按阈值时，定时器只标记长按成立，并由基座直接反转 SVG 内的十六进制 RGB 色值、提交一次同尺寸图作为确认反馈；此时不得调用 `onLongPress`。不得依赖宿主可能忽略的 SVG filter，也不得改变 `viewBox`、transform 或任何几何尺寸，并保持到 `keyup`。松开时，若长按已成立则调用 `onLongPress` 并抑制 `onRun`，否则调用 `onRun`；随后清除反色态并按最新业务状态绘制一次正常颜色图。业务 action 不得各自绘制按压态或长按反馈。`run` 仅作为旧宿主兼容回退；当前 context 一旦观察到真实 key 事件，必须在调用 `eventProcessor.runtime()` 之前短路后续 `run`，防止重复执行业务。

统一要求：

- 所有运行态按钮按 256 x 256 画布设计。
- **安全边框**：内容一律画在 40..216 的设计箱内（所有坐标按此设计），不得越界；框架的 `frameFor` / `frameContent` 会按 `frameSize` 把内容等比缩放到目标安全区。两档范围：`optimal` 最佳显示（内容区内缩 30，等比放大约 1.11；壳→面板留白 12，与 max 一致——曾经内缩 40 的 1:1 映射会让内容挤在中央、离外框过远）、`max` 最大化（内容区内缩 18，等比放大 1.25）。
- **背景随安全框**：背景填充按预设的背景界（`bleed`）绘制，不永远铺满整键——`optimal` 背景内缩 12（键面留出真实边距），`max` 铺满（bleed 0）；装饰性背景（latency/pomowave 的主题渐变）必须整体等比缩放进同一背景界（transform 组）。**禁止用 `clipPath` 实现**：宿主 SVG 渲染器对 clipPath 支持不可靠，会静默失效导致背景不随框变化。
- **圆角规则**：嵌套方式参考 Apple 图标的同心圆角（内层圆角 = 外层圆角 − 层间距，下限 2），四角间隙均匀；但比例按 DX200 实体键角取 42/256 ≈ 16.41%（`FRAME_RADIUS_RATIO`，256 全幅时圆角 42）——Apple 的 22.37% 对本硬件偏大。半径一律由 `frameFor` 的 `radiusAt` 推导，不得在预设或 action 里硬编码圆角；连续曲率（squircle）按圆弧近似，不做模拟。
- **内框线（高亮区域）**：框架在面板内缘（`panel + 4`）预留一条默认不绘制的内框线；action 需要强调运行态（如 latency 掉线、pomowave 尾段脉冲）时用 `frameHighlight(frame, color)` 把它画出来，画在 `frameContent` 之外的真实坐标层。圆角同样由 `radiusAt` 同心推导，且不受 `showFrame` 影响；action 不得自绘几何不一致的高亮框。
- `showFrame` 只控制边框（外环/壳/面板描边）是否绘制，不改变内容布局几何——开关边框内容不跳动。`frameSize` / `showFrame` 是框架级共享设置，由 `normalizeSettings` 归一化，action 不得自行解析。
- 新 action 的 `render` 内容必须整体经 `renderScreenFrame(..., frame)` 或 `frameContent(frame, inner)` 输出，不允许绕过安全边框直接铺画布。
- 外框、屏幕、内面板优先复用 `renderScreenFrame` 这一层级，不为单 action 造完全不同的骨架。
- 文本、颜色、图形布局必须围绕 theme token，而不是在各 action 里散落硬编码。
- 默认保留“标题 1 行 + 次标题 1 行 + 主要信息区”的结构，除非功能本身不适合文本。
- 静态图标要表达 action 类型，动态图标要表达当前状态，两者职责不要混淆。
- 如果宿主对系统字体渲染不稳定，优先切到 path/glyph 方案，不继续堆字体 fallback。

## 6. 风格与主题规范

当前主题以 `THEMES` 为唯一来源，任何新 action 都从这里取值：

- `accent`
- `canvas`
- `panel`
- `shell`
- `text`
- `muted`
- `low`
- `contrast`

规则：

- 不在某个 action 内新增私有主题结构；若需要新 token，先扩 `THEMES` 的公共字段。
- theme 名称必须短且稳定，当前 9 套：`mint`（青绿）、`ember`（暖橙）、`mono`（灰阶）、`signal`（信号蓝）、`neon`（科幻霓虹）、`ice`（冷调冰蓝）、`sunset`（暖调落日）、`forest`（自然森林）、`sand`（浅色暖沙）。
- 强调色一律取当前 theme 的 `accent`，不提供按 action 的颜色覆盖设置（原 `settings.color` 已移除；action 运行态自有的颜色轮换如 swatch 属业务状态，不受此限）。
- **颜色只有 theme 这一个轴**：不得再引入与 theme 并列的第二个外观设置。原 `settings.backgroundStyle` 已移除——它的 `mist` / `paper` 把 shell、panel、描边、文字全部改写成硬编码浅色 hex，实质是一套与 `THEMES` 抢控制权的影子主题，9 套主题 × 4 种背景里大部分组合都因此失效。需要浅色外观就选 `sand` 主题；需要新外观就扩 `THEMES`，不要在 action 侧另开设置项。
- 新 action 默认先复用已有主题，不先新增新套。
- Property Inspector 的 theme 选项要和运行态 theme key 一一对应。
- PI 主题色卡由共享层按 `inspector-shared.js` 的 `THEME_SWATCHES` 动态渲染，五段按角色依次为：背景（`canvas`）、填充（`panel`）、边框（`low`）、强调（`accent`）、文字（`text`）；页面只保留空的 `.theme-row` 容器，不再逐页写色卡 CSS。
- 每套主题除五段色卡角色外，还必须提供语义告警色 `ok` / `warn` / `crit`，供需要分级预警的 action 使用（例如 claudeusage 的额度 severity）。它们**不进** `THEME_SWATCHES`——色卡只展示五个角色。取值要与该主题色调调和且在其 `canvas` 上有足够对比度；`sand` 是浅色主题，三色必须取深色档。注意 `sunset` 的 `accent` 本身是玫红、`forest` 的 `accent` 本身是绿，这两套下 `crit` / `ok` 与 `accent` 同色系，分级预警不能只靠颜色，需要配合非颜色信号（图形姿态、图标）。
- 新增主题的完整动作：扩 `THEMES`（业务插件与 template 两份，含 `ok` / `warn` / `crit`）→ 扩 `THEME_SWATCHES`。Pomowave 的阶段色必须从当前 theme token 派生，不再维护独立静态色板；两份主题与 Inspector 色卡的一致性、语义色的合法性与三色互异、以及 `THEMES` 在两份之间的完全一致，均由 `npm test` 校验锁定，漏改会直接红。

## 7. Property Inspector 共享规范

共享层以 `property-inspector/inspector-shared.js` 为中心，所有 action 都先复用这套协议：

- `initInspector(actionUuid, fields)` 负责连接、回填、提交。
- `collectSettings(fields)` 负责从 DOM 读值。
- `applySettings(fields, settings)` 负责回显。
- `bindThemeButtons(pushSettings)` 负责 theme 交互。

规则：

- 共享字段名固定使用 `title`、`subtitle`、`theme`、`frameSize`、`showFrame`；新增字段时保持同样命名风格。
- 每个 PI 页面必须提供安全边框控件：`#frameSize`（checkbox：选中=最佳范围 optimal、未选中=最大范围 max）与 `#showFrame`（checkbox），走 `data-localize` 文案。
- checkbox 默认映射 `'true'/'false'`；需要自定义值对时用 `data-on` / `data-off` 声明（如 `#frameSize` 的 `data-on="optimal" data-off="max"`），由共享层 `collectSettings` / `applySettings` 统一处理，不做字段名特判。
- action 私有 inspector 入口文件只做 `initInspector(...)` 调用，不写重复连接代码。
- HTML 表单结构保持 `#property-inspector` 和 `.uspi-wrapper`，不要每个 action 自定义 wrapper 约定。
- Inspector 里主题按钮的 `data-theme-value` 必须直接对应 `THEMES` key。
- 文本等连续输入统一使用 `400ms` 去抖自动提交，减少连续写盘；表单提交、主题等按钮操作必须 flush 待提交值并立即发送。
- 每个 PI 页面必须提供“保存”与“恢复默认”（`#resetDefaults`）按钮，以及内联反馈条（`#inspector-feedback` 容器 + `#feedback-saved` / `#feedback-reset` 文案）；两个按钮按下后由共享层 `flashInspectorFeedback` 显示反馈并自动隐藏。
- 恢复默认按钮只发送 `__resetDefaults` 控制参数并取消未提交的去抖尾值；默认值的唯一权威是插件侧 `ACTION_CONFIGS.defaults`，PI 页面不得自带默认值副本。
- PI 每次连接成功都发送一次 `__requestSettings` 控制请求；在收到权威回推前不得主动提交 HTML 初始值。

## 8. 新增 Action 的标准步骤

1. 先确认 action key、用途、默认标题和默认 theme。
2. 在 `manifest.json` 增加 action 项，补 `PropertyInspectorPath`、`Icon`、`UUID`。
3. 新建 `plugin/actions/<action>.js`，通过工厂返回 `{ key, config }`；私有常量、状态机、I/O、渲染和私有字段归一化都放在这里。
4. 只在 `plugin/actions/index.js` 导入并加入 `createActionModules(runtime)`；`ACTION_CONFIGS`、`ACTIONS`、`ACTION_KEY_BY_UUID` 由框架自动生成，不手写第二套映射。
5. 新建 `property-inspector/<action>.html` 和 `<action>.js`，优先从最接近的现有 action 复制。
6. 补 `assets/icons/action<Something>.svg`。
7. 新建 `tests/<key>-action.test.js`；`testing` 导出的通用符号加 action 前缀防撞（见 §4「Action 与测试的代码隔离」）。
8. 用 `npm run dev:desktop -- --plugin <plugin> --mode sync|rebind|restart` 验证。

## 9. 项目结构演进规则

- `plugin/app.js` 只保留宿主启动、共享主题/渲染原语、实例管理、存储、隔离与事件分发；不得重新放入具体 action 的常量、状态机、网络/进程 I/O 或 SVG 业务实现。
- action 模块只能使用工厂参数中显式注入的框架能力；不得直接访问 `$UD`、`INSTANCES`、持久化文件路径，也不得反向 import `app.js`。
- action 之间禁止互相 import。多个 action 第二次需要同一纯能力时，再把它提升为 `plugin/app.js` 的共享原语并显式注入；领域逻辑不能借“共享”之名上移。
- 单个 action 模块持续超过约 700 行且内部职责稳定时，可在 `plugin/actions/<key>/` 下继续拆 `state.js`、`render.js`、`service.js`，但只由该 action 的 `index.js` 对外暴露定义。
- 多个 action 共用的 inspector UI 片段，第二次出现时就应抽成共享 HTML/CSS 方案；不要等到第五个 action 再清理。
- 若单个插件开始承载明显不同的领域，优先拆成新插件，而不是无限堆 action。
- `libs/node` 和 `libs/js` 视为宿主桥接层，除非是通用 API 封装，不把业务代码塞进去。
- 新脚本若只服务单次排障，不进入 `scripts/`；只有可复用流程才纳入仓库脚本。

### 共享层回流（多 agent 协作强制项）

- 共享层指：`libs/`、`property-inspector/inspector-shared.js`、`plugin/app.js` 的框架段（THEMES、通用 normalize、INSTANCES、事件分发、隔离层）以及 `plugin/actions/index.js` 的注册协议。
- 在业务插件里对共享层做出的**通用**修复或增强，验证通过后必须同步回流 `template/`，同一次任务内完成，不留"以后再补"。
- 例行核对命令：`diff -rq template/com.example.hello.ulanziPlugin/libs plugins/<plugin>/libs`；`libs/node/utils.js` 里的 `__PLUGIN_NAME__` 是脚手架占位符，属预期差异，不算漂移。
- 浏览器桥接层（`libs/js/*`）与 `inspector-shared.js` 的双份一致性、以及 inspector 脚本对 `$UD` 方法的调用面，已由 `tests/inspector-bridge.test.js` 用真实桥接文件锁定；mock 掉 `$UD` 的测试看不见这类断裂，新增 `$UD` 用法时优先补真实桥接测试。
- 改共享层的任务，完成定义额外包含：模板与业务插件两份副本一致（占位符除外）、双份 `node --check` 通过、`npm test` 全绿。

## 10. 调试方法

先判断是哪一层出问题，再选动作：

### A. 静态图标层

- 看 `manifest.json` 的 `Icon` 和 `States[].Image` 是否指向真实文件。
- 看按钮是不是一直停在静态图标。如果是，先不要怀疑业务逻辑，先查运行态是否根本没接管。

### B. 运行态接管层

- 用 `npm run dev:desktop -- --plugin <plugin> --mode sync` 同步代码。
- 对比宿主插件目录里的 `plugin/app.js` 时间，确认文件确实同步过去。
- 查插件进程是否真在跑新代码，必要时重启 `Ulanzi Studio`。
- 重新拖放 action，排除旧 UUID / 旧实例仍绑在设备上的情况。

### C. Property Inspector 层

- 确认 `PropertyInspectorPath` 存在。
- 确认 action 的 inspector 入口 `.js` 调的是正确 UUID。
- 看字段是否能在 `onAdd` 和 `onParamFromApp` 后正确回填。

### D. 渲染层

- 优先验证 `render(instance)` 是否在 `onAdd`、`onRun`、`onParamFromApp` 后都能触发。
- 出问题先回退到最小 SVG，确认是布局问题还是宿主兼容问题。
- 文本显示不稳定时，先区分宿主字体问题和 SVG 结构问题。

### E. 模式选择

- 只改 Inspector 页面、静态资源：`sync`（PI 每次打开都重新加载，拷过去即生效）
- 改 `plugin/app.js` 或任何 `plugin/actions/*.js` 逻辑（含纯渲染函数）：`restart`。它们都由常驻 Node 主服务加载，`sync` 只拷文件不重载进程，改了也不会生效——不要被"只是改了渲染"骗过
- 改 UUID、action identity、按钮绑定关系：`rebind`
- 改 `manifest.json`、主入口、依赖、首次安装：`restart`

### F. 宿主连接层（端口与进程事实）

- 桌面版 Ulanzi Studio 的 WebSocket 监听 `127.0.0.1:3906`；官方 Simulator 监听 `127.0.0.1:39069`。两者不要混。
- **桌面工作流下宿主会自动拉起插件的 Node 主服务进程**（从 `~/Library/Application Support/.../Plugins/` 的同步副本）。不要再手动跑 `run-plugin` 连 3906——同一插件 UUID 双连接行为不可预期。`run-plugin` 只用于 Simulator 工作流（默认连 39069）。
- 桥接层（`libs/node/ulanzideckApi.js`）具备连接自愈：连不上宿主时打印中文提示并每 5 秒自动重连，进程不退出。如果看到进程因连接失败直接崩溃，说明桥接层被改坏或没回流，先查桥接层，不要在业务层加 try/catch 绕过。
- `restart` 模式会先清理宿主拉起的插件 Node 子进程再重启 Studio（孤儿进程会导致 Studio 重启失败或继续跑旧代码）。重启后验证顺序：主进程新 PID → `lsof -iTCP:3906` 有监听 → 插件子进程新 PID → 同步副本内容为新代码。
- **实机行为与新代码不符（改了没生效、无声音、按钮无反应）时，先证伪"旧进程 / 未同步"，再怀疑逻辑**。诊断命令：对仓库与宿主副本中实际修改的 `plugin/app.js` 或 `plugin/actions/<key>.js` 执行 `grep -c '<新加的符号>' <file>` 并比较——部署副本计数为 0，说明新代码根本没进 Studio 加载的那份副本，是常驻旧进程在跑，`restart` 即可，不是逻辑 bug。别在源码里反复找错。改插件侧 JS 后必须 `restart`（§10.E），Node 不热重载；纯 PI 页面改动 `sync` 后重开 PI 面板即可。

## 11. 协作与文档同步规范

### 文档先行与变更同步（强制项）

- **修改任何 action 功能或技术实现之前，必须先完整阅读该 action 的对应规格**：`docs/specifications/actions/<key>.md`。修改范围包括业务模块、manifest 声明、Property Inspector、静态/动态图标、设置、状态机、I/O、持久化、交互、渲染和测试契约。
- **修改任何基座功能或共享层之前，必须先完整阅读 `docs/specifications/base.md`**。修改范围包括 `plugin/app.js` 框架段、`plugin/actions/index.js` 注册协议、`libs/`、`inspector-shared.js`、共享主题/渲染原语、实例生命周期、存储、隔离、桥接和通用脚本语义。
- 同一次任务同时影响基座与 action 时，两类对应文档都必须在改代码前读取；影响多个 action 时，逐份读取所有受影响 action 规格，不能只读其中一份。
- 新增 action 时，先读 `docs/specifications/base.md`，并在实现前为新 action 建立 `docs/specifications/actions/<key>.md` 的初始规格，明确 identity、功能边界和技术契约。
- 修改完成后，必须在同一次任务中把必要的功能和技术变化更新到对应规格，并更新“最后代码核对”日期。必要变化至少包括：功能/交互、字段与默认值、状态机、生命周期、I/O 或依赖、持久化结构、渲染、错误语义、测试与部署要求中实际发生变化的部分。
- 纯内部重构若确认没有改变任何既有功能或技术契约，可以不改规格正文，但完成前仍必须逐项核对对应规格，并在任务交付中明确说明“已核对，无需更新正文”。不得以“只是重构”为由跳过修改前阅读。
- 对应规格未读取，或实现已经变化但规格尚未同步时，任务不得宣告完成、提交合并或进入部署验收。

文档映射与统一入口见 `docs/specifications/README.md`。长期硬约束仍以本文件为权威，具体实现行为以对应规格维护。

### 多智能体协作

- 开工前先声明本次只改哪个插件、哪个 action、哪一层。
- 一次任务最多同时改一个插件内的一类问题，避免一边改主题一边改同步脚本。
- 改共享层时必须说明会影响哪些现有 action。
- 新 action 的默认配置、字段命名和 theme key 必须与已有 action 对齐，不做“局部特例”。
- 没验证宿主运行态前，不得宣称“图标渲染不支持”或“字体不支持”。
- 如果需要新增公共约束，先改这份文档，再改模板或代码。

### 部署协同（多 agent 并行强制项）

多个 agent 各自在独立 worktree 里开发各自的 action 时，**开发与测试可以并行，部署到共享实机必须串行且只从主线**。原因是部署这一步有两个共享资源无法并发：

- **整目录替换**：`dev:desktop` 从 `process.cwd()` 的 `plugins/<plugin>` 全量同步到宿主副本（`syncPluginDir` 先清空再拷贝，仅保留 `data/`）。从缺少兄弟 action 的 worktree 部署，会把实机上别的 agent 的 action **静默删掉**。
- **全局单宿主重启**：`restart` 会 `pkill` 唯一的 Ulanzi Studio 及其插件 Node 子进程再拉起。一个 agent 的重启会把宿主从**所有**正在实机联调的 agent 脚下抽走。

因此强制：

1. **worktree 只用于构建 + `npm test`**，不直接部署到共享实机。
2. **部署只从主检出（`.git` 为目录的那份规范树）进行，且必须在该 action 已合并回主线之后**。一棵集成好的树 → 一次连贯部署。
3. 跨 action 的唯一改动接触点是 `plugin/actions/index.js` 与 `manifest.json`；这两个文件的合并冲突在主线上解决一次，然后由集成者部署一次，其他 agent 不各自抢重启。
4. 该约束由 `scripts/lib/worktree-guard.mjs` 机器执行：`dev-desktop.mjs` 在同步前调用 `assertDeployableRoot`，从联动 worktree 部署会直接报错退出；确需单人从 worktree 部署（无并行 agent）时附加 `--allow-worktree` 显式放行。判定只用文件系统事实（联动 worktree 的 `.git` 是文件而非目录），不依赖 git 可执行。

## 12. 完成定义

一个 action 开发完成，至少满足：

- `manifest.json`、`plugin/actions/<key>.js`、`property-inspector/`、`assets/icons/` 四层齐全，且已加入 `plugin/actions/index.js`。
- 修改前已完整阅读对应 action 规格；涉及基座时也已完整阅读基座规格。
- 必要的功能与技术变化已同步到对应规格，并更新“最后代码核对”日期；无正文变化时已完成逐项核对并在交付中说明。
- `npm test` 全绿（仓库根目录跑，覆盖框架段、持久化与 inspector 生命周期）。
- `sync` 或 `restart` 后能在宿主看到正确按钮。
- Inspector 改值后，按钮能实时或预期地刷新。
- 删除旧实例并重新拖放后，UUID 绑定正常。
- 没有把业务逻辑塞进桥接库或脚本目录。

改动触及共享层（框架段、`inspector-shared.js`、`libs/`）时，`npm test` 是**合并前的强制门槛**，不是可选项：这套测试正是用来兜住"单 action 改动打穿框架"的回归。测试失败时先查是否真的动了共享语义，不要为了让测试变绿而改测试预期。

## 13. 后续建议

- 下一步应把 `property-inspector` 的重复 HTML/CSS 抽成模板或共享样式，否则 action 一多会快速漂移。
- 如果未来 action 超过 8 个，建议补一份 `docs/action-catalog.md`，记录每个 action 的字段、默认 theme 和验证要点。
