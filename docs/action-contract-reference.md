# Action 运行契约

开发或修改 action 时读取。与 development-rules.md 冲突时以后者为准。

## 每个 action 的四层 + ACTION_CONFIGS 约束

四层齐全:`manifest.json` 声明 / `plugin/app.js` 的 `ACTION_CONFIGS[key]` / `property-inspector/<key>.{html,js}` / `assets/icons/`。

`ACTION_CONFIGS` 条目至少含 `defaults`、`createState`、`onRun`、`render`,且:

- `defaults` 只放可序列化设置,`createState` 只放运行态。
- 所有设置先经 `normalizeSettings` 再进 `render`;`render` 是纯函数,依赖 `settings + state`。
- 运行态统一放 `INSTANCES`,不跨 context 共享可变状态。
- 颜色/布局走 `THEMES` token(`mint`/`ember`/`mono`/`signal`),不在 action 内硬编码或新增私有主题。
- Property Inspector 复用 `property-inspector/inspector-shared.js`,共享字段固定 `title`/`subtitle`/`color`/`theme`。

四件套之外的可选生命周期钩子:`onReady(instance)` / `onSettingsChanged(instance, previousSettings)` / `onParamFromPlugin(instance, param)` / `persist`(默认持久化归一化后的完整设置,设 `false` 关闭,传筛选函数只保存指定字段)。

设置持久化由框架层统一负责(插件目录下 `data/action-settings.json`,记录键 `actionid::key`):**不要在框架事件里新增 action key 分支,也不要给 action 写私有持久化**。宿主恢复事件以本地 persisted 为权威并回推 Inspector,Inspector 提交事件以 incoming 为权威。完整条款见 [docs/development-rules.md](docs/development-rules.md) §4。

## 进程内隔离(单进程硬约束)

所有 action 共用一个 Node 进程(低系统占用),隔离由框架层保证,action 代码必须遵守:

- 不得直接调用 `setTimeout`/`setInterval`,统一走 `setInstanceTimeout(instance, slot, fn, ms)` / `clearInstanceTimeout` / `hasInstanceTimeout`;实例清除时框架 `disposeInstance` 统一回收。
- 进入 action 的入口(`onRun`/`render`/`createState`/定时器回调)已由 `guardAction`/`safeHandler` 兜底,单 action 抛错只让该键位显示 ERR 图,不影响进程。不要移除这些包裹。
- 异步 `onRun` 必须 return Promise,否则 rejection 逃逸出框架兜底。

