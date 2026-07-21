import UlanzideckApi from '../libs/node/ulanzideckApi.js';
import { log } from '../libs/node/utils.js';
import { createActionModules } from './actions/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.lexutility';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 数据目录默认在插件目录下，但允许 ULANZI_PLUGIN_DATA_DIR 覆盖。宿主永远不设它——
// 这是给测试用的：测试会 import 本文件并触发真实落盘，不隔离就会把测试键写进仓库的
// data/，再被同步脚本带到用户机器上。路径常量在 import 期求值，所以只能靠进程级环境
// 变量注入（见 tests/setup.mjs），不能等测试里再改。
// 覆盖时按 PLUGIN_UUID 分子目录：同一个测试进程会同时 import 本框架与 template 框架，
// 共用一份存储会让两边同名的 `actionid::key` 互相覆盖。
const DATA_DIR = process.env.ULANZI_PLUGIN_DATA_DIR
  ? path.resolve(process.env.ULANZI_PLUGIN_DATA_DIR, PLUGIN_UUID)
  : path.join(__dirname, '..', 'data');
// 框架层持久化：所有 action 的设置都落到同一份 data/action-settings.json，
// 按 `${actionid}::${key}` 归档。旧版 latency 专属文件仅用于一次性迁移。
const SETTINGS_STORE_PATH = path.join(DATA_DIR, 'action-settings.json');
const LEGACY_LATENCY_STORE_PATH = path.join(DATA_DIR, 'latency-settings.json');
// 运行态与设置分开存：设置由框架自动落盘，运行态由 action 自己按语义边界批量写。
const STATE_STORE_PATH = path.join(DATA_DIR, 'action-state.json');
const LONG_PRESS_MS = 600;
// keydown/keyup 之后宿主补发 run 的容忍窗口，超过即认为按键事件通路已断，回落到 run。
const RUN_AFTER_KEY_EVENT_MS = 1500;
const LONG_PRESS_TIMER_SLOT = 'baseLongPress';

// ok / warn / crit 是语义告警色，供需要分级预警的 action 使用（例如 claudeusage
// 的额度 severity）。它们不进 THEME_SWATCHES —— 色卡只展示
// canvas / panel / low / accent / text 五个角色。取值原则：与该主题色调调和，
// 且在各自 canvas 上有足够对比度；sand 是浅色主题，三色必须取深色档。
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
    ok: '#34d399',
    warn: '#fbbf24',
    crit: '#f87171',
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
    ok: '#4ade80',
    warn: '#facc15',
    crit: '#ef4444',
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
    ok: '#22c55e',
    warn: '#eab308',
    crit: '#ef4444',
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
    ok: '#34d399',
    warn: '#fbbf24',
    crit: '#f87171',
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
    ok: '#4ade80',
    warn: '#fde047',
    crit: '#f43f5e',
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
    ok: '#34d399',
    warn: '#fcd34d',
    crit: '#f87171',
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
    ok: '#4ade80',
    warn: '#fbbf24',
    // sunset 的 accent 本身是玫红，crit 只能靠更饱和的正红拉开距离；
    // 该主题下的危险级别应同时依赖非颜色信号（例如宠物姿态）。
    crit: '#ef4444',
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
    // forest 的 accent 就是绿色，ok 取更浅一档以免与 accent 完全同值。
    ok: '#86efac',
    warn: '#fbbf24',
    crit: '#f87171',
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
    ok: '#15803d',
    warn: '#a16207',
    crit: '#b91c1c',
  },
};

const THEME_NAMES = Object.keys(THEMES);
let ACTION_CONFIGS;
let ACTIONS;
let ACTION_KEY_BY_UUID;
let ACTION_TESTING;

const $UD = new UlanzideckApi();
const INSTANCES = new Map();
const EXCLUSIVE_TASKS = createExclusiveTaskQueue();
const SETTINGS_STORAGE = createSettingsStorage();
const PERSISTED_SETTINGS = SETTINGS_STORAGE.load();
const STATE_STORAGE = createSettingsStorage({ storePath: STATE_STORE_PATH, legacyPath: null });
const PERSISTED_STATE = STATE_STORAGE.load();

