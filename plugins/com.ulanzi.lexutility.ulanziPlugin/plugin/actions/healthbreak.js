import { execFile } from 'node:child_process';
import os from 'node:os';

export function createHealthBreakAction(runtime) {
  const {
    clearInstanceTimeout,
    escapeXml,
    frameContent,
    frameFor,
    frameHighlight,
    instances: INSTANCES,
    normalizeBooleanString,
    normalizeNumberString,
    normalizeTime,
    readPersistedState,
    renderInstance,
    renderThemeBackdrop,
    sendParamFromPlugin,
    setInstanceTimeout,
    t,
    themeFor,
    toDataUrl,
    writePersistedState,
  } = runtime;

  const ACTION_SUFFIX = '.healthbreak';
  const STATE_VERSION = 1;
  const TIMER_SLOT = 'healthbreak';
  const CHECKPOINT_MS = 60_000;
  const REMINDER_COOLDOWN_MS = 120_000;
  const ACTIVE_FLASH_WINDOW_MS = 120_000;
  const ACTIVE_PROBE_INTERVAL_MS = 30_000;
  const ACTIVE_IDLE_LIMIT_MS = 5 * 60_000;
  const MAX_ACTIVE_DELTA_MS = 2_500;
  const DAY_MS = 86_400_000;
  // 历史保留天数：供配置页 GitHub 风格活跃度网格用（约 13 周，一个季度）。
  const HISTORY_DAYS = 91;
  const VALID_STATUSES = ['waiting', 'due', 'queued', 'running', 'paused', 'done'];
  const GROUP_KEYS = ['eyes', 'neck', 'hands', 'stand', 'breathe', 'pelvic'];

  const GROUPS = Object.freeze({
    eyes: {
      label: 'Eyes',
      stages: [
        { id: 'far', label: 'Look far', seconds: 20, cue: 'soft' },
        { id: 'blink', label: 'Blink', seconds: 10, reps: 10, cue: 'bright' },
      ],
    },
    neck: {
      label: 'Neck and shoulders',
      stages: [
        { id: 'chin', label: 'Chin tuck', seconds: 15, cue: 'soft' },
        { id: 'left', label: 'Turn left', seconds: 15, cue: 'low' },
        { id: 'right', label: 'Turn right', seconds: 15, cue: 'high' },
        { id: 'scapula', label: 'Shoulder blades', seconds: 20, reps: 10, cue: 'bright' },
      ],
    },
    hands: {
      label: 'Wrists',
      stages: [
        { id: 'open', label: 'Open and close', seconds: 20, reps: 10, cue: 'bright' },
        { id: 'wristLeft', label: 'Left wrist', seconds: 15, cue: 'low' },
        { id: 'wristRight', label: 'Right wrist', seconds: 15, cue: 'high' },
      ],
    },
    stand: {
      label: 'Stand',
      stages: [
        { id: 'rise', label: 'Stand up', seconds: 10, cue: 'bright' },
        { id: 'calf', label: 'Heel raises', seconds: 30, reps: 10, cue: 'high' },
        { id: 'march', label: 'Walk', seconds: 30, cue: 'bright' },
      ],
    },
    breathe: {
      label: 'Breathing',
      stages: Array.from({ length: 5 }, () => [
        { id: 'inhale', label: 'Inhale', seconds: 4, cue: 'high' },
        { id: 'exhale', label: 'Exhale', seconds: 6, cue: 'low' },
      ]).flat(),
    },
    pelvic: {
      label: 'Pelvic floor',
      stages: Array.from({ length: 5 }, () => [
        { id: 'contract', label: 'Contract', seconds: 5, cue: 'high' },
        { id: 'release', label: 'Relax', seconds: 5, cue: 'low' },
      ]).flat(),
    },
  });

  let activeContext = null;
  let activeReminderContext = null;
  let reminderCooldownUntil = 0;
  const manualQueue = [];
  const activityProbe = {
    active: true,
    checkedAt: 0,
    pending: false,
  };

  function isEnabled(value) {
    return String(value) === 'true';
  }

  function parseList(value, allowed, fallback, max = allowed.length) {
    const seen = new Set();
    const result = String(value ?? '').split(',').flatMap((part) => {
      const key = part.trim();
      if (!allowed.includes(key) || seen.has(key) || seen.size >= max) {
        return [];
      }
      seen.add(key);
      return [key];
    });
    return result.length > 0 ? result : [...fallback];
  }

  function selectedGroups(settings) {
    return parseList(settings.groups, GROUP_KEYS, ['eyes', 'neck'], 3);
  }

  function selectedDays(settings) {
    return parseList(settings.activeDays, ['0', '1', '2', '3', '4', '5', '6'], ['0', '1', '2', '3', '4', '5', '6'])
      .map(Number);
  }

  function intervalMs(settings) {
    return (Number.parseInt(settings.intervalMin, 10) || 45) * 60_000;
  }

  function localDayKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // 本地周一 00:00 —— 本周达标统计以周一到周日为一周。
  function startOfWeek(date) {
    const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const mondayOffset = (local.getDay() + 6) % 7;
    local.setDate(local.getDate() - mondayOffset);
    return local;
  }

  function minutesFromTime(value) {
    const [hours, minutes] = String(value).split(':').map(Number);
    return hours * 60 + minutes;
  }

  // 午休排除：只在时间已落入有效时段时再判定，因此与有效时段天然取交集
  // （例如有效 09–18、午休配成 17–19，仅 17–18 被遮蔽）。午休窗按同日
  // [start, end) 计算，start >= end（含相等）视为未配置，不遮蔽。
  function withinLunch(settings, minute) {
    if (!isEnabled(settings.lunchEnabled)) {
      return false;
    }
    const start = minutesFromTime(settings.lunchStart);
    const end = minutesFromTime(settings.lunchEnd);
    return start < end && minute >= start && minute < end;
  }

  function healthWindowFor(settings, now = Date.now()) {
    const date = new Date(now);
    const minute = date.getHours() * 60 + date.getMinutes();
    const start = minutesFromTime(settings.activeStart);
    const end = minutesFromTime(settings.activeEnd);
    const anchor = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    let active = false;

    if (start === end) {
      active = true;
    } else if (start < end) {
      active = minute >= start && minute < end;
    } else if (minute >= start) {
      active = true;
    } else if (minute < end) {
      active = true;
      anchor.setDate(anchor.getDate() - 1);
    }

    if (!active || withinLunch(settings, minute) || !selectedDays(settings).includes(anchor.getDay())) {
      return { active: false, dayKey: null };
    }
    return { active: true, dayKey: localDayKey(anchor) };
  }

  function emptyStats(dayKey = null) {
    return { dayKey, completed: 0, bonus: 0, skipped: 0, cancelled: 0 };
  }

  function sanitizeStats(raw, fallbackDayKey = null) {
    const number = (value) => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
    const rawDayKey = typeof raw?.dayKey === 'string' ? raw.dayKey : fallbackDayKey;
    return {
      dayKey: /^\d{4}-\d{2}-\d{2}$/.test(rawDayKey || '') ? rawDayKey : null,
      completed: number(raw?.completed),
      bonus: number(raw?.bonus),
      skipped: number(raw?.skipped),
      cancelled: number(raw?.cancelled),
    };
  }

  function sanitizeHistory(raw) {
    if (!Array.isArray(raw)) {
      return [];
    }
    const byDay = new Map();
    for (const entry of raw) {
      const clean = sanitizeStats(entry);
      if (clean.dayKey) {
        byDay.set(clean.dayKey, clean);
      }
    }
    return [...byDay.values()].sort((left, right) => left.dayKey.localeCompare(right.dayKey)).slice(-HISTORY_DAYS);
  }

  function archiveToday(instance) {
    if (!instance.today?.dayKey) {
      return;
    }
    instance.history = sanitizeHistory([...(instance.history || []), instance.today]);
  }

  function beginHealthDay(instance, dayKey) {
    if (instance.today?.dayKey === dayKey) {
      return false;
    }
    archiveToday(instance);
    instance.today = emptyStats(dayKey);
    instance.healthStatus = 'waiting';
    instance.queueKind = null;
    instance.intervalRemainingMs = intervalMs(instance.settings);
    instance.dueAt = null;
    instance.reminderPlayed = false;
    return true;
  }

  function manualDayKey(instance, now = Date.now()) {
    return healthWindowFor(instance.settings, now).dayKey || localDayKey(new Date(now));
  }

  function buildSessionPlan(settings) {
    return selectedGroups(settings).flatMap((groupKey) => GROUPS[groupKey].stages.map((stage) => ({
      ...stage,
      groupKey,
      durationMs: stage.seconds * 1000,
    })));
  }

  function serializeHealthBreakState(instance) {
    return {
      v: STATE_VERSION,
      healthStatus: instance.healthStatus,
      intervalRemainingMs: Math.max(0, Math.round(instance.intervalRemainingMs || 0)),
      dueAt: Number.isFinite(instance.dueAt) ? instance.dueAt : null,
      today: sanitizeStats(instance.today),
      history: sanitizeHistory(instance.history),
      sessionStepIndex: Math.max(0, Math.round(instance.sessionStepIndex || 0)),
      stageRemainingMs: Math.max(0, Math.round(instance.stageRemainingMs || 0)),
      sessionWasBonus: Boolean(instance.sessionWasBonus),
    };
  }

  function hydrateHealthBreakState(raw, settings) {
    if (!raw || typeof raw !== 'object' || raw.v !== STATE_VERSION) {
      return {};
    }
    const restoredStatus = VALID_STATUSES.includes(raw.healthStatus) ? raw.healthStatus : 'waiting';
    const healthStatus = ['running', 'paused'].includes(restoredStatus) ? 'paused'
      : ['due', 'queued'].includes(restoredStatus) ? 'queued'
        : restoredStatus;
    return {
      healthStatus,
      queueKind: healthStatus === 'queued' ? 'due' : null,
      intervalRemainingMs: Number.isFinite(raw.intervalRemainingMs)
        ? Math.max(0, Math.min(intervalMs(settings), Math.round(raw.intervalRemainingMs)))
        : intervalMs(settings),
      dueAt: Number.isFinite(raw.dueAt) ? raw.dueAt : null,
      today: sanitizeStats(raw.today),
      history: sanitizeHistory(raw.history),
      sessionStepIndex: Number.isFinite(raw.sessionStepIndex) ? Math.max(0, Math.round(raw.sessionStepIndex)) : 0,
      stageRemainingMs: Number.isFinite(raw.stageRemainingMs) ? Math.max(0, Math.round(raw.stageRemainingMs)) : 0,
      sessionWasBonus: Boolean(raw.sessionWasBonus),
    };
  }

  function flushHealthBreakState(instance, force = false, now = Date.now()) {
    if (!instance?.context || (!force && now - (instance.lastCheckpointAt || 0) < CHECKPOINT_MS)) {
      return false;
    }
    instance.lastCheckpointAt = now;
    return writePersistedState(instance.context, serializeHealthBreakState(instance));
  }

  function healthInstances() {
    return [...INSTANCES.values()].filter((instance) => instance?.actionUuid?.endsWith(ACTION_SUFFIX));
  }

  function sendStats(instance) {
    if (!instance?.context || typeof sendParamFromPlugin !== 'function') {
      return;
    }
    const goal = Number.parseInt(instance.settings.dailyGoal, 10) || 6;
    const history = sanitizeHistory([...(instance.history || []), instance.today].filter(Boolean));
    let streak = 0;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if ((history[index].completed || 0) < goal) {
        break;
      }
      streak += 1;
    }
    const weekStart = startOfWeek(new Date());
    const mondayKey = localDayKey(weekStart);
    const sundayKey = localDayKey(new Date(weekStart.getTime() + 6 * DAY_MS));
    let weekCompleted = 0;
    let weekGoalDays = 0;
    for (const entry of history) {
      if (entry.dayKey >= mondayKey && entry.dayKey <= sundayKey) {
        weekCompleted += entry.completed || 0;
        if ((entry.completed || 0) >= goal) {
          weekGoalDays += 1;
        }
      }
    }
    sendParamFromPlugin({
      healthStats: JSON.stringify({
        today: sanitizeStats(instance.today), history, streak, goal, weekCompleted, weekGoalDays,
      }),
    }, instance.context);
  }

  function stopCue(instance) {
    const handle = instance?.cueProcess;
    instance.cueProcess = null;
    if (handle && typeof handle.kill === 'function' && !handle.killed) {
      try {
        handle.kill();
      } catch {
        // 短提示音可能已经自行退出；声音失败不影响状态机。
      }
    }
  }

  function playCue(instance, kind = 'soft') {
    if (!isEnabled(instance.settings.soundEnabled)) {
      return null;
    }
    stopCue(instance);
    const platform = os.platform();
    // 音色偏柔和悦耳：提示用清亮铃声，节奏拍点(beat)用轻柔的水滴/气泡音，
    // 避免久坐提醒变成刺耳的蜂鸣。beat 在运动阶段内按动作节奏反复播放。
    const macSounds = { reminder: 'Glass', start: 'Bottle', complete: 'Glass', bright: 'Ping', high: 'Blow', low: 'Purr', soft: 'Tink', beat: 'Pop' };
    const windowsTones = { reminder: [880, 150], start: [660, 100], complete: [988, 180], bright: [784, 90], high: [698, 90], low: [440, 120], soft: [554, 80], beat: [620, 55] };
    if (platform === 'darwin') {
      instance.cueProcess = execFile('afplay', [`/System/Library/Sounds/${macSounds[kind] || macSounds.soft}.aiff`], () => {
        instance.cueProcess = null;
      });
      return instance.cueProcess;
    }
    if (platform === 'win32') {
      const [frequency, duration] = windowsTones[kind] || windowsTones.soft;
      instance.cueProcess = execFile('powershell', ['-NoProfile', '-Command', `[console]::beep(${frequency},${duration})`], () => {
        instance.cueProcess = null;
      });
      return instance.cueProcess;
    }
    try {
      process.stdout.write('\u0007');
    } catch {
      // 无终端时静音降级。
    }
    return null;
  }

  function parseIdleMilliseconds(output, platform = os.platform()) {
    const match = String(output || '').match(/(\d+)/);
    if (!match) {
      return null;
    }
    const value = Number(match[1]);
    if (!Number.isFinite(value)) {
      return null;
    }
    return platform === 'darwin' ? value / 1_000_000 : value;
  }

  function maybeProbeActivity(now = Date.now()) {
    if (activityProbe.pending || now - activityProbe.checkedAt < ACTIVE_PROBE_INTERVAL_MS) {
      return activityProbe.active;
    }
    activityProbe.pending = true;
    activityProbe.checkedAt = now;
    const platform = os.platform();
    let command;
    let args;
    if (platform === 'darwin') {
      command = '/usr/sbin/ioreg';
      args = ['-c', 'IOHIDSystem'];
    } else if (platform === 'win32') {
      command = 'powershell';
      args = ['-NoProfile', '-Command', '$t=@"\nusing System;using System.Runtime.InteropServices;public class I{[StructLayout(LayoutKind.Sequential)]public struct L{public uint s;public uint t;}[DllImport("user32.dll")]public static extern bool GetLastInputInfo(ref L l);public static uint M(){L l=new L();l.s=(uint)Marshal.SizeOf(l);GetLastInputInfo(ref l);return unchecked((uint)Environment.TickCount-l.t);}}\n"@;Add-Type $t -ErrorAction SilentlyContinue;[I]::M()'];
    } else {
      command = 'xprintidle';
      args = [];
    }
    execFile(command, args, { timeout: 4_000 }, (error, stdout) => {
      activityProbe.pending = false;
      if (error) {
        activityProbe.active = true;
        return;
      }
      const idleMs = platform === 'darwin'
        ? parseIdleMilliseconds((String(stdout).match(/"HIDIdleTime"\s*=\s*(\d+)/) || [])[1], platform)
        : parseIdleMilliseconds(stdout, platform);
      activityProbe.active = idleMs == null ? true : idleMs < ACTIVE_IDLE_LIMIT_MS;
    });
    return activityProbe.active;
  }

  function stageFor(instance) {
    return instance.sessionPlan?.[instance.sessionStepIndex] || null;
  }

  // 运动阶段内的节奏拍点间隔（毫秒），0 表示该阶段不补拍。
  // 次数类动作每次一拍；较长的计时保持类动作约每 2 秒一拍；呼吸/盆底这类
  // 短促交替动作靠阶段切换音自身节奏即可，不再叠加拍点，避免过于吵闹。
  function beatIntervalMs(stage) {
    if (!stage) {
      return 0;
    }
    if (stage.reps) {
      return Math.max(600, Math.round(stage.durationMs / stage.reps));
    }
    return stage.durationMs >= 8_000 ? 2_000 : 0;
  }

  // 按已进行时长补齐应播放的拍点，只在运动进行且用户活动时调用。
  function emitStageBeats(instance) {
    const stage = stageFor(instance);
    const interval = beatIntervalMs(stage);
    if (interval <= 0) {
      return;
    }
    const elapsed = Math.max(0, (stage.durationMs || 0) - instance.stageRemainingMs);
    const due = Math.floor(elapsed / interval);
    while (instance.stageBeatCount < due && instance.stageBeatCount < 1_000) {
      instance.stageBeatCount += 1;
      playCue(instance, 'beat');
    }
  }

  function scheduleTick(instance, delay = 1_000) {
    setInstanceTimeout(instance, TIMER_SLOT, () => tickHealthBreak(instance), delay);
  }

  function renderMany(instances) {
    for (const instance of instances) {
      renderInstance(instance);
    }
  }

  function promoteDue(now = Date.now()) {
    const candidates = healthInstances().filter((instance) => (
      ['due', 'queued'].includes(instance.healthStatus) && instance.queueKind !== 'manual'
    ));
    if (activeContext || now < reminderCooldownUntil || candidates.length === 0) {
      return null;
    }
    const current = candidates.find((instance) => instance.context === activeReminderContext && instance.healthStatus === 'due');
    if (current) {
      return current;
    }
    candidates.sort((left, right) => (left.dueAt || now) - (right.dueAt || now));
    const chosen = candidates[0];
    for (const candidate of candidates) {
      candidate.healthStatus = candidate === chosen ? 'due' : 'queued';
      candidate.queueKind = 'due';
    }
    activeReminderContext = chosen.context;
    if (!chosen.reminderPlayed) {
      chosen.reminderPlayed = true;
      playCue(chosen, 'reminder');
    }
    renderMany(candidates);
    return chosen;
  }

  function clearReminder(instance) {
    if (activeReminderContext === instance.context) {
      activeReminderContext = null;
    }
    instance.reminderPlayed = false;
  }

  function removeFromManualQueue(context) {
    let index = manualQueue.indexOf(context);
    while (index >= 0) {
      manualQueue.splice(index, 1);
      index = manualQueue.indexOf(context);
    }
  }

  function startQueuedManual(now = Date.now()) {
    while (manualQueue.length > 0) {
      const context = manualQueue.shift();
      const instance = INSTANCES.get(context);
      if (instance?.actionUuid?.endsWith(ACTION_SUFFIX)) {
        startSession(instance, now);
        return instance;
      }
    }
    return null;
  }

  function startSession(instance, now = Date.now()) {
    if (activeContext && activeContext !== instance.context) {
      removeFromManualQueue(instance.context);
      manualQueue.unshift(instance.context);
      instance.healthStatus = 'queued';
      instance.queueKind = 'manual';
      renderInstance(instance);
      flushHealthBreakState(instance, true, now);
      return false;
    }

    const dayKey = manualDayKey(instance, now);
    if (instance.today?.dayKey !== dayKey) {
      beginHealthDay(instance, dayKey);
    }
    for (const other of healthInstances()) {
      if (other.context !== instance.context && other.healthStatus === 'due') {
        other.healthStatus = 'queued';
        other.queueKind = 'due';
        renderInstance(other);
      }
    }
    clearReminder(instance);
    activeContext = instance.context;
    instance.sessionPlan = buildSessionPlan(instance.settings);
    instance.sessionStepIndex = 0;
    instance.stageRemainingMs = instance.sessionPlan[0]?.durationMs || 1_000;
    instance.stageBeatCount = 0;
    instance.healthStatus = 'running';
    instance.queueKind = null;
    instance.sessionWasBonus = instance.today.completed >= Number.parseInt(instance.settings.dailyGoal, 10);
    instance.intervalRemainingMs = intervalMs(instance.settings);
    instance.lastTickAt = now;
    instance.animFrame = 0;
    playCue(instance, 'start');
    renderInstance(instance);
    flushHealthBreakState(instance, true, now);
    scheduleTick(instance, 500);
    return true;
  }

  function releaseSession(instance, now = Date.now(), { cooldown = true } = {}) {
    if (activeContext === instance.context) {
      activeContext = null;
    }
    stopCue(instance);
    if (cooldown) {
      reminderCooldownUntil = now + REMINDER_COOLDOWN_MS;
    }
    const next = startQueuedManual(now);
    if (!next) {
      promoteDue(now);
    }
    return next;
  }

  function completeSession(instance, now = Date.now()) {
    const goal = Number.parseInt(instance.settings.dailyGoal, 10) || 6;
    if (instance.sessionWasBonus || instance.today.completed >= goal) {
      instance.today.bonus += 1;
    } else {
      instance.today.completed += 1;
    }
    instance.healthStatus = instance.today.completed >= goal ? 'done' : 'waiting';
    instance.intervalRemainingMs = intervalMs(instance.settings);
    instance.sessionPlan = [];
    instance.sessionStepIndex = 0;
    instance.stageRemainingMs = 0;
    flushHealthBreakState(instance, true, now);
    sendStats(instance);
    renderInstance(instance);
    const next = releaseSession(instance, now);
    if (!next) {
      playCue(instance, 'complete');
    }
    scheduleTick(instance, 1_000);
  }

  function advanceStage(instance, now = Date.now()) {
    instance.sessionStepIndex += 1;
    const next = stageFor(instance);
    if (!next) {
      completeSession(instance, now);
      return false;
    }
    instance.stageRemainingMs = next.durationMs;
    instance.stageBeatCount = 0;
    playCue(instance, next.cue);
    flushHealthBreakState(instance, true, now);
    return true;
  }

  function skipReminder(instance, now = Date.now()) {
    clearReminder(instance);
    instance.today ||= emptyStats(manualDayKey(instance, now));
    instance.today.skipped += 1;
    instance.healthStatus = instance.today.completed >= Number.parseInt(instance.settings.dailyGoal, 10) ? 'done' : 'waiting';
    instance.queueKind = null;
    instance.intervalRemainingMs = intervalMs(instance.settings);
    reminderCooldownUntil = now + REMINDER_COOLDOWN_MS;
    flushHealthBreakState(instance, true, now);
    sendStats(instance);
    renderInstance(instance);
    promoteDue(now);
  }

  function cancelSession(instance, now = Date.now(), { count = true } = {}) {
    if (count) {
      instance.today ||= emptyStats(manualDayKey(instance, now));
      instance.today.cancelled += 1;
    }
    instance.healthStatus = instance.today?.completed >= Number.parseInt(instance.settings.dailyGoal, 10) ? 'done' : 'waiting';
    instance.queueKind = null;
    instance.intervalRemainingMs = intervalMs(instance.settings);
    instance.sessionPlan = [];
    instance.sessionStepIndex = 0;
    instance.stageRemainingMs = 0;
    flushHealthBreakState(instance, true, now);
    sendStats(instance);
    renderInstance(instance);
    releaseSession(instance, now);
    scheduleTick(instance, 1_000);
  }

  function handleShortPress(instance, now = Date.now()) {
    if (instance.healthStatus === 'running') {
      instance.healthStatus = 'paused';
      stopCue(instance);
      flushHealthBreakState(instance, true, now);
      renderInstance(instance);
      scheduleTick(instance, 1_000);
      return;
    }
    if (instance.healthStatus === 'paused') {
      if (activeContext && activeContext !== instance.context) {
        startSession(instance, now);
        return;
      }
      activeContext = instance.context;
      instance.healthStatus = 'running';
      instance.lastTickAt = now;
      playCue(instance, stageFor(instance)?.cue || 'start');
      flushHealthBreakState(instance, true, now);
      renderInstance(instance);
      scheduleTick(instance, 500);
      return;
    }
    startSession(instance, now);
  }

  function handleLongPress(instance, now = Date.now()) {
    if (instance.healthStatus === 'due' || (instance.healthStatus === 'queued' && instance.queueKind === 'due')) {
      skipReminder(instance, now);
      return;
    }
    if (instance.healthStatus === 'running' || instance.healthStatus === 'paused') {
      cancelSession(instance, now);
    }
  }

  function expireReminder(instance) {
    clearReminder(instance);
    instance.healthStatus = 'waiting';
    instance.queueKind = null;
    instance.dueAt = null;
    instance.intervalRemainingMs = intervalMs(instance.settings);
    renderInstance(instance);
  }

  function tickHealthBreak(instance, options = {}) {
    const now = options.now ?? Date.now();
    const registry = options.instances ?? INSTANCES;
    if (!instance || !registry.has(instance.context)) {
      return;
    }
    const previousTick = instance.lastTickAt || now;
    const rawDelta = Math.max(0, now - previousTick);
    const delta = Math.min(rawDelta, MAX_ACTIVE_DELTA_MS);
    instance.lastTickAt = now;
    instance.animFrame = (instance.animFrame + 1) % 4;
    const userActive = options.userActive ?? maybeProbeActivity(now);

    if (instance.healthStatus === 'running') {
      if (userActive) {
        instance.stageRemainingMs -= delta;
        while (instance.stageRemainingMs <= 0 && instance.healthStatus === 'running') {
          const overshoot = -instance.stageRemainingMs;
          if (!advanceStage(instance, now)) {
            return;
          }
          instance.stageRemainingMs -= overshoot;
        }
        emitStageBeats(instance);
      }
      renderInstance(instance);
      flushHealthBreakState(instance, false, now);
      scheduleTick(instance, 500);
      return;
    }

    if (instance.healthStatus === 'paused') {
      renderInstance(instance);
      scheduleTick(instance, 1_000);
      return;
    }

    const window = healthWindowFor(instance.settings, now);
    if (!window.active) {
      if (instance.healthStatus === 'due' || (instance.healthStatus === 'queued' && instance.queueKind === 'due')) {
        expireReminder(instance);
      }
      renderInstance(instance);
      scheduleTick(instance, 30_000);
      return;
    }

    if (beginHealthDay(instance, window.dayKey)) {
      flushHealthBreakState(instance, true, now);
      sendStats(instance);
    }
    const goal = Number.parseInt(instance.settings.dailyGoal, 10) || 6;
    if (instance.today.completed >= goal) {
      instance.healthStatus = 'done';
    } else if (instance.healthStatus === 'waiting' && userActive) {
      instance.intervalRemainingMs = Math.max(0, instance.intervalRemainingMs - delta);
      if (instance.intervalRemainingMs <= 0) {
        instance.healthStatus = 'queued';
        instance.queueKind = 'due';
        instance.dueAt = now;
        instance.reminderPlayed = false;
        flushHealthBreakState(instance, true, now);
      }
    }
    promoteDue(now);
    renderInstance(instance);
    flushHealthBreakState(instance, false, now);
    const fast = instance.healthStatus === 'due' && reminderFlashStrong(instance, now);
    scheduleTick(instance, fast ? 650 : instance.healthStatus === 'due' ? 1_800 : 1_000);
  }

  function reminderFlashStrong(instance, now = Date.now()) {
    const elapsed = Math.max(0, now - (instance.dueAt || now));
    if (elapsed < ACTIVE_FLASH_WINDOW_MS) {
      return true;
    }
    const repeatMin = Number.parseInt(instance.settings.repeatReminderMin, 10) || 0;
    return repeatMin > 0 && elapsed % (repeatMin * 60_000) < 10_000;
  }

  function compactRemaining(milliseconds) {
    const minutes = Math.max(0, Math.ceil((milliseconds || 0) / 60_000));
    if (minutes < 60) {
      return `${minutes}m`;
    }
    return `${Math.floor(minutes / 60)}h`;
  }

  function groupGlyph(key, x, y, size, color, muted, phase = 0) {
    const scale = size / 48;
    const transform = `translate(${x} ${y}) scale(${scale.toFixed(3)})`;
    const pulse = phase % 2 === 0 ? 0 : 2;
    const common = `fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"`;
    if (key === 'eyes') {
      return `<g transform="${transform}" ${common}><path d="M3 24 Q24 5 45 24 Q24 43 3 24Z"/><circle cx="24" cy="24" r="${7 + pulse}" fill="${color}" stroke="none"/></g>`;
    }
    if (key === 'neck') {
      return `<g transform="${transform}" ${common}><circle cx="24" cy="13" r="9"/><path d="M19 23v7M29 23v7M7 43q4-13 17-13t17 13"/><path d="M8 15l-5 5 5 5M40 15l5 5-5 5" stroke="${muted}"/></g>`;
    }
    if (key === 'hands') {
      return `<g transform="${transform}" ${common}><path d="M13 42V21q0-4 4-4t4 4V9q0-4 4-4t4 4v12-9q0-4 4-4t4 4v14-7q0-4 4-4t4 4v10q0 14-14 14H26q-8 0-13-1Z"/></g>`;
    }
    if (key === 'stand') {
      return `<g transform="${transform}" ${common}><circle cx="24" cy="8" r="6"/><path d="M24 15v16M12 22l12-7 12 7M24 31l-9 14M24 31l9 14"/><path d="M10 ${44 - pulse}h28" stroke="${muted}"/></g>`;
    }
    if (key === 'breathe') {
      return `<g transform="${transform}" ${common}><path d="M22 9v12c-8-9-16-3-16 8 0 9 6 14 16 14V25M26 9v12c8-9 16-3 16 8 0 9-6 14-16 14V25"/><path d="M24 8v35" stroke="${muted}"/></g>`;
    }
    return `<g transform="${transform}" ${common}><path d="M8 10q16 8 32 0M8 38q16-8 32 0"/><ellipse cx="24" cy="24" rx="${12 + pulse}" ry="9"/><circle cx="24" cy="24" r="3" fill="${color}" stroke="none"/></g>`;
  }

  function groupLayout(groups) {
    if (groups.length === 1) return [{ x: 102, y: 56, size: 54 }];
    if (groups.length === 2) return [{ x: 60, y: 64, size: 50 }, { x: 148, y: 64, size: 50 }];
    return [{ x: 48, y: 68, size: 46 }, { x: 105, y: 68, size: 46 }, { x: 162, y: 68, size: 46 }];
  }

  // ---- 护眼 / 颈椎大幅面指导图 ----
  // 半具象线描，走 theme token，占满安全框上部主视觉区（约 y48..148），
  // 逐帧（animFrame 0..3、约 2fps）用离散姿势表达动作，不依赖插值平滑。
  function guideStroke(color, width = 6) {
    return `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;
  }

  function renderEyeShape(theme, cx, cy, halfWidth, aperture) {
    const c = theme.accent;
    if (aperture <= 0.08) {
      return `<path d="M${cx - halfWidth} ${cy} Q${cx} ${cy + 8} ${cx + halfWidth} ${cy}" ${guideStroke(c)}/>
        <path d="M${cx - halfWidth + 8} ${cy + 10} l-4 8 M${cx} ${cy + 12} v9 M${cx + halfWidth - 8} ${cy + 10} l4 8" ${guideStroke(theme.muted, 4)}/>`;
    }
    const h = Math.max(4, Math.round(halfWidth * 0.62 * aperture));
    const irisR = Math.min(h - 3, Math.round(halfWidth * 0.36));
    const iris = irisR > 3
      ? `<circle cx="${cx}" cy="${cy}" r="${irisR}" fill="${c}" stroke="none"/>
         <circle cx="${cx}" cy="${cy}" r="${Math.max(2, Math.round(irisR * 0.42))}" fill="${theme.canvas}" stroke="none"/>`
      : '';
    return `<path d="M${cx - halfWidth} ${cy} Q${cx} ${cy - h} ${cx + halfWidth} ${cy} Q${cx} ${cy + h} ${cx - halfWidth} ${cy} Z" ${guideStroke(c)}/>${iris}`;
  }

  function guideEyesFar(theme, phase) {
    const pulse = [0, 2, 4, 2][phase] || 0;
    return `${renderEyeShape(theme, 92, 96, 36, 1)}
      <path d="M124 96 H176" ${guideStroke(theme.muted, 4)} stroke-dasharray="2 11"/>
      <circle cx="190" cy="96" r="${8 + pulse}" ${guideStroke(theme.muted, 4)}/>`;
  }

  function guideEyesBlink(theme, phase) {
    const aperture = [1, 0.4, 0.04, 0.4][phase] ?? 1;
    return renderEyeShape(theme, 128, 94, 46, aperture);
  }

  function guideNeckChin(theme, phase) {
    const shift = [14, 7, 0, 7][phase] ?? 0;
    const hx = 116 + shift;
    const hy = 76;
    const r = 25;
    const c = theme.accent;
    return `<circle cx="${hx}" cy="${hy}" r="${r}" ${guideStroke(c)}/>
      <path d="M${hx + r - 3} ${hy - 4} l16 11 l-14 6" ${guideStroke(c, 5)}/>
      <path d="M${hx - 4} ${hy + r - 2} q4 16 20 18" ${guideStroke(c)}/>
      <path d="M92 142 h72" ${guideStroke(theme.muted, 5)}/>
      <path d="M172 66 h-30 m9 -9 l-11 9 l11 9" ${guideStroke(theme.muted, 5)}/>`;
  }

  function guideNeckTurn(theme, phase, dir) {
    const t = [0, 0.5, 1, 0.5][phase] ?? 0;
    const sign = dir === 'left' ? -1 : 1;
    const cx = 128;
    const cy = 84;
    const rx = 36;
    const ry = 42;
    const nx = cx + Math.round(sign * 24 * t);
    const c = theme.accent;
    const m = theme.muted;
    return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" ${guideStroke(c)}/>
      <circle cx="${nx}" cy="${cy - 10}" r="4" fill="${c}" stroke="none"/>
      <path d="M${nx} ${cy - 6} L${nx + sign * 18} ${cy + 1} L${nx} ${cy + 8} Z" fill="${c}" stroke="none"/>
      <path d="M${cx - sign * 4} ${cy + ry + 10} q ${sign * 38} 15 ${sign * 62} -6" ${guideStroke(m, 5)}/>
      <path d="M${cx + sign * 58} ${cy + ry + 2} l ${sign * 2} 13 l ${sign * -14} -5" ${guideStroke(m, 5)}/>`;
  }

  function guideNeckScapula(theme, phase) {
    const squeeze = [0, 4, 9, 4][phase] ?? 0;
    const c = theme.accent;
    const m = theme.muted;
    const gap = 26 - squeeze;
    return `<path d="M128 50 v92" ${guideStroke(m, 4)} stroke-dasharray="2 9"/>
      <path d="M74 68 q22 -12 42 4 l-8 40 q-24 6 -40 -8 z" ${guideStroke(c)}/>
      <path d="M182 68 q-22 -12 -42 4 l8 40 q24 6 40 -8 z" ${guideStroke(c)}/>
      <path d="M${108 - gap} 108 h-22" ${guideStroke(m, 5)}/>
      <path d="M${108 - gap} 108 l9 -6 m-9 6 l9 6" ${guideStroke(m, 5)}/>
      <path d="M${148 + gap} 108 h22" ${guideStroke(m, 5)}/>
      <path d="M${148 + gap} 108 l-9 -6 m9 6 l-9 6" ${guideStroke(m, 5)}/>`;
  }

  // 运动态指导主视觉：eyes/neck 用专属大图，其余动作暂用放大的概览 glyph。
  function renderGuideArt(stage, theme, phase) {
    const key = stage?.groupKey;
    const id = stage?.id;
    if (key === 'eyes') {
      return id === 'far' ? guideEyesFar(theme, phase) : guideEyesBlink(theme, phase);
    }
    if (key === 'neck') {
      if (id === 'chin') return guideNeckChin(theme, phase);
      if (id === 'right') return guideNeckTurn(theme, phase, 'right');
      if (id === 'scapula') return guideNeckScapula(theme, phase);
      return guideNeckTurn(theme, phase, 'left');
    }
    return groupGlyph(key || 'eyes', 92, 48, 72, theme.accent, theme.muted, phase);
  }

  function renderWaitingContent(instance, theme, window) {
    const language = instance.settings.uiLanguage;
    const groups = selectedGroups(instance.settings);
    const icons = groupLayout(groups).map((position, index) => groupGlyph(
      groups[index], position.x, position.y, position.size, theme.accent, theme.muted, instance.animFrame,
    )).join('');
    const goal = Number.parseInt(instance.settings.dailyGoal, 10) || 6;
    const progress = `${instance.today?.completed || 0}/${goal}`;
    let label = window.active ? compactRemaining(instance.intervalRemainingMs) : t('OFF', language);
    if (instance.healthStatus === 'queued') label = t(instance.queueKind === 'manual' ? 'Later' : 'Waiting', language);
    if (instance.healthStatus === 'done') label = t('Done', language);
    return `${icons}
      <text x="128" y="174" text-anchor="middle" fill="${theme.text}" font-size="31" font-weight="800" font-family="Arial, sans-serif">${escapeXml(label)}</text>
      <text x="128" y="202" text-anchor="middle" fill="${theme.muted}" font-size="18" font-weight="700" font-family="Arial, sans-serif">${escapeXml(t('Today', language))} ${escapeXml(progress)}</text>`;
  }

  function renderRunningContent(instance, theme) {
    const language = instance.settings.uiLanguage;
    const stage = stageFor(instance) || { groupKey: selectedGroups(instance.settings)[0], label: 'Start', seconds: 1, durationMs: 1_000 };
    const seconds = Math.max(0, Math.ceil(instance.stageRemainingMs / 1000));
    const elapsedRatio = Math.max(0, Math.min(1, 1 - instance.stageRemainingMs / Math.max(1, stage.durationMs)));
    const value = stage.reps
      ? `${Math.min(stage.reps, Math.floor(elapsedRatio * stage.reps) + 1)}/${stage.reps}`
      : `${seconds}s`;
    const pause = instance.healthStatus === 'paused'
      ? `<g fill="${theme.text}" opacity="0.92"><rect x="112" y="80" width="11" height="34" rx="3"/><rect x="133" y="80" width="11" height="34" rx="3"/></g>`
      : '';
    return `${renderGuideArt(stage, theme, instance.animFrame)}
      ${pause}
      <text x="128" y="155" text-anchor="middle" fill="${theme.text}" font-size="28" font-weight="800" font-family="Arial, sans-serif">${escapeXml(t(instance.healthStatus === 'paused' ? 'Paused' : stage.label, language))}</text>
      <text x="128" y="198" text-anchor="middle" fill="${theme.accent}" font-size="36" font-weight="800" font-family="Arial, sans-serif">${escapeXml(value)}</text>`;
  }

  function renderDueContent(instance, theme, now = Date.now()) {
    const language = instance.settings.uiLanguage;
    const key = selectedGroups(instance.settings)[0];
    const visible = reminderFlashStrong(instance, now) ? instance.animFrame % 2 === 0 : instance.animFrame === 0;
    return `<g opacity="${visible ? 1 : 0.3}">
      ${groupGlyph(key, 80, 45, 96, theme.warn, theme.muted, instance.animFrame)}
      <text x="128" y="185" text-anchor="middle" fill="${theme.warn}" font-size="32" font-weight="800" font-family="Arial, sans-serif">${escapeXml(t('Start', language))}</text>
      <text x="128" y="207" text-anchor="middle" fill="${theme.muted}" font-size="14" font-weight="700" font-family="Arial, sans-serif">${escapeXml(t('Hold to skip', language))}</text>
    </g>`;
  }

  function renderDoneContent(instance, theme) {
    const language = instance.settings.uiLanguage;
    const bonus = instance.today?.bonus || 0;
    return `<circle cx="128" cy="112" r="58" fill="${theme.ok}" opacity="0.2"/>
      <path d="M92 112l24 24 49-55" fill="none" stroke="${theme.ok}" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="128" y="191" text-anchor="middle" fill="${theme.text}" font-size="27" font-weight="800" font-family="Arial, sans-serif">${escapeXml(t('Completed today', language))}</text>
      ${bonus ? `<text x="128" y="211" text-anchor="middle" fill="${theme.muted}" font-size="15" font-weight="700" font-family="Arial, sans-serif">${escapeXml(t('Bonus', language))} +${bonus}</text>` : ''}`;
  }

  function renderHealthBreakIcon(instance, options = {}) {
    const now = options.now ?? Date.now();
    const theme = themeFor(instance.settings);
    const frame = frameFor(instance.settings);
    const background = renderThemeBackdrop(theme, instance.healthStatus === 'due' ? theme.warn : theme.accent, frame);
    const window = healthWindowFor(instance.settings, now);
    let content;
    if (instance.healthStatus === 'running' || instance.healthStatus === 'paused') {
      content = renderRunningContent(instance, theme);
    } else if (instance.healthStatus === 'due') {
      content = renderDueContent(instance, theme, now);
    } else if (instance.healthStatus === 'done') {
      content = renderDoneContent(instance, theme);
    } else {
      content = renderWaitingContent(instance, theme, window);
    }
    const highlight = instance.healthStatus === 'due'
      ? frameHighlight(frame, theme.warn, reminderFlashStrong(instance, now) ? 0.9 : 0.45)
      : '';
    return toDataUrl(`<svg width="392" height="392" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${background.outer}${highlight}${frameContent(frame, content)}
    </svg>`);
  }

  const config = {
    defaults: {
      groups: 'eyes,neck',
      intervalMin: '45',
      dailyGoal: '6',
      activeStart: '09:00',
      activeEnd: '18:00',
      activeDays: '0,1,2,3,4,5,6',
      lunchEnabled: 'true',
      lunchStart: '12:00',
      lunchEnd: '14:00',
      repeatReminderMin: '5',
      soundEnabled: 'true',
      theme: 'mint',
      frameSize: 'optimal',
      showFrame: 'true',
    },
    normalizeSettings: (settings, defaults) => ({
      groups: selectedGroups({ groups: settings.groups ?? defaults.groups }).join(','),
      intervalMin: normalizeNumberString(settings.intervalMin, defaults.intervalMin, 5, 240),
      dailyGoal: normalizeNumberString(settings.dailyGoal, defaults.dailyGoal, 1, 12),
      activeStart: normalizeTime(settings.activeStart, defaults.activeStart),
      activeEnd: normalizeTime(settings.activeEnd, defaults.activeEnd),
      activeDays: selectedDays({ activeDays: settings.activeDays ?? defaults.activeDays }).join(','),
      lunchEnabled: normalizeBooleanString(settings.lunchEnabled, defaults.lunchEnabled),
      lunchStart: normalizeTime(settings.lunchStart, defaults.lunchStart),
      lunchEnd: normalizeTime(settings.lunchEnd, defaults.lunchEnd),
      repeatReminderMin: normalizeNumberString(settings.repeatReminderMin, defaults.repeatReminderMin, 0, 30),
      soundEnabled: normalizeBooleanString(settings.soundEnabled, defaults.soundEnabled),
    }),
    createState: (instance) => {
      const settings = instance.settings || config.defaults;
      return {
        healthStatus: 'waiting',
        queueKind: null,
        intervalRemainingMs: intervalMs(settings),
        dueAt: null,
        reminderPlayed: false,
        today: emptyStats(),
        history: [],
        sessionPlan: [],
        sessionStepIndex: 0,
        stageRemainingMs: 0,
        stageBeatCount: 0,
        sessionWasBonus: false,
        lastTickAt: Date.now(),
        lastCheckpointAt: 0,
        animFrame: 0,
        cueProcess: null,
        ...(instance?.context ? hydrateHealthBreakState(readPersistedState(instance.context), settings) : {}),
      };
    },
    onRun: (instance) => handleShortPress(instance),
    onLongPress: (instance) => handleLongPress(instance),
    onReady: (instance) => {
      if (instance.healthStatus === 'paused') {
        instance.sessionPlan = buildSessionPlan(instance.settings);
        instance.sessionStepIndex = Math.min(instance.sessionStepIndex, Math.max(0, instance.sessionPlan.length - 1));
        instance.stageRemainingMs ||= stageFor(instance)?.durationMs || 1_000;
      }
      tickHealthBreak(instance);
      sendStats(instance);
    },
    onSettingsChanged: (instance, previousSettings) => {
      const groupsChanged = previousSettings.groups !== instance.settings.groups;
      if (groupsChanged && ['running', 'paused'].includes(instance.healthStatus)) {
        cancelSession(instance, Date.now(), { count: false });
      }
      if (previousSettings.intervalMin !== instance.settings.intervalMin) {
        instance.intervalRemainingMs = intervalMs(instance.settings);
      }
      if (instance.today?.completed >= Number.parseInt(instance.settings.dailyGoal, 10)) {
        instance.healthStatus = 'done';
      } else if (instance.healthStatus === 'done') {
        instance.healthStatus = 'waiting';
      }
      flushHealthBreakState(instance, true);
      sendStats(instance);
    },
    onParamFromPlugin: (instance, param) => {
      if (param?.__requestHealthStats === 'true') {
        sendStats(instance);
      }
    },
    onDispose: (instance) => {
      const wasActive = activeContext === instance.context;
      clearInstanceTimeout(instance, TIMER_SLOT);
      stopCue(instance);
      removeFromManualQueue(instance.context);
      if (activeContext === instance.context) activeContext = null;
      if (activeReminderContext === instance.context) activeReminderContext = null;
      flushHealthBreakState(instance, true);
      if (wasActive && !startQueuedManual()) {
        promoteDue();
      }
    },
    render: (instance) => renderHealthBreakIcon(instance),
  };

  return {
    key: 'healthbreak',
    config,
    testing: {
      healthBreakBeatInterval: beatIntervalMs,
      healthBreakBuildSessionPlan: buildSessionPlan,
      healthBreakHealthWindowFor: healthWindowFor,
      healthBreakHydrateState: hydrateHealthBreakState,
      healthBreakIntervalMs: intervalMs,
      healthBreakNormalizeGroups: selectedGroups,
      healthBreakReminderFlashStrong: reminderFlashStrong,
      healthBreakRenderIcon: renderHealthBreakIcon,
      healthBreakSerializeState: serializeHealthBreakState,
      healthBreakTick: tickHealthBreak,
    },
  };
}
