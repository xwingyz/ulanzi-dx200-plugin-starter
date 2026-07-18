import UlanzideckApi from '../libs/node/ulanzideckApi.js';
import { log } from '../libs/node/utils.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.lexutility';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 框架层持久化：所有 action 的设置都落到同一份 data/action-settings.json，
// 按 `${actionid}::${key}` 归档。旧版 latency 专属文件仅用于一次性迁移。
const SETTINGS_STORE_PATH = path.join(__dirname, '..', 'data', 'action-settings.json');
const LEGACY_LATENCY_STORE_PATH = path.join(__dirname, '..', 'data', 'latency-settings.json');
// 运行态与设置分开存：设置由框架自动落盘，运行态由 action 自己按语义边界批量写。
const STATE_STORE_PATH = path.join(__dirname, '..', 'data', 'action-state.json');

const THEMES = {
  mint: {
    accent: '#14b8a6',
    canvas: '#07111f',
    panel: '#0f172a',
    shell: '#08131f',
    text: '#e2e8f0',
    muted: '#94a3b8',
    low: '#64748b',
    contrast: '#042f2e',
  },
  ember: {
    accent: '#f97316',
    canvas: '#1a0d08',
    panel: '#2a140c',
    shell: '#140a06',
    text: '#fff7ed',
    muted: '#fdba74',
    low: '#9a3412',
    contrast: '#431407',
  },
  mono: {
    accent: '#d4d4d8',
    canvas: '#09090b',
    panel: '#18181b',
    shell: '#111111',
    text: '#fafafa',
    muted: '#a1a1aa',
    low: '#52525b',
    contrast: '#18181b',
  },
  signal: {
    accent: '#60a5fa',
    canvas: '#06111f',
    panel: '#0b1730',
    shell: '#07101d',
    text: '#eff6ff',
    muted: '#93c5fd',
    low: '#1d4ed8',
    contrast: '#082f49',
  },
  neon: {
    accent: '#e879f9',
    canvas: '#0d0221',
    panel: '#1b0f3b',
    shell: '#130829',
    text: '#f3e8ff',
    muted: '#c084fc',
    low: '#6d28d9',
    contrast: '#2e1065',
  },
  ice: {
    accent: '#67e8f9',
    canvas: '#051820',
    panel: '#0b2a38',
    shell: '#07202b',
    text: '#ecfeff',
    muted: '#a5f3fc',
    low: '#0e7490',
    contrast: '#083344',
  },
  sunset: {
    accent: '#fb7185',
    canvas: '#1f0910',
    panel: '#38121f',
    shell: '#2a0d17',
    text: '#fff1f2',
    muted: '#fda4af',
    low: '#9f1239',
    contrast: '#4c0519',
  },
  forest: {
    accent: '#4ade80',
    canvas: '#04150c',
    panel: '#0d2b1a',
    shell: '#082012',
    text: '#ecfdf5',
    muted: '#86efac',
    low: '#166534',
    contrast: '#052e16',
  },
  sand: {
    accent: '#b45309',
    canvas: '#f6f1e7',
    panel: '#fffcf5',
    shell: '#efe6d4',
    text: '#292524',
    muted: '#78716c',
    low: '#d6c7ab',
    contrast: '#fef3c7',
  },
};

const THEME_NAMES = Object.keys(THEMES);
const LATENCY_HISTORY_LIMIT = 24;
const LATENCY_GRAPH_MODES = ['bars', 'line'];
const LATENCY_MANUAL_FEEDBACK_MS = 650;
// uptime 聚合：5 分钟一桶、只保留 24h（288 桶）。逐条存样本在 3s 间隔下会到 28800 条，
// 所以桶内延迟分布用固定分箱直方图压成 17 个整数——p95 精度到箱宽，对按钮上的三位数足够。
const LATENCY_BUCKET_MS = 5 * 60 * 1000;
const LATENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const LATENCY_BUCKET_LIMIT = LATENCY_WINDOW_MS / LATENCY_BUCKET_MS;
const LATENCY_BINS = [25, 50, 75, 100, 150, 200, 300, 400, 600, 800, 1200, 1600, 2400, 3200, 5000, 8000, Infinity];
const LATENCY_STATE_VERSION = 1;
// 双击窗口：单击不等待这 400ms（刷新是幂等的，先发出去），第二次按键到达时再撤销。
const LATENCY_DOUBLE_TAP_MS = 400;
const LATENCY_SSL_WARN_DAYS = 30;
const POMODORO_SOUND_STYLES = ['glass', 'hero', 'purr', 'submarine'];
const POMODORO_ALERT_WINDOW_SEC = 5;
const POMODORO_CYCLE_COMPLETE_SEC = 4;
const POMODORO_STATE_VERSION = 1;
const POMODORO_PHASES = ['idle', 'focus', 'shortBreak', 'longBreak', 'done'];
const POMODORO_DOUBLE_TAP_MS = 400;
const POMODORO_BLINK_MS = 550;
const POMODORO_PALETTES = {
  mint: { focus: '#14b8a6', shortBreak: '#22c55e', longBreak: '#38bdf8', done: '#84cc16' },
  ember: { focus: '#ff7f50', shortBreak: '#7ddf64', longBreak: '#74a9ff', done: '#facc15' },
  mono: { focus: '#f4f4f5', shortBreak: '#d4d4d8', longBreak: '#a1a1aa', done: '#86efac' },
  signal: { focus: '#fb7185', shortBreak: '#34d399', longBreak: '#60a5fa', done: '#fbbf24' },
  neon: { focus: '#e879f9', shortBreak: '#34d399', longBreak: '#22d3ee', done: '#fde047' },
  ice: { focus: '#67e8f9', shortBreak: '#4ade80', longBreak: '#818cf8', done: '#fbbf24' },
  sunset: { focus: '#fb7185', shortBreak: '#4ade80', longBreak: '#38bdf8', done: '#facc15' },
  forest: { focus: '#4ade80', shortBreak: '#2dd4bf', longBreak: '#60a5fa', done: '#fbbf24' },
  sand: { focus: '#b45309', shortBreak: '#15803d', longBreak: '#1d4ed8', done: '#a16207' },
};
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
const ACTION_CONFIGS = {
  pomowave: {
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
      autoStartBreaks: 'true',
      autoStartFocus: 'true',
    },
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
      flushPomodoroState(instance);
    },
    render: (instance) => renderPomodoroIcon(instance),
  },
  latency: {
    defaults: {
      url: 'https://example.com',
      intervalSec: '30',
      warnMs: '800',
      timeoutMs: '8000',
      sslWarnDays: '30',
      theme: 'signal',
      frameSize: 'optimal',
      showFrame: 'true',
      graphMode: 'bars',
    },
    createState: (instance) => ({
      lastMs: null,
      status: 'checking',
      checking: false,
      requestId: 0,
      // 历史跨重启水合：24h uptime 的全部意义就在于此，重建实例不能把它清零。
      ...hydrateLatencyState(readPersistedState(instance.context)),
    }),
    onRun: (instance) => handleLatencyTap(instance),
    onReady: (instance) => {
      if (instance.paused) {
        return undefined;
      }
      scheduleLatencyCheck(instance);
      if (!instance.recent.length && !instance.checking) {
        return runLatencyCheck(instance, { immediateRender: true });
      }
      return undefined;
    },
    onSettingsChanged: (instance, previousSettings) => {
      // 换 URL 意味着监控对象变了，历史与证书都不再属于它，必须连同落盘的记录一起丢弃；
      // 只改间隔/阈值/超时则是同一个对象的观测方式变化，历史继续有效。
      const targetChanged = previousSettings.url !== instance.settings.url;
      const probeChanged =
        targetChanged ||
        previousSettings.intervalSec !== instance.settings.intervalSec ||
        previousSettings.timeoutMs !== instance.settings.timeoutMs;
      if (targetChanged) {
        instance.buckets = [];
        instance.recent = [];
        instance.certExpiresAt = null;
        dropPersistedState(instance.context);
      }
      // 仅 warnMs / 主题这类纯展示项变化时无需重探——框架会在钩子返回后统一渲染。
      if (!probeChanged) {
        return;
      }
      instance.lastMs = null;
      instance.status = 'checking';
      clearLatencyTimer(instance);
      instance.checking = false;
      guardAction(instance, 'ready', () => onInstanceReady(instance));
    },
    onDispose: (instance) => {
      flushLatencyState(instance);
    },
    render: (instance) => renderLatencyIcon(instance),
  },
};

