# PomoWave 功能与技术规范

状态：持续维护  
最后代码核对：2026-07-29
action key：`pomowave`  
UUID：`com.ulanzi.ulanzistudio.lexutility.pomowave`

**变更门槛：修改 PomoWave 的业务模块、manifest、Inspector、图标、设置、状态、提示音、持久化、交互、渲染或测试契约前，必须先完整阅读本文件；修改完成后，必须在同一次任务中同步必要的功能和技术变化，并更新“最后代码核对”日期。涉及基座时还必须读写 `../base.md`。**

## 1. 功能定位

PomoWave 是可跨睡眠和插件重启恢复的番茄钟。它在专注、短休息、长休息、完成态之间循环，以截止时间戳而非 tick 次数计算剩余时间，支持自动/手动衔接、提示音、暂停和放弃当前阶段。

四层实现：

- manifest：`manifest.json` 的 `Pomowave`。
- 注册名称：英文 `Pomowave`，简体中文 `番茄钟`。
- 业务：`plugin/actions/pomowave.js`。
- Inspector：`property-inspector/pomowave.html`、`pomowave.js`。
- 静态图标：`assets/icons/actionPomowave.svg`。

## 2. 用户功能与按键语义

- idle 短按：开始一段完整专注。
- 运行中短按：暂停；暂停中短按：从冻结剩余时间恢复。
- 按住至少 600ms 时显示反色确认，松开后执行长按：当前阶段为专注（运行、暂停或等待确认）时，临时开关当前轮次背景音，不改变计时进度和 Inspector 配置；idle、休息和完成状态不执行任何业务。
- 等待下一阶段时短按：确认并从完整时长开始该阶段。
- Inspector“跳过阶段”：视同当前阶段自然完成；专注仍计入轮次，但不播放提示音。idle 时无动作，done 时回到初始状态。
- Inspector“重置计时”：清空当前循环、轮次和计时状态，回到 idle。
- 双击沿用共享 `dispatchShortPress`：第一次短按立即执行，同时保存按前阶段快照；第二次短按成立后放弃快照中的当前阶段并立即开始下一阶段，不受 `autoStartBreaks` / `autoStartFocus` 限制。放弃 focus 不增加完成轮次，放弃休息不改变轮次；awaiting 放弃键面显示的待确认阶段；idle 保持 idle；done 回到初始状态。
- 点选提示音样式时立即试听；背景音提供独立的试听/停止试听，所有试听都不改变计时状态。

## 3. 设置契约

| 字段 | 默认值 | 合法范围/选项 | 含义 |
| --- | --- | --- | --- |
| `focusMin` | `25` | 1..180 分钟 | 专注时长 |
| `shortBreakMin` | `5` | 1..60 分钟 | 短休息时长 |
| `longBreakMin` | `15` | 1..120 分钟 | 长休息时长 |
| `roundsBeforeLongBreak` | `4` | 2..8 | 每轮长休息前的专注次数 |
| `theme` | `ember` | 公共主题 key | 全局外观与阶段色来源 |
| `frameSize` | `optimal` | `optimal` / `max` | 安全显示范围 |
| `showFrame` | `true` | `true` / `false` | 是否绘制公共边框 |
| `soundStyle` | `glass` | `glass` / `hero` / `purr` / `submarine` | 提示音样式 |
| `soundEnabled` | `true` | 字符串布尔值 | 阶段结束是否发声 |
| `cueDuration` | `180` | `continuous` / `60` / `180` / `300` / `600` | 仅 awaiting 手动开始时循环提示的最长秒数；自动衔接仍只响一次 |
| `backgroundSound` | `rain` | `none` / `rain` / `clock` / `wave` / `forest` / `cafe` / `morning` / `summer` / `storm` / `stove` / `stream` / `deepSea` / `desert` / `chirp` / `boiling` / `musicBox` / `woodenFish` / `streetTraffic` | 随机关闭时的专注背景音固定选择 |
| `backgroundRandom` | `false` | 字符串布尔值 | 每个新 focus 轮次从 17 种声音中随机选择一次；开启时优先于 `backgroundSound`，即使固定项为 `none` 也会抽取 |
| `backgroundVolume` | `35` | `0..100` 的数字字符串 | 背景音及其试听的音量 |
| `autoStartBreaks` | `true` | 字符串布尔值 | 专注结束后是否自动开始休息 |
| `autoStartFocus` | `true` | 字符串布尔值 | 休息/完成后是否自动开始专注 |

持续时间在运行中改变时，按旧阶段的剩余比例映射到新时长，不把当前进度粗暴归零；idle 时重算默认专注时长。

## 4. 状态机