const ACTION_MODULES = createActionModules({
  clearInstanceTimeout,
  delayInstance,
  dropPersistedState,
  escapeXml,
  exclusiveTasks: EXCLUSIVE_TASKS,
  formatCountdown,
  frameContent,
  frameFor,
  frameHighlight,
  guardAction,
  instances: INSTANCES,
  mixHex,
  normalizeBooleanString,
  normalizeChoice,
  normalizeNumberString,
  normalizeServerId,
  normalizeTime,
  normalizeUrl,
  persistSettings: (instance) => writePersistedSettings(
    instance.context,
    configFromUuid(instance.actionUuid),
    instance.settings,
  ),
  readPersistedState,
  renderInstance,
  renderMeterRow,
  renderScreenFrame,
  renderThemeBackdrop,
  sanitizeServerList,
  sendParamFromPlugin: (payload, context) => $UD.sendParamFromPlugin(payload, context),
  setInstanceTimeout,
  themeFor,
  toDataUrl,
  writePersistedState,
});
ACTION_CONFIGS = Object.freeze(Object.fromEntries(
  ACTION_MODULES.map(({ key, config }) => [key, config]),
));
ACTIONS = Object.freeze(Object.fromEntries(
  Object.keys(ACTION_CONFIGS).map((key) => [key, `${PLUGIN_UUID}.${key}`]),
));
ACTION_KEY_BY_UUID = Object.freeze(Object.fromEntries(
  Object.entries(ACTIONS).map(([key, uuid]) => [uuid, key]),
));
ACTION_TESTING = Object.freeze(Object.assign({}, ...ACTION_MODULES.map(({ testing }) => testing)));

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

// 通用独占任务队列：同一资源（例如 network-bandwidth）一次只允许一个实例运行。
// 框架只负责排队、取消与 AbortSignal，不感知任何 action key 或业务结果结构。
function createExclusiveTaskQueue() {
  const resources = new Map();
  const sameInstance = (left, right) => left === right || (
    left?.context && right?.context && left.context === right.context
  );
  const stateFor = (resource) => {
    if (!resources.has(resource)) {
      resources.set(resource, { active: null, waiting: [] });
    }
    return resources.get(resource);
  };
  const callHook = (entry, name, ...args) => {
    try {
      entry.options?.[name]?.(...args);
    } catch (error) {
      log(`exclusive task hook failed [${name}]`, error?.stack || error);
    }
  };
  const pump = (resource) => {
    const state = stateFor(resource);
    if (state.active || state.waiting.length === 0) {
      return;
    }
    const entry = state.waiting.shift();
    state.active = entry;
    entry.started = true;
    entry.controller = new AbortController();
    callHook(entry, 'onStart');
    Promise.resolve()
      .then(() => entry.controller.signal.aborted
        ? { cancelled: true }
        : entry.task(entry.controller.signal))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        if (state.active === entry) {
          state.active = null;
        }
        callHook(entry, 'onFinish');
        if (!state.active && state.waiting.length === 0) {
          resources.delete(resource);
        }
        pump(resource);
      });
  };
  const find = (instance, resource) => {
    const state = resources.get(resource);
    if (!state) {
      return null;
    }
    if (state.active && sameInstance(state.active.instance, instance)) {
      return state.active;
    }
    return state.waiting.find((entry) => sameInstance(entry.instance, instance)) || null;
  };

  return {
    run(instance, resource, task, options = {}) {
      const existing = find(instance, resource);
      if (existing) {
        return existing.promise;
      }
      const state = stateFor(resource);
      const entry = { instance, resource, task, options, started: false, controller: null };
      entry.promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      state.waiting.push(entry);
      if (state.active) {
        callHook(entry, 'onQueued', state.waiting.length);
      }
      pump(resource);
      return entry.promise;
    },
    cancel(instance, resource) {
      const state = resources.get(resource);
      if (!state) {
        return false;
      }
      if (state.active && sameInstance(state.active.instance, instance)) {
        callHook(state.active, 'onCancel', 'active');
        state.active.controller?.abort();
        return true;
      }
      const index = state.waiting.findIndex((entry) => sameInstance(entry.instance, instance));
      if (index < 0) {
        return false;
      }
      const [entry] = state.waiting.splice(index, 1);
      callHook(entry, 'onCancel', 'waiting');
      entry.resolve({ cancelled: true });
      if (!state.active && state.waiting.length === 0) {
        resources.delete(resource);
      }
      return true;
    },
    cancelAll(instance) {
      let cancelled = false;
      for (const resource of [...resources.keys()]) {
        cancelled = this.cancel(instance, resource) || cancelled;
      }
      return cancelled;
    },
    position(instance, resource) {
      const state = resources.get(resource);
      if (!state) {
        return -1;
      }
      if (state.active && sameInstance(state.active.instance, instance)) {
        return 0;
      }
      const index = state.waiting.findIndex((entry) => sameInstance(entry.instance, instance));
      return index < 0 ? -1 : index + 1;
    },
  };
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
  EXCLUSIVE_TASKS.cancelAll(instance);
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
      <svg width="392" height="392" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
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

