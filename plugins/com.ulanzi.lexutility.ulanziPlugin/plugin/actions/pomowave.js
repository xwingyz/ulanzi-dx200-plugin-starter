import { execFile } from 'node:child_process';
import os from 'node:os';

export function createPomowaveAction(runtime) {
  const {
    clearInstanceTimeout,
    escapeXml,
    frameContent,
    frameFor,
    frameHighlight,
    instances: INSTANCES,
    mixHex,
    normalizeBooleanString,
    normalizeChoice,
    normalizeNumberString,
    readPersistedState,
    renderInstance,
    renderThemeBackdrop,
    setInstanceTimeout,
    themeFor,
    toDataUrl,
    writePersistedState,
  } = runtime;

const POMODORO_SOUND_STYLES = ['glass', 'hero', 'purr', 'submarine'];
const POMODORO_ALERT_WINDOW_SEC = 5;
const POMODORO_CYCLE_COMPLETE_SEC = 4;
const POMODORO_STATE_VERSION = 1;
const POMODORO_PHASES = ['idle', 'focus', 'shortBreak', 'longBreak', 'done'];
const POMODORO_DOUBLE_TAP_MS = 400;
const POMODORO_BLINK_MS = 550;
const POMODORO_CUE_REPEAT_DELAY_MS = 150;
const POMODORO_MAC_SOUND_MAP = {
  glass: 'Glass',
  hero: 'Hero',
  purr: 'Purr',
  submarine: 'Submarine',
};
const POMODORO_WINDOWS_SOUND_MAP = {
  glass: [880, 160],
  hero: [988, 170],
  purr: [659, 220],
  submarine: [392, 260],
};

function isEnabled(value) {
  return String(value) === 'true';
}

function pomodoroPalette(settings) {
  const theme = themeFor(settings);
  return {
    // 阶段差异保留在同一主题的明度层级内，避免独立红/绿/蓝色板只改变部分画面。
    focus: theme.accent,
    shortBreak: mixHex(theme.accent, theme.text, 0.28),
    longBreak: theme.muted,
    done: theme.text,
  };
}

function pomodoroColor(settings, phase) {
  const palette = pomodoroPalette(settings);
  return palette[phase] || palette.focus;
}

function pomodoroDurationSecFromSettings(settings, phase) {
  if (phase === 'focus') {
    return (Number.parseInt(settings.focusMin, 10) || 25) * 60;
  }
  if (phase === 'shortBreak') {
    return (Number.parseInt(settings.shortBreakMin, 10) || 5) * 60;
  }
  if (phase === 'longBreak') {
    return (Number.parseInt(settings.longBreakMin, 10) || 15) * 60;
  }
  return POMODORO_CYCLE_COMPLETE_SEC;
}

function pomodoroRoundsGoal(settings) {
  return Number.parseInt(settings.roundsBeforeLongBreak, 10) || 4;
}

function pomodoroPhaseLabel(instance) {
  if (instance.phase === 'idle') {
    return 'READY';
  }
  // 待命（awaiting）与运行态一样显示阶段名，只有真正暂停才显示 PAUSED。
  const active = instance.running || instance.awaiting;
  if (instance.phase === 'focus') {
    return active ? 'FOCUS' : 'PAUSED';
  }
  if (instance.phase === 'shortBreak') {
    return active ? 'SHORT' : 'PAUSED';
  }
  if (instance.phase === 'longBreak') {
    return active ? 'LONG' : 'PAUSED';
  }
  return 'DONE';
}

function formatPomodoroTime(totalSeconds) {
  const safe = Math.max(0, totalSeconds || 0);
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function clearPomodoroTimer(instance) {
  clearInstanceTimeout(instance, 'pomodoro');
}

// 决定该不该响、响哪种：与实际发声副作用分离，便于无声测试。
// options.style 覆盖 settings.soundStyle（PI 试听用），options.ignoreEnabled 让试听
// 无视 soundEnabled 开关——用户主动点按试听时，就是要听到声音。
function pomodoroCuePlan(settings, options = {}) {
  if (!options.ignoreEnabled && !isEnabled(settings.soundEnabled)) {
    return null;
  }
  return normalizeChoice(options.style ?? settings.soundStyle, 'glass', POMODORO_SOUND_STYLES);
}

function playPomodoroCue(settings, options = {}) {
  const style = pomodoroCuePlan(settings, options);
  if (!style) {
    return null;
  }

  const onComplete = typeof options.onComplete === 'function' ? options.onComplete : () => {};

  if (os.platform() === 'darwin') {
    const soundName = POMODORO_MAC_SOUND_MAP[style] || POMODORO_MAC_SOUND_MAP.glass;
    return execFile('afplay', [`/System/Library/Sounds/${soundName}.aiff`], onComplete);
  }

  if (os.platform() === 'win32') {
    const [frequency, duration] = POMODORO_WINDOWS_SOUND_MAP[style] || POMODORO_WINDOWS_SOUND_MAP.glass;
    return execFile(
      'powershell',
      ['-NoProfile', '-Command', `[console]::beep(${frequency},${duration})`],
      onComplete,
    );
  }

  process.stdout.write('\u0007');
  onComplete(null);
  return null;
}

function shouldRepeatPomodoroCue(settings, { autoStart = false } = {}) {
  return !autoStart && isEnabled(settings.repeatManualCue);
}

function stopPomodoroCue(instance) {
  instance.cueRepeating = false;
  instance.cueGeneration = (instance.cueGeneration || 0) + 1;
  clearInstanceTimeout(instance, 'pomodoroCue');
  const processHandle = instance.cueProcess;
  instance.cueProcess = null;
  if (processHandle && typeof processHandle.kill === 'function' && !processHandle.killed) {
    try {
      processHandle.kill();
    } catch {
      // 播放器可能刚好自行退出；停止提示音不应影响计时器。
    }
  }
}

// 阶段结束提示音：自动进入下一阶段永远只播一次；手动确认模式可按设置循环，直到用户启动下一阶段。
function playPomodoroPhaseEndCue(instance, { autoStart = false } = {}) {
  stopPomodoroCue(instance);
  if (!pomodoroCuePlan(instance.settings)) {
    return;
  }
  const repeat = shouldRepeatPomodoroCue(instance.settings, { autoStart });
  instance.cueRepeating = repeat;
  const generation = instance.cueGeneration;

  const playNext = () => {
    let processHandle = null;
    processHandle = playPomodoroCue(instance.settings, {
      onComplete: (error) => {
        if (instance.cueGeneration !== generation) {
          return;
        }
        if (instance.cueProcess === processHandle) {
          instance.cueProcess = null;
        }
        if (!instance.cueRepeating) {
          return;
        }
        const delay = error ? 1000 : POMODORO_CUE_REPEAT_DELAY_MS;
        setInstanceTimeout(instance, 'pomodoroCue', playNext, delay);
      },
    });
    instance.cueProcess = processHandle;
  };

  playNext();
}

// 剩余时间只有一个事实源：运行中看 phaseEndAt 与时钟的差，暂停/空闲看冻结的 remainingSec。
// 逐秒递减计数会把 setTimeout 误差累积成漂移，还会在系统睡眠时凭空"丢时间"。
function pomodoroRemainingSec(instance, now = Date.now()) {
  if (instance.running && Number.isFinite(instance.phaseEndAt)) {
    return Math.max(0, Math.ceil((instance.phaseEndAt - now) / 1000));
  }
  return Math.max(0, Math.round(instance.remainingSec ?? instance.totalSec ?? 0));
}

function serializePomodoroState(instance) {
  return {
    v: POMODORO_STATE_VERSION,
    phase: instance.phase,
    running: Boolean(instance.running),
    remainingSec: instance.remainingSec,
    totalSec: instance.totalSec,
    completedFocusRounds: instance.completedFocusRounds || 0,
    phaseEndAt: instance.phaseEndAt ?? null,
  };
}

function hydratePomodoroState(raw, now = Date.now()) {
  const valid = raw && typeof raw === 'object' && raw.v === POMODORO_STATE_VERSION
    && POMODORO_PHASES.includes(raw.phase);
  if (!valid) {
    return {};
  }
  const completedFocusRounds = Number.isFinite(raw.completedFocusRounds)
    ? Math.max(0, Math.round(raw.completedFocusRounds))
    : 0;
  const totalSec = Number.isFinite(raw.totalSec) && raw.totalSec > 0 ? Math.round(raw.totalSec) : null;
  const running = Boolean(raw.running) && Number.isFinite(raw.phaseEndAt);
  const remainingSec = running
    ? Math.max(0, Math.ceil((raw.phaseEndAt - now) / 1000))
    : Number.isFinite(raw.remainingSec) ? Math.max(0, Math.round(raw.remainingSec)) : null;
  if (raw.phase === 'idle' || totalSec == null || remainingSec == null) {
    // 数据残缺时只保底轮次进度，其余交给 initialize 走干净初始态。
    return { completedFocusRounds };
  }
  return {
    phase: raw.phase,
    running,
    totalSec,
    remainingSec,
    phaseEndAt: running ? raw.phaseEndAt : null,
    completedFocusRounds,
  };
}

// 只在阶段转换/暂停恢复/重置时落盘——remainingSec 可由 phaseEndAt 反推，不需要逐秒写磁盘。
function flushPomodoroState(instance, options = {}) {
  if (!instance.context) {
    return false;
  }
  const write = options.write ?? writePersistedState;
  return write(instance.context, serializePomodoroState(instance));
}

function resetPomodoroInstance(instance, { preserveRounds = false } = {}) {
  stopPomodoroCue(instance);
  clearPomodoroTimer(instance);
  instance.phase = 'idle';
  instance.running = false;
  instance.awaiting = false;
  instance.blinkOn = false;
  instance.phaseEndAt = null;
  instance.totalSec = pomodoroDurationSecFromSettings(instance.settings, 'focus');
  instance.remainingSec = instance.totalSec;
  if (!preserveRounds) {
    instance.completedFocusRounds = 0;
  }
  flushPomodoroState(instance);
}

function schedulePomodoroTick(instance, now = Date.now()) {
  if (!instance.running) {
    clearPomodoroTimer(instance);
    return;
  }
  // 对齐到整秒边界而不是固定 1000ms：每个 tick 的调度误差都会被下一次对齐吸收。
  const msLeft = Number.isFinite(instance.phaseEndAt) ? instance.phaseEndAt - now : 1000;
  const delay = msLeft > 0 ? ((msLeft - 1) % 1000) + 1 : 1;
  setInstanceTimeout(instance, 'pomodoro', () => tickPomodoro(instance), delay);
}

// 待命闪烁：阶段结束但下一阶段不自动开始时，圆环在 blinkOn 明灭之间循环闪烁，直到用户按键。
// 复用 'pomodoro' 定时器槽——待命时没有 tick，blink 独占它；用户确认后 schedulePomodoroTick 覆盖回 tick。
function scheduleBlink(instance) {
  if (!instance.awaiting) {
    clearPomodoroTimer(instance);
    return;
  }
  setInstanceTimeout(instance, 'pomodoro', () => {
    instance.blinkOn = !instance.blinkOn;
    renderInstance(instance);
    scheduleBlink(instance);
  }, POMODORO_BLINK_MS);
}

// 进入待命：切到下一阶段但不启动计时，圆环闪烁提示按下。提示音可循环到用户确认。
function enterAwaitingPhase(instance, phase, options = {}) {
  const { playSound = true } = options;
  clearPomodoroTimer(instance);
  instance.phase = phase;
  instance.totalSec = pomodoroDurationSecFromSettings(instance.settings, phase);
  instance.remainingSec = instance.totalSec;
  instance.running = false;
  instance.phaseEndAt = null;
  instance.awaiting = true;
  instance.blinkOn = true;
  if (playSound) {
    playPomodoroPhaseEndCue(instance, { autoStart: false });
  }
  flushPomodoroState(instance);
  renderInstance(instance);
  scheduleBlink(instance);
}

// 确认待命阶段：从满时长起点开始计时。
function beginAwaitedPhase(instance, now = Date.now()) {
  stopPomodoroCue(instance);
  instance.awaiting = false;
  instance.running = true;
  instance.phaseEndAt = now + Math.max(1, instance.remainingSec ?? instance.totalSec ?? 1) * 1000;
  flushPomodoroState(instance);
  renderInstance(instance);
  schedulePomodoroTick(instance, now);
}

function startPomodoroPhase(instance, phase, options = {}) {
  const {
    autoStart = true,
    playSound = false,
    now = Date.now(),
  } = options;

  stopPomodoroCue(instance);
  clearPomodoroTimer(instance);
  instance.phase = phase;
  instance.totalSec = pomodoroDurationSecFromSettings(instance.settings, phase);
  instance.remainingSec = instance.totalSec;
  instance.running = autoStart;
  instance.phaseEndAt = autoStart ? now + instance.totalSec * 1000 : null;
  instance.awaiting = false;

  if (phase === 'done') {
    instance.completedFocusRounds = 0;
  }

  if (playSound) {
    playPomodoroPhaseEndCue(instance, { autoStart: true });
  }

  flushPomodoroState(instance);
  renderInstance(instance);
  schedulePomodoroTick(instance, now);
}

function advancePomodoroPhase(instance, options = {}) {
  const { playSound = true } = options;
  const roundsGoal = pomodoroRoundsGoal(instance.settings);

  if (instance.phase === 'focus') {
    instance.completedFocusRounds += 1;
    const hitLongBreak = instance.completedFocusRounds % roundsGoal === 0;
    const nextBreak = hitLongBreak ? 'longBreak' : 'shortBreak';
    // 专注结束：自动则直接开始休息，否则进入待命（圆环闪烁，等按键 / 双击跳过休息）。
    if (isEnabled(instance.settings.autoStartBreaks)) {
      startPomodoroPhase(instance, nextBreak, { autoStart: true, playSound });
    } else {
      enterAwaitingPhase(instance, nextBreak, { playSound });
    }
    return;
  }

  if (instance.phase === 'shortBreak') {
    // 短休息结束：自动则直接开始专注，否则进入待命（圆环闪烁，等按键进专注）。
    if (isEnabled(instance.settings.autoStartFocus)) {
      startPomodoroPhase(instance, 'focus', { autoStart: true, playSound });
    } else {
      enterAwaitingPhase(instance, 'focus', { playSound });
    }
    return;
  }

  if (instance.phase === 'longBreak') {
    startPomodoroPhase(instance, 'done', {
      autoStart: true,
      playSound,
    });
    return;
  }

  if (instance.phase === 'done') {
    if (isEnabled(instance.settings.autoStartFocus)) {
      startPomodoroPhase(instance, 'focus', {
        autoStart: true,
        playSound: false,
      });
    } else {
      resetPomodoroInstance(instance);
      renderInstance(instance);
    }
  }
}

function tickPomodoro(instance, options = {}) {
  const instances = options.instances ?? INSTANCES;
  const now = options.now ?? Date.now();
  if (!instance || !instances.has(instance.context) || !instance.running) {
    return;
  }

  instance.remainingSec = pomodoroRemainingSec(instance, now);
  if (instance.remainingSec <= 0) {
    advancePomodoroPhase(instance);
    return;
  }

  renderInstance(instance);
  schedulePomodoroTick(instance, now);
}

function initializePomodoroInstance(instance) {
  if (instance.remainingSec == null || instance.totalSec == null) {
    resetPomodoroInstance(instance);
  }
}

function reconcilePomodoroSettings(instance, previousSettings) {
  const changedDurations =
    previousSettings.focusMin !== instance.settings.focusMin ||
    previousSettings.shortBreakMin !== instance.settings.shortBreakMin ||
    previousSettings.longBreakMin !== instance.settings.longBreakMin;

  if (!changedDurations) {
    return;
  }

  if (instance.phase === 'idle') {
    resetPomodoroInstance(instance, { preserveRounds: true });
    return;
  }

  const previousTotal = pomodoroDurationSecFromSettings(previousSettings, instance.phase);
  const nextTotal = pomodoroDurationSecFromSettings(instance.settings, instance.phase);
  if (previousTotal <= 0 || nextTotal <= 0) {
    return;
  }

  const now = Date.now();
  const ratio = Math.max(0, Math.min(1, pomodoroRemainingSec(instance, now) / previousTotal));
  instance.totalSec = nextTotal;
  instance.remainingSec = Math.max(1, Math.round(nextTotal * ratio));
  if (instance.running) {
    instance.phaseEndAt = now + instance.remainingSec * 1000;
    schedulePomodoroTick(instance, now);
  }
  flushPomodoroState(instance);
}

function togglePomodoro(instance, now = Date.now()) {
  initializePomodoroInstance(instance);

  if (instance.phase === 'idle') {
    startPomodoroPhase(instance, 'focus', { autoStart: true, playSound: false, now });
    return;
  }

  if (instance.phase === 'done') {
    resetPomodoroInstance(instance);
    startPomodoroPhase(instance, 'focus', { autoStart: true, playSound: false, now });
    return;
  }

  if (instance.running) {
    // 暂停：把真实剩余时间冻结回 remainingSec，时间戳随之作废。
    instance.remainingSec = pomodoroRemainingSec(instance, now);
    instance.running = false;
    instance.phaseEndAt = null;
  } else {
    instance.running = true;
    instance.phaseEndAt = now + Math.max(1, instance.remainingSec ?? instance.totalSec ?? 1) * 1000;
  }
  flushPomodoroState(instance);
  renderInstance(instance);
  schedulePomodoroTick(instance, now);
}

function skipPomodoroPhase(instance) {
  initializePomodoroInstance(instance);
  if (instance.phase === 'idle') {
    return;
  }
  if (instance.phase === 'done') {
    resetPomodoroInstance(instance);
    renderInstance(instance);
    return;
  }
  // 跳过视同该阶段自然完成（专注照常计入轮次），但不放提示音——这是用户主动叫停的。
  advancePomodoroPhase(instance, { playSound: false });
}

// 工作被打断：把当前番茄重启为一段全新的满时长专注并继续运行。
// 只作废当前这颗番茄，保留已完成轮次数（startPomodoroPhase 只在 done 阶段清零轮次）。
function resetPomodoroWork(instance, now = Date.now()) {
  initializePomodoroInstance(instance);
  startPomodoroPhase(instance, 'focus', { autoStart: true, playSound: false, now });
}

// 单击开始/暂停，双击重启当前工作时间。沿用 latency 的"先动作、被第二击覆盖"策略：
// 单击零延迟即时生效，双击时第一击的瞬时切换会在 400ms 内被重启覆盖，不需要预置延迟。
// 待命态（awaiting）另有语义：单击确认进入该阶段；等待进休息时双击=跳过休息直接开始下一个专注。
function handlePomodoroTap(instance, options = {}) {
  const now = options.now ?? Date.now();
  const doubleTapMs = options.doubleTapMs ?? POMODORO_DOUBLE_TAP_MS;
  const previousTapAt = instance.lastTapAt ?? 0;
  instance.lastTapAt = now;
  const isDouble = now - previousTapAt < doubleTapMs;
  if (isDouble) {
    instance.lastTapAt = 0;
  }

  // 待命态第一击即确认进入该阶段开始计时（第一击必然清掉 awaiting）。
  // 若紧接第二击构成双击，会落到下方 resetPomodoroWork——把刚开始的休息重启为一段全新专注，
  // 即"专注结束等待进休息时双击=跳过休息、直接进入下一个专注"。
  if (instance.awaiting) {
    beginAwaitedPhase(instance, now);
    return;
  }

  if (isDouble) {
    resetPomodoroWork(instance, now);
    return;
  }
  togglePomodoro(instance, now);
}

function renderPomodoroIcon(instance) {
  initializePomodoroInstance(instance);
  const theme = themeFor(instance.settings);
  const frame = frameFor(instance.settings);
  const background = renderThemeBackdrop(theme, pomodoroColor(instance.settings, instance.phase), frame);
  const phaseColor = pomodoroColor(instance.settings, instance.phase === 'idle' ? 'focus' : instance.phase);
  const totalSec = Math.max(1, instance.totalSec || pomodoroDurationSecFromSettings(instance.settings, 'focus'));
  const remainingSec = pomodoroRemainingSec(instance);
  // 顺时针逐步填充：已用时间比例（elapsed）从 0 增到 1，可见弧从 12 点顺时针铺开。
  const elapsed = instance.phase === 'done' ? 1 : Math.max(0, Math.min(1, 1 - remainingSec / totalSec));
  const circumference = 2 * Math.PI * 79;
  const fillLength = (elapsed * circumference).toFixed(1);
  const isAwaiting = instance.awaiting === true;
  const alertPulse = instance.running && instance.phase !== 'done' && remainingSec <= POMODORO_ALERT_WINDOW_SEC && remainingSec % 2 === 0;
  const accent = alertPulse ? background.text : phaseColor;
  const displayText = instance.phase === 'done' ? '✓' : formatPomodoroTime(remainingSec);
  const displaySize = instance.phase === 'done' ? 88 : 40;
  const label = pomodoroPhaseLabel(instance);
  const roundsGoal = pomodoroRoundsGoal(instance.settings);
  const completedInCycle = instance.phase === 'longBreak' || instance.phase === 'done'
    ? roundsGoal
    : instance.completedFocusRounds % roundsGoal;
  const dots = Array.from({ length: roundsGoal }, (_, index) => {
    const cx = 128 - ((roundsGoal - 1) * 18) / 2 + index * 18;
    const filled = index < completedInCycle;
    return `<circle cx="${cx}" cy="174" r="5.5" fill="${filled ? accent : background.low}" opacity="${filled ? '1' : '0.45'}"/>`;
  }).join('');

  return toDataUrl(`
    <svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${background.outer}
      ${alertPulse ? frameHighlight(frame, accent) : ''}
      ${frameContent(frame, `
      <circle cx="128" cy="128" r="79" fill="none" stroke="${background.low}" stroke-width="12" opacity="0.42"/>
      ${isAwaiting
        ? `<circle cx="128" cy="128" r="79" fill="none" stroke="${accent}" stroke-width="12" opacity="${instance.blinkOn ? 1 : 0.16}"/>`
        : `<circle
        cx="128"
        cy="128"
        r="79"
        fill="none"
        stroke="${accent}"
        stroke-width="12"
        stroke-linecap="round"
        stroke-dasharray="${fillLength} ${circumference.toFixed(1)}"
        transform="rotate(-90 128 128)"
      />`}
      ${instance.phase === 'done' ? '' : `<g transform="translate(128 78)" fill="${accent}">
        <circle cx="0" cy="2" r="12"/>
        <path d="M0,-14 L1.88,-9.09 L7.13,-8.82 L3.04,-5.51 L4.41,-0.43 L0,-3.3 L-4.41,-0.43 L-3.04,-5.51 L-7.13,-8.82 L-1.88,-9.09 Z"/>
      </g>`}
      <text x="128" y="${instance.phase === 'done' ? 160 : 126}" text-anchor="middle" fill="${instance.phase === 'done' ? accent : background.text}" font-size="${displaySize}" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(displayText)}</text>
      ${instance.phase === 'done' ? '' : `<text x="128" y="152" text-anchor="middle" fill="${accent}" font-size="19" font-weight="800" font-family="Arial, Helvetica, sans-serif" letter-spacing="2">${escapeXml(label)}</text>${dots}`}
      `)}
    </svg>
  `);
}

// 背景一律由 theme token 派生：颜色只有主题这一个轴。
// 曾经的 mist / paper 把 shell、panel、描边、文字全部改成写死的浅色 hex，实际上是
// 第二套暗中生效的主题系统，与 theme 互相打架（规则 §6 明令颜色围绕 theme token）。
// 想要浅色请选 sand 主题，那才是主题系统里的正确入口。

const config = {
    defaults: {
      focusMin: '25',
      shortBreakMin: '5',
      longBreakMin: '15',
      roundsBeforeLongBreak: '4',
      theme: 'ember',
      frameSize: 'optimal',
      showFrame: 'true',
      soundStyle: 'glass',
      soundEnabled: 'true',
      repeatManualCue: 'false',
      autoStartBreaks: 'true',
      autoStartFocus: 'true',
    },
    normalizeSettings: (settings, defaults) => ({
      focusMin: normalizeNumberString(settings.focusMin, defaults.focusMin, 1, 180),
      shortBreakMin: normalizeNumberString(settings.shortBreakMin, defaults.shortBreakMin, 1, 60),
      longBreakMin: normalizeNumberString(settings.longBreakMin, defaults.longBreakMin, 1, 120),
      roundsBeforeLongBreak: normalizeNumberString(settings.roundsBeforeLongBreak, defaults.roundsBeforeLongBreak, 2, 8),
      soundStyle: normalizeChoice(settings.soundStyle, defaults.soundStyle, POMODORO_SOUND_STYLES),
      soundEnabled: normalizeBooleanString(settings.soundEnabled, defaults.soundEnabled),
      repeatManualCue: normalizeBooleanString(settings.repeatManualCue, defaults.repeatManualCue),
      autoStartBreaks: normalizeBooleanString(settings.autoStartBreaks, defaults.autoStartBreaks),
      autoStartFocus: normalizeBooleanString(settings.autoStartFocus, defaults.autoStartFocus),
    }),
    createState: (instance) => ({
      phase: 'idle',
      remainingSec: null,
      totalSec: null,
      completedFocusRounds: 0,
      running: false,
      phaseEndAt: null,
      // awaiting：阶段自然结束但下一阶段非自动开始，圆环闪烁等用户按键确认。属瞬时转场态，不持久化。
      awaiting: false,
      blinkOn: false,
      cueProcess: null,
      cueRepeating: false,
      cueGeneration: 0,
      // 进行中的番茄靠 phaseEndAt 跨重启恢复真实剩余时间，重建实例不能把它吞掉。
      ...(instance?.context ? hydratePomodoroState(readPersistedState(instance.context)) : {}),
    }),
    onRun: (instance) => {
      handlePomodoroTap(instance);
    },
    onReady: (instance) => {
      initializePomodoroInstance(instance);
      if (instance.running) {
        // 先按时钟对齐再续排定时器：睡眠唤醒/进程重启期间流逝的时间在这里一次性追平。
        tickPomodoro(instance);
      }
    },
    onSettingsChanged: (instance, previousSettings) => {
      initializePomodoroInstance(instance);
      reconcilePomodoroSettings(instance, previousSettings);
    },
    onParamFromPlugin: (instance, param) => {
      if (param?.previewSound) {
        // PI 试听：播放点选样式，无视 soundEnabled，不改动计时状态。
        playPomodoroCue(instance.settings, { style: param.previewSound, ignoreEnabled: true });
        return;
      }
      if (param?.resetTimer === 'true') {
        resetPomodoroInstance(instance);
        return;
      }
      if (param?.skipPhase === 'true') {
        skipPomodoroPhase(instance);
      }
    },
    onDispose: (instance) => {
      stopPomodoroCue(instance);
      flushPomodoroState(instance);
    },
    render: (instance) => renderPomodoroIcon(instance),
  };

  return {
    key: 'pomowave',
    config,
    testing: {
      pomodoroPalette,
      hydratePomodoroState,
      serializePomodoroState,
      flushPomodoroState,
      pomodoroRemainingSec,
      tickPomodoro,
      togglePomodoro,
      skipPomodoroPhase,
      handlePomodoroTap,
      resetPomodoroWork,
      pomodoroCuePlan,
      shouldRepeatPomodoroCue,
    },
  };
}
