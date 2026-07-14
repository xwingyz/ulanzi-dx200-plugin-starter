# AGENTS.md

Ulanzi DX200 / Ulanzi Deck 插件开发仓库的 agent 指令入口。

**长期规则的唯一权威是 [docs/development-rules.md](docs/development-rules.md)。** 本文件只放每次开工必须先知道的关键约束,详细条款一律以 development-rules.md 为准,两边冲突时以它为准。

## 第一原则

- source of truth 只有当前仓库。新 action、共享逻辑、图标、脚本都先落仓库,再同步到宿主。
- `~/Library/Application Support/Ulanzi/UlanziDeck/Plugins/` 里的同步副本**不是可编辑源**,不要直接改它。
- 没在宿主运行态验证前,不得断言“图标渲染不支持”或“字体不支持”。

## 仓库分工

- `template/` — 脚手架母版。想让以后新插件自动带上某规范,改这里。
- `plugins/com.ulanzi.<plugin>.ulanziPlugin/` — 真实业务插件,只在这里实现具体 action。
- `scripts/` — 只负责生成、同步、重启、本地运行,不放业务逻辑。
- `docs/` — 只写长期规则、调试方法、协作约束。

## 命名(四层必须完全一致)

- 插件目录:`com.ulanzi.<pluginSegment>.ulanziPlugin`
- 插件 UUID:`com.ulanzi.ulanzistudio.<pluginSegment>`
- action UUID:`com.ulanzi.ulanzistudio.<pluginSegment>.<actionKey>`
- `actionKey` 只用小写 ASCII 字母数字,无中划线。
- 同一 action key 贯穿:UUID、`ACTION_CONFIGS[key]`、`property-inspector/<key>.html` + `<key>.js`、`assets/icons/action<Key>.svg`。

## 每个 action 的四层 + ACTION_CONFIGS 约束

四层齐全:`manifest.json` 声明 / `plugin/app.js` 的 `ACTION_CONFIGS[key]` / `property-inspector/<key>.{html,js}` / `assets/icons/`。

`ACTION_CONFIGS` 条目至少含 `defaults`、`createState`、`onRun`、`render`,且:

- `defaults` 只放可序列化设置,`createState` 只放运行态。
- 所有设置先经 `normalizeSettings` 再进 `render`;`render` 是纯函数,依赖 `settings + state`。
- 运行态统一放 `INSTANCES`,不跨 context 共享可变状态。
- 颜色/布局走 `THEMES` token(`mint`/`ember`/`mono`/`signal`),不在 action 内硬编码或新增私有主题。
- Property Inspector 复用 `property-inspector/inspector-shared.js`,共享字段固定 `title`/`subtitle`/`color`/`theme`。

## 进程内隔离(单进程硬约束)

所有 action 共用一个 Node 进程(低系统占用),隔离由框架层保证,action 代码必须遵守:

- 不得直接调用 `setTimeout`/`setInterval`,统一走 `setInstanceTimeout(instance, slot, fn, ms)` / `clearInstanceTimeout` / `hasInstanceTimeout`;实例清除时框架 `disposeInstance` 统一回收。
- 进入 action 的入口(`onRun`/`render`/`createState`/定时器回调)已由 `guardAction`/`safeHandler` 兜底,单 action 抛错只让该键位显示 ERR 图,不影响进程。不要移除这些包裹。
- 异步 `onRun` 必须 return Promise,否则 rejection 逃逸出框架兜底。

## 宿主连接事实

- 桌面版 Studio 监听 `3906` 且**自动拉起插件主服务**;`run-plugin`(默认 39069)只用于 Simulator 工作流,桌面下不要手动跑。
- 桥接层自带 5 秒自动重连;连接失败崩溃 = 桥接层被改坏,先查 `libs/node/ulanzideckApi.js`。

## 常用命令(均从仓库根目录跑)

```bash
npm install                                          # 安装模板最小依赖
npm run new -- --id <id> --name "<Name>"             # 生成新插件
npm run install-plugin -- --plugin <pluginDir>       # 同步到本机 Ulanzi 插件目录
npm run dev:desktop -- --plugin <pluginDir> --mode <sync|rebind|restart>
npm run dev:sim -- --plugin <pluginDir>              # 同步到官方 Simulator
npm run run-plugin -- --plugin <pluginDir>           # 启动 Node.js 主服务
```

模式选择:

- 只改渲染逻辑 / 普通 JS / Inspector 页面 → `sync`
- 改 UUID / action identity / 按钮绑定 → `rebind`
- 改 `manifest.json` / 主入口 / 依赖 / 首次安装 → `restart`

## 多智能体协作

- 开工先声明:本次只改哪个插件、哪个 action、哪一层。
- 一次任务只改一类问题,不要一边改主题一边改同步脚本。
- 改共享层必须说明影响哪些现有 action,且通用修复必须在同一次任务内回流 `template/`(详见 development-rules.md §9「共享层回流」)。
- 要新增公共约束,先改 [docs/development-rules.md](docs/development-rules.md),再改模板或代码。

## 完成定义

四层齐全;`sync`/`restart` 后宿主显示正确按钮;Inspector 改值后按钮按预期刷新;删旧实例重拖后 UUID 绑定正常;业务逻辑没塞进桥接库或脚本目录。

详见 development-rules.md §4、§8、§12。