```text
idle -> focus
focus -> shortBreak                 未达到长休息轮次
focus -> longBreak                  达到 roundsBeforeLongBreak
shortBreak -> focus
longBreak -> done
done -> focus                       autoStartFocus=true
done -> idle                        autoStartFocus=false
```

当相应 auto-start 关闭时，目标阶段先进入 `awaiting`：计时未开始、满时长、圆环闪烁，等待用户确认。`awaiting` 是瞬时衔接态，不持久化；重建时以保存的阶段、running、剩余时间和 deadline 为准。

状态显示：`READY`、`FOCUS`、`SHORT`、`LONG`、`DONE`、`PAUSED`。除文案不同外，状态文字使用不同的主题语义色：READY 为 muted/text 混色，FOCUS 为 accent，SHORT 为 ok，LONG 为 muted/text 混色，DONE 为 text，PAUSED 为 warn。自然完成或 Inspector 跳过的专注会增加 `completedFocusRounds`；双击放弃专注不增加，进入 done 时轮次归零。

## 5. 无漂移计时与恢复

运行中唯一时间事实源为 `phaseEndAt`：

```text
remaining = ceil((phaseEndAt - Date.now()) / 1000)
```

`remainingSec` 只作为暂停/空闲时冻结值和渲染缓存。tick 对齐下一个整秒边界，调度误差不会累计；系统睡眠或插件重启后，`onReady` 立即按墙上时钟追平，已经超时则推进阶段。

运行态版本为 `v: 2`，保存：`phase`、`running`、`remainingSec`、`totalSec`、`completedFocusRounds`、`phaseEndAt`、`selectedBackgroundSound`、`backgroundMuted`、最近 35 个自然日的 `history`。历史按本机日期记录 focus、shortBreak、longBreak 的 completed/cancelled；本周从本地周一零点起算。自然完成与沿用既有语义的 Inspector 跳过计为 completed，双击明确放弃计为 cancelled。随机结果只在真正进入新 focus 轮次时生成，暂停/恢复及重启继续使用同一选择；长按临时静音在同一轮重启后保持，进入新 focus 时清除。旧版本、非法 phase 或残缺数据安全降级为初始状态。只在阶段转换、暂停/恢复、长按切换、重置、设置重算和 dispose 时写盘，不逐秒写盘。

## 6. 提示音

- 提示音仍使用 macOS `afplay`、Windows PowerShell beep 与其他平台终端 bell。自动开始下一阶段时只播一次；awaiting 依 `cueDuration` 循环，到期只停声、不离开 awaiting；`continuous` 直到用户操作或销毁。
- 背景音仅在 `focus + running + !backgroundMuted` 时播放。macOS 使用 `afplay`，Windows 使用 Windows Media Player COM，其他平台尝试 `ffplay`；平台或播放器不可用时静默降级。暂停优先续播，不能续播则恢复时从同一音源起点重播；运行中改音源、随机或音量立即重启，但不得越过当前轮次的长按临时静音。
- 17 条素材使用播放时特征增益，不改写或重新编码源文件，`backgroundVolume` 的 0–100 仍作为最终比例控制。持续且偏轻的环境声提升较多，尖锐、重复、瞬态明显或本身较响的声音保守提升：`forest +10 dB`；`rain`、`streetTraffic +9 dB`；`cafe`、`stream`、`desert`、`boiling +8 dB`；`wave +7 dB`；`clock`、`morning +6 dB`；`musicBox +5 dB`；`storm`、`chirp`、`woodenFish +4 dB`；`summer`、`deepSea +2 dB`；`stove +0.5 dB`。macOS 与 `ffplay` 可完整应用增益；Windows Media Player 在放大后达到 100 时安全截顶。
- 提示、背景、试听是独立的实例通道，分别持有子进程、generation、播放/暂停标记与实例定时器；背景试听至多 15 秒，`Stop preview` 可提前停止。generation 使旧回调失效。播放失败仅停止该音频通道，不改变计时、不显示 ERR。
- 背景资源位于 `assets/audio/pomowave/`，17 项 M4A 从本机 TickTick 8.0.80 的群组数据容器逐字节抽取，未转码、截断、归一化或淡化。文件身份、原文件名、SHA-256 及“授权状态未确认、不得据此对外分发”的边界见同目录 `CREDITS.md`。
- 旧设置值在归一化时兼容迁移：`fireplace -> stove`、`ocean -> wave`、`brownNoise -> deepSea`；运行态保存的旧选择按同一规则水合，不需要提升状态版本。
- `onDispose` 停止三个音频通道后再 flush 状态。

## 7. 生命周期与定时器