function invertHexColor(_match, hex) {
  const expanded = hex.length <= 4
    ? [...hex].map((digit) => `${digit}${digit}`).join('')
    : hex;
  const rgb = expanded.slice(0, 6);
  const alpha = expanded.slice(6);
  const inverted = [0, 2, 4]
    .map((offset) => (255 - Number.parseInt(rgb.slice(offset, offset + 2), 16)).toString(16).padStart(2, '0'))
    .join('');
  return `#${inverted}${alpha}`;
}

// 宿主 SVG 渲染器会忽略部分 filter。直接反转颜色字面量，不改变任何几何属性。
function longPressFeedbackIcon(icon, active = false) {
  if (!active) {
    return icon;
  }
  const prefix = 'data:image/svg+xml;base64,';
  if (typeof icon !== 'string' || !icon.startsWith(prefix)) {
    return icon;
  }
  try {
    const svg = Buffer.from(icon.slice(prefix.length), 'base64').toString('utf8');
    return toDataUrl(svg.replace(/#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/gi, invertHexColor));
  } catch {
    return icon;
  }
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
  if (eventType === 'hostRestore' || eventType === 'inspectorRequest') {
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
const REQUEST_SETTINGS_PARAM = '__requestSettings';
const SETTINGS_SYNC_PARAM = '__settingsSync';
const SETTINGS_SUBMIT_PARAM = '__settingsSubmit';

function isResetDefaultsRequest(param) {
  return String(param?.[RESET_DEFAULTS_PARAM] ?? '') === 'true';
}

function isRequestSettingsRequest(param) {
  return String(param?.[REQUEST_SETTINGS_PARAM] ?? '') === 'true';
}

function isSettingsSyncResponse(param) {
  return String(param?.[SETTINGS_SYNC_PARAM] ?? '') === 'true';
}

function isSettingsSubmit(param) {
  return String(param?.[SETTINGS_SUBMIT_PARAM] ?? '') === 'true';
}

function withoutSettingsSubmit(param) {
  const settings = { ...param };
  delete settings[SETTINGS_SUBMIT_PARAM];
  return settings;
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

function normalizeTime(value, fallback) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    return fallback;
  }
  return `${match[1]}:${match[2]}`;
}

function normalizeServerId(value) {
  return String(value ?? '').trim().replace(/[^0-9]/g, '').slice(0, 12);
}

function sanitizeServerList(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) {
      return '[]';
    }
    const seen = new Set();
    const clean = parsed.slice(0, 100).flatMap((server) => {
      const id = normalizeServerId(server?.id);
      if (!id || seen.has(id)) {
        return [];
      }
      seen.add(id);
      return [{
        id,
        host: String(server?.host || '').slice(0, 120),
        name: String(server?.name || '').slice(0, 80),
        city: String(server?.city || server?.location || '').slice(0, 80),
        country: String(server?.country || '').slice(0, 80),
        countryCode: String(server?.countryCode || server?.cc || '').toUpperCase().slice(0, 3),
        ip: String(server?.ip || '').slice(0, 64),
        ipCity: String(server?.ipCity || '').slice(0, 80),
        ipCountry: String(server?.ipCountry || '').slice(0, 80),
        ipCountryCode: String(server?.ipCountryCode || '').toUpperCase().slice(0, 3),
        locationSource: String(server?.locationSource || 'official').slice(0, 16),
      }];
    });
    return JSON.stringify(clean);
  } catch {
    return '[]';
  }
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

// 重置倒计时格式化。用量类 action 共用：两个键并排时，同样的剩余时长必须写成
// 同样的字样。
//
// 只保留最大的那一个单位（`3d` / `5h` / `45m`），不写 `3d02h` 这种复合形式——
// 键面上这一栏是最次要的信息，粗粒度足够，省下的宽度留给百分比。
// 传入绝对时间戳（毫秒）。已过期返回 'now'，无效值返回空串。
function formatCountdown(resetsAt, now = Date.now()) {
  if (!Number.isFinite(resetsAt)) {
    return '';
  }
  const diff = resetsAt - now;
  if (diff <= 0) {
    return 'now';
  }
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

// 计量行：整行背景按百分比横向填充，三段文字叠在其上（左标签 / 中数值 / 右附注）。
// 用量类 action（claudeusage、chatgptusage）共用，保证并排摆放时行高、字号与填充
// 观感必然一致——同一个函数比"两边照着写"可靠。
//
// 填充一律用矩形宽度实现，**不用 clipPath**：宿主 SVG 渲染器对 clipPath 支持不可靠，
// 会静默失效导致进度完全不显示。
//
// 只负责几何与排版；阈值、颜色含义这类领域语义由调用方传入 color 决定。
const UNIT_FONT_SIZE = 15;

function renderMeterRow(geometry, theme, options = {}) {
  const { x, y, width, height } = geometry;
  const {
    percent = null,
    color = theme.accent,
    label = '',
    value = '',
    tail = '',
    tailColor = theme.muted,
    showBar = true,
  } = options;

  const fontSize = Math.min(24, Math.max(15, height * 0.62));
  const textY = (y + height * 0.5 + fontSize * 0.35).toFixed(1);
  const font = 'Arial, Helvetica, sans-serif';

  const track = showBar
    ? `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="3" fill="${theme.panel}" opacity="0.55"/>`
    : '';
  const fill = showBar && percent != null
    ? `<rect x="${x}" y="${y}" width="${(width * Math.max(0, Math.min(100, percent)) / 100).toFixed(1)}" height="${height}" rx="3" fill="${color}" opacity="0.30"/>`
    : '';

  // 数字与单位分开排版：读者真正要看的是数量，`%` 和 `d/h/m` 只是量纲。
  // 同一个 <text> 内用 <tspan> 换字号，基线自动对齐，不需要手工算偏移。
  //
  // 单位固定 15px 而不按 fontSize 缩放：它是恒定的量纲标注，行数变化时不该跟着
  // 抖动；数字才随行高自适应。
  const numeric = (text, numSize, unitSize) => {
    const match = /^(-?[\d.]+)(.*)$/.exec(String(text ?? ''));
    if (!match) {
      // 没有数字的整串（例如 `now`）按小字号原样输出。
      return `<tspan font-size="${unitSize.toFixed(1)}">${escapeXml(text ?? '')}</tspan>`;
    }
    const [, num, unit] = match;
    return `<tspan font-size="${numSize.toFixed(1)}">${escapeXml(num)}</tspan>`
      + (unit ? `<tspan font-size="${unitSize.toFixed(1)}">${escapeXml(unit)}</tspan>` : '');
  };

  return `
      ${track}${fill}
      <text x="${x + 6}" y="${textY}" fill="${color}" font-size="${(fontSize * 0.82).toFixed(1)}" font-weight="800" font-family="${font}">${escapeXml(label)}</text>
      <text x="${x + width * 0.56}" y="${textY}" text-anchor="end" fill="${theme.text}" font-weight="800" font-family="${font}">${numeric(value, fontSize * 1.26, UNIT_FONT_SIZE)}</text>
      <text x="${x + width - 5}" y="${textY}" text-anchor="end" fill="${tailColor}" font-weight="700" font-family="${font}">${numeric(tail, fontSize * 1.0, UNIT_FONT_SIZE)}</text>`;
}

function normalizeSettings(actionUuid, settings = {}) {
  const config = configFromUuid(actionUuid);
  const defaults = config.defaults;
  const shared = {
    title: typeof defaults.title === 'string' ? normalizeText(settings.title, defaults.title, 14) : undefined,
    subtitle: typeof defaults.subtitle === 'string' ? normalizeText(settings.subtitle, defaults.subtitle, 18) : undefined,
    theme: normalizeTheme(settings.theme, defaults.theme),
    frameSize: typeof defaults.frameSize === 'string' ? normalizeChoice(settings.frameSize, defaults.frameSize, FRAME_SIZE_NAMES) : undefined,
    showFrame: typeof defaults.showFrame === 'string' ? normalizeBooleanString(settings.showFrame, defaults.showFrame) : undefined,
  };
  return { ...shared, ...(config.normalizeSettings?.(settings, defaults) || {}) };
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

function onInstanceReady(instance) {
  const config = configFromUuid(instance.actionUuid);
  return config.onReady?.(instance);
}

// 每次宿主恢复都把插件侧权威（含持久化）的归一化设置回推给 PI。
// 新 PI 可能在宿主原始 add/paramFromApp 之后才完成加载；即使来件内容一致也必须回推，
// 否则表单会停留在 HTML 默认值，并在后续输入或 pagehide 时反向污染持久化。
function syncInspectorSettings(instance, _incomingSettings = {}, ud = $UD) {
  const authoritative = { [SETTINGS_SYNC_PARAM]: 'true' };
  for (const [name, value] of Object.entries(instance.settings)) {
    if (value !== undefined) {
      authoritative[name] = value;
    }
  }
  ud.sendParamFromPlugin(authoritative, instance.context);
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
  $UD.setBaseDataIcon(instance.context, longPressFeedbackIcon(icon, instance.longPressFeedback === true));
}

function dispatchShortPress(instance, config = configFromUuid(instance.actionUuid), render = renderInstance) {
  guardAction(instance, 'onRun', () => config.onRun(instance));
  render(instance);
}

function beginPress(instance, config = configFromUuid(instance.actionUuid), runtime = {}) {
  if (instance.active === false) {
    return;
  }
  const schedule = runtime.setTimeout ?? setInstanceTimeout;
  const cancel = runtime.clearTimeout ?? clearInstanceTimeout;
  // 上一次按压可能没等到 keyUp（拖拽移动按键最典型：按住抓起、松手给了拖拽），
  // 残留的 pressed 与长按判定会把下一次短按误判成长按。新的 keyDown 一律按全新按压重置。
  cancel(instance, LONG_PRESS_TIMER_SLOT);
  instance.usesKeyEvents = true;
  instance.lastKeyEventAt = runtime.now ?? Date.now();
  instance.pressed = true;
  instance.longPressQualified = false;
  instance.longPressFeedback = false;
  if (!config.onLongPress) {
    return;
  }
  schedule(instance, LONG_PRESS_TIMER_SLOT, () => {
    if (!instance.pressed || instance.active === false) {
      return;
    }
    instance.longPressQualified = true;
    instance.longPressFeedback = true;
    (runtime.render ?? renderInstance)(instance);
  }, config.longPressMs ?? LONG_PRESS_MS);
}

function endPress(instance, config = configFromUuid(instance.actionUuid), runtime = {}) {
  if (!instance.pressed) {
    return;
  }
  const render = runtime.render ?? renderInstance;
  const cancel = runtime.clearTimeout ?? clearInstanceTimeout;
  instance.lastKeyEventAt = runtime.now ?? Date.now();
  cancel(instance, LONG_PRESS_TIMER_SLOT);
  const wasLongPress = instance.longPressQualified === true;
  instance.pressed = false;
  instance.longPressQualified = false;
  instance.longPressFeedback = false;
  if (wasLongPress) {
    guardAction(instance, 'onLongPress', () => config.onLongPress(instance));
    render(instance);
    return;
  }
  dispatchShortPress(instance, config, render);
}

// 新宿主会在 keydown/keyup 之后补发 run，需要短路掉，否则业务会重复执行一次。
// 但这个判断不能做成"见过按键事件就永久锁存"：拖拽移动按键会留下一次收不到 keyUp 的
// 半程按压，此后宿主补发的 run 若被无条件吞掉，这个键就再也按不动了（已复现）。
// 因此只在"刚刚发生过按键事件"的时间窗内短路，超时自动回落到 run，保证按键可自愈。
function keyEventsFresh(instance, now = Date.now()) {
  return Boolean(instance?.usesKeyEvents)
    && now - (instance.lastKeyEventAt ?? 0) < RUN_AFTER_KEY_EVENT_MS;
}

function dispatchRunFallback(instance, config = configFromUuid(instance.actionUuid), render = renderInstance, now = Date.now()) {
  if (keyEventsFresh(instance, now)) {
    return;
  }
  dispatchShortPress(instance, config, render);
}

// 必须在 runtime() 之前短路，否则 runtime() 自带的 render 会重复执行业务。
// 实体按压视觉由宿主负责，插件在 keydown 不提交图标。
function handleRunEvent(context, runtime = {}) {
  const instances = runtime.instances ?? INSTANCES;
  const now = runtime.now ?? Date.now();
  const current = instances.get(context);
  if (keyEventsFresh(current, now)) {
    return current;
  }
  const processor = runtime.eventProcessor;
  const instance = processor.runtime(context);
  const config = configFromUuid(instance.actionUuid);
  dispatchRunFallback(instance, config, runtime.render ?? renderInstance, now);
  return instance;
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
      !['runtime', 'inspectorRequest'].includes(eventType) &&
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
      !['runtime', 'inspectorRequest'].includes(eventType) &&
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
      // 主进程回推给 Inspector 的 PARAMFROMPLUGIN 会被宿主广播回主进程。
      // 带标记的回声只用于填充表单，绝不能再次当作用户提交写入设置。
      if (isSettingsSyncResponse(incomingSettings)) {
        return runtime.instances.get(context) ?? ensureInstance(context, {}, 'inspectorRequest', {
          ...runtime,
          render: () => {},
          ready: () => {},
        });
      }
      if (isRequestSettingsRequest(incomingSettings)) {
        const instance = runtime.instances.get(context) ?? ensureInstance(context, {}, 'inspectorRequest', {
          ...runtime,
          render: () => {},
          ready: () => {},
        });
        guardAction(instance, 'syncInspector', () => syncInspectorSettings(instance, {}, ud));
        return instance;
      }
      if (isResetDefaultsRequest(incomingSettings)) {
        return this.resetDefaults(context);
      }
      const hasControlParam = Object.keys(incomingSettings).some((key) => key.startsWith('__'));
      if (!isSettingsSubmit(incomingSettings) && !hasControlParam) {
        return runtime.instances.get(context) ?? ensureInstance(context, {}, 'inspectorRequest', {
          ...runtime,
          render: () => {},
          ready: () => {},
        });
      }
      const submittedSettings = isSettingsSubmit(incomingSettings)
        ? withoutSettingsSubmit(incomingSettings)
        : incomingSettings;
      const instance = ensureInstance(context, submittedSettings, 'pluginSubmit', runtime);
      const config = configFromUuid(instance.actionUuid);
      guardAction(instance, 'paramFromPlugin', () => dispatchActionParam(config, instance, submittedSettings));
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
  handleRunEvent(message.context, { eventProcessor, instances: INSTANCES });
}));

$UD.onKeyDown(safeHandler('keyDown', (message) => {
  const instance = INSTANCES.get(message.context) ?? eventProcessor.runtime(message.context);
  beginPress(instance);
}));

$UD.onKeyUp(safeHandler('keyUp', (message) => {
  const instance = INSTANCES.get(message.context) ?? eventProcessor.runtime(message.context);
  endPress(instance);
}));

$UD.onSetActive(safeHandler('setActive', (message) => {
  const instance = INSTANCES.get(message.context);
  if (!instance) {
    return;
  }
  instance.active = Boolean(message.active);
  if (instance.active) {
    renderInstance(instance);
  } else {
    clearInstanceTimeout(instance, LONG_PRESS_TIMER_SLOT);
    instance.pressed = false;
    instance.longPressQualified = false;
    instance.longPressFeedback = false;
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
  ...ACTION_TESTING,
  formatCountdown,
  frameFor,
  frameHighlight,
  beginPress,
  clearInstanceTimeout,
  createSettingsEventProcessor,
  createExclusiveTaskQueue,
  createSettingsStorage,
  delayInstance,
  dispatchActionParam,
  disposeInstance,
  dispatchRunFallback,
  endPress,
  handleRunEvent,
  dropPersistedState,
  initializeInstanceState,
  longPressFeedbackIcon,
  readPersistedState,
  resolveSettingsForEvent,
  setInstanceTimeout,
  writePersistedSettings,
  writePersistedState,
});
