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
  const VALID_STATUSES = ['waiting', 'due', 'queued', 'running', 'paused', 'done'];
  const GROUP_KEYS = ['eyes', 'neck', 'hands', 'stand', 'breathe', 'pelvic'];

  const GROUPS = Object.freeze({
    eyes: {
      label: '护眼',
      stages: [
        { id: 'far', label: '远眺', seconds: 20, cue: 'soft' },
        { id: 'blink', label: '眨眼', seconds: 10, reps: 10, cue: 'bright' },
      ],
    },
    neck: {
      label: '颈肩',
      stages: [
        { id: 'chin', label: '微收', seconds: 15, cue: 'soft' },
        { id: 'left', label: '左转', seconds: 15, cue: 'low' },
        { id: 'right', label: '右转', seconds: 15, cue: 'high' },
        { id: 'scapula', label: '肩胛', seconds: 20, reps: 10, cue: 'bright' },
      ],
    },
    hands: {
      label: '手腕',
      stages: [
        { id: 'open', label: '张合', seconds: 20, reps: 10, cue: 'bright' },
        { id: 'wristLeft', label: '左腕', seconds: 15, cue: 'low' },
        { id: 'wristRight', label: '右腕', seconds: 15, cue: 'high' },
      ],
    },
    stand: {
      label: '起身',
      stages: [
        { id: 'rise', label: '站起', seconds: 10, cue: 'bright' },
        { id: 'calf', label: '提踵', seconds: 30, reps: 10, cue: 'high' },
        { id: 'march', label: '走动', seconds: 30, cue: 'bright' },
      ],
    },
    breathe: {
      label: '呼吸',
      stages: Array.from({ length: 5 }, () => [
        { id: 'inhale', label: '吸气', seconds: 4, cue: 'high' },
        { id: 'exhale', label: '呼气', seconds: 6, cue: 'low' },
      ]).flat(),
    },
    pelvic: {
      label: '盆底',
      stages: Array.from({ length: 5 }, () => [
        { id: 'contract', label: '收缩', seconds: 5, cue: 'high' },
        { id: 'release', label: '放松', seconds: 5, cue: 'low' },
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
    return parseList(settings.groups, GROUP_KEYS, ['eyes', 'neck'], 4);
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

  function minutesFromTime(value) {
    const [hours, minutes] = String(value).split(':').map(Number);
    return hours * 60 + minutes;
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

    if (!active || !selectedDays(settings).includes(anchor.getDay())) {
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
    return [...byDay.values()].sort((left, right) => left.dayKey.localeCompare(right.dayKey)).slice(-30);
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
    sendParamFromPlugin({
      healthStats: JSON.stringify({ today: sanitizeStats(instance.today), history, streak }),
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
    const macSounds = { reminder: 'Glass', start: 'Pop', complete: 'Glass', bright: 'Ping', high: 'Tink', low: 'Purr', soft: 'Morse' };
    const windowsTones = { reminder: [880, 150], start: [660, 100], complete: [988, 180], bright: [784, 90], high: [698, 90], low: [440, 120], soft: [554, 80] };
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
    if (groups.length === 1) return [{ x: 104, y: 60, size: 48 }];
    if (groups.length === 2) return [{ x: 66, y: 66, size: 46 }, { x: 144, y: 66, size: 46 }];
    if (groups.length === 3) return [{ x: 53, y: 72, size: 42 }, { x: 107, y: 72, size: 42 }, { x: 161, y: 72, size: 42 }];
    return [{ x: 72, y: 54, size: 40 }, { x: 144, y: 54, size: 40 }, { x: 72, y: 103, size: 40 }, { x: 144, y: 103, size: 40 }];
  }

  function renderWaitingContent(instance, theme, window) {
    const groups = selectedGroups(instance.settings);
    const icons = groupLayout(groups).map((position, index) => groupGlyph(
      groups[index], position.x, position.y, position.size, theme.accent, theme.muted, instance.animFrame,
    )).join('');
    const goal = Number.parseInt(instance.settings.dailyGoal, 10) || 6;
    const progress = `${instance.today?.completed || 0}/${goal}`;
    let label = window.active ? compactRemaining(instance.intervalRemainingMs) : 'OFF';
    if (instance.healthStatus === 'queued') label = instance.queueKind === 'manual' ? '随后' : '等待';
    if (instance.healthStatus === 'done') label = '完成';
    return `${icons}
      <text x="128" y="174" text-anchor="middle" fill="${theme.text}" font-size="31" font-weight="800" font-family="Arial, sans-serif">${escapeXml(label)}</text>
      <text x="128" y="202" text-anchor="middle" fill="${theme.muted}" font-size="18" font-weight="700" font-family="Arial, sans-serif">今日 ${escapeXml(progress)}</text>`;
  }

  function renderRunningContent(instance, theme) {
    const stage = stageFor(instance) || { groupKey: selectedGroups(instance.settings)[0], label: '开始', seconds: 1, durationMs: 1_000 };
    const seconds = Math.max(0, Math.ceil(instance.stageRemainingMs / 1000));
    const elapsedRatio = Math.max(0, Math.min(1, 1 - instance.stageRemainingMs / Math.max(1, stage.durationMs)));
    const value = stage.reps
      ? `${Math.min(stage.reps, Math.floor(elapsedRatio * stage.reps) + 1)}/${stage.reps}`
      : `${seconds}s`;
    const pause = instance.healthStatus === 'paused'
      ? `<g fill="${theme.text}"><rect x="112" y="82" width="11" height="34" rx="3"/><rect x="133" y="82" width="11" height="34" rx="3"/></g>`
      : '';
    return `${groupGlyph(stage.groupKey, 92, 48, 72, theme.accent, theme.muted, instance.animFrame)}
      ${pause}
      <text x="128" y="155" text-anchor="middle" fill="${theme.text}" font-size="28" font-weight="800" font-family="Arial, sans-serif">${escapeXml(instance.healthStatus === 'paused' ? '暂停' : stage.label)}</text>
      <text x="128" y="198" text-anchor="middle" fill="${theme.accent}" font-size="36" font-weight="800" font-family="Arial, sans-serif">${escapeXml(value)}</text>`;
  }

  function renderDueContent(instance, theme, now = Date.now()) {
    const key = selectedGroups(instance.settings)[0];
    const visible = reminderFlashStrong(instance, now) ? instance.animFrame % 2 === 0 : instance.animFrame === 0;
    return `<g opacity="${visible ? 1 : 0.3}">
      ${groupGlyph(key, 80, 45, 96, theme.warn, theme.muted, instance.animFrame)}
      <text x="128" y="185" text-anchor="middle" fill="${theme.warn}" font-size="32" font-weight="800" font-family="Arial, sans-serif">开始</text>
      <text x="128" y="207" text-anchor="middle" fill="${theme.muted}" font-size="14" font-weight="700" font-family="Arial, sans-serif">长按跳过</text>
    </g>`;
  }

  function renderDoneContent(instance, theme) {
    const bonus = instance.today?.bonus || 0;
    return `<circle cx="128" cy="112" r="58" fill="${theme.ok}" opacity="0.2"/>
      <path d="M92 112l24 24 49-55" fill="none" stroke="${theme.ok}" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="128" y="191" text-anchor="middle" fill="${theme.text}" font-size="27" font-weight="800" font-family="Arial, sans-serif">今日完成</text>
      ${bonus ? `<text x="128" y="211" text-anchor="middle" fill="${theme.muted}" font-size="15" font-weight="700" font-family="Arial, sans-serif">加练 +${bonus}</text>` : ''}`;
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