| 钩子 | 行为 |
| --- | --- |
| `createState` | 创建阶段/计时/轮次及三路音频通道状态并水合持久化运行态 |
| `onReady` | 初始化缺失值；运行中立即按当前时钟对齐并续排 tick |
| `onRun` | 保存按前阶段快照，处理短按与 awaiting 确认交互 |
| `onDoublePress` | 使用快照放弃当前阶段、不计未完成 focus，并强制启动下一阶段；不自行识别双击 |
| `onLongPress` | focus（运行、暂停或 awaiting）中切换当前轮次背景音；只更新业务状态，由共享 `endPress` 在清除反色后统一重绘一次；其他状态无动作 |
| `onSettingsChanged` | 按比例重算当前阶段时长；运行中的 focus 变更背景设置立即重启播放器 |
| `onParamFromPlugin` | 处理提示试听、背景试听/停止、状态请求、`resetTimer`、`skipPhase` 控制命令 |
| `onDispose` | 停止提示/背景/试听并同步落盘 |
| `render` | 生成阶段 SVG data URL |

定时器 slot：`pomodoro`（tick 或 awaiting 闪烁复用）、`pomodoroCue` 与 `pomodoroCueLimit`（循环提示及上限）、`pomodoroBackground`、`pomodoroPreview`。

## 8. 键面显示

- 显示阶段标签、剩余 `MM:SS`、进度圆环、番茄图形与轮次信息。
- 轮次完成度在状态文字下方显示为一排水平短灯，灯组相对原圆点位置上移；默认显示 4 灯，数量随 `roundsBeforeLongBreak` 在 2–8 之间变化。
- focus 键面在轮次灯下一行居中显示当前实际选中背景音的矢量图标，17 种声音各有独立图形；图标不绘制外圈，主体约为 20×20，固定为 `none` 或随机声音尚未生成时显示无声图标。暂停只停止播放，不改变图标状态；长按静音后图标整体变暗，并叠加覆盖主体范围的斜杠。
- 圆环按已用时间顺时针填充；等待确认时按 550ms 周期闪烁。
- 最后 5 秒进入告警脉冲并可使用内框高亮。
- done 状态不显示番茄图形，避免把“完成”误看成仍在专注。
- 阶段色全部从当前公共 theme token 派生：focus 用 accent，短休息为 accent/text 混色，长休息用 muted，done 用 text；不维护私有阶段主题。

Property Inspector 顶部显示只读状态卡：今日、本周的专注/短休息/长休息完成数与取消数，以及当前专注实际选择的背景声名称；尚未开始随机专注时显示“随机背景音”。Inspector 连接时通过 `__requestPomodoroStatus` 主动请求，阶段完成、取消、设置或背景声变化后由 action 回推 `pomodoroStatus`，统计字段不得进入 settings。

## 9. 已覆盖的关键验证

- 墙钟计时、睡眠间隔追平、暂停冻结与恢复 deadline。
- 状态序列化/水合、跳过语义、idle/done 边界。
- 短按、focus 运行/暂停/awaiting 时长按切换背景音、非 focus 长按无动作；长按释放只由共享 `endPress` 提交一次恢复帧。
- 自动衔接单次提示、awaiting 提示的 continuous/60/180/300/600 上限与清理。
- 专注临时静音的持久化/新轮次清除、按前快照双击边界（idle/done/awaiting/运行/暂停）、放弃 focus 不计轮次并强制启动下一阶段。
- 背景固定与随机选择、同轮/重启稳定性、音量、暂停恢复、设置变更、失败与销毁清理。
- Inspector、新旧设置升级、多语言、17 项音频资源、SHA-256 和来源记录一致性。
- 今日/本周统计边界、三阶段完成/取消计数、状态请求与当前背景声回显。
- 各主题阶段色与状态文字色、上移的水平轮次灯、灯组下方居中且无外圈的 17 种放大背景音图标及静音斜杠、进度方向、awaiting 闪烁和末段告警。

修改阶段图、长按语义、计时事实源、运行态字段或提示音生命周期时，应同步本文件并扩充 `tests/app-framework.test.js`；修改 Inspector 控制命令时还应更新 `tests/inspector-lifecycle.test.js`。

## 多语言契约

- Inspector 默认英文；静态文案使用 `data-localize`，自定义控制器通过共享 helper 处理 `uiLanguage`、权威设置回读和语言切换。
- 工作、短休、长休、暂停和等待确认等阶段文案按实例 `uiLanguage` 翻译；计时数值、阶段状态机与提示音数据不因语言改变。
- `en.json` 与 `zh_CN.json` 的 action 名称/说明顺序必须与 manifest 一致，新增键由 `tests/i18n.test.js` 锁定覆盖。
- 用户可见注册名称固定为英文 `Pomowave`、简体中文 `番茄钟`。
