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

## Action 开发

新增或修改 action 时读取 [运行契约](docs/action-contract-reference.md) 和 `docs/development-rules.md` 对应条款；涉及实例状态、定时器、异步异常或设置持久化时必须遵守其隔离要求。

## 宿主连接事实

- 桌面版 Studio 监听 `3906` 且**自动拉起插件主服务**;`run-plugin`(默认 39069)只用于 Simulator 工作流,桌面下不要手动跑。
- 桥接层自带 5 秒自动重连;连接失败崩溃 = 桥接层被改坏,先查 `libs/node/ulanzideckApi.js`。

## 常用命令(均从仓库根目录跑)

```bash
npm install                                          # 安装模板最小依赖
npm test                                             # 框架段/持久化/inspector 生命周期回归,改共享层必跑
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

## 验证

按改动选择验证：共享层必须通过 `npm test`，通用修复同轮回流 `template/`；action 行为改动需在宿主验证按钮、Inspector 刷新与实例绑定。纯文档修改不运行宿主全链路。同步文件不等于 Node 进程已加载新代码，宣称生效前核对运行态。不得为了通过测试改写未变化的共享语义。
