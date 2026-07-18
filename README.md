# Ulanzi DX200 Plugin Starter

这个仓库提供一个可直接扩展的 Ulanzi DX200 / Ulanzi Deck JavaScript 插件最小框架。

长期协作规则见 [docs/development-rules.md](docs/development-rules.md)，基座架构分析见 [docs/base-architecture.md](docs/base-architecture.md)。

当前已经按官方 SDK 的公开约定收敛了最关键的命名规则：

- 插件目录：`com.ulanzi.{pluginName}.ulanziPlugin`
- 主插件 UUID：`com.ulanzi.ulanzistudio.{pluginName}`
- Action UUID：`com.ulanzi.ulanzistudio.{pluginName}.{actionName}`

目标不是复刻某个现成插件，而是给你一套后续可以持续复制的基座：

- 一个最小可运行插件模板
- 一套精简后的 Ulanzi WebSocket API 包装
- 一个简单的 Property Inspector
- 一个脚手架命令，用来生成多个独立插件

## 目录结构

```text
.
├── package.json
├── README.md
├── docs/
│   ├── base-architecture.md
│   └── development-rules.md
├── scripts/
│   ├── create-plugin.mjs
│   ├── dev-desktop.mjs
│   ├── run-plugin.mjs
│   └── sync-plugin.mjs
├── template/
│   └── com.example.hello.ulanziPlugin/
│       ├── manifest.json
│       ├── package.json
│       ├── assets/icons/
│       ├── libs/
│       ├── plugin/app.js
│       └── property-inspector/   # 每个 action 一组 <key>.html + <key>.js，共用 inspector-shared.js
└── plugins/
    └── com.ulanzi.lexutility.ulanziPlugin/   # 示例插件（6 个 action）
```

## 快速开始

先安装模板里需要的最小依赖：

```bash
npm install
```

生成一个新插件：

```bash
npm run new -- --id lex-utility --name "Lex Utility"
```

这会生成：

```text
plugins/com.ulanzi.lexutility.ulanziPlugin
```

默认规则：

- 插件目录：`com.ulanzi.<id>.ulanziPlugin`
- 插件 UUID：`com.ulanzi.ulanzistudio.<id>`
- 默认 action UUID：
  - `com.ulanzi.ulanzistudio.<id>.counter`
  - `com.ulanzi.ulanzistudio.<id>.badge`
  - `com.ulanzi.ulanzistudio.<id>.swatch`
  - `com.ulanzi.ulanzistudio.<id>.fontprobe`
- `id` 会被规整成单一段名，只保留字母数字；例如 `lex-utility` 会变成 `lexutility`

模板现在默认带 4 个示例 action，但结构不是固定 3 个，也不是固定 4 个。后续继续新增 action 时，主要补这几处：

- `plugin/app.js` 里的 `ACTION_CONFIGS`
- `manifest.json` 里的 `Actions`
- `property-inspector/` 对应页面和入口脚本
- `assets/icons/` 对应图标

也可以显式指定：

```bash
npm run new -- \
  --id my-status \
  --name "My Status" \
  --author "yuanlei" \
  --description "My first DX200 plugin" \
  --plugin-uuid "com.ulanzi.ulanzistudio.my.status" \
  --action-uuid "com.ulanzi.ulanzistudio.my.status.main"
```

## 安装到本机

生成插件后，先安装插件自己的依赖：

```bash
cd plugins/com.ulanzi.lexutility.ulanziPlugin
npm install
```

然后从仓库根目录同步到 macOS 的 Ulanzi 插件目录：

```bash
cd /Users/yuanlei/Documents/Lab/Ulanzi
npm run install-plugin -- --plugin com.ulanzi.lexutility.ulanziPlugin
```

默认目标目录：

```text
~/Library/Application Support/Ulanzi/UlanziDeck/Plugins/
```

安装脚本会：

- 校验插件目录是否存在
- 自动复制整个插件目录
- 覆盖同名旧版本

装完后重启 `UlanziDeck Studio`。

## 开发流

### 1. 桌面版开发流

同步到桌面版插件目录：

```bash
npm run dev:desktop -- --plugin com.ulanzi.lexutility.ulanziPlugin
```

默认模式是 `sync`，只做同步，不重启程序：

```bash
npm run dev:desktop -- \
  --plugin com.ulanzi.lexutility.ulanziPlugin \
  --mode sync
```

适用场景：

- 改普通 JS 逻辑
- 改 SVG 渲染
- 改 Property Inspector 页面

改了 UUID 或 action identity 时，用 `rebind`：

```bash
npm run dev:desktop -- \
  --plugin com.ulanzi.lexutility.ulanziPlugin \
  --mode rebind
```

