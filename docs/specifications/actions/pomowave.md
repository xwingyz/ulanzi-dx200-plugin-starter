# PomoWave 功能与技术规范

状态：持续维护  
最后代码核对：2026-07-18  
action key：`pomowave`  
UUID：`com.ulanzi.ulanzistudio.lexutility.pomowave`

**变更门槛：修改 PomoWave 的业务模块、manifest、Inspector、图标、设置、状态、提示音、持久化、交互、渲染或测试契约前，必须先完整阅读本文件；修改完成后，必须在同一次任务中同步必要的功能和技术变化，并更新“最后代码核对”日期。涉及基座时还必须读写 `../base.md`。**

## 1. 功能定位

PomoWave 是可跨睡眠和插件重启恢复的番茄钟。它在专注、短休息、长休息、完成态之间循环，以截止时间戳而非 tick 次数计算剩余时间，支持自动/手动衔接、提示音、暂停、跳过和重新开始当前工作。

四层实现：

- manifest：`manifest.json` 的 `Pomowave`。
- 业务：`plugin/actions/pomowave.js`。
- Inspector：`property-inspector/pomowave.html`、`pomowave.js`。
- 静态图标：`assets/icons/actionPomowave.svg`。

## 2. 用户功能与按键语义

- idle 短按：开始一段完整专注。
- 运行中短按：暂停；暂停中短按：从冻结剩余时间恢复。
- 按住至少 600ms 时显示反色确认，松开后执行长按：把当前工作重启为一段完整专注，保留已经完成的专注轮次。
- 等待下一阶段时短按：确认并从完整时长开始该阶段。
- 等待进入休息时长按：直接重启为新专注，相当于跳过休息。
- Inspector“跳过阶段”：视同当前阶段自然完成；专注仍计入轮次，但不播放提示音。idle 时无动作，done 时回到初始状态。
- Inspector“重置计时”：清空当前循环、轮次和计时状态，回到 idle。
- 点选提示音样式时立即试听；试听忽略总声音开关，但不改变计时状态。

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
| `repeatManualCue` | `false` | 字符串布尔值 | 手动确认阶段时是否循环提示 |
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

状态显示：`READY`、`FOCUS`、`SHORT`、`LONG`、`DONE`、`PAUSED`。专注结束会增加 `completedFocusRounds`；进入 done 时轮次归零。

## 5. 无漂移计时与恢复

运行中唯一时间事实源为 `phaseEndAt`：

```text
remaining = ceil((phaseEndAt - Date.now()) / 1000)
```

`remainingSec` 只作为暂停/空闲时冻结值和渲染缓存。tick 对齐下一个整秒边界，调度误差不会累计；系统睡眠或插件重启后，`onReady` 立即按墙上时钟追平，已经超时则推进阶段。

运行态版本为 `v: 1`，保存：`phase`、`running`、`remainingSec`、`totalSec`、`completedFocusRounds`、`phaseEndAt`。只在阶段转换、暂停/恢复、重置、设置重算和 dispose 时写盘，不逐秒写盘。版本不符或非法 phase 降级为初始状态。

## 6. 提示音

- macOS 使用 `afplay` 播放系统声音；Windows 使用 PowerShell beep；其他平台回退终端 bell。
- 自动开始下一阶段时只播一次。
- 只有阶段停在 `awaiting` 且 `repeatManualCue=true` 时循环播放，直到确认、跳过、重置或销毁。
- 播放器句柄、重复标记和 generation 都是实例运行态；generation 使旧播放器回调失效，避免跨阶段重新排音。
- `onDispose` 必须停止提示音后再 flush 状态。

## 7. 生命周期与定时器

| 钩子 | 行为 |
| --- | --- |
| `createState` | 创建阶段/计时/轮次/提示音状态并水合持久化运行态 |
| `onReady` | 初始化缺失值；运行中立即按当前时钟对齐并续排 tick |
| `onRun` | 处理短按与 awaiting 确认交互 |
| `onLongPress` | 重启完整专注；awaiting 休息时等价于跳过休息 |
| `onSettingsChanged` | 按比例重算当前阶段时长 |
| `onParamFromPlugin` | 处理 `previewSound`、`resetTimer`、`skipPhase` 控制命令 |
| `onDispose` | 停止声音并同步落盘 |
| `render` | 生成阶段 SVG data URL |

定时器 slot：`pomodoro`（tick 或 awaiting 闪烁复用）、`pomodoroCue`（循环提示）。

## 8. 键面显示

- 显示阶段标签、剩余 `MM:SS`、进度圆环、番茄图形与轮次信息。
- 圆环按已用时间顺时针填充；等待确认时按 550ms 周期闪烁。
- 最后 5 秒进入告警脉冲并可使用内框高亮。
- done 状态不显示番茄图形，避免把“完成”误看成仍在专注。
- 阶段色全部从当前公共 theme token 派生：focus 用 accent，短休息为 accent/text 混色，长休息用 muted，done 用 text；不维护私有阶段主题。

## 9. 已覆盖的关键验证

- 墙钟计时、睡眠间隔追平、暂停冻结与恢复 deadline。
- 状态序列化/水合、跳过语义、idle/done 边界。
- 短按/长按、awaiting 确认与跳过休息。
- 自动衔接与手动衔接、提示音开关/试听/循环规则。
- 各主题阶段色、进度方向、awaiting 闪烁和末段告警。

修改阶段图、长按语义、计时事实源、运行态字段或提示音生命周期时，应同步本文件并扩充 `tests/app-framework.test.js`；修改 Inspector 控制命令时还应更新 `tests/inspector-lifecycle.test.js`。
