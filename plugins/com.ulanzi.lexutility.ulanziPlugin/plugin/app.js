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
};

const THEME_NAMES = Object.keys(THEMES);
const SWATCH_COLORS = ['#8b5cf6', '#14b8a6', '#f97316', '#ef4444', '#22c55e'];
const LATENCY_HISTORY_LIMIT = 24;
const LATENCY_GRAPH_MODES = ['bars', 'line'];
const LATENCY_BACKGROUNDS = ['gradient', 'stars', 'mist', 'paper'];
const LATENCY_MANUAL_FEEDBACK_MS = 650;
const POMODORO_SOUND_STYLES = ['glass', 'hero', 'purr', 'submarine'];
const POMODORO_ALERT_WINDOW_SEC = 5;
const POMODORO_CYCLE_COMPLETE_SEC = 4;
const POMODORO_PALETTES = {
  mint: { focus: '#14b8a6', shortBreak: '#22c55e', longBreak: '#38bdf8', done: '#84cc16' },
  ember: { focus: '#ff7f50', shortBreak: '#7ddf64', longBreak: '#74a9ff', done: '#facc15' },
  mono: { focus: '#f4f4f5', shortBreak: '#d4d4d8', longBreak: '#a1a1aa', done: '#86efac' },
  signal: { focus: '#fb7185', shortBreak: '#34d399', longBreak: '#60a5fa', done: '#fbbf24' },
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
const FONT_TEST_LINES = [
  { size: 28, y: 96 },
  { size: 32, y: 144 },
  { size: 36, y: 198 },
];
const FONT_TEST_TEXT = '测速128Kbps';
const FONT_TEST_FAMILY = '"Arial Black", "Helvetica Neue", Arial, Helvetica, sans-serif';

const ACTION_CONFIGS = {
  counter: {
    defaults: {
      title: 'Lex Utility',
      subtitle: 'Counter',
      color: '#14b8a6',
      theme: 'mint',
    },
    createState: () => ({ count: 0 }),
    onRun: (instance) => {
      instance.count += 1;
    },
    render: (instance) => renderCounterIcon(instance.settings, instance.count),
  },
  badge: {
    defaults: {
      title: 'Lex Utility',
      subtitle: 'Status',
      color: '#f97316',
      theme: 'ember',
    },
    createState: () => ({ activeBadge: true }),
    onRun: (instance) => {
      instance.activeBadge = !instance.activeBadge;
    },
    render: (instance) => renderBadgeIcon(instance.settings, instance.activeBadge),
  },
  swatch: {
    defaults: {
      title: 'Lex Utility',
      subtitle: 'Palette',
      color: '#8b5cf6',
      theme: 'signal',
    },
    createState: () => ({ step: 0, currentColor: SWATCH_COLORS[0] }),
    onRun: (instance) => {
      instance.step = (instance.step + 1) % SWATCH_COLORS.length;
      instance.currentColor = SWATCH_COLORS[instance.step];
    },
    render: (instance) => renderSwatchIcon(instance.settings, instance.step, instance.currentColor),
  },
  fontprobe: {
    defaults: {
      title: 'Lex Utility',
      subtitle: 'Font Test',
      color: '#d4d4d8',
      theme: 'mono',
    },
    createState: () => ({}),
    onRun: () => {},
    render: (instance) => renderFontTestIcon(instance.settings),
  },
  pomowave: {
    defaults: {
      focusMin: '25',
      shortBreakMin: '5',
      longBreakMin: '15',
      roundsBeforeLongBreak: '4',
      color: '#ff7f50',
      theme: 'ember',
      backgroundStyle: 'gradient',
      soundStyle: 'glass',
      soundEnabled: 'true',
      autoStartBreaks: 'true',
      autoStartFocus: 'true',
    },
    createState: () => ({
      phase: 'idle',
      remainingSec: null,
      totalSec: null,
      completedFocusRounds: 0,
      running: false,
    }),
    onRun: (instance) => {
      togglePomodoro(instance);
    },
    onReady: (instance) => {
      initializePomodoroInstance(instance);
      if (instance.running && !hasInstanceTimeout(instance, 'pomodoro')) {
        schedulePomodoroTick(instance);
      }
    },
    onSettingsChanged: (instance, previousSettings) => {
      initializePomodoroInstance(instance);
      reconcilePomodoroSettings(instance, previousSettings);
    },
    onParamFromPlugin: (instance, param) => {
      if (param?.resetTimer === 'true') {
        resetPomodoroInstance(instance);
      }
    },
    render: (instance) => renderPomodoroIcon(instance),
  },
  latency: {
    defaults: {
      url: 'https://example.com',
      intervalSec: '30',
      warnMs: '800',
      timeoutMs: '8000',
      theme: 'signal',
      color: '#60a5fa',
      graphMode: 'bars',
      backgroundStyle: 'gradient',
    },
    createState: () => ({
      history: [],
      lastMs: null,
      status: 'checking',
      checking: false,
      requestId: 0,
    }),
    onRun: (instance) =>
      runLatencyCheck(instance, { immediateRender: true, minDisplayMs: LATENCY_MANUAL_FEEDBACK_MS, forceFeedback: true }),
    onReady: (instance) => {
      scheduleLatencyCheck(instance);
      if (!instance.history.length && !instance.checking) {
        return runLatencyCheck(instance, { immediateRender: true });
      }
      return undefined;
    },
    onSettingsChanged: (instance, previousSettings) => {
      const probeChanged =
        previousSettings.url !== instance.settings.url ||
        previousSettings.intervalSec !== instance.settings.intervalSec ||
        previousSettings.warnMs !== instance.settings.warnMs ||
        previousSettings.timeoutMs !== instance.settings.timeoutMs;
      if (!probeChanged) {
        return;
      }
      instance.history = [];
      instance.lastMs = null;
      instance.status = 'checking';
      clearLatencyTimer(instance);
      instance.checking = false;
      guardAction(instance, 'ready', () => onInstanceReady(instance));
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
  const state = guardAction(instance, 'createState', () => config.createState() || {}, onError);
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
  if (!instance?.timers) {
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
        `)}
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
  const legacyPath = options.legacyPath ?? LEGACY_LATENCY_STORE_PATH;
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
  return ACTION_KEY_BY_UUID[actionUuid] || 'counter';
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

function normalizeSettings(actionUuid, settings = {}) {
  const config = configFromUuid(actionUuid);
  const defaults = config.defaults;
  return {
    title: typeof defaults.title === 'string' ? normalizeText(settings.title, defaults.title, 14) : undefined,
    subtitle: typeof defaults.subtitle === 'string' ? normalizeText(settings.subtitle, defaults.subtitle, 18) : undefined,
    color: normalizeColor(settings.color, defaults.color),
    theme: normalizeTheme(settings.theme, defaults.theme),
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
    graphMode: typeof defaults.graphMode === 'string' ? normalizeChoice(settings.graphMode, defaults.graphMode, LATENCY_GRAPH_MODES) : undefined,
    backgroundStyle: typeof defaults.backgroundStyle === 'string' ? normalizeChoice(settings.backgroundStyle, defaults.backgroundStyle, LATENCY_BACKGROUNDS) : undefined,
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

function checkUrl(rawUrl, timeoutMs) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(normalizeUrl(rawUrl, ''));
    } catch {
      resolve({ ok: false, ms: 0, code: 0, error: 'bad_url' });
      return;
    }

    const client = url.protocol === 'http:' ? http : https;
    const started = Date.now();
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
        timeout: timeoutMs,
        headers: {
          'user-agent': 'LexUtilityLatency/0.1.0',
          accept: '*/*',
        },
      },
      (response) => {
        const ms = Date.now() - started;
        const code = response.statusCode || 0;
        response.resume();
        response.on('end', () => {
          finish({ ok: code > 0 && code < 400, ms, code });
        });
      },
    );

    request.on('timeout', () => {
      request.destroy();
      finish({ ok: false, ms: timeoutMs, code: 0, error: 'timeout' });
    });

    request.on('error', () => {
      finish({ ok: false, ms: Date.now() - started, code: 0, error: 'network' });
    });

    request.end();
  });
}

function renderScreenFrame(theme, accent, innerSvg) {
  return `
    <rect width="256" height="256" rx="48" fill="${theme.canvas}"/>
    <rect x="16" y="16" width="224" height="224" rx="40" fill="none" stroke="${theme.low}" stroke-width="2" opacity="0.4"/>
    <rect x="28" y="28" width="200" height="200" rx="30" fill="${theme.shell}" stroke="${accent}" stroke-width="4"/>
    <rect x="40" y="40" width="176" height="176" rx="24" fill="${theme.panel}" stroke="${accent}" stroke-width="1.5" opacity="0.98"/>
    ${innerSvg}
  `;
}

function renderCounterIcon(settings, count) {
  const theme = themeFor(settings);
  const accent = normalizeColor(settings.color, theme.accent);

  return toDataUrl(`
    <svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${renderScreenFrame(
        theme,
        accent,
        `
          <rect x="54" y="54" width="148" height="20" rx="10" fill="${accent}" opacity="0.2"/>
          <text x="128" y="78" text-anchor="middle" fill="${theme.text}" font-size="22" font-family="Arial, Helvetica, sans-serif">${escapeXml(settings.title)}</text>
          <text x="128" y="138" text-anchor="middle" fill="${accent}" font-size="72" font-weight="700" font-family="Arial, Helvetica, sans-serif">${count}</text>
          <text x="128" y="174" text-anchor="middle" fill="${theme.muted}" font-size="22" font-family="Arial, Helvetica, sans-serif">${escapeXml(settings.subtitle)}</text>
          <text x="128" y="204" text-anchor="middle" fill="${theme.low}" font-size="16" font-family="Arial, Helvetica, sans-serif">press to increment</text>
        `,
      )}
    </svg>
  `);
}

function renderBadgeIcon(settings, active) {
  const theme = themeFor(settings);
  const accent = normalizeColor(settings.color, theme.accent);
  const pillFill = active ? accent : theme.low;
  const pillText = active ? theme.contrast : theme.text;

  return toDataUrl(`
    <svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${renderScreenFrame(
        theme,
        accent,
        `
          <rect x="54" y="56" width="148" height="42" rx="21" fill="${pillFill}"/>
          <text x="128" y="84" text-anchor="middle" fill="${pillText}" font-size="20" font-weight="700" font-family="Arial, Helvetica, sans-serif">${active ? 'LIVE' : 'PAUSED'}</text>
          <text x="128" y="136" text-anchor="middle" fill="${theme.text}" font-size="30" font-weight="700" font-family="Arial, Helvetica, sans-serif">${escapeXml(settings.title)}</text>
          <text x="128" y="170" text-anchor="middle" fill="${theme.muted}" font-size="22" font-family="Arial, Helvetica, sans-serif">${escapeXml(settings.subtitle)}</text>
          <text x="128" y="202" text-anchor="middle" fill="${accent}" font-size="16" font-family="Arial, Helvetica, sans-serif">press to toggle</text>
        `,
      )}
    </svg>
  `);
}

function renderSwatchIcon(settings, step, currentColor = settings.color) {
  const theme = themeFor(settings);
  const accent = normalizeColor(currentColor, theme.accent);
  const dots = SWATCH_COLORS.map((color, index) => {
    const cx = 72 + index * 28;
    const stroke = step % SWATCH_COLORS.length === index ? theme.text : theme.shell;
    return `<circle cx="${cx}" cy="194" r="10" fill="${color}" stroke="${stroke}" stroke-width="3"/>`;
  }).join('');

  return toDataUrl(`
    <svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${renderScreenFrame(
        theme,
        accent,
        `
          <rect x="54" y="54" width="148" height="76" rx="20" fill="${accent}"/>
          <text x="128" y="162" text-anchor="middle" fill="${theme.text}" font-size="28" font-weight="700" font-family="Arial, Helvetica, sans-serif">${escapeXml(settings.title)}</text>
          <text x="128" y="188" text-anchor="middle" fill="${theme.muted}" font-size="17" font-family="Arial, Helvetica, sans-serif">${escapeXml(settings.subtitle)}</text>
          <text x="128" y="218" text-anchor="middle" fill="${theme.text}" font-size="17" font-family="Arial, Helvetica, sans-serif">${escapeXml(accent.toUpperCase())}</text>
          ${dots}
        `,
      )}
    </svg>
  `);
}

function renderFontTestIcon(settings) {
  const theme = themeFor(settings);
  const accent = normalizeColor(settings.color, theme.accent);
  const samples = FONT_TEST_LINES.map(({ size, y }, index) => {
    const fill = index === 2 ? accent : theme.text;
    return `
      <text x="128" y="${y}" text-anchor="middle" fill="${fill}" font-size="${size}" font-weight="800" font-family="${FONT_TEST_FAMILY}">${escapeXml(FONT_TEST_TEXT)}</text>
    `;
  }).join('');

  return toDataUrl(`
    <svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${renderScreenFrame(
        theme,
        accent,
        `
          <rect x="50" y="50" width="156" height="156" rx="20" fill="none" stroke="${accent}" stroke-width="2"/>
          <rect x="40" y="40" width="176" height="176" rx="24" fill="none" stroke="${theme.muted}" stroke-width="1.5" stroke-dasharray="6 6" opacity="0.8"/>
          ${samples}
        `,
      )}
    </svg>
  `);
}

function pomodoroPalette(settings) {
  const palette = POMODORO_PALETTES[normalizeTheme(settings.theme, 'ember')] || POMODORO_PALETTES.ember;
  return {
    focus: normalizeColor(settings.color, palette.focus),
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
  if (instance.phase === 'focus') {
    return instance.running ? 'FOCUS' : 'PAUSED';
  }
  if (instance.phase === 'shortBreak') {
    return instance.running ? 'SHORT' : 'PAUSED';
  }
  if (instance.phase === 'longBreak') {
    return instance.running ? 'LONG' : 'PAUSED';
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

function playPomodoroCue(settings) {
  if (!isEnabled(settings.soundEnabled)) {
    return;
  }

  const style = normalizeChoice(settings.soundStyle, 'glass', POMODORO_SOUND_STYLES);
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

function resetPomodoroInstance(instance, { preserveRounds = false } = {}) {
  clearPomodoroTimer(instance);
  instance.phase = 'idle';
  instance.running = false;
  instance.totalSec = pomodoroDurationSecFromSettings(instance.settings, 'focus');
  instance.remainingSec = instance.totalSec;
  if (!preserveRounds) {
    instance.completedFocusRounds = 0;
  }
}

function schedulePomodoroTick(instance) {
  if (!instance.running) {
    clearPomodoroTimer(instance);
    return;
  }
  setInstanceTimeout(instance, 'pomodoro', () => tickPomodoro(instance), 1000);
}

function startPomodoroPhase(instance, phase, options = {}) {
  const {
    autoStart = true,
    playSound = false,
  } = options;

  clearPomodoroTimer(instance);
  instance.phase = phase;
  instance.totalSec = pomodoroDurationSecFromSettings(instance.settings, phase);
  instance.remainingSec = instance.totalSec;
  instance.running = autoStart;

  if (phase === 'focus' && !autoStart) {
    instance.remainingSec = instance.totalSec;
  }

  if (phase === 'done') {
    instance.completedFocusRounds = 0;
  }

  if (playSound) {
    playPomodoroCue(instance.settings);
  }

  renderInstance(instance);
  schedulePomodoroTick(instance);
}

function advancePomodoroPhase(instance) {
  const roundsGoal = pomodoroRoundsGoal(instance.settings);

  if (instance.phase === 'focus') {
    instance.completedFocusRounds += 1;
    const hitLongBreak = instance.completedFocusRounds % roundsGoal === 0;
    startPomodoroPhase(instance, hitLongBreak ? 'longBreak' : 'shortBreak', {
      autoStart: isEnabled(instance.settings.autoStartBreaks),
      playSound: true,
    });
    return;
  }

  if (instance.phase === 'shortBreak') {
    startPomodoroPhase(instance, 'focus', {
      autoStart: isEnabled(instance.settings.autoStartFocus),
      playSound: true,
    });
    return;
  }

  if (instance.phase === 'longBreak') {
    startPomodoroPhase(instance, 'done', {
      autoStart: true,
      playSound: true,
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

function tickPomodoro(instance) {
  if (!instance || !INSTANCES.has(instance.context) || !instance.running) {
    return;
  }

  instance.remainingSec = Math.max(0, (instance.remainingSec ?? instance.totalSec ?? 0) - 1);
  if (instance.remainingSec <= 0) {
    advancePomodoroPhase(instance);
    return;
  }

  renderInstance(instance);
  schedulePomodoroTick(instance);
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

  const ratio = Math.max(0, Math.min(1, (instance.remainingSec ?? nextTotal) / previousTotal));
  instance.totalSec = nextTotal;
  instance.remainingSec = Math.max(1, Math.round(nextTotal * ratio));
}

function togglePomodoro(instance) {
  initializePomodoroInstance(instance);

  if (instance.phase === 'idle') {
    startPomodoroPhase(instance, 'focus', { autoStart: true, playSound: false });
    return;
  }

  if (instance.phase === 'done') {
    resetPomodoroInstance(instance);
    startPomodoroPhase(instance, 'focus', { autoStart: true, playSound: false });
    return;
  }

  instance.running = !instance.running;
  renderInstance(instance);
  schedulePomodoroTick(instance);
}

function renderPomodoroIcon(instance) {
  initializePomodoroInstance(instance);
  const theme = themeFor(instance.settings);
  const background = renderLatencyBackground(theme, pomodoroColor(instance.settings, instance.phase), instance.settings.backgroundStyle);
  const phaseColor = pomodoroColor(instance.settings, instance.phase === 'idle' ? 'focus' : instance.phase);
  const totalSec = Math.max(1, instance.totalSec || pomodoroDurationSecFromSettings(instance.settings, 'focus'));
  const remainingSec = Math.max(0, instance.remainingSec ?? totalSec);
  const progress = instance.phase === 'done' ? 1 : remainingSec / totalSec;
  const circumference = 2 * Math.PI * 72;
  const dashOffset = (circumference * (1 - progress)).toFixed(1);
  const alertPulse = instance.running && instance.phase !== 'done' && remainingSec <= POMODORO_ALERT_WINDOW_SEC && remainingSec % 2 === 0;
  const accent = alertPulse ? background.text : phaseColor;
  const displayText = instance.phase === 'done' ? '✓' : formatPomodoroTime(remainingSec);
  const displaySize = instance.phase === 'done' ? 88 : 40;
  const label = pomodoroPhaseLabel(instance);
  const footer = instance.phase === 'idle'
    ? 'tap to start'
    : instance.running ? 'tap to pause' : 'tap to resume';
  const roundsGoal = pomodoroRoundsGoal(instance.settings);
  const completedInCycle = instance.phase === 'longBreak' || instance.phase === 'done'
    ? roundsGoal
    : instance.completedFocusRounds % roundsGoal;
  const dots = Array.from({ length: roundsGoal }, (_, index) => {
    const cx = 128 - ((roundsGoal - 1) * 18) / 2 + index * 18;
    const filled = index < completedInCycle;
    return `<circle cx="${cx}" cy="214" r="5.5" fill="${filled ? accent : background.low}" opacity="${filled ? '1' : '0.45'}"/>`;
  }).join('');

  return toDataUrl(`
    <svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${background.outer}
      <circle cx="128" cy="114" r="72" fill="none" stroke="${background.low}" stroke-width="12" opacity="0.42"/>
      <circle
        cx="128"
        cy="114"
        r="72"
        fill="none"
        stroke="${accent}"
        stroke-width="12"
        stroke-linecap="round"
        stroke-dasharray="${circumference.toFixed(1)}"
        stroke-dashoffset="${dashOffset}"
        transform="rotate(-90 128 114)"
      />
      <rect x="74" y="48" width="108" height="26" rx="13" fill="${accent}" fill-opacity="0.14"/>
      <text x="128" y="66" text-anchor="middle" fill="${accent}" font-size="16" font-weight="800" font-family="Arial, Helvetica, sans-serif" letter-spacing="2">POMOWAVE</text>
      <text x="128" y="123" text-anchor="middle" fill="${instance.phase === 'done' ? accent : background.text}" font-size="${displaySize}" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(displayText)}</text>
      <text x="128" y="156" text-anchor="middle" fill="${accent}" font-size="19" font-weight="800" font-family="Arial, Helvetica, sans-serif" letter-spacing="2">${escapeXml(label)}</text>
      <text x="128" y="180" text-anchor="middle" fill="${background.muted}" font-size="14" font-family="Arial, Helvetica, sans-serif">${escapeXml(footer)}</text>
      <text x="128" y="198" text-anchor="middle" fill="${background.low}" font-size="12" font-family="Arial, Helvetica, sans-serif">${escapeXml(`${instance.settings.focusMin}/${instance.settings.shortBreakMin}/${instance.settings.longBreakMin} min`)}</text>
      ${dots}
    </svg>
  `);
}

function renderLatencyBackground(theme, accent, backgroundStyle) {
  const styles = {
    gradient: {
      outer: `
        <defs>
          <linearGradient id="latencyBg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="${theme.canvas}"/>
            <stop offset="55%" stop-color="${theme.shell}"/>
            <stop offset="100%" stop-color="${theme.panel}"/>
          </linearGradient>
        </defs>
        <rect width="256" height="256" rx="48" fill="url(#latencyBg)"/>
        <circle cx="206" cy="54" r="44" fill="${accent}" opacity="0.08"/>
        <circle cx="52" cy="212" r="58" fill="${theme.low}" opacity="0.10"/>
      `,
    },
    stars: {
      outer: `
        <rect width="256" height="256" rx="48" fill="${theme.canvas}"/>
        <circle cx="58" cy="52" r="1.8" fill="#ffffff" opacity="0.65"/>
        <circle cx="92" cy="82" r="1.2" fill="#ffffff" opacity="0.48"/>
        <circle cx="188" cy="58" r="1.6" fill="#ffffff" opacity="0.7"/>
        <circle cx="214" cy="98" r="1.4" fill="#ffffff" opacity="0.42"/>
        <circle cx="166" cy="34" r="1" fill="${accent}" opacity="0.65"/>
        <circle cx="38" cy="118" r="1" fill="${accent}" opacity="0.35"/>
        <circle cx="228" cy="148" r="1.3" fill="#ffffff" opacity="0.36"/>
        <circle cx="72" cy="180" r="1.1" fill="#ffffff" opacity="0.34"/>
      `,
    },
    mist: {
      outer: `
        <defs>
          <linearGradient id="latencyBg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#f7fbff"/>
            <stop offset="100%" stop-color="#d6e4fb"/>
          </linearGradient>
        </defs>
        <rect width="256" height="256" rx="48" fill="url(#latencyBg)"/>
        <circle cx="72" cy="58" r="56" fill="#ffffff" opacity="0.62"/>
        <circle cx="194" cy="210" r="64" fill="#bfd3f8" opacity="0.5"/>
      `,
    },
    paper: {
      outer: `
        <defs>
          <linearGradient id="latencyBgPaper" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#fffaf2"/>
            <stop offset="100%" stop-color="#eedfc8"/>
          </linearGradient>
        </defs>
        <rect width="256" height="256" rx="48" fill="url(#latencyBgPaper)"/>
        <circle cx="198" cy="62" r="54" fill="#fde7cf" opacity="0.62"/>
        <circle cx="46" cy="196" r="50" fill="#e8d6bf" opacity="0.56"/>
      `,
    },
  };

  const background = styles[backgroundStyle] || styles.gradient;
  const shellFill = backgroundStyle === 'mist' ? '#d7e4f8' : backgroundStyle === 'paper' ? '#ead7bd' : theme.shell;
  const panelFill = backgroundStyle === 'mist' ? '#fdfefe' : backgroundStyle === 'paper' ? '#fffdf8' : theme.panel;
  const shellStroke = backgroundStyle === 'mist' ? '#8eadd7' : backgroundStyle === 'paper' ? '#c6a47c' : accent;
  const shellStrokeOpacity = backgroundStyle === 'mist' || backgroundStyle === 'paper' ? 0.7 : 1;
  const panelText = backgroundStyle === 'mist' || backgroundStyle === 'paper' ? '#17212f' : theme.text;
  const panelMuted = backgroundStyle === 'mist' ? '#5f7594' : backgroundStyle === 'paper' ? '#7d6548' : theme.muted;
  const panelLow = backgroundStyle === 'mist' ? '#9eb6d6' : backgroundStyle === 'paper' ? '#cbb390' : theme.low;

  return {
    outer: `
      ${background.outer}
      <rect x="16" y="16" width="224" height="224" rx="40" fill="none" stroke="${shellStroke}" stroke-width="2.2" opacity="0.34"/>
      <rect x="28" y="28" width="200" height="200" rx="30" fill="${shellFill}" stroke="${shellStroke}" stroke-width="4.5" stroke-opacity="${shellStrokeOpacity}"/>
      <rect x="40" y="40" width="176" height="176" rx="24" fill="${panelFill}" stroke="${shellStroke}" stroke-width="1.4" opacity="0.985"/>
      <rect x="46" y="46" width="164" height="164" rx="20" fill="#ffffff" opacity="${backgroundStyle === 'mist' ? '0.18' : backgroundStyle === 'paper' ? '0.14' : '0'}"/>
    `,
    text: panelText,
    muted: panelMuted,
    low: panelLow,
  };
}

function buildLatencySeries(instance, warnMs, accent) {
  const history = instance.history || [];
  // 纵向刻度锚定在告警阈值附近并固定下来：单个尖峰/超时只会被钳到柱顶，
  // 不会反过来把整条基线上的正常柱子重新压扁（这正是之前“显示不正常”的根因）。
  const maxMs = Math.max(warnMs * 1.5, 150);

  // 横向布局：把柱子收敛在基线宽度（startX → endX）内，按历史上限分配槽位，
  // 这样柱宽稳定、从左往右增长，满历史时也不会越过右边缘。
  const startX = 42;
  const endX = 214;
  const chartBottom = 192;
  const chartHeight = 42;
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
    const fill = !entry.ok ? '#ef4444' : entry.ms > warnMs ? '#f59e0b' : accent;
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

function renderLatencyIcon(instance) {
  const theme = themeFor(instance.settings);
  const background = renderLatencyBackground(theme, normalizeColor(instance.settings.color, theme.accent), instance.settings.backgroundStyle);
  const host = hostFromUrl(instance.settings.url);
  const warnMs = Number.parseInt(instance.settings.warnMs, 10) || 400;
  const status = instance.status || 'checking';
  const accent =
    status === 'down' ? '#ef4444'
    : status === 'slow' ? '#f59e0b'
    : status === 'up' ? normalizeColor(instance.settings.color, theme.accent)
    : theme.muted;
  const bigText =
    status === 'down' ? 'DOWN'
    : status === 'checking' ? 'Chk...'
    : instance.lastMs == null ? '...'
    : String(instance.lastMs);
  const uptime = instance.history.length
    ? Math.round((instance.history.filter((entry) => entry.ok).length / instance.history.length) * 100)
    : null;
  const headerText =
    status === 'down' ? '离线'
    : status === 'slow' ? '偏高'
    : status === 'up' ? '延迟'
    : '检查';
  const hostLabel = clipText(host, 18);
  const chart = buildLatencySeries(instance, warnMs, accent);
  const graphSvg = instance.settings.graphMode === 'line'
    ? `${chart.line}${chart.dots}`
    : chart.bars;
  const uptimeLabel = uptime == null ? '--' : `UP ${uptime}%`;
  const valueFontSize = bigText.length >= 4 ? 42 : 50;

  return toDataUrl(`
    <svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${background.outer}
      ${
        `
          <circle cx="58" cy="62" r="7" fill="${accent}"/>
          <text x="72" y="68" fill="${accent}" font-size="18" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(headerText)}</text>
          <text x="128" y="88" text-anchor="middle" fill="${background.low}" font-size="13" font-family="Arial, Helvetica, sans-serif">${escapeXml(hostLabel)}</text>
          <text x="122" y="136" text-anchor="middle" fill="${status === 'down' ? '#ef4444' : background.text}" font-size="${status === 'down' ? 38 : valueFontSize}" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(bigText)}</text>
          <text x="${bigText.length >= 4 ? 183 : 176}" y="136" fill="${background.muted}" font-size="22" font-weight="700" font-family="Arial, Helvetica, sans-serif">ms</text>
          <line x1="42" y1="192" x2="214" y2="192" stroke="${background.low}" stroke-width="1.5" opacity="0.55"/>
          ${graphSvg}
          <text x="44" y="212" fill="${background.low}" font-size="12" font-family="Arial, Helvetica, sans-serif">${instance.settings.graphMode === 'line' ? '折线图' : '柱状图'}</text>
          <text x="214" y="212" text-anchor="end" fill="${accent}" font-size="15" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(uptimeLabel)}</text>
        `
      }
    </svg>
  `);
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
  instance.checking = false;
  instance.lastMs = result.ok ? result.ms : null;
  instance.history = [...instance.history, result].slice(-LATENCY_HISTORY_LIMIT);
  instance.status = !result.ok ? 'down' : result.ms > warnMs ? 'slow' : 'up';
  render(instance);
  schedule(instance);
  return true;
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
      const instance = ensureInstance(context, incomingSettings, 'pluginSubmit', runtime);
      const config = configFromUuid(instance.actionUuid);
      guardAction(instance, 'paramFromPlugin', () => dispatchActionParam(config, instance, incomingSettings));
      runtime.render(instance);
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
  clearInstanceTimeout,
  commitLatencyResult,
  createSettingsEventProcessor,
  createSettingsStorage,
  delayInstance,
  dispatchActionParam,
  disposeInstance,
  initializeInstanceState,
  resolveSettingsForEvent,
  setInstanceTimeout,
  writePersistedSettings,
});
