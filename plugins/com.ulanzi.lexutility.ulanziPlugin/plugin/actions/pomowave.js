import { execFile } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

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
    t,
    themeFor,
    toDataUrl,
    writePersistedState,
  } = runtime;

const runPlayer = runtime.execFile ?? execFile;
const platform = runtime.platform ?? os.platform;

const POMODORO_SOUND_STYLES = ['glass', 'hero', 'purr', 'submarine'];
const POMODORO_ALERT_WINDOW_SEC = 5;
const POMODORO_CYCLE_COMPLETE_SEC = 4;
const POMODORO_STATE_VERSION = 2;
const POMODORO_PHASES = ['idle', 'focus', 'shortBreak', 'longBreak', 'done'];
const POMODORO_BLINK_MS = 550;
const POMODORO_CUE_REPEAT_DELAY_MS = 150;
const POMODORO_PREVIEW_MAX_MS = 15_000;
const POMODORO_CUE_DURATIONS = ['continuous', '60', '180', '300', '600'];
const POMODORO_BACKGROUND_SOUNDS = [
  'rain',
  'clock',
  'wave',
  'forest',
  'cafe',
  'morning',
  'summer',
  'storm',
  'stove',
  'stream',
  'deepSea',
  'desert',
  'chirp',
  'boiling',
  'musicBox',
  'woodenFish',
  'streetTraffic',
];
const POMODORO_BACKGROUND_CHOICES = ['none', ...POMODORO_BACKGROUND_SOUNDS];
// TickTick 原始素材的平均电平相差约 26 dB。按声音特征做播放时增益，不改写音频：
// 持续、偏轻的环境声提升较多；尖锐、重复或本身较响的声音保守提升，避免疲劳与削波。
const POMODORO_BACKGROUND_GAIN_DB = Object.freeze({
  rain: 9,
  clock: 6,
  wave: 7,
  forest: 10,
  cafe: 8,
  morning: 6,
  summer: 2,
  storm: 4,
  stove: 0.5,
  stream: 8,
  deepSea: 2,
  desert: 8,
  chirp: 4,
  boiling: 8,
  musicBox: 5,
  woodenFish: 4,
  streetTraffic: 9,
});
const POMODORO_LEGACY_BACKGROUND_MAP = Object.freeze({
  fireplace: 'stove',
  ocean: 'wave',
  brownNoise: 'deepSea',
});
const POMODORO_BACKGROUND_GLYPHS = Object.freeze({
  rain: '<path d="M5 12.5h12.5a3.5 3.5 0 0 0 .3-7A5.2 5.2 0 0 0 8 7.2 3.1 3.1 0 0 0 5 12.5Z"/><path d="m7 16-1 2m5-2-1 2m5-2-1 2"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3.5 2"/>',
  wave: '<path d="M3 10c2.2 0 2.2-2 4.4-2s2.2 2 4.4 2 2.2-2 4.4-2 2.2 2 4.4 2M3 15c2.2 0 2.2-2 4.4-2s2.2 2 4.4 2 2.2-2 4.4-2 2.2 2 4.4 2"/>',
  forest: '<path d="m8 4-4 7h3l-4 7h10l-4-7h3L8 4Zm9 3-3 5h2l-3 6h8l-3-6h2l-3-5Z"/>',
  cafe: '<path d="M5 9h11v5.5A4.5 4.5 0 0 1 11.5 19h-2A4.5 4.5 0 0 1 5 14.5V9Zm11 2h2a2.5 2.5 0 0 1 0 5h-2M8 6c-1-1 1-2 0-3m4 3c-1-1 1-2 0-3"/>',
  morning: '<path d="M4 17h16M6 17a6 6 0 0 1 12 0M12 4v3M5.6 7.6l2.1 2.1m10.7-2.1-2.1 2.1"/>',
  summer: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1m0-14.2L17 7M7 17l-2.1 2.1"/>',
  storm: '<path d="M5 12.5h12.5a3.5 3.5 0 0 0 .3-7A5.2 5.2 0 0 0 8 7.2 3.1 3.1 0 0 0 5 12.5Z"/><path d="m12 13-2 4h3l-2 4"/>',
  stove: '<path d="M12 3c1 4-3 5-1 8 1.2 1.8 3.5.8 3-1.5 3 2.3 4 5 2.3 8A5.2 5.2 0 0 1 7 16c-.8-2.7.8-5.4 3.2-7.5-.1 2.2.5 3.2 1.8 3.5"/>',
  stream: '<path d="M4 4c7 2 9 5 3 8s-4 6 10 8M11 4c7 2 8 5 2 8s-4 5 7 7"/>',
  deepSea: '<path d="M4 12c3-4 8-5 13-2l3-2v8l-3-2c-5 3-10 2-13-2Zm4 0h.1"/><circle cx="18.5" cy="4.5" r="1.5"/><circle cx="15" cy="6" r="1"/>',
  desert: '<circle cx="18" cy="6" r="3"/><path d="M2 18c4-5 8-6 12-2 2-2 5-2 8 0M2 21c6-3 12-3 20 0"/>',
  chirp: '<ellipse cx="12" cy="13" rx="2.5" ry="5"/><path d="m10 10-4-3m8 3 4-3m-8 5-5 1m9-1 5 1m-9 3-4 3m8-3 4 3M11 7l-1-3m3 3 1-3"/>',
  boiling: '<path d="M5 10h14l-1 9H6l-1-9Zm-2 0h18M8 6c-1.5-1.5 1.5-2.5 0-4m4 4c-1.5-1.5 1.5-2.5 0-4m4 4c-1.5-1.5 1.5-2.5 0-4"/>',
  musicBox: '<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M7 9V6h10v3m-7 7a2 2 0 1 0 2-2V7l5-1v7"/>',
  woodenFish: '<path d="M4 14c2-6 8-9 15-5l2 3-2 3c-7 4-13 2-15-1Zm4-1h8M17 5l3-2"/>',
  streetTraffic: '<path d="m5 9 2-4h10l2 4 2 2v6h-2v2h-3v-2H8v2H5v-2H3v-6l2-2Zm0 0h14M7 13h.1M17 13h.1"/>',
  none: '<path d="M4 10h4l5-4v12l-5-4H4v-4Zm12-2 5 8m0-8-5 8"/>',
});
const POMODORO_AUDIO_DIR = new URL('../../assets/audio/pomowave/', import.meta.url);
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

