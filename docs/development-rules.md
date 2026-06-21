# Ulanzi 插件开发规则

这份文档是 `/Users/yuanlei/Documents/Personal/Ulanzi` 的长期开发约束，目标是让多个智能体可以在同一套基座上并行扩展多个 action，而不反复改坏宿主兼容性、目录结构或调试流程。

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
│       ├── plugin/app.js
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
- `manifest.json`、`plugin/app.js`、`property-inspector/*.js` 里的 action identity 必须完全一致。

## 4. Action 设计约束

每个 action 必须同时具备这四层：

1. `manifest.json` 里的 action 声明。
2. `plugin/app.js` 里的 `ACTION_CONFIGS[actionKey]`。
3. `property-inspector/<action>.html` 和 `<action>.js`。
4. `assets/icons/` 里的静态图标。

每个 `ACTION_CONFIGS` 条目至少包含：

- `defaults`
- `createState`
- `onRun`
- `render`

规则：

- `defaults` 只放可序列化设置，不放运行态临时值。
- `createState` 只初始化实例态，例如计数、开关、轮播步进。
- `onRun` 只处理按键行为，不直接写死 SVG 字符串。
- `render` 必须是纯渲染函数输入，依赖 `settings + state` 产出图标。
- 所有设置都先经 `normalizeSettings` 归一化，再进入 `render`。
- 同一个 action 的运行态不跨 context 共享可变状态，统一放 `INSTANCES`。

## 5. 图标与按钮 UI 规范

按钮 UI 分成两层：

- 静态层：`manifest.json` 和 `States[].Image` 使用 `assets/icons/*.svg`，用于宿主未拉起运行态前的默认图标。
- 动态层：`plugin/app.js` 用 `setBaseDataIcon` 推送运行态 `data:image/svg+xml;base64,...`。

统一要求：

- 所有运行态按钮按 256 x 256 画布设计。
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
- theme 名称必须短且稳定，当前使用 `mint`、`ember`、`mono`、`signal`。
- `settings.color` 是用户覆盖色，只覆盖强调色，不改整套 theme。
- 新 action 默认先复用已有 4 套主题，不先新增第 5 套。
- Property Inspector 的 theme 选项要和运行态 theme key 一一对应。

## 7. Property Inspector 共享规范

共享层以 `property-inspector/inspector-shared.js` 为中心，所有 action 都先复用这套协议：

- `initInspector(actionUuid, fields)` 负责连接、回填、提交。
- `collectSettings(fields)` 负责从 DOM 读值。
- `applySettings(fields, settings)` 负责回显。
- `bindThemeButtons(pushSettings)` 负责 theme 交互。

规则：

- 共享字段名固定使用 `title`、`subtitle`、`color`、`theme`；新增字段时保持同样命名风格。
- action 私有 inspector 入口文件只做 `initInspector(...)` 调用，不写重复连接代码。
- HTML 表单结构保持 `#property-inspector` 和 `.uspi-wrapper`，不要每个 action 自定义 wrapper 约定。
- Inspector 里主题按钮的 `data-theme-value` 必须直接对应 `THEMES` key。
- 输入事件默认即时同步，只有昂贵操作才允许手动提交。

## 8. 新增 Action 的标准步骤

1. 先确认 action key、用途、默认标题和默认 theme。
2. 在 `manifest.json` 增加 action 项，补 `PropertyInspectorPath`、`Icon`、`UUID`。
3. 在 `plugin/app.js` 的 `ACTION_CONFIGS` 加条目。
4. 在 `ACTIONS` / `ACTION_KEY_BY_UUID` 现有映射机制下复用自动注册，不再手写第二套映射。
5. 新建 `property-inspector/<action>.html` 和 `<action>.js`，优先从最接近的现有 action 复制。
6. 补 `assets/icons/action<Something>.svg`。
7. 用 `npm run dev:desktop -- --plugin <plugin> --mode sync|rebind|restart` 验证。

## 9. 项目结构演进规则

- 多个 action 共用的渲染基础能力优先提到 `plugin/` 内共享函数，不复制到多个 `renderXxx`。
- 多个 action 共用的 inspector UI 片段，第二次出现时就应抽成共享 HTML/CSS 方案；不要等到第五个 action 再清理。
- 若单个插件开始承载明显不同的领域，优先拆成新插件，而不是无限堆 action。
- `libs/node` 和 `libs/js` 视为宿主桥接层，除非是通用 API 封装，不把业务代码塞进去。
- 新脚本若只服务单次排障，不进入 `scripts/`；只有可复用流程才纳入仓库脚本。

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

- 只改渲染逻辑、普通 JS、Inspector 页面：`sync`
- 改 UUID、action identity、按钮绑定关系：`rebind`
- 改 `manifest.json`、主入口、依赖、首次安装：`restart`

## 11. 多智能体协作规范

- 开工前先声明本次只改哪个插件、哪个 action、哪一层。
- 一次任务最多同时改一个插件内的一类问题，避免一边改主题一边改同步脚本。
- 改共享层时必须说明会影响哪些现有 action。
- 新 action 的默认配置、字段命名和 theme key 必须与已有 action 对齐，不做“局部特例”。
- 没验证宿主运行态前，不得宣称“图标渲染不支持”或“字体不支持”。
- 如果需要新增公共约束，先改这份文档，再改模板或代码。

## 12. 完成定义

一个 action 开发完成，至少满足：

- `manifest.json`、`plugin/app.js`、`property-inspector/`、`assets/icons/` 四层齐全。
- `sync` 或 `restart` 后能在宿主看到正确按钮。
- Inspector 改值后，按钮能实时或预期地刷新。
- 删除旧实例并重新拖放后，UUID 绑定正常。
- 没有把业务逻辑塞进桥接库或脚本目录。

## 13. 后续建议

- 下一步应把 `property-inspector` 的重复 HTML/CSS 抽成模板或共享样式，否则 action 一多会快速漂移。
- 如果未来 action 超过 8 个，建议补一份 `docs/action-catalog.md`，记录每个 action 的字段、默认 theme 和验证要点。