这个模式会同步插件，然后明确提示你：

- 删除旧按钮实例
- 重新把 action 拖到键位上

改了 `manifest.json`、主服务入口或依赖时，用 `restart`：

```bash
npm run dev:desktop -- \
  --plugin com.ulanzi.lexutility.ulanziPlugin \
  --mode restart
```

这个模式会：

- 同步插件目录
- 关闭桌面版 `UlanziDeck`
- 重新启动 `Ulanzi Studio`

限制与边界：

- `sync` 不会自动重启桌面程序
- `rebind` 不会自动删除旧按钮实例
- `restart` 适合这些情况：
  - 新插件首次安装
  - `manifest.json` 变更
  - 插件 UUID / action UUID 变更
  - `plugin/app.js` 主服务入口或依赖变化

实际经验规则：

- 只改运行时渲染和按钮状态：`sync`
- 改 action 身份或 UUID：`rebind`
- 改宿主加载边界：`restart`

当前模板还给每个 action 标配了主题预设切换：

- `CRT Mint`
- `CRT Ember`
- `CRT Mono`
- `CRT Signal`

### 2. Simulator 开发流

先准备官方 Simulator：

```bash
cd /tmp/UlanziDeckPlugin-SDK/UlanziDeckSimulator
npm install
npm start
```

浏览器打开：

```text
http://127.0.0.1:39069
```

给当前 shell 设置 Simulator 根目录：

```bash
export ULANZI_SIMULATOR_DIR=/tmp/UlanziDeckPlugin-SDK/UlanziDeckSimulator
```

同步插件到 Simulator：

```bash
cd /Users/yuanlei/Documents/Lab/Ulanzi
npm run dev:sim -- --plugin com.ulanzi.lexutility.ulanziPlugin
```

这个命令等价于：

```bash
npm run sync-plugin -- \
  --target sim \
  --plugin com.ulanzi.lexutility.ulanziPlugin \
  --sim-root /tmp/UlanziDeckPlugin-SDK/UlanziDeckSimulator
```

然后点击 Simulator 页面里的 `Refresh Plugin List`。

对 Node.js 插件，还需要单独启动主服务：

```bash
cd /Users/yuanlei/Documents/Lab/Ulanzi
npm run run-plugin -- --plugin com.ulanzi.lexutility.ulanziPlugin
```

默认会连接：

- 地址：`127.0.0.1`
- 端口：`39069`

如果要显式指定：

```bash
npm run run-plugin -- \
  --plugin com.ulanzi.lexutility.ulanziPlugin \
  --address 127.0.0.1 \
  --port 39069
```

### 3. 推荐日常流程

改界面或交互时，优先走：

1. 保存代码
2. `npm run dev:sim -- --plugin com.ulanzi.lexutility.ulanziPlugin`
3. Simulator 里点 `Refresh Plugin List`
4. 如有 Node 主服务改动，重跑 `npm run run-plugin -- --plugin ...`

只有在这些情况再切回桌面版：

- 需要验证真实宿主行为
- 需要验证设备真机显示
- 需要验证 Simulator 不支持的行为

## 测试插件

先从仓库根目录运行共享框架测试：

```bash
npm test
```

该入口覆盖模板与示例插件的生命周期分发、设置优先级、持久化安全和实例隔离等框架行为；测试项会随框架演进，不以固定数量作为完成标准。宿主与真机行为仍按下列流程验证。

### 1. 在桌面版 UlanziDeck 中测试

1. 重启 `UlanziDeck Studio`
2. 在插件列表里找到你的插件
3. 把 action 拖到一个键位
4. 点击键位，确认按钮计数递增
5. 打开右侧属性面板，修改对应 action 的设置
6. 确认设备按钮图像实时刷新

这个模板默认包含 4 个 action：

- `Counter`（key `counter`）：点击后计数递增
- `Badge`（key `badge`）：点击后在 `LIVE / PAUSED` 之间切换
- `Swatch`（key `swatch`）：点击后在内置颜色盘之间轮换
- `Font Test`（key `fontprobe`）：固定显示 3 行 `测速128Kbps`，字号分别为 `28px / 32px / 36px`

> 约定：action key 用于 UUID、`ACTION_CONFIGS`、`property-inspector/<key>.html` 与 `<key>.js`、`assets/icons/action<Key>.svg` 四层命名，必须保持一致（详见 [docs/development-rules.md](docs/development-rules.md) §4、§8）。`Font Test` 的展示名是 “Font Test”，但 key 是 `fontprobe`，对应文件即 `fontprobe.html` / `fontprobe.js`。

仓库内的业务插件 `plugins/com.ulanzi.lexutility.ulanziPlugin` 不携带上述模板测试 action，只保留实际使用的工具：