function pomodoroStatusColor(instance, theme) {
  if (instance.phase === 'idle') {
    return mixHex(theme.muted, theme.text, 0.28);
  }
  if (!instance.running && !instance.awaiting && instance.phase !== 'done') {
    return theme.warn || theme.muted;
  }
  if (instance.phase === 'focus') {
    return theme.accent;
  }
  if (instance.phase === 'shortBreak') {
    return theme.ok || mixHex(theme.accent, theme.text, 0.55);
  }
  if (instance.phase === 'longBreak') {
    return mixHex(theme.muted, theme.text, 0.48);
  }
  return theme.text;
}

function pomodoroBackgroundGlyph(sound) {
  return POMODORO_BACKGROUND_GLYPHS[sound] || POMODORO_BACKGROUND_GLYPHS.none;
}

function pomodoroBackgroundSoundForDisplay(instance) {
  if (instance.phase !== 'focus') {
    return null;
  }
  if (POMODORO_BACKGROUND_CHOICES.includes(instance.selectedBackgroundSound)) {
    return instance.selectedBackgroundSound;
  }
  if (isEnabled(instance.settings?.backgroundRandom)) {
    return 'none';
  }
  return normalizePomodoroBackgroundChoice(instance.settings?.backgroundSound, 'none');
}

function renderPomodoroBackgroundBadge(instance, theme, background) {
  const sound = pomodoroBackgroundSoundForDisplay(instance);
  if (!sound) {
    return '';
  }
  const muted = Boolean(instance.backgroundMuted) || sound === 'none';
  const iconColor = muted ? background.muted : theme.text;
  return `
    <g data-background-sound="${sound}" data-background-muted="${muted}" transform="translate(118 174)">
      <g transform="scale(0.8333)" fill="none" stroke="${iconColor}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity="${muted ? '0.34' : '0.96'}">
        ${pomodoroBackgroundGlyph(sound)}
      </g>
      ${muted ? `<path data-background-muted-slash d="M2 18 18 2" fill="none" stroke="${theme.muted}" stroke-width="2" stroke-linecap="round" opacity="0.92"/>` : ''}
    </g>
  `;
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

  if (platform() === 'darwin') {
    const soundName = POMODORO_MAC_SOUND_MAP[style] || POMODORO_MAC_SOUND_MAP.glass;
    return runPlayer('afplay', [`/System/Library/Sounds/${soundName}.aiff`], onComplete);
  }

  if (platform() === 'win32') {
    const [frequency, duration] = POMODORO_WINDOWS_SOUND_MAP[style] || POMODORO_WINDOWS_SOUND_MAP.glass;
    return runPlayer(
      'powershell',
      ['-NoProfile', '-Command', `[console]::beep(${frequency},${duration})`],
      onComplete,
    );
  }

  process.stdout.write('\u0007');
  onComplete(null);
  return null;
}

