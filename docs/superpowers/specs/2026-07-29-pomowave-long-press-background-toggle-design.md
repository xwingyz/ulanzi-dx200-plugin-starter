# PomoWave 长按切换当前专注背景音设计

## 目标

调整 PomoWave 长按语义：当前阶段为专注时，长按临时开关当前专注轮次的背景音；非专注阶段继续沿用原来的暂停式重置。

## 行为契约

- `focus + running`：长按切换当前轮次的临时静音状态。关闭时立即停止背景播放器；开启时继续使用本轮已选声音并立即播放。
- `focus + paused`：长按只切换临时静音状态。下一次恢复倒计时时，根据该状态决定播放或保持静音。
- 进入新的 focus 轮次时清除临时静音，重新遵循 Inspector 中的固定/随机背景音和音量设置。
- `idle`、`shortBreak`、`longBreak`、`done` 及 `awaiting`：长按继续停止所有声音，并重置为完整且暂停的 focus，保留已完成专注轮次。
- 长按不修改 `backgroundSound`、`backgroundRandom` 或 `backgroundVolume`，不改变用户的持久化配置。

## 状态与恢复

新增实例态 `backgroundMuted`。它只描述当前 focus 轮次是否被长按临时静音，与播放器进程是否因暂停而挂起分开。

`backgroundMuted` 随 PomoWave `v2` 运行态保存和水合，使插件重启后不会在同一轮专注中意外恢复声音。旧状态缺失该字段时按 `false` 处理。开始新 focus 时将其重置为 `false`。

背景音启动函数在创建或恢复播放器前检查 `backgroundMuted`；静音时确保播放器已停止并返回。设置变更不会越过临时静音重新启动背景音。

## 实现边界

仅修改：

- `plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/actions/pomowave.js`
- `tests/pomowave-action.test.js`
- 必要的聚合回归测试
- `docs/specifications/actions/pomowave.md`

不修改共享按键分派、长按阈值、Inspector、音频资源和其他 action。

## 验收

- 运行中 focus 长按可关闭并再次开启同一背景声音。
- 暂停中 focus 长按可控制下次恢复时是否播放。
- 同一轮插件重启后保留临时静音。
- 新 focus 自动清除临时静音。
- 非 focus 长按仍执行原暂停式重置。
- 提示音、预览音和背景音通道互不干扰，停止后无残留播放器进程。
- `npm test` 全部通过；使用 desktop `restart` 部署后核对宿主副本与仓库一致。
