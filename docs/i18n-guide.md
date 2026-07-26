# Action 多语言（i18n）实施手册

> 面向：处理**单个 action** 多语言的执行 agent。**两种场景都适用**——
> 给已有 action 补齐多语言（返工），以及开发**新 action** 时从一开始就做对（推荐）。
> 新 action 的总流程见 [development-rules.md](development-rules.md) §8，i18n 是其中一步；本手册是那一步的细则。
> 前置：基础层已就绪（见 [development-rules.md](development-rules.md) §7.1）。**本手册只讲 action 层怎么做，不要改基础层。**
> 首发语言：`en`（英文，回退基准）+ `zh_CN`（简体中文）。

> **新 action 请正向落地，别先写死一种语言再返工**：写 HTML/render 时默认文案直接用英文并挂 `data-localize`，同步把 key 加进两个语言文件。下面的"改造前/后"示例，"改造后"就是新 action 应有的样子。

> **语言选择器是框架自带的**：每个 PI 页面必须包含一个 `#uiLanguage <select>`（选项 `auto`/`en`/`zh_CN`，`Auto` 与标题 `Language` 走 `data-localize`），从任一现有页面复制即可；其行为（即时重定位 + 持久化 + 运行态同步）由 `inspector-shared.js` 自动接管，你**不用写任何绑定代码**。运行态 `render` 里取译文统一用 `t(key, instance.settings.uiLanguage)`，让按键图标跟随该实例所选语言。

---

## 0. 一句话目标

把你负责的 action 里**所有用户可见的文字**——配置界面（Property Inspector）+ 运行态按键图标 + manifest 动作名/提示——都变成"跟随宿主语言切换"，英文用户看英文、中文用户看中文。

## 1. 现状与缺口（先理解再动手）

当前每个 action 的文案基本是**单语言硬编码**（有的写死中文，有的写死英文），只有共享控件（保存 / 恢复默认 / 安全边框）走了本地化。所以你的活是：

1. **PI 页面**：把 action 专属的硬编码文案，改成 `data-localize` 机制，默认文案统一为**英文**。
2. **语言文件**：把这些英文 key 加进 `en.json`，中文译文加进 `zh_CN.json`，**两边 key 必须完全对齐**。
3. **运行态图标**：action 的 `render` 里如有硬编码英文/中文句子，改走 `t()`。
4. **动作名/提示**：核对 `en.json` / `zh_CN.json` 的 `Actions[]` 里你这个 action 的 `Name` / `Tooltip` 正确。

## 2. 六条黄金规则（不可违反）

1. **默认文案 = 英文 = key**。HTML 里元素的默认文字（或 placeholder）必须是英文，且 `data-localize` 的值就是这句英文。原因：`en.json` 是回退基准；遇到没有语言文件的 locale（如 `ja_JP`），界面直接保留英文默认值，不会漏出中文。
2. **key 两端对齐**。凡加进 `en.json` 的 key，必须同时加进 `zh_CN.json`（值为中文译文）。缺一边测试直接红。
3. **只翻 UI 文字，不翻数据**。数字、主机名、URL、IP、时间戳、用户输入回显、`ERR` 这类通用缩写——不要本地化。
4. **不碰基础层**。`libs/js/*`、`libs/node/i18n.js`、`inspector-shared.js`、`utils.js` 是框架，已冻结。你只改：本 action 的 `property-inspector/<action>.html`、`plugin/actions/<action>.js`、以及两个语言文件里属于你的 key。
5. **不新增语言文件**。首发只有 `en` + `zh_CN`，别加 `ja_JP.json` 之类。
6. **图标字形与文字分离**。当一个控件里既有图标字形（`◉ ↑ ✋` 等）又有文字时，把字形留在本地化节点**之外**，只给文字节点加 `data-localize`（见 §6 反例）。

## 3. 逐 action 操作步骤

### Step 1 — PI 页面：文案改造

打开 `property-inspector/<action>.html`，把每一处用户可见文字按 §5 的元素规则改造。核心动作：

- 默认文字改成英文；
- 加 `data-localize="<英文 key>"`。