- `Latency`（key `latency`）：网络/接口延迟监测展示
- `Pomowave`（key `pomowave`）：番茄钟节奏可视化

新增 action 时按相同四层命名扩展即可，不需要改脚手架。

两个业务 action 都复用内置主题、安全框和共享 Inspector。

图标基线：

- 示例 icon 统一使用 `256 x 256` 画布
- 实际主要内容收敛在中间约 `200 x 200` 安全区
- 外围约 `28px` 作为边缘不建议使用区，避免 DX200 小屏边缘观感发虚或被裁切

### 2. 用官方 Simulator 测试

官方 SDK 文档给出了 Simulator 流程：

1. 进入 `UlanziDeckSimulator`
2. `npm install`
3. `npm start`
4. 打开 `http://127.0.0.1:39069`
5. 用 `npm run dev:sim -- --plugin ...` 同步到 `UlanziDeckSimulator/plugins/`
6. 点击 `Refresh Plugin List`
7. 对 Node.js 插件，执行：

```bash
npm run run-plugin -- --plugin com.ulanzi.lexutility.ulanziPlugin
```

8. 把 action 拖到模拟器键位
9. 点击键位、打开属性面板、触发事件验证

注意：

- Simulator 不会自动启动 Node.js 主服务
- 桌面版 Studio 则监听 `127.0.0.1:3906` 并自动拉起已安装插件的主服务；桌面工作流不要手动运行 `run-plugin`
- `run-plugin` 默认连接 Simulator 的 `127.0.0.1:39069`，仅用于 Simulator 工作流
- `openurl` / `openview` 在浏览器模拟器里受限制

### 3. 调试

官方 SDK 文档给出两种调试方式：

- HTML 插件调试：启动 UlanziStudio 时加 `--webRemoteDebug`，再打开 `localhost:9292`
- Node.js 插件调试：启动 UlanziStudio 时加 `--nodeRemoteDebug`，再用 Chrome 打开 `chrome://inspect`

macOS 示例：

```bash
open /Applications/Ulanzi\ Studio.app --args --log --webRemoteDebug --nodeRemoteDebug
```

## 本地开发

1. 进入生成后的插件目录。
2. 安装依赖：

```bash
cd plugins/com.ulanzi.lexutility.ulanziPlugin
npm install
```

3. 用同步脚本同步到目标环境。

4. 重启 UlanziDeck Studio。

## 模板里包含什么

模板插件默认实现了一个最小交互闭环：

- 加到键位后显示一个 SVG 渲染的按钮
- Property Inspector 可修改标题、副标题、颜色和主题
- 点击键位可触发各 action 的默认交互
- 设置变化会实时回传并刷新按钮

这足够作为后续插件的开发基座：

- 如果你要做状态类插件，改 `plugin/app.js` 的数据获取和渲染
- 如果你要做控制类插件，改 `onRun` 逻辑
- 如果你要做配置面板，新增 `property-inspector/<action>.html` 与 `<action>.js`，并复用 `property-inspector/inspector-shared.js` 里的连接/回填/提交逻辑

## 当前实现与官方 SDK 的关系

这个仓库当前是“官方协议兼容的最小基座”，不是把官方 SDK 仓库原样 vendor 进来。

已经对齐的部分：

- 目录命名规则
- UUID 分段规则
- `manifest.json` 必需字段
- Property Inspector 与主服务的事件模型
- Node.js `ws` 通信方式
- 通过外部 `UlanziDeckSimulator` 目录进行同步和运行的开发流
- macOS 与 Windows 的桌面插件目录解析及同步入口

还没做的部分：

- 没有把官方 `common-html` / `common-node` 整包直接镜像进仓库
- 没有把官方 `UlanziDeckSimulator` 作为仓库子目录 vendor；通过 `--sim-root` 或 `ULANZI_SIMULATOR_DIR` 指向外部 SDK 目录
- Windows 已支持桌面插件目录解析、同步与 `restart` 流程；具体宿主可见行为仍需在对应平台实机验证

## 参考来源

这个最小框架是从以下仓库提炼共性后整理出来的：

- [JEAN-ALMEIDA-CZO/Ulanzi-Uptime-Monitor-Plugin](https://github.com/JEAN-ALMEIDA-CZO/Ulanzi-Uptime-Monitor-Plugin)
- [JEAN-ALMEIDA-CZO/Ulanzi-Pomodoro-Timer](https://github.com/JEAN-ALMEIDA-CZO/Ulanzi-Pomodoro-Timer)
- [narlei/ulanzideck_claude](https://github.com/narlei/ulanzideck_claude)