const ACTIONS = Object.fromEntries(
  Object.keys(ACTION_CONFIGS).map((key) => [key, `${PLUGIN_UUID}.${key}`]),
);
const ACTION_KEY_BY_UUID = Object.fromEntries(
  Object.entries(ACTIONS).map(([key, uuid]) => [uuid, key]),
);

const $UD = new UlanzideckApi();
const INSTANCES = new Map();
const SETTINGS_STORAGE = createSettingsStorage();
const PERSISTED_SETTINGS = SETTINGS_STORAGE.load();
const STATE_STORAGE = createSettingsStorage({ storePath: STATE_STORE_PATH, legacyPath: null });
const PERSISTED_STATE = STATE_STORAGE.load();

// ---- 框架隔离层：单进程内按实例隔离异常与定时器（见 docs/development-rules.md §4）----

function reportActionError(instance, phase, error, options = {}) {
  const instances = options.instances ?? INSTANCES;
  const errorRenderer = options.renderError ?? renderErrorState;
  const actionKey = instance ? actionKeyFromUuid(instance.actionUuid) : 'unknown';
  log(`action error [${actionKey}] phase=${phase}`, error?.stack || error);
  if (instance) {
    instance.lastError = { phase, message: String(error?.message || error), at: Date.now() };
    if (options.renderError || instances.has(instance.context)) {
      errorRenderer(instance);
    }
  }
}

function guardAction(instance, phase, fn, onError = reportActionError) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      result.catch((error) => onError(instance, phase, error));
    }
    return result;
  } catch (error) {
    onError(instance, phase, error);
    return undefined;
  }
}

function initializeInstanceState(instance, config, options = {}) {
  const onError = (failedInstance, phase, error) => reportActionError(failedInstance, phase, error, options);
  // createState 收到的 instance 已带 context 与归一化 settings，据此可水合持久化运行态。
  const state = guardAction(instance, 'createState', () => config.createState(instance) || {}, onError);
  if (state) {
    Object.assign(instance, state);
  }
  return instance;
}

function safeHandler(name, handler) {
  return (message) => {
    try {
      handler(message);
    } catch (error) {
      log(`handler error [${name}]`, error?.stack || error);
    }
  };
}

function setInstanceTimeout(instance, slot, fn, ms, onCancel) {
  clearInstanceTimeout(instance, slot);
  if (!instance.timers) {
    instance.timers = new Map();
  }
  const timer = { handle: null, cancel: onCancel };
  timer.handle = setTimeout(() => {
    if (instance.timers?.get(slot) !== timer) {
      return;
    }
    instance.timers?.delete(slot);
    timer.cancel = undefined;
    guardAction(instance, `timer:${slot}`, fn);
  }, ms);
  instance.timers.set(slot, timer);
}

function hasInstanceTimeout(instance, slot) {
  return Boolean(instance?.timers?.has(slot));
}

function clearInstanceTimeout(instance, slot) {
  const timer = instance?.timers?.get(slot);
  if (timer) {
    clearTimeout(timer.handle ?? timer);
    instance.timers.delete(slot);
    timer.cancel?.();
  }
}

function disposeInstance(instance) {
  if (!instance) {
    return;
  }
  // 先给 action 最后一次同步 flush 的机会，再回收定时器——顺序反了 onDispose 就拿不到
  // 还在等定时器里落盘的运行态。onDispose 抛错不得阻断定时器回收。
  const config = ACTION_KEY_BY_UUID[instance.actionUuid] ? configFromUuid(instance.actionUuid) : null;
  if (config?.onDispose) {
    guardAction(instance, 'dispose', () => config.onDispose(instance));
  }
  if (!instance.timers) {
    return;
  }
  for (const slot of [...instance.timers.keys()]) {
    clearInstanceTimeout(instance, slot);
  }
}

function delayInstance(instance, slot, ms) {
  return new Promise((resolve) => {
    setInstanceTimeout(instance, slot, () => resolve(true), ms, () => resolve(false));
  });
}

function renderErrorState(instance) {
  if (instance.active === false) {
    return;
  }
  try {
    const theme = themeFor(instance.settings || {});
    const actionKey = actionKeyFromUuid(instance.actionUuid);
    $UD.setBaseDataIcon(instance.context, toDataUrl(`
      <svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
        ${renderScreenFrame(theme, theme.accent, `
          <text x="128" y="116" text-anchor="middle" fill="${theme.text}" font-size="34" font-weight="700" font-family="Arial, Helvetica, sans-serif">ERR</text>
          <text x="128" y="150" text-anchor="middle" fill="${theme.muted}" font-size="18" font-family="Arial, Helvetica, sans-serif">${escapeXml(actionKey)}</text>
          <text x="128" y="182" text-anchor="middle" fill="${theme.low}" font-size="14" font-family="Arial, Helvetica, sans-serif">see plugin log</text>
        `, frameFor(instance.settings || {}))}
      </svg>
    `));
  } catch {}
}

function toDataUrl(svg) {
  const encoded = Buffer.from(svg).toString('base64');
  return `data:image/svg+xml;base64,${encoded}`;
}

function createSettingsStorage(options = {}) {
  const storePath = options.storePath ?? SETTINGS_STORE_PATH;
  // legacyPath: null 表示该存储没有历史包袱（如运行态存储），直接跳过迁移分支。
  const legacyPath = options.legacyPath === undefined ? LEGACY_LATENCY_STORE_PATH : options.legacyPath;
  const fsImpl = options.fsImpl ?? fs;
  const logger = options.logger ?? log;
  let sequence = 0;
  let loadedFromLegacy = false;
  let storeCorrupt = false;

  const readJson = (filePath) => {
    const value = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw new TypeError('persist store root must be a plain object');
    }
    return value;
  };
  const storage = {
    get loadedFromLegacy() {
      return loadedFromLegacy;
    },
    get storeCorrupt() {
      return storeCorrupt;
    },
    load() {
      try {
        return readJson(storePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          storeCorrupt = true;
          logger('persist store read failed', error?.stack || error);
          return {};
        }
      }
      if (!legacyPath) {
        return {};
      }
      try {
        const legacyData = readJson(legacyPath);
        loadedFromLegacy = true;
        storage.write(legacyData);
        return legacyData;
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          logger('legacy persist store read failed', error?.stack || error);
        }
        return {};
      }
    },
    write(data) {
      if (storeCorrupt) {
        logger('persist store is read-only after load failure');
        return false;
      }
      const directory = path.dirname(storePath);
      const tempPath = path.join(
        directory,
        `.${path.basename(storePath)}.${process.pid}.${++sequence}.tmp`,
      );
      try {
        fsImpl.mkdirSync(directory, { recursive: true });
        fsImpl.writeFileSync(tempPath, JSON.stringify(data, null, 2));
        fsImpl.renameSync(tempPath, storePath);
        return true;
      } catch (error) {
        try {
          fsImpl.unlinkSync(tempPath);
        } catch (cleanupError) {
          if (cleanupError?.code !== 'ENOENT') {
            logger('persist temp cleanup failed', cleanupError?.stack || cleanupError);
          }
        }
        logger('persist store write failed', error?.stack || error);
        return false;
      }
    },
  };
  return storage;
}

function persistenceKey(context) {
  const { key = '', actionid = '' } = $UD.decodeContext(context) || {};
  return `${actionid}::${key}`;
}

// persist 语义：默认持久化整份归一化设置；action 可用 `persist: false` 关闭，
// 或 `persist: (settings) => ({...})` 只挑选需要落盘的字段。
function readPersistedSettings(context, config) {
  if (config.persist === false) {
    return {};
  }
  return PERSISTED_SETTINGS[persistenceKey(context)] || {};
}