**改造前（硬编码中文，反面）：**
```html
<label for="scope">节点区域</label>
<select id="scope">
  <option value="any">不限</option>
  <option value="mainland">中国大陆</option>
</select>
<input id="serverSearch" type="search" placeholder="城市、运营商、IP、Server ID">
```

**改造后（英文默认 + data-localize，正面）：**
```html
<label for="scope" data-localize="Server region">Server region</label>
<select id="scope">
  <option value="any" data-localize="Any">Any</option>
  <option value="mainland" data-localize="Mainland China">Mainland China</option>
</select>
<input id="serverSearch" type="search" data-localize="City, ISP, IP, Server ID"
       placeholder="City, ISP, IP, Server ID">
```

### Step 2 — 语言文件：加 key

在 `en.json` 和 `zh_CN.json` 的 `Localization` 段各加同一批 key：

`en.json`（英文，key 与值相同）：
```json
"Server region": "Server region",
"Any": "Any",
"Mainland China": "Mainland China",
"City, ISP, IP, Server ID": "City, ISP, IP, Server ID"
```
`zh_CN.json`（中文译文）：
```json
"Server region": "节点区域",
"Any": "不限",
"Mainland China": "中国大陆",
"City, ISP, IP, Server ID": "城市、运营商、IP、Server ID"
```

> 把你这个 action 的 key 放在一起、保持连续，方便协作与 review。

### Step 3 — 运行态图标文案（如有）

看 `plugin/actions/<action>.js` 的 `render`，如有硬编码的英文/中文**句子/标签**（不是数据），改走框架的 `t()`：

```js
// 改造前
<text ...>今日完成</text>
// 改造后（key 用英文，翻译进语言文件）
<text ...>${escapeXml(t('Done today'))}</text>
```
`t` 已通过工厂 `runtime` 注入。在你的 action 工厂里从 `runtime` 解构即可，和 `escapeXml` / `frameFor` 用法一样：
```js
export function createHealthBreakAction(runtime) {
  const { t, escapeXml, frameFor, /* ... */ } = runtime;
  // render 里：${escapeXml(t('Done today'))}
}
```
不要在 action 里自己 import 语言文件或 `libs/node/i18n.js`。运行态 key 同样要进 `en.json` / `zh_CN.json`。
> `ERR`、纯图标、单位符号（`ms` `%`）、数字不翻。

### Step 4 — 校验 Actions[] 动作名/提示

确认 `en.json` / `zh_CN.json` 的 `Actions[]` 中，**与你 action 在 manifest 里同一索引位**的 `Name` / `Tooltip` 已是正确译文（英文文件写英文，中文文件写中文）。顺序必须与 `manifest.json` 的 `Actions` 一致。

## 4. 元素类型对照表（localizeUI 的行为）

`localizeUI` 遍历 `[data-localize]`，按元素类型决定改哪个属性：

| 元素 | 本地化目标 | 你要做的 |
| --- | --- | --- |
| `<label>` / `<span>` / `<div>` / `<button>` 文本 | `textContent` | 加 `data-localize="English"`，默认文字写英文 |
| `<option>` | `textContent` | 每个 `<option>` 单独加 `data-localize`，`value` 不动 |
| `<input>` / `<textarea>` 占位符 | `placeholder` | 加 `data-localize`，`placeholder` 写英文 |
| 带 `title` 的元素（tooltip） | `title` | 加 `data-localize`，`title` 写英文 |

> 不要给 `<select>` 本身加 `data-localize`，只给它的 `<option>` 加。

## 5. 不要本地化的东西

- 动态数据：数字、百分比、延迟毫秒、主机名、URL、IP、Server ID、时间、日期、用户输入回显。
- 单位与通用符号：`ms`、`%`、`KB/s`、`↑ ↓`、`◉ ✋` 等字形。
- 通用缩写：`ERR`、`CPU`、`GPU`、`RAM`、`NAS`、`API`。
- 主题 key、CSS 类名、`value`、`data-*` 属性值、id/name。

## 6. 常见坑（都来自本仓库真实页面）

1. **图标 + 文字混在一起**（healthbreak 的动作组按钮）：
   ```html
   <!-- 反例：字形进了 key -->
   <button data-group-key="eyes">◉ 护眼 · 远眺与眨眼</button>
   <!-- 正例：字形留在外面，只本地化文字 -->
   <button data-group-key="eyes"><span aria-hidden="true">◉</span>
     <span data-localize="Eye care · look far & blink">Eye care · look far & blink</span></button>
   ```