function cueDurationMs(settings) {
  const duration = normalizeChoice(settings.cueDuration, '180', POMODORO_CUE_DURATIONS);
  return duration === 'continuous' ? null : Number.parseInt(duration, 10) * 1000;
}

function shouldRepeatPomodoroCue(settings, { autoStart = false } = {}) {
  return !autoStart && cueDurationMs(settings) !== 0;
}

function stopPomodoroCue(instance) {
  instance.cueRepeating = false;
  instance.cueGeneration = (instance.cueGeneration || 0) + 1;
  clearInstanceTimeout(instance, 'pomodoroCue');
  clearInstanceTimeout(instance, 'pomodoroCueLimit');
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

// 阶段结束提示音：自动进入下一阶段永远只播一次；手动等待阶段按 cueDuration 循环，到期只停声。
function playPomodoroPhaseEndCue(instance, { autoStart = false } = {}) {
  stopPomodoroCue(instance);
  if (!pomodoroCuePlan(instance.settings)) {
    return;
  }
  const repeat = shouldRepeatPomodoroCue(instance.settings, { autoStart });
  instance.cueRepeating = repeat;
  const generation = instance.cueGeneration;
  const limitMs = repeat ? cueDurationMs(instance.settings) : null;
  instance.cueStartedAt = Date.now();

  if (limitMs != null) {
    setInstanceTimeout(instance, 'pomodoroCueLimit', () => {
      if (instance.cueGeneration === generation) {
        stopPomodoroCue(instance);
      }
    }, limitMs);
  }

  const playNext = () => {
    if (instance.cueGeneration !== generation || !instance.cueRepeating) {
      return;
    }
    if (limitMs != null && Date.now() - instance.cueStartedAt >= limitMs) {
      stopPomodoroCue(instance);
      return;
    }
    let processHandle = null;
    try {
      processHandle = playPomodoroCue(instance.settings, {
        onComplete: (error) => {
          if (instance.cueGeneration !== generation) {
            return;
          }
          if (instance.cueProcess === processHandle) {
            instance.cueProcess = null;
          }
          if (error) {
            stopPomodoroCue(instance);
            return;
          }
          if (!instance.cueRepeating) {
            return;
          }
          setInstanceTimeout(instance, 'pomodoroCue', playNext, POMODORO_CUE_REPEAT_DELAY_MS);
        },
      });
      instance.cueProcess = processHandle;
    } catch {
      // 声音设备或播放器不可用时，计时状态机照常继续。
      instance.cueProcess = null;
      instance.cueRepeating = false;
    }
  };

  if (repeat) {
    playNext();
  } else {
    const generation = instance.cueGeneration;
    let processHandle = null;
    try {
      processHandle = playPomodoroCue(instance.settings, {
        onComplete: (error) => {
          if (instance.cueGeneration !== generation) {
            return;
          }
          if (error) {
            stopPomodoroCue(instance);
            return;
          }
          if (instance.cueProcess === processHandle) {
            instance.cueProcess = null;
          }
        },
      });
      instance.cueProcess = processHandle;
    } catch {
      instance.cueProcess = null;
    }
  }
}

function backgroundAudioPath(sound) {
  if (!POMODORO_BACKGROUND_SOUNDS.includes(sound)) {
    return null;
  }
  return fileURLToPath(new URL(`${sound}.m4a`, POMODORO_AUDIO_DIR));
}

function normalizePomodoroBackgroundChoice(value, fallback = 'rain') {
  const migrated = POMODORO_LEGACY_BACKGROUND_MAP[value] ?? value;
  return POMODORO_BACKGROUND_CHOICES.includes(migrated) ? migrated : fallback;
}

function normalizedBackgroundVolume(settings) {
  return Number.parseInt(normalizeNumberString(settings.backgroundVolume, '35', 0, 100), 10);
}

function pomodoroBackgroundGainDb(sound) {
  return POMODORO_BACKGROUND_GAIN_DB[sound] ?? 0;
}

function amplifiedPomodoroBackgroundVolume(sound, volume) {
  const safeVolume = Math.max(0, Math.min(100, Number(volume) || 0));
  const gain = 10 ** (pomodoroBackgroundGainDb(sound) / 20);
  return Number((safeVolume * gain).toFixed(4));
}

function selectPomodoroBackground(instance, { force = false } = {}) {
  if (!instance.settings) {
    instance.selectedBackgroundSound = 'none';
    return 'none';
  }
  if (!force && POMODORO_BACKGROUND_SOUNDS.includes(instance.selectedBackgroundSound)) {
    return instance.selectedBackgroundSound;
  }
  if (isEnabled(instance.settings.backgroundRandom)) {
    instance.selectedBackgroundSound = POMODORO_BACKGROUND_SOUNDS[Math.floor(Math.random() * POMODORO_BACKGROUND_SOUNDS.length)];
  } else if (instance.settings.backgroundSound === 'none') {
    instance.selectedBackgroundSound = 'none';
  } else {
    instance.selectedBackgroundSound = normalizePomodoroBackgroundChoice(instance.settings.backgroundSound);
  }
  return instance.selectedBackgroundSound;
}

function stopAudioProcess(instance, processKey, generationKey, timerSlot) {
  instance[generationKey] = (instance[generationKey] || 0) + 1;
  clearInstanceTimeout(instance, timerSlot);
  const processHandle = instance[processKey];
  instance[processKey] = null;
  // ChildProcess.killed 仅表示曾发送过信号；SIGSTOP 后也会变 true，不能据此省略 SIGTERM。
  const exited = processHandle?.exited === true || processHandle?.exitCode != null;
  if (processHandle && typeof processHandle.kill === 'function' && !exited) {
    try {
      processHandle.kill();
    } catch {
      // 子进程已经结束时不影响计时。
    }
  }
}

function stopPomodoroBackground(instance) {
  instance.backgroundPaused = false;
  stopAudioProcess(instance, 'backgroundProcess', 'backgroundGeneration', 'pomodoroBackground');
}

function pausePomodoroBackground(instance) {
  if (!instance.backgroundProcess) {
    return;
  }
  if (platform() === 'darwin') {
    try {
      if (instance.backgroundProcess.kill('SIGSTOP') === false) {
        throw new Error('background player rejected SIGSTOP');
      }
      instance.backgroundPaused = true;
      return;
    } catch {
      // 无法暂停则降级为停止，恢复时从同一音源起点重播。
    }
  }
  stopPomodoroBackground(instance);
}

function windowsBackgroundPlaybackCommand(audioPath, volume) {
  const encodedPath = Buffer.from(audioPath, 'utf8').toString('base64');
  const safeVolume = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
  const script = `$audioPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $player = New-Object -ComObject WMPlayer.OCX; $player.URL = $audioPath; $player.settings.volume = ${safeVolume}; $player.settings.setMode('loop', $true); $player.controls.play(); while ($true) { Start-Sleep -Seconds 1 }`;
  return {
    command: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}

function backgroundPlaybackCommand(sound, volume) {
  const audioPath = backgroundAudioPath(sound);
  if (!audioPath) {
    return null;
  }
  const gainDb = pomodoroBackgroundGainDb(sound);
  const amplifiedVolume = amplifiedPomodoroBackgroundVolume(sound, volume);
  if (platform() === 'darwin') {
    return { command: 'afplay', args: ['-v', String(amplifiedVolume / 100), audioPath] };
  }
  if (platform() === 'win32') {
    // WMP 的音量上限为 100；正常设置区间仍可获得增益，达到上限后安全截顶。
    return windowsBackgroundPlaybackCommand(audioPath, Math.min(100, amplifiedVolume));
  }
  return {
    command: 'ffplay',
    args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(volume), '-af', `volume=${gainDb}dB`, audioPath],
  };
}

function startPomodoroBackground(instance, options = {}) {
  if (instance.active === false || instance.phase !== 'focus' || !instance.running) {
    return null;
  }
  if (instance.backgroundMuted) {
    stopPomodoroBackground(instance);
    return null;
  }
  const sound = selectPomodoroBackground(instance, options);
  if (sound === 'none') {
    stopPomodoroBackground(instance);
    return null;
  }
  const plan = backgroundPlaybackCommand(sound, normalizedBackgroundVolume(instance.settings));
  if (!plan) {
    return null;
  }
  if (instance.backgroundPaused && instance.backgroundProcess && platform() === 'darwin') {
    try {
      if (instance.backgroundProcess.kill('SIGCONT') === false) {
        throw new Error('background player rejected SIGCONT');
      }
      instance.backgroundPaused = false;
      return instance.backgroundProcess;
    } catch {
      instance.backgroundProcess = null;
    }
  }
  stopPomodoroBackground(instance);
  const generation = instance.backgroundGeneration;
  let processHandle = null;
  try {
    processHandle = runPlayer(plan.command, plan.args, (error) => {
      if (instance.backgroundGeneration !== generation || instance.backgroundProcess !== processHandle) {
        return;
      }
      instance.backgroundProcess = null;
      if (error || instance.phase !== 'focus' || !instance.running) {
        return;
      }
      setInstanceTimeout(instance, 'pomodoroBackground', () => startPomodoroBackground(instance), 100);
    });
    instance.backgroundProcess = processHandle;
    return processHandle;
  } catch {
    instance.backgroundProcess = null;
    return null;
  }
}

function stopPomodoroPreview(instance) {
  instance.previewPlaying = false;
  stopAudioProcess(instance, 'previewProcess', 'previewGeneration', 'pomodoroPreview');
}

function startPomodoroPreview(instance, startPlayback) {
  stopPomodoroPreview(instance);
  const generation = instance.previewGeneration;
  let processHandle = null;
  try {
    processHandle = startPlayback(() => {
      if (instance.previewGeneration === generation && instance.previewProcess === processHandle) {
        instance.previewProcess = null;
        instance.previewPlaying = false;
        clearInstanceTimeout(instance, 'pomodoroPreview');
      }
    });
    if (!processHandle) {
      instance.previewPlaying = false;
      return null;
    }
    instance.previewProcess = processHandle;
    instance.previewPlaying = true;
    setInstanceTimeout(instance, 'pomodoroPreview', () => {
      if (instance.previewGeneration === generation) {
        stopPomodoroPreview(instance);
      }
    }, POMODORO_PREVIEW_MAX_MS);
    return processHandle;
  } catch {
    instance.previewProcess = null;
    instance.previewPlaying = false;
    return null;
  }
}

function playPomodoroCuePreview(instance, requestedStyle) {
  return startPomodoroPreview(instance, (onComplete) => playPomodoroCue(instance.settings, {
    style: requestedStyle,
    ignoreEnabled: true,
    onComplete,
  }));
}

function playPomodoroBackgroundPreview(instance, requestedSound) {
  const sound = normalizePomodoroBackgroundChoice(requestedSound ?? instance.settings.backgroundSound);
  if (sound === 'none') {
    stopPomodoroPreview(instance);
    return null;
  }
  const plan = backgroundPlaybackCommand(sound, normalizedBackgroundVolume(instance.settings));
  if (!plan) {
    return null;
  }
  return startPomodoroPreview(instance, (onComplete) => runPlayer(plan.command, plan.args, onComplete));
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
  const selectedBackgroundSound = normalizePomodoroBackgroundChoice(instance.selectedBackgroundSound, 'none');
  return {
    v: POMODORO_STATE_VERSION,
    phase: instance.phase,
    running: Boolean(instance.running),
    remainingSec: instance.remainingSec,
    totalSec: instance.totalSec,
    completedFocusRounds: instance.completedFocusRounds || 0,
    phaseEndAt: instance.phaseEndAt ?? null,
    backgroundMuted: Boolean(instance.backgroundMuted),
    selectedBackgroundSound,
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
  const selectedBackgroundSound = normalizePomodoroBackgroundChoice(raw.selectedBackgroundSound, null);
  return {
    phase: raw.phase,
    running,
    totalSec,
    remainingSec,
    phaseEndAt: running ? raw.phaseEndAt : null,
    completedFocusRounds,
    backgroundMuted: Boolean(raw.backgroundMuted),
    selectedBackgroundSound,
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
  stopPomodoroBackground(instance);
  stopPomodoroPreview(instance);
  clearPomodoroTimer(instance);
  instance.phase = 'idle';
  instance.running = false;
  instance.awaiting = false;
  instance.blinkOn = false;
  instance.phaseEndAt = null;
  instance.backgroundMuted = false;
  instance.selectedBackgroundSound = 'none';
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
  stopPomodoroCue(instance);
  stopPomodoroBackground(instance);
  instance.phase = phase;
  instance.totalSec = pomodoroDurationSecFromSettings(instance.settings, phase);
  instance.remainingSec = instance.totalSec;
  instance.running = false;
  instance.phaseEndAt = null;
  instance.awaiting = true;
  instance.blinkOn = true;
  instance.backgroundMuted = false;
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
  if (instance.phase === 'focus') {
    startPomodoroBackground(instance);
  }
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
  stopPomodoroBackground(instance);
  clearPomodoroTimer(instance);
  instance.phase = phase;
  instance.totalSec = pomodoroDurationSecFromSettings(instance.settings, phase);
  instance.remainingSec = instance.totalSec;
  instance.running = autoStart;
  instance.phaseEndAt = autoStart ? now + instance.totalSec * 1000 : null;
  instance.awaiting = false;
  instance.backgroundMuted = false;

  if (phase === 'focus') {
    selectPomodoroBackground(instance, { force: true });
  } else {
    instance.selectedBackgroundSound = 'none';
  }

  if (phase === 'done') {
    instance.completedFocusRounds = 0;
  }

  if (playSound) {
    playPomodoroPhaseEndCue(instance, { autoStart: true });
  }

  flushPomodoroState(instance);
  if (phase === 'focus' && autoStart) {
    startPomodoroBackground(instance);
  }
  renderInstance(instance);
  schedulePomodoroTick(instance, now);
}

function advancePomodoroPhase(instance, options = {}) {
  const {
    playSound = true,
    countFocus = true,
    forceAutoStart = false,
  } = options;
  const roundsGoal = pomodoroRoundsGoal(instance.settings);

  if (instance.phase === 'focus') {
    if (countFocus) {
      instance.completedFocusRounds += 1;
    }
    const hitLongBreak = instance.completedFocusRounds > 0
      && instance.completedFocusRounds % roundsGoal === 0;
    const nextBreak = hitLongBreak ? 'longBreak' : 'shortBreak';
    // 专注结束：自动则直接开始休息，否则进入待命（圆环闪烁，等待短按确认）。
    if (forceAutoStart || isEnabled(instance.settings.autoStartBreaks)) {
      startPomodoroPhase(instance, nextBreak, { autoStart: true, playSound });
    } else {
      enterAwaitingPhase(instance, nextBreak, { playSound });
    }
    return;
  }

  if (instance.phase === 'shortBreak') {
    // 短休息结束：自动则直接开始专注，否则进入待命（圆环闪烁，等按键进专注）。
    if (forceAutoStart || isEnabled(instance.settings.autoStartFocus)) {
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
  const changedBackground =
    previousSettings.backgroundSound !== instance.settings.backgroundSound ||
    previousSettings.backgroundRandom !== instance.settings.backgroundRandom ||
    previousSettings.backgroundVolume !== instance.settings.backgroundVolume;

  if (changedBackground && instance.phase === 'focus') {
    // 暂停时也要丢弃旧句柄并更新选择；只有运行中立即重启。
    selectPomodoroBackground(instance, {
      force: previousSettings.backgroundRandom !== instance.settings.backgroundRandom ||
        (!isEnabled(instance.settings.backgroundRandom) && previousSettings.backgroundSound !== instance.settings.backgroundSound),
    });
    stopPomodoroBackground(instance);
    if (instance.running) {
      startPomodoroBackground(instance);
    }
    flushPomodoroState(instance);
  }

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
    pausePomodoroBackground(instance);
  } else {
    instance.running = true;
    instance.phaseEndAt = now + Math.max(1, instance.remainingSec ?? instance.totalSec ?? 1) * 1000;
    if (instance.phase === 'focus') {
      startPomodoroBackground(instance);
    }
  }
  flushPomodoroState(instance);
  renderInstance(instance);
  schedulePomodoroTick(instance, now);
}

function skipPomodoroPhase(instance) {
  initializePomodoroInstance(instance);
  stopPomodoroCue(instance);
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

// 短按开始/暂停；待命态短按确认进入下一阶段。按压时序和长按判定由基座统一处理，
// action 只表达业务语义，不再维护双击窗口或 lastTapAt。
function handlePomodoroShortPress(instance, options = {}) {
  const now = options.now ?? Date.now();
  // 统一双击分派会先立即执行这次短按；保存按前快照，让第二次按键能跳过键面原来显示的阶段。
  instance.doublePressSnapshot = {
    phase: instance.phase,
    awaiting: Boolean(instance.awaiting),
    completedFocusRounds: instance.completedFocusRounds || 0,
  };
  if (instance.awaiting) {
    beginAwaitedPhase(instance, now);
    return;
  }
  togglePomodoro(instance, now);
}

function handlePomodoroDoublePress(instance) {
  const snapshot = instance.doublePressSnapshot;
  instance.doublePressSnapshot = null;
  if (!snapshot || snapshot.phase === 'idle' || snapshot.phase === 'done') {
    resetPomodoroInstance(instance);
    renderInstance(instance);
    return;
  }
  // 首次短按可能暂停或确认 awaiting，但不会改变正常阶段；按快照阶段静默推进即可。
  if (snapshot.phase === 'focus' || snapshot.phase === 'shortBreak' || snapshot.phase === 'longBreak') {
    instance.phase = snapshot.phase;
    instance.awaiting = false;
    stopPomodoroCue(instance);
    // 双击明确表示放弃当前阶段：专注不计完成轮次，并直接启动下一阶段，不受自动衔接设置限制。
    advancePomodoroPhase(instance, {
      playSound: false,
      countFocus: false,
      forceAutoStart: true,
    });
  }
}

// 长按只负责专注背景音；休息、完成和 idle 状态不承载其他业务。
function togglePomodoroBackgroundMuted(instance) {
  instance.backgroundMuted = !instance.backgroundMuted;
  if (instance.backgroundMuted) {
    stopPomodoroBackground(instance);
  } else if (instance.running) {
    startPomodoroBackground(instance);
  }
  flushPomodoroState(instance);
  renderInstance(instance);
  return instance.backgroundMuted;
}

function handlePomodoroLongPress(instance) {
  initializePomodoroInstance(instance);
  if (instance.phase === 'focus') {
    togglePomodoroBackgroundMuted(instance);
  }
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
  const isBreak = instance.phase === 'shortBreak' || instance.phase === 'longBreak';
  // 专注与休息对调番茄/时间的用色，两种状态一眼可分；仍只用主题既有 token，不引入第二套色板。
  // 专注：番茄用强调色（醒目）+ 时间中性；休息：番茄转中性（静下来）+ 时间染上阶段色。
  const tomatoFill = isBreak ? background.text : accent;
  // 休息时间向 text 混合再上色：longBreak 的阶段色是偏暗的 muted，直接用会读不清。
  const timeFill = instance.phase === 'done'
    ? accent
    : isBreak ? mixHex(phaseColor, background.text, 0.3) : background.text;
  const displayText = instance.phase === 'done' ? '✓' : formatPomodoroTime(remainingSec);
  const displaySize = instance.phase === 'done' ? 88 : 40;
  const statusKey = pomodoroPhaseLabel(instance);
  const label = t(statusKey, instance.settings.uiLanguage);
  const statusColor = pomodoroStatusColor(instance, theme);
  const roundsGoal = pomodoroRoundsGoal(instance.settings);
  const completedInCycle = instance.phase === 'longBreak' || instance.phase === 'done'
    ? roundsGoal
    : instance.completedFocusRounds % roundsGoal;
  const roundLights = Array.from({ length: roundsGoal }, (_, index) => {
    const cx = 128 - ((roundsGoal - 1) * 18) / 2 + index * 18;
    const filled = index < completedInCycle;
    return `<rect x="${cx - 6}" y="163" width="12" height="4" rx="2" fill="${filled ? accent : background.low}" opacity="${filled ? '1' : '0.45'}"/>`;
  }).join('');

  return toDataUrl(`
    <svg width="392" height="392" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
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
      ${instance.phase === 'done' ? '' : `<g transform="translate(128 78)" fill="${tomatoFill}">
        <circle cx="0" cy="2" r="12"/>
        <path d="M0,-14 L1.88,-9.09 L7.13,-8.82 L3.04,-5.51 L4.41,-0.43 L0,-3.3 L-4.41,-0.43 L-3.04,-5.51 L-7.13,-8.82 L-1.88,-9.09 Z"/>
      </g>`}
      ${renderPomodoroBackgroundBadge(instance, theme, background)}
      <text x="128" y="${instance.phase === 'done' ? 145 : 126}" text-anchor="middle" fill="${timeFill}" font-size="${displaySize}" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(displayText)}</text>
      <text data-pomodoro-status="${statusKey}" x="128" y="${instance.phase === 'done' ? 178 : 152}" text-anchor="middle" fill="${statusColor}" font-size="19" font-weight="800" font-family="Arial, Helvetica, sans-serif" letter-spacing="2">${escapeXml(label)}</text>${instance.phase === 'done' ? '' : roundLights}
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
      cueDuration: '180',
      backgroundSound: 'rain',
      backgroundRandom: 'false',
      backgroundVolume: '35',
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
      cueDuration: normalizeChoice(settings.cueDuration, defaults.cueDuration, POMODORO_CUE_DURATIONS),
      backgroundSound: normalizePomodoroBackgroundChoice(settings.backgroundSound, defaults.backgroundSound),
      backgroundRandom: normalizeBooleanString(settings.backgroundRandom, defaults.backgroundRandom),
      backgroundVolume: normalizeNumberString(settings.backgroundVolume, defaults.backgroundVolume, 0, 100),
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
      cueStartedAt: null,
      backgroundProcess: null,
      backgroundGeneration: 0,
      backgroundPaused: false,
      backgroundMuted: false,
      selectedBackgroundSound: null,
      previewProcess: null,
      previewGeneration: 0,
      previewPlaying: false,
      // 进行中的番茄靠 phaseEndAt 跨重启恢复真实剩余时间，重建实例不能把它吞掉。
      ...(instance?.context ? hydratePomodoroState(readPersistedState(instance.context)) : {}),
    }),
    onRun: (instance) => handlePomodoroShortPress(instance),
    onDoublePress: (instance) => handlePomodoroDoublePress(instance),
    onLongPress: (instance) => handlePomodoroLongPress(instance),
    onReady: (instance) => {
      initializePomodoroInstance(instance);
      if (instance.running) {
        const wasRunningFocus = instance.phase === 'focus';
        // 先按时钟对齐再续排定时器：睡眠唤醒/进程重启期间流逝的时间在这里一次性追平。
        tickPomodoro(instance);
        // 过期 break/done 推进至 focus 时，startPomodoroPhase 已经启动背景音；
        // 只有原本就是同一运行中 focus 才在这里补启一次。
        if (wasRunningFocus && instance.phase === 'focus' && instance.running) {
          startPomodoroBackground(instance);
          flushPomodoroState(instance);
        }
      }
    },
    onSettingsChanged: (instance, previousSettings) => {
      initializePomodoroInstance(instance);
      reconcilePomodoroSettings(instance, previousSettings);
    },
    onParamFromPlugin: (instance, param) => {
      if (param?.previewSound) {
        // PI 试听：播放点选样式，无视 soundEnabled，不改动计时状态。
        playPomodoroCuePreview(instance, param.previewSound);
        return;
      }
      if (param?.previewBackgroundSound) {
        playPomodoroBackgroundPreview(instance, param.previewBackgroundSound);
        return;
      }
      if (param?.stopPreviewBackgroundSound === 'true') {
        stopPomodoroPreview(instance);
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
      stopPomodoroBackground(instance);
      stopPomodoroPreview(instance);
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
      handlePomodoroLongPress,
      handlePomodoroShortPress,
      handlePomodoroDoublePress,
      startPomodoroPhase,
      pomodoroCuePlan,
      shouldRepeatPomodoroCue,
      cueDurationMs,
      playPomodoroPhaseEndCue,
      stopPomodoroCue,
      startPomodoroBackground,
      stopPomodoroBackground,
      pausePomodoroBackground,
      togglePomodoroBackgroundMuted,
      playPomodoroBackgroundPreview,
      playPomodoroCuePreview,
      stopPomodoroPreview,
      selectPomodoroBackground,
      backgroundAudioPath,
      backgroundPlaybackCommand,
      windowsBackgroundPlaybackCommand,
      pomodoroBackgroundGainDb,
      amplifiedPomodoroBackgroundVolume,
      normalizePomodoroBackgroundChoice,
      pomodoroStatusColor,
      pomodoroBackgroundGlyph,
      pomodoroBackgroundSoundForDisplay,
      renderPomodoroBackgroundBadge,
    },
  };
}