function writePersistedSettings(context, config, settings, options = {}) {
  if (config.persist === false) {
    return false;
  }
  const store = options.store ?? PERSISTED_SETTINGS;
  const storage = options.storage ?? SETTINGS_STORAGE;
  const keyFromContext = options.keyFromContext ?? persistenceKey;
  const clean = pickPersistedSettings(config, settings);
  const key = keyFromContext(context);
  const candidate = { ...store, [key]: clean };
  if (!storage.write(candidate)) {
    return false;
  }
  store[key] = clean;
  return true;
}

function pickPersistedSettings(config, settings) {
  const source = typeof config.persist === 'function' ? config.persist(settings) : settings;
  const clean = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined) {
      clean[name] = value;
    }
  }
  return clean;
}

// 运行态持久化：与设置存储同构（同一个 `${actionid}::${key}`），但框架不自动读写。
// action 自己决定落盘时机，框架不感知运行态结构。读不到就返回空——历史是增益，不是前置条件。
function readPersistedState(context, options = {}) {
  const store = options.store ?? PERSISTED_STATE;
  const keyFromContext = options.keyFromContext ?? persistenceKey;
  const value = store[keyFromContext(context)];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function writePersistedState(context, data, options = {}) {
  const store = options.store ?? PERSISTED_STATE;
  const storage = options.storage ?? STATE_STORAGE;
  const keyFromContext = options.keyFromContext ?? persistenceKey;
  const key = keyFromContext(context);
  const candidate = { ...store, [key]: data };
  if (!storage.write(candidate)) {
    return false;
  }
  store[key] = data;
  return true;
}

function dropPersistedState(context, options = {}) {
  const store = options.store ?? PERSISTED_STATE;
  const storage = options.storage ?? STATE_STORAGE;
  const keyFromContext = options.keyFromContext ?? persistenceKey;
  const key = keyFromContext(context);
  if (!(key in store)) {
    return false;
  }
  const candidate = { ...store };
  delete candidate[key];
  if (!storage.write(candidate)) {
    return false;
  }
  delete store[key];
  return true;
}

function persistedSettingsEqual(actionUuid, config, settings, persistedSettings) {
  const desired = pickPersistedSettings(config, settings);
  const previous = pickPersistedSettings(config, normalizeSettings(actionUuid, persistedSettings));
  const keys = new Set([...Object.keys(desired), ...Object.keys(previous)]);
  return [...keys].every((key) => Object.is(desired[key], previous[key]));
}

function resolveSettingsForEvent(eventType, {
  current = {},
  incoming = {},
  persisted = {},
} = {}) {
  if (eventType === 'hostRestore') {
    return { ...current, ...incoming, ...persisted };
  }
  if (eventType === 'pluginSubmit') {
    return { ...current, ...persisted, ...incoming };
  }
  return { ...current, ...incoming };
}

function dispatchActionParam(config, instance, param) {
  return config.onParamFromPlugin?.(instance, param);
}

// 框架保留控制参数：PI 的“恢复默认配置”按钮通过它触发重置。
// 控制参数不进入设置合并，也不透传给 action 的 onParamFromPlugin。
const RESET_DEFAULTS_PARAM = '__resetDefaults';

function isResetDefaultsRequest(param) {
  return String(param?.[RESET_DEFAULTS_PARAM] ?? '') === 'true';
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function actionFromContext(context) {
  return ($UD.decodeContext(context) || {}).uuid || '';
}

function actionKeyFromUuid(actionUuid) {
  return ACTION_KEY_BY_UUID[actionUuid] || 'unknown';
}

function configFromUuid(actionUuid) {
  return ACTION_CONFIGS[actionKeyFromUuid(actionUuid)];
}

function normalizeText(value, fallback, maxLength) {
  return String(value || fallback).slice(0, maxLength);
}

function normalizeColor(value, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? value : fallback;
}

function normalizeTheme(value, fallback) {
  return THEME_NAMES.includes(value) ? value : fallback;
}

function normalizeChoice(value, fallback, choices) {
  return choices.includes(value) ? value : fallback;
}

function normalizeBooleanString(value, fallback) {
  return String(value) === 'true' || String(value) === 'false'
    ? String(value)
    : String(fallback) === 'true' ? 'true' : 'false';
}

function normalizeNumberString(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return String(fallback);
  }
  return String(Math.min(max, Math.max(min, parsed)));
}

function normalizeUrl(value, fallback) {
  const raw = String(value || fallback).trim();
  if (!raw) {
    return fallback;
  }
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function themeFor(settings) {
  return THEMES[normalizeTheme(settings.theme, 'mint')];
}

// ---- 安全边框：所有内容画在 40..216 的设计箱内，框架按 frameSize 等比
// 缩放到目标安全区；showFrame 只控制边框绘制，不改变内容布局几何。----
const FRAME_DESIGN_INSET = 40;
const FRAME_DESIGN_BOX = 256 - FRAME_DESIGN_INSET * 2;
const FRAME_PRESETS = {
  // 最佳显示范围：边框紧贴背景边缘（背景→壳留白 6）；面板/内容箱收到 30，
  // 壳→面板留白 12（与 max 一致）。曾经的 40（设计箱 1:1）会让内容挤在中央、
  // 离外框过远，等比放大 ~1.11 后字号也随之变大。
  optimal: { bleed: 12, ring: 14, shell: 18, panel: 30, content: 30 },
  // 最大化范围：边框收薄贴边（背景→壳留白 6），内容区扩到 18..238（等比放大 1.25）。
  max: { bleed: 0, ring: 2, shell: 6, panel: 18, content: 18 },
};
const FRAME_SIZE_NAMES = Object.keys(FRAME_PRESETS);
// 圆角规则参考 Apple 图标的同心嵌套（内层圆角 = 外层圆角 − 层间距，下限 2），
// 但比例按 DX200 实体键角实测收小为 42/256 ≈ 16.41%（256 全幅时圆角 42）——
// Apple 的 22.37% 对本硬件偏大。squircle 在键面尺寸下差异可忽略，用圆弧近似。
const FRAME_RADIUS_RATIO = 42 / 256;

function frameFor(settings = {}) {
  const preset = FRAME_PRESETS[normalizeChoice(settings.frameSize, 'optimal', FRAME_SIZE_NAMES)];
  const scale = (256 - preset.content * 2) / FRAME_DESIGN_BOX;
  const bleedRadius = Math.round((256 - preset.bleed * 2) * FRAME_RADIUS_RATIO);
  const radiusAt = (inset) => Math.max(2, bleedRadius - (inset - preset.bleed));
  return {
    ...preset,
    bleedRadius,
    ringRadius: radiusAt(preset.ring),
    shellRadius: radiusAt(preset.shell),
    panelRadius: radiusAt(preset.panel),
    highlight: preset.panel + 4,
    highlightRadius: radiusAt(preset.panel + 4),
    radiusAt,
    show: String(settings.showFrame) !== 'false',
    scale,
    offset: preset.content - FRAME_DESIGN_INSET * scale,
  };
}

function frameRect(inset, radius, extras) {
  const size = 256 - inset * 2;
  return `<rect x="${inset}" y="${inset}" width="${size}" height="${size}" rx="${radius}" ${extras}/>`;
}

function frameContent(frame, innerSvg) {
  if (frame.scale === 1) {
    return innerSvg;
  }
  return `<g transform="translate(${frame.offset.toFixed(2)} ${frame.offset.toFixed(2)}) scale(${frame.scale.toFixed(4)})">${innerSvg}</g>`;
}

// 内框线：默认不绘制；action 需要强调运行态时把它画出来作为高亮区域。
// 位置贴面板内缘（panel + 4），圆角同样由 radiusAt 同心推导，不受 showFrame 影响。
function frameHighlight(frame, color, opacity = 1) {
  return frameRect(frame.highlight, frame.highlightRadius, `fill="none" stroke="${color}" stroke-width="6" opacity="${opacity}"`);
}

function normalizeSettings(actionUuid, settings = {}) {
  const config = configFromUuid(actionUuid);
  const defaults = config.defaults;
  return {
    title: typeof defaults.title === 'string' ? normalizeText(settings.title, defaults.title, 14) : undefined,
    subtitle: typeof defaults.subtitle === 'string' ? normalizeText(settings.subtitle, defaults.subtitle, 18) : undefined,
    theme: normalizeTheme(settings.theme, defaults.theme),
    frameSize: typeof defaults.frameSize === 'string' ? normalizeChoice(settings.frameSize, defaults.frameSize, FRAME_SIZE_NAMES) : undefined,
    showFrame: typeof defaults.showFrame === 'string' ? normalizeBooleanString(settings.showFrame, defaults.showFrame) : undefined,
    focusMin: typeof defaults.focusMin === 'string' ? normalizeNumberString(settings.focusMin, defaults.focusMin, 1, 180) : undefined,
    shortBreakMin: typeof defaults.shortBreakMin === 'string' ? normalizeNumberString(settings.shortBreakMin, defaults.shortBreakMin, 1, 60) : undefined,
    longBreakMin: typeof defaults.longBreakMin === 'string' ? normalizeNumberString(settings.longBreakMin, defaults.longBreakMin, 1, 120) : undefined,
    roundsBeforeLongBreak: typeof defaults.roundsBeforeLongBreak === 'string' ? normalizeNumberString(settings.roundsBeforeLongBreak, defaults.roundsBeforeLongBreak, 2, 8) : undefined,
    soundStyle: typeof defaults.soundStyle === 'string' ? normalizeChoice(settings.soundStyle, defaults.soundStyle, POMODORO_SOUND_STYLES) : undefined,
    soundEnabled: typeof defaults.soundEnabled === 'string' ? normalizeBooleanString(settings.soundEnabled, defaults.soundEnabled) : undefined,
    autoStartBreaks: typeof defaults.autoStartBreaks === 'string' ? normalizeBooleanString(settings.autoStartBreaks, defaults.autoStartBreaks) : undefined,
    autoStartFocus: typeof defaults.autoStartFocus === 'string' ? normalizeBooleanString(settings.autoStartFocus, defaults.autoStartFocus) : undefined,
    url: typeof defaults.url === 'string' ? normalizeUrl(settings.url, defaults.url) : undefined,
    intervalSec: typeof defaults.intervalSec === 'string' ? normalizeNumberString(settings.intervalSec, defaults.intervalSec, 3, 3600) : undefined,
    warnMs: typeof defaults.warnMs === 'string' ? normalizeNumberString(settings.warnMs, defaults.warnMs, 50, 10000) : undefined,
    timeoutMs: typeof defaults.timeoutMs === 'string' ? normalizeNumberString(settings.timeoutMs, defaults.timeoutMs, 500, 30000) : undefined,
    sslWarnDays: typeof defaults.sslWarnDays === 'string' ? normalizeNumberString(settings.sslWarnDays, defaults.sslWarnDays, 1, 365) : undefined,
    graphMode: typeof defaults.graphMode === 'string' ? normalizeChoice(settings.graphMode, defaults.graphMode, LATENCY_GRAPH_MODES) : undefined,
  };
}

function hostFromUrl(url) {
  try {
    return new URL(normalizeUrl(url, '')).hostname.replace(/^www\./, '');
  } catch {
    return 'invalid host';
  }
}

function isEnabled(value) {
  return String(value) === 'true';
}

function clipText(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

// host 超宽时中段省略：保留开头与结尾（结尾带着 TLD），比尾部截断保住更多辨识度——
// `dashboard.internal.example.com` 截成 `dashboard.inter…` 就没人认得出它是谁了。
function clipHostMiddle(value, maxLength, tail = 7) {
  const text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - tail - 1)}…${text.slice(-tail)}`;
}

const LATENCY_MAX_REDIRECTS = 3;

// 专用 agent，禁用 TLS 会话缓存：默认 agent 会按 host 复用 TLS session，恢复的
// 会话里服务器不重发证书、getPeerCertificate() 返回空对象——一旦 certExpiresAt
// 被清（恢复默认、改 URL），之后的探测就永远补不回证书。每次完整握手还让延迟
// 口径一致：测的都是"冷访客"的真实首连成本，而不是快慢混杂的会话恢复。
const LATENCY_TLS_AGENT = new https.Agent({ maxCachedSessions: 0 });

// 单跳探测。延迟计到响应头到达为止（不含响应体），拿到头就 destroy 连接：
// 监控只关心“站点是否响应、多快响应”，把首页正文每 30 秒下载一遍纯属浪费带宽。
function requestHop(url, timeoutMs, deadlineAt) {
  return new Promise((resolve) => {
    const client = url.protocol === 'http:' ? http : https;
    const started = Date.now();
    const budget = Math.max(1, Math.min(timeoutMs, deadlineAt - started));
    let settled = false;
    const finish = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(payload);
    };

    const request = client.request(
      url,
      {
        method: 'GET',
        timeout: budget,
        agent: url.protocol === 'https:' ? LATENCY_TLS_AGENT : undefined,
        headers: {
          'user-agent': 'LexUtilityLatency/0.2.0',
          accept: '*/*',
        },
      },
      (response) => {
        const ms = Date.now() - started;
        const code = response.statusCode || 0;
        // 证书只在 https 跳有意义，且必须在 destroy 之前从 socket 上取。
        const cert = url.protocol === 'https:'
          ? peerCertExpiry(response.socket)
          : null;
        const location = response.headers?.location || '';
        // 必须先 finish 再 destroy：中止连接会同步触发 request 的 'error'，
        // 若顺序反了，那个 ECONNRESET 会抢先 settle 成 network 错误，把这次成功的探测吃掉。
        finish({ ms, code, cert, location });
        response.destroy();
        request.destroy();
      },
    );

    request.on('timeout', () => {
      request.destroy();
      finish({ ms: Date.now() - started, code: 0, error: 'timeout' });
    });

    request.on('error', () => {
      finish({ ms: Date.now() - started, code: 0, error: 'network' });
    });

    request.end();
  });
}

function peerCertExpiry(socket) {
  try {
    const cert = socket?.getPeerCertificate?.();
    if (!cert || !cert.valid_to) {
      return null;
    }
    const expiresAt = Date.parse(cert.valid_to);
    return Number.isFinite(expiresAt) ? expiresAt : null;
  } catch {
    return null;
  }
}

// 跟随重定向到最终状态码：监控的问题是“这个站还活着吗”，不是“这个 URL 返回了什么”。
// 一个 301 到抢注域名的站点不该显示为正常。延迟只记第一跳——那是用户实际感知到的
// 首字节时间，把多跳累加会让数字随重定向链长度漂移而失去可比性。
// 证书同样只取第一跳（用户配置的那个 host），重定向目标的证书不是他要监控的对象。
async function checkUrl(rawUrl, timeoutMs, options = {}) {
  const maxRedirects = options.maxRedirects ?? LATENCY_MAX_REDIRECTS;
  const hop = options.requestHop ?? requestHop;
  let url;
  try {
    url = new URL(normalizeUrl(rawUrl, ''));
  } catch {
    return { ok: false, ms: 0, code: 0, error: 'bad_url' };
  }

  const deadlineAt = Date.now() + timeoutMs;
  let firstMs = null;
  let cert = null;

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const hopResult = await hop(url, timeoutMs, deadlineAt);
    if (firstMs === null) {
      firstMs = hopResult.ms;
      cert = hopResult.cert ?? null;
    }
    const ms = firstMs;

    if (hopResult.error) {
      return { ok: false, ms, code: 0, error: hopResult.error, cert };
    }

    const { code, location } = hopResult;
    const isRedirect = code >= 300 && code < 400 && location;
    if (!isRedirect) {
      return { ok: code >= 200 && code < 400, ms, code, cert };
    }
    if (redirects === maxRedirects) {
      return { ok: false, ms, code, error: 'too_many_redirects', cert };
    }
    try {
      url = new URL(location, url);
    } catch {
      return { ok: false, ms, code, error: 'bad_redirect', cert };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, ms, code, error: 'bad_redirect', cert };
    }
    if (Date.now() >= deadlineAt) {
      return { ok: false, ms, code: 0, error: 'timeout', cert };
    }
  }
  return { ok: false, ms: firstMs ?? 0, code: 0, error: 'too_many_redirects', cert };
}

function renderScreenFrame(theme, accent, innerSvg, frame = frameFor()) {
  const chrome = frame.show
    ? `
    ${frameRect(frame.ring, frame.ringRadius, `fill="none" stroke="${theme.low}" stroke-width="2" opacity="0.4"`)}
    ${frameRect(frame.shell, frame.shellRadius, `fill="${theme.shell}" stroke="${accent}" stroke-width="4"`)}
    ${frameRect(frame.panel, frame.panelRadius, `fill="${theme.panel}" stroke="${accent}" stroke-width="1.5" opacity="0.98"`)}
  `
    : '';
  return `
    ${frameRect(frame.bleed, frame.bleedRadius, `fill="${theme.canvas}"`)}
    ${chrome}
    ${frameContent(frame, innerSvg)}
  `;
}

function pomodoroPalette(settings) {
  const palette = POMODORO_PALETTES[normalizeTheme(settings.theme, 'ember')] || POMODORO_PALETTES.ember;
  return {
    focus: palette.focus,
    shortBreak: palette.shortBreak,
    longBreak: palette.longBreak,
    done: palette.done,
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
    return;
  }

  if (os.platform() === 'darwin') {
    const soundName = POMODORO_MAC_SOUND_MAP[style] || POMODORO_MAC_SOUND_MAP.glass;
    execFile('afplay', [`/System/Library/Sounds/${soundName}.aiff`], () => {});
    return;
  }

  if (os.platform() === 'win32') {
    const [frequency, duration] = POMODORO_WINDOWS_SOUND_MAP[style] || POMODORO_WINDOWS_SOUND_MAP.glass;
    execFile(
      'powershell',
      ['-NoProfile', '-Command', `[console]::beep(${frequency},${duration})`],
      () => {},
    );
    return;
  }

  process.stdout.write('\u0007');
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

// 进入待命：切到下一阶段但不启动计时，圆环闪烁提示按下。播放阶段结束提示音。
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
    playPomodoroCue(instance.settings);
  }
  flushPomodoroState(instance);
  renderInstance(instance);
  scheduleBlink(instance);
}

// 确认待命阶段：从满时长起点开始计时。
function beginAwaitedPhase(instance, now = Date.now()) {
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
    playPomodoroCue(instance.settings);
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
function renderThemeBackdrop(theme, accent, frame = frameFor()) {
  // 渐变 id 按背景 token 稳定派生：latency 与 pomodoro 的多个键若被宿主内联到同一 DOM，
  // 不同主题不会因同名 id 串色；相同 token 共用定义时视觉本就一致。保持 render 纯函数，
  // 不使用模块级递增计数器引入跨实例可变状态。
  const gradientId = `themeBg-${[theme.canvas, theme.shell, theme.panel]
    .join('')
    .replace(/[^a-z0-9]/gi, '')}`;
  // 纯渐变背景，无装饰图形：曾经的低透明度装饰圆在无边框模式下会浮出成
  // 可见的浅圈（浅色主题上尤其明显），信息量为零还抢注意力。
  const outer = `
    <defs>
      <linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${theme.canvas}"/>
        <stop offset="55%" stop-color="${theme.shell}"/>
        <stop offset="100%" stop-color="${theme.panel}"/>
      </linearGradient>
    </defs>
    <rect width="256" height="256" rx="42" fill="url(#${gradientId})"/>
  `;
  // 面板只留填充不描边：三层嵌套边框（外环/壳/面板线）里最内那条只添噪。
  const chrome = frame.show
    ? `
      ${frameRect(frame.ring, frame.ringRadius, `fill="none" stroke="${accent}" stroke-width="2.2" opacity="0.34"`)}
      ${frameRect(frame.shell, frame.shellRadius, `fill="${theme.shell}" stroke="${accent}" stroke-width="4.5"`)}
      ${frameRect(frame.panel, frame.panelRadius, `fill="${theme.panel}" opacity="0.985"`)}
    `
    : '';
  // 装饰背景整体等比缩进背景界内，不永远铺满整键。
  // 不用 clipPath 实现：宿主 SVG 渲染器对 clipPath 支持不可靠（会静默失效）。
  const artScale = (256 - frame.bleed * 2) / 256;
  const art = frame.bleed === 0
    ? outer
    : `<g transform="translate(${frame.bleed} ${frame.bleed}) scale(${artScale.toFixed(4)})">${outer}</g>`;
  return {
    outer: `
      ${art}
      ${chrome}
    `,
    text: theme.text,
    muted: theme.muted,
    low: theme.low,
  };
}

// 双色线性插值：图表用它把「延迟高低」映射成「颜色冷热」。
function mixHex(from, to, t) {
  const a = Number.parseInt(String(from).slice(1), 16);
  const b = Number.parseInt(String(to).slice(1), 16);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return from;
  }
  const lerp = (shift) => {
    const x = (a >> shift) & 0xff;
    const y = (b >> shift) & 0xff;
    return Math.round(x + (y - x) * t);
  };
  return `#${((lerp(16) << 16) | (lerp(8) << 8) | lerp(0)).toString(16).padStart(6, '0')}`;
}

function buildLatencySeries(instance, warnMs, accent) {
  const history = instance.recent || [];
  // 纵向刻度锚定在告警阈值附近并固定下来：单个尖峰/超时只会被钳到柱顶，
  // 不会反过来把整条基线上的正常柱子重新压扁（这正是之前“显示不正常”的根因）。
  const maxMs = Math.max(warnMs * 1.5, 150);

  // 横向布局：把柱子收敛在基线宽度（startX → endX）内，按历史上限分配槽位，
  // 这样柱宽稳定、从左往右增长，满历史时也不会越过右边缘。
  const startX = 42;
  const endX = 214;
  const chartBottom = 190;
  const chartHeight = 36;
  const slotCount = LATENCY_HISTORY_LIMIT;
  const step = (endX - startX) / slotCount;
  const gap = step * 0.22;
  const barWidth = step - gap;
  const points = [];
  let bars = '';

  const barGeometry = (entry, index) => {
    const x = startX + index * step;
    const value = entry.ok ? entry.ms : maxMs;
    // sqrt 曲线放大低延迟段，让 40ms / 120ms 这类正常值也能拉开高度差。
    const ratio = Math.sqrt(Math.min(1, value / maxMs));
    const height = Math.max(4, ratio * chartHeight);
    const y = chartBottom - height;
    // 颜色随每根柱自己的延迟连续变热（accent→琥珀），而不是只在越过阈值时
    // 二值跳变——高度差在 36px 图表里不够醒目，颜色补上这个信息。失败恒为红。
    const fill = !entry.ok
      ? '#ef4444'
      : entry.ms > warnMs
        ? '#f59e0b'
        : mixHex(accent, '#f59e0b', Math.min(1, entry.ms / warnMs));
    return { x, y, height, fill };
  };

  history.forEach((entry, index) => {
    const { x, y, height, fill } = barGeometry(entry, index);
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${height.toFixed(1)}" rx="2" fill="${fill}" opacity="0.98"/>`;
    points.push(`${(x + barWidth / 2).toFixed(1)},${y.toFixed(1)}`);
  });

  return {
    bars,
    line: points.length > 1
      ? `<polyline points="${points.join(' ')}" fill="none" stroke="${accent}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`
      : '',
    dots: history.map((entry, index) => {
      const { x, y, fill } = barGeometry(entry, index);
      return `<circle cx="${(x + barWidth / 2).toFixed(1)}" cy="${y.toFixed(1)}" r="2.3" fill="${fill}"/>`;
    }).join(''),
  };
}

// 观测时长自报家门：标签写的是实际观测到多久，而不是名义上的 24h 窗口。
// 宿主常关意味着窗口大概率只被填满一部分，硬写「24h」就是在撒谎。
function formatObservedSpan(observedMs) {
  if (!observedMs) {
    return '';
  }
  const minutes = Math.round(observedMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.round(observedMs / 3_600_000)}h`;
}

function formatUptimeLabel(stats) {
  if (stats.uptime == null) {
    return '--';
  }
  const span = formatObservedSpan(stats.observedMs);
  // 99.95 不应该显示成 100%——那会把一次真实的宕机抹掉。只有真正无失败才是 100。
  const value = stats.uptime === 100
    ? '100'
    : Math.min(99.9, Math.floor(stats.uptime * 10) / 10).toFixed(1);
  return span ? `${span} ${value}%` : `${value}%`;
}

function sslDaysLeft(certExpiresAt, now = Date.now()) {
  if (!Number.isFinite(certExpiresAt)) {
    return null;
  }
  return Math.floor((certExpiresAt - now) / 86_400_000);
}

// SSL 徽标：正常时 `SSL` + 绿点（光秃秃一个绿点说不清自己是什么），进入提醒
// 阈值（settings.sslWarnDays，默认 30 天）换成 `SSL xxd` 并变黄/红；非 https 不出现。
function renderSslBadge(certExpiresAt, theme, warnDays = LATENCY_SSL_WARN_DAYS, now = Date.now()) {
  const days = sslDaysLeft(certExpiresAt, now);
  if (days == null) {
    return '';
  }
  // 字号与圆点尺寸对齐左侧「延迟」标题（20px / r7），两端视觉重量一致。
  if (days > warnDays) {
    return `
      <text x="196" y="69" text-anchor="end" fill="#22c55e" font-size="20" font-weight="800" font-family="Arial, Helvetica, sans-serif">SSL</text>
      <circle cx="207" cy="62" r="7" fill="#22c55e"/>`;
  }
  const color = days <= 7 ? '#ef4444' : '#f59e0b';
  const label = days <= 0 ? 'SSL !' : `SSL ${days}d`;
  return `<text x="214" y="69" text-anchor="end" fill="${color}" font-size="20" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(label)}</text>`;
}

function renderLatencyIcon(instance) {
  const theme = themeFor(instance.settings);
  const frame = frameFor(instance.settings);
  const background = renderThemeBackdrop(theme, theme.accent, frame);
  const host = hostFromUrl(instance.settings.url);
  const warnMs = Number.parseInt(instance.settings.warnMs, 10) || 400;
  const status = instance.paused ? 'paused' : instance.status || 'checking';
  const accent =
    status === 'down' ? '#ef4444'
    : status === 'slow' ? '#f59e0b'
    : status === 'up' ? theme.accent
    : theme.muted;
  const bigText =
    status === 'paused' ? 'Pause'
    : status === 'down' ? 'DOWN'
    : status === 'checking' ? '...'
    : instance.lastMs == null ? '...'
    : String(instance.lastMs);
  const headerText =
    status === 'paused' ? '暂停'
    : status === 'down' ? '离线'
    : status === 'slow' ? '偏高'
    : status === 'up' ? '延迟'
    : '检查';
  const stats = latencyStats(instance);
  const hostLabel = clipHostMiddle(host, 19);
  // 图表基色固定用主题 accent：历史柱描述的是各自当时的延迟，不随「当前状态」整体染色
  // ——否则一次 down 会把整段正常历史都涂成红的。
  const chart = buildLatencySeries(instance, warnMs, theme.accent);
  const graphSvg = instance.settings.graphMode === 'line'
    ? `${chart.line}${chart.dots}`
    : chart.bars;
  const uptimeLabel = formatUptimeLabel(stats);
  const p95Label = stats.p95 == null ? '' : `p95 ${stats.p95}`;
  // Pause / DOWN 是词不是数值，跟 ms 单位并排没有意义，居中独占主区。
  const numeric = status !== 'paused' && status !== 'down';
  const valueFontSize = bigText.length >= 4 ? 42 : 50;

  return toDataUrl(`
    <svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${background.outer}
      ${status === 'down' ? frameHighlight(frame, '#ef4444') : ''}
      ${
        frameContent(frame, `
          <circle cx="58" cy="62" r="7" fill="${accent}"/>
          <text x="72" y="69" fill="${accent}" font-size="20" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(headerText)}</text>
          ${renderSslBadge(instance.certExpiresAt, theme, Number.parseInt(instance.settings.sslWarnDays, 10) || LATENCY_SSL_WARN_DAYS)}
          <text x="128" y="90" text-anchor="middle" fill="${background.muted}" font-size="16" font-family="Arial, Helvetica, sans-serif">${escapeXml(hostLabel)}</text>
          ${
            numeric
              ? `<text x="122" y="136" text-anchor="middle" fill="${background.text}" font-size="${valueFontSize}" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(bigText)}</text>
                 <text x="${bigText.length >= 4 ? 183 : 176}" y="136" fill="${background.muted}" font-size="25" font-weight="800" font-family="Arial, Helvetica, sans-serif">ms</text>`
              : `<text x="128" y="136" text-anchor="middle" fill="${status === 'down' ? '#ef4444' : background.muted}" font-size="38" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(bigText)}</text>`
          }
          <line x1="42" y1="190" x2="214" y2="190" stroke="${background.low}" stroke-width="1.5" opacity="0.55"/>
          ${graphSvg}
          <text x="44" y="212" fill="${accent}" font-size="17" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(uptimeLabel)}</text>
          <text x="214" y="212" text-anchor="end" fill="${background.low}" font-size="17" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(p95Label)}</text>
        `)
      }
    </svg>
  `);
}

function latencyBinIndex(ms) {
  for (let i = 0; i < LATENCY_BINS.length; i += 1) {
    if (ms <= LATENCY_BINS[i]) {
      return i;
    }
  }
  return LATENCY_BINS.length - 1;
}

function bucketStartAt(timestamp) {
  return Math.floor(timestamp / LATENCY_BUCKET_MS) * LATENCY_BUCKET_MS;
}

function emptyBucket(t) {
  return { t, ok: 0, fail: 0, bins: new Array(LATENCY_BINS.length).fill(0) };
}

// 只保留窗口内的桶。桶按 t 升序，且仅在有探测时才存在——这正是「实际观测时长」的来源。
function pruneLatencyBuckets(buckets, now) {
  const cutoff = bucketStartAt(now) - LATENCY_WINDOW_MS + LATENCY_BUCKET_MS;
  return buckets.filter((bucket) => bucket.t >= cutoff).slice(-LATENCY_BUCKET_LIMIT);
}

function pruneLatencyRecent(recent, now) {
  const cutoff = now - LATENCY_WINDOW_MS;
  return recent.filter((entry) => entry.t >= cutoff).slice(-LATENCY_HISTORY_LIMIT);
}

// 返回是否发生了桶滚动——滚动是运行态落盘的语义边界，避免逐次探测就写盘。
function recordLatencySample(instance, result, now = Date.now()) {
  const t = bucketStartAt(now);
  const buckets = pruneLatencyBuckets(instance.buckets || [], now);
  const last = buckets[buckets.length - 1];
  const rolled = !last || last.t !== t;
  const bucket = rolled ? emptyBucket(t) : last;
  if (rolled) {
    buckets.push(bucket);
  }

  if (result.ok) {
    bucket.ok += 1;
    bucket.bins[latencyBinIndex(result.ms)] += 1;
  } else {
    bucket.fail += 1;
  }

  instance.buckets = pruneLatencyBuckets(buckets, now);
  instance.recent = pruneLatencyRecent(
    [...(instance.recent || []), { t: now, ok: Boolean(result.ok), ms: result.ms }],
    now,
  );
  return rolled;
}

// uptime 的分母只有实际观测到的探测数：宿主关着的时段既不算正常也不算宕机，
// 而是根本没被观测到。observedMs 让按钮把这个事实说出来，而不是用「24h」撒谎。
function latencyStats(instance, now = Date.now()) {
  const buckets = pruneLatencyBuckets(instance.buckets || [], now);
  let ok = 0;
  let fail = 0;
  const bins = new Array(LATENCY_BINS.length).fill(0);
  for (const bucket of buckets) {
    ok += bucket.ok || 0;
    fail += bucket.fail || 0;
    for (let i = 0; i < bins.length; i += 1) {
      bins[i] += bucket.bins?.[i] || 0;
    }
  }
  const checks = ok + fail;
  return {
    checks,
    uptime: checks ? (ok / checks) * 100 : null,
    observedMs: buckets.length * LATENCY_BUCKET_MS,
    p95: percentileFromBins(bins, 0.95),
  };
}

// 取分箱上沿作为 p95：宁可略微高报延迟，也不要让一个监控指标显得比实际乐观。
function percentileFromBins(bins, percentile) {
  const total = bins.reduce((sum, count) => sum + count, 0);
  if (!total) {
    return null;
  }
  const target = Math.ceil(percentile * total);
  let seen = 0;
  for (let i = 0; i < bins.length; i += 1) {
    seen += bins[i];
    if (seen >= target) {
      const edge = LATENCY_BINS[i];
      return Number.isFinite(edge) ? edge : LATENCY_BINS[i - 1];
    }
  }
  return null;
}

function serializeLatencyState(instance) {
  return {
    v: LATENCY_STATE_VERSION,
    paused: Boolean(instance.paused),
    buckets: instance.buckets || [],
    recent: instance.recent || [],
    certExpiresAt: instance.certExpiresAt ?? null,
  };
}

// 历史读不到就当没有——它是增益不是前置条件，绝不能因为存储损坏让按钮报错。
function hydrateLatencyState(raw, now = Date.now()) {
  const valid = raw && typeof raw === 'object' && raw.v === LATENCY_STATE_VERSION;
  const buckets = valid && Array.isArray(raw.buckets)
    ? raw.buckets.filter((bucket) => bucket && Number.isFinite(bucket.t) && Array.isArray(bucket.bins))
    : [];
  const recent = valid && Array.isArray(raw.recent)
    ? raw.recent.filter((entry) => entry && Number.isFinite(entry.t) && Number.isFinite(entry.ms))
    : [];
  return {
    paused: valid ? Boolean(raw.paused) : false,
    buckets: pruneLatencyBuckets(buckets, now),
    recent: pruneLatencyRecent(recent, now),
    certExpiresAt: valid && Number.isFinite(raw.certExpiresAt) ? raw.certExpiresAt : null,
  };
}

function flushLatencyState(instance, options = {}) {
  const write = options.write ?? writePersistedState;
  return write(instance.context, serializeLatencyState(instance));
}

function clearLatencyTimer(instance) {
  clearInstanceTimeout(instance, 'latency');
}

function scheduleLatencyCheck(instance) {
  const intervalSec = Number.parseInt(instance.settings.intervalSec, 10) || 15;
  setInstanceTimeout(instance, 'latency', () => runLatencyCheck(instance), intervalSec * 1000);
}

function isInstanceCurrent(instance, requestId, instances = INSTANCES) {
  return instances.get(instance.context) === instance && requestId === instance.requestId;
}

function commitLatencyResult(instance, result, options = {}) {
  const {
    requestId,
    feedbackCompleted = true,
    instances = INSTANCES,
    warnMs = Number.parseInt(instance.settings.warnMs, 10) || 400,
    render = renderInstance,
    schedule = scheduleLatencyCheck,
  } = options;
  if (!feedbackCompleted || !isInstanceCurrent(instance, requestId, instances)) {
    return false;
  }
  const now = options.now ?? Date.now();
  const flush = options.flush ?? flushLatencyState;
  instance.checking = false;
  instance.lastMs = result.ok ? result.ms : null;
  if (Number.isFinite(result.cert)) {
    instance.certExpiresAt = result.cert;
  }
  instance.status = !result.ok ? 'down' : result.ms > warnMs ? 'slow' : 'up';
  // 桶滚动才落盘：每 5 分钟一次，而不是每次探测一次。进行中的桶靠 onDispose 补 flush。
  const rolled = recordLatencySample(instance, result, now);
  if (rolled) {
    flush(instance);
  }
  render(instance);
  schedule(instance);
  return true;
}

// 宿主协议只有单一 `run` 事件，没有按下/抬起分离，因此长按无法实现（见 constants.js）。
// 双击代之：单击不等待窗口关闭就立刻刷新——刷新是幂等且无副作用的，先发出去；
// 若 400ms 内第二次按键到达，再把它作废并转成 Pause。这样单击零延迟，代价只是
// 进入 Pause 时浪费一次探测请求。
function handleLatencyTap(instance, options = {}) {
  const now = options.now ?? Date.now();
  const run = options.run ?? runLatencyCheck;
  const render = options.render ?? renderInstance;
  const flush = options.flush ?? flushLatencyState;
  const doubleTapMs = options.doubleTapMs ?? LATENCY_DOUBLE_TAP_MS;

  const previousTapAt = instance.lastTapAt ?? 0;
  instance.lastTapAt = now;

  if (now - previousTapAt < doubleTapMs) {
    // 第二击：作废刚发出的那次刷新（提升 requestId 让它的结果被 isInstanceCurrent 丢弃）。
    instance.lastTapAt = 0;
    instance.requestId += 1;
    instance.checking = false;
    clearLatencyTimer(instance);
    clearInstanceTimeout(instance, 'latencyFeedback');
    instance.paused = !instance.paused;
    if (instance.paused) {
      instance.status = 'paused';
      instance.lastMs = null;
      flush(instance);
      render(instance);
      return undefined;
    }
    // 从 Pause 退出走的是与单击相同的路径：立即刷新并恢复轮询。
    flush(instance);
    return run(instance, { immediateRender: true, minDisplayMs: LATENCY_MANUAL_FEEDBACK_MS, forceFeedback: true });
  }

  if (instance.paused) {
    instance.paused = false;
    flush(instance);
  }
  return run(instance, { immediateRender: true, minDisplayMs: LATENCY_MANUAL_FEEDBACK_MS, forceFeedback: true });
}

async function runLatencyCheck(instance, options = {}) {
  const {
    immediateRender = false,
    minDisplayMs = 0,
    forceFeedback = false,
  } = options;

  if (!instance) {
    return;
  }
  if (instance.checking) {
    if (forceFeedback) {
      instance.status = 'checking';
      instance.lastMs = null;
      renderInstance(instance);
    }
    return;
  }

  instance.checking = true;
  instance.status = 'checking';
  instance.lastMs = null;
  instance.requestId += 1;
  const requestId = instance.requestId;
  const startedAt = Date.now();
  if (immediateRender) {
    renderInstance(instance);
  }

  const timeoutMs = Number.parseInt(instance.settings.timeoutMs, 10) || 4000;
  const warnMs = Number.parseInt(instance.settings.warnMs, 10) || 400;
  const result = await checkUrl(instance.settings.url, timeoutMs);

  if (!isInstanceCurrent(instance, requestId)) {
    return;
  }

  const remainingFeedbackMs = minDisplayMs - (Date.now() - startedAt);
  let feedbackCompleted = true;
  if (remainingFeedbackMs > 0) {
    feedbackCompleted = await delayInstance(instance, 'latencyFeedback', remainingFeedbackMs);
  }

  commitLatencyResult(instance, result, { requestId, feedbackCompleted, warnMs });
}

function onInstanceReady(instance) {
  const config = configFromUuid(instance.actionUuid);
  return config.onReady?.(instance);
}

// 回填加固：把插件侧权威（含持久化）的归一化设置回推给 PI，纠正宿主
// 可能过期/缺字段的 ActionParam。仅在与来件不一致时发送，避免多余流量与回环。
function syncInspectorSettings(instance, incomingSettings = {}, ud = $UD) {
  const authoritative = {};
  for (const [name, value] of Object.entries(instance.settings)) {
    if (value !== undefined) {
      authoritative[name] = value;
    }
  }
  const differs = Object.keys(authoritative).some(
    (name) => String(incomingSettings?.[name] ?? '') !== String(authoritative[name]),
  );
  if (differs) {
    ud.sendParamFromPlugin(authoritative, instance.context);
  }
}

function renderInstance(instance) {
  if (instance.active === false) {
    return;
  }
  const config = configFromUuid(instance.actionUuid);
  let icon;
  try {
    icon = config.render(instance);
  } catch (error) {
    reportActionError(instance, 'render', error);
    return;
  }
  $UD.setBaseDataIcon(instance.context, icon);
}

function ensureInstance(context, incomingSettings = {}, eventType = 'hostRestore', runtime = {}) {
  const instances = runtime.instances ?? INSTANCES;
  const readPersisted = runtime.readPersisted ?? readPersistedSettings;
  const writePersisted = runtime.writePersisted ?? writePersistedSettings;
  const render = runtime.render ?? renderInstance;
  const ready = runtime.ready ?? onInstanceReady;
  let instance = instances.get(context);
  const actionUuid = actionFromContext(context);
  const config = configFromUuid(actionUuid);
  const persistedSettings = readPersisted(context, config);

  if (!instance) {
    instance = {
      context,
      actionUuid,
      settings: normalizeSettings(actionUuid, resolveSettingsForEvent(eventType, {
        incoming: incomingSettings,
        persisted: persistedSettings,
      })),
      active: true,
    };
    instances.set(context, instance);
    initializeInstanceState(instance, config, {
      instances,
      renderError: runtime.renderError,
    });
    if (
      eventType !== 'runtime' &&
      !persistedSettingsEqual(actionUuid, config, instance.settings, persistedSettings)
    ) {
      writePersisted(context, config, instance.settings);
    }
  } else if (incomingSettings && Object.keys(incomingSettings).length > 0) {
    const previousSettings = { ...instance.settings };
    instance.settings = normalizeSettings(actionUuid, resolveSettingsForEvent(eventType, {
      current: instance.settings,
      incoming: incomingSettings,
      persisted: persistedSettings,
    }));
    if (
      eventType !== 'runtime' &&
      !persistedSettingsEqual(actionUuid, config, instance.settings, persistedSettings)
    ) {
      writePersisted(context, config, instance.settings);
    }
    guardAction(instance, 'settingsChanged', () => config.onSettingsChanged?.(instance, previousSettings));
  }

  if (instance.lastError?.phase === 'createState') {
    return instance;
  }
  render(instance);
  guardAction(instance, 'ready', () => ready(instance));
  return instance;
}

function createSettingsEventProcessor(options = {}) {
  const runtime = {
    instances: options.instances ?? INSTANCES,
    readPersisted: options.readPersisted ?? readPersistedSettings,
    writePersisted: options.writePersisted ?? writePersistedSettings,
    render: options.render ?? renderInstance,
    renderError: options.renderError,
    ready: options.ready ?? onInstanceReady,
  };
  const ud = options.ud ?? $UD;
  return {
    ensure: (context, incomingSettings = {}, eventType = 'hostRestore') =>
      ensureInstance(context, incomingSettings, eventType, runtime),
    runtime: (context) => ensureInstance(context, {}, 'runtime', runtime),
    hostRestore(context, incomingSettings = {}) {
      const instance = ensureInstance(context, incomingSettings, 'hostRestore', runtime);
      guardAction(instance, 'syncInspector', () => syncInspectorSettings(instance, incomingSettings, ud));
      return instance;
    },
    pluginSubmit(context, incomingSettings = {}) {
      if (isResetDefaultsRequest(incomingSettings)) {
        return this.resetDefaults(context);
      }
      const instance = ensureInstance(context, incomingSettings, 'pluginSubmit', runtime);
      const config = configFromUuid(instance.actionUuid);
      guardAction(instance, 'paramFromPlugin', () => dispatchActionParam(config, instance, incomingSettings));
      runtime.render(instance);
      return instance;
    },
    // 恢复默认：以 defaults 归一化结果为权威，持久化后回推 PI 刷新表单。
    resetDefaults(context) {
      const instance = ensureInstance(context, {}, 'runtime', runtime);
      const config = configFromUuid(instance.actionUuid);
      const previousSettings = { ...instance.settings };
      instance.settings = normalizeSettings(instance.actionUuid, {});
      const persistedSettings = runtime.readPersisted(context, config);
      if (!persistedSettingsEqual(instance.actionUuid, config, instance.settings, persistedSettings)) {
        runtime.writePersisted(context, config, instance.settings);
      }
      guardAction(instance, 'settingsChanged', () => config.onSettingsChanged?.(instance, previousSettings));
      runtime.render(instance);
      guardAction(instance, 'syncInspector', () => syncInspectorSettings(instance, {}, ud));
      return instance;
    },
  };
}

function startPlugin() {
  $UD.connect(PLUGIN_UUID);
  const eventProcessor = createSettingsEventProcessor({ instances: INSTANCES });

$UD.onConnected(() => {
  log('connected');
});

$UD.onError(safeHandler('wsError', (error) => {
  log(`websocket error: ${error?.message || error}`);
}));

$UD.onClose(safeHandler('wsClose', () => {
  log('websocket closed, waiting for reconnect');
}));

$UD.onAdd(safeHandler('add', (message) => {
  eventProcessor.hostRestore(message.context, message.param || {});
}));

$UD.onParamFromApp(safeHandler('paramFromApp', (message) => {
  eventProcessor.hostRestore(message.context, message.param || {});
}));

$UD.onParamFromPlugin(safeHandler('paramFromPlugin', (message) => {
  eventProcessor.pluginSubmit(message.context, message.param || {});
}));

$UD.onRun(safeHandler('run', (message) => {
  const instance = eventProcessor.runtime(message.context);
  const config = configFromUuid(instance.actionUuid);
  guardAction(instance, 'onRun', () => config.onRun(instance));
  renderInstance(instance);
}));

$UD.onSetActive(safeHandler('setActive', (message) => {
  const instance = INSTANCES.get(message.context);
  if (!instance) {
    return;
  }
  instance.active = Boolean(message.active);
  if (instance.active) {
    renderInstance(instance);
  }
}));

$UD.onClear(safeHandler('clear', (message) => {
  if (!Array.isArray(message.param)) {
    return;
  }
  message.param.forEach((item) => {
    const instance = INSTANCES.get(item.context);
    disposeInstance(instance);
    INSTANCES.delete(item.context);
  });
}));

// 宿主退出是最常见的下线路径（用户直接关 Studio），不接这里 action 就没有 flush 机会。
// 'exit' 只允许同步操作，disposeInstance 与 onDispose 的落盘都是 writeFileSync，符合约束。
let disposedAll = false;
const disposeAllInstances = () => {
  if (disposedAll) {
    return;
  }
  disposedAll = true;
  for (const instance of INSTANCES.values()) {
    disposeInstance(instance);
  }
};
process.on('exit', disposeAllInstances);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    disposeAllInstances();
    process.exit(0);
  });
}

process.on('unhandledRejection', (reason) => {
  log('unhandledRejection (isolated)', reason?.stack || reason);
});

process.on('uncaughtException', (error) => {
  log('uncaughtException (isolated, process kept alive)', error?.stack || error);
});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startPlugin();
}

export const __testing = Object.freeze({
  ACTION_CONFIGS,
  THEMES,
  POMODORO_PALETTES,
  frameFor,
  frameHighlight,
  checkUrl,
  clearInstanceTimeout,
  commitLatencyResult,
  formatUptimeLabel,
  handleLatencyTap,
  hydrateLatencyState,
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
  latencyStats,
  recordLatencySample,
  sslDaysLeft,
  createSettingsEventProcessor,
  createSettingsStorage,
  delayInstance,
  dispatchActionParam,
  disposeInstance,
  dropPersistedState,
  initializeInstanceState,
  readPersistedState,
  resolveSettingsForEvent,
  setInstanceTimeout,
  writePersistedSettings,
  writePersistedState,
});