2. **只翻了区块标题，漏了具体项**（chatgptusage 现状）：`data-localize="Rows"` 有了，但下面的 `次要窗口` / `重置券` 复选框文字漏翻。逐个控件过，别只翻大标题。
3. **默认文案写成中文**（speedtest 现状）：会让英文/未知语言用户看到中文。默认必须英文。
4. **只加 en 忘了 zh（或反之）**：key 不对齐，`tests/i18n.test.js` 立即失败。
5. **给 `<option>` 的父 `<select>` 加 data-localize**：无效。加到每个 `<option>`。
6. **运行态把数据也翻了**：如把主机名、数字包进 `t()`。只翻固定标签。

## 7. key 命名约定

- key **就是英文原文**（人类可读的完整短语），不要用 `action.field.label` 这种符号 key——本仓库/官方 SDK 都用"英文原文即 key"。
- 大小写、标点与英文默认文字**逐字一致**（`Show frame` ≠ `Show Frame`）。
- 能复用已有共享 key 就复用（如 `Save`、`Theme`、`Restore defaults`、`Safe frame`、`Show frame`、`Optimal area`），不要造同义新 key。先查 `en.json` 现有 key 再新增。

## 8. 验证（提交前必须全绿）

```bash
npm test
```
`tests/i18n.test.js` 会校验：en↔zh_CN 的 `Localization` key 完全对齐、`Actions[]` 与 manifest 数量一致、四段结构完整。**key 不对齐会直接红。**

同步到宿主实机看效果：
```bash
npm run dev:desktop -- --plugin com.ulanzi.lexutility.ulanziPlugin --mode restart
```
> 改了 `plugin/actions/*.js`（运行态）用 `restart`；只改 PI 的 `.html`/`.js` 用 `sync`。
在宿主把系统语言在中/英间切换（或用不同 locale 启动），确认 PI 界面与按键图标都随之切换、无漏译、无中英混排。

## 9. 完成定义（Definition of Done）

你负责的 action 满足全部才算完成：

- [ ] PI 页面所有用户可见文字都走 `data-localize`，默认文案为英文。
- [ ] 运行态 `render` 无硬编码英文/中文句子（数据/缩写除外），需要的都走 `t()`。
- [ ] 新增 key 已同时进 `en.json`（英文）与 `zh_CN.json`（中文），两端对齐。
- [ ] `Actions[]` 里本 action 的 `Name`/`Tooltip` 正确。
- [ ] `npm test` 全绿。
- [ ] `restart` 后实机中/英切换验证通过，无漏译、无中英混排。
- [ ] 没有改动基础层文件（`libs/*`、`inspector-shared.js` 等）。

## 10. 多 agent 协作（重要）

- **一个 agent 只负责一个 action**：只改该 action 的 `<action>.html`、`plugin/actions/<action>.js`。
- **语言文件是共享的**：`en.json` / `zh_CN.json` 会被多个 agent 同时改，容易冲突。约定：
  - 每个 action 的 key **成组连续**放置，组前留一行行内标记（如 `"__action:latency": "__marker"` 不可行——JSON 无注释，故改为：按 action 分组、组内按出现顺序排列，并在 PR/任务说明里列出本组新增 key 清单）。
  - 若并行执行，语言文件的合并冲突按**并集**解决（两个 action 的 key 都保留），再跑 `npm test` 确认对齐。
  - 更稳妥：由编排方串行合并各 action 的语言文件改动，或指定各 action 的 key 集互不重叠。
- **不需要回流模板**：action 专属内容不进 `template/`（模板有自己的脚手架 action）。只有基础层才回流，而你不改基础层。

---

**参考落地例**：`property-inspector/latency.html` + `plugin/actions/latency.js` 是已接入共享控件的样板；`chatgptusage.html` 展示了"部分本地化"的中间态（可作为"还差哪些"的对照）。反面完整例：`healthbreak.html`、`systemstatus.html`（当前 0 覆盖，适合作为练手对象）。
