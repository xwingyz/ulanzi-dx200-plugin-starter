import UlanzideckApi from '../libs/node/ulanzideckApi.js';
import { log } from '../libs/node/utils.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_UUID = '__PLUGIN_UUID__';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 框架层持久化：所有 action 的设置都落到同一份 data/action-settings.json，
// 按 `${actionid}::${key}` 归档。
const SETTINGS_STORE_PATH = path.join(__dirname, '..', 'data', 'action-settings.json');
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
const SWATCH_COLORS = ['#8b5cf6', '#14b8a6', '#f97316', '#ef4444', '#22c55e'];
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
      title: '__PLUGIN_NAME__',
      subtitle: 'Counter',
      theme: 'mint',
      frameSize: 'optimal',
      showFrame: 'true',
    },
    createState: () => ({ count: 0 }),
    onRun: (instance) => {
      instance.count += 1;
    },
    render: (instance) => renderCounterIcon(instance.settings, instance.count),
  },
  badge: {
    defaults: {
      title: '__PLUGIN_NAME__',
      subtitle: 'Status',
      theme: 'ember',
      frameSize: 'optimal',
      showFrame: 'true',
    },
    createState: () => ({ activeBadge: true }),
    onRun: (instance) => {
      instance.activeBadge = !instance.activeBadge;
    },
    render: (instance) => renderBadgeIcon(instance.settings, instance.activeBadge),
  },
  swatch: {
    defaults: {
      title: '__PLUGIN_NAME__',
      subtitle: 'Palette',
      theme: 'signal',
      frameSize: 'optimal',
      showFrame: 'true',
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
      title: '__PLUGIN_NAME__',
      subtitle: 'Font Test',
      theme: 'mono',
      frameSize: 'optimal',
      showFrame: 'true',
    },
    createState: () => ({}),
    onRun: () => {},
    render: (instance) => renderFontTestIcon(instance.settings),
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
const STATE_STORAGE = createSettingsStorage({ storePath: STATE_STORE_PATH });
const PERSISTED_STATE = STATE_STORAGE.load();

// ---- 框架持久化层：所有 action 设置按 `${actionid}::${key}` 落盘并跨重启回读 ----

function createSettingsStorage(options = {}) {
  const storePath = options.storePath ?? SETTINGS_STORE_PATH;
  const fsImpl = options.fsImpl ?? fs;
  const logger = options.logger ?? log;
  let sequence = 0;
  let storeCorrupt = false;

  const readStore = () => {
    const value = JSON.parse(fsImpl.readFileSync(storePath, 'utf8'));
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
      return false;
    },
    get storeCorrupt() {
      return storeCorrupt;
    },
    load() {
      try {
        return readStore();
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          storeCorrupt = true;
          logger('persist store read failed', error?.stack || error);
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

// 框架保留控制参数：PI 的“恢复默认配置”按钮通过它触发重置。
// 控制参数不进入设置合并，也不透传给 action 的 onParamFromPlugin。
const RESET_DEFAULTS_PARAM = '__resetDefaults';

function isResetDefaultsRequest(param) {
  return String(param?.[RESET_DEFAULTS_PARAM] ?? '') === 'true';
}

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
    title: normalizeText(settings.title, defaults.title, 14),
    subtitle: normalizeText(settings.subtitle, defaults.subtitle, 18),
    theme: normalizeTheme(settings.theme, defaults.theme),
    frameSize: typeof defaults.frameSize === 'string' ? normalizeChoice(settings.frameSize, defaults.frameSize, FRAME_SIZE_NAMES) : undefined,
    showFrame: typeof defaults.showFrame === 'string' ? normalizeBooleanString(settings.showFrame, defaults.showFrame) : undefined,
  };
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

function renderCounterIcon(settings, count) {
  const theme = themeFor(settings);
  const accent = theme.accent;

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
        frameFor(settings),
      )}
    </svg>
  `);
}

function renderBadgeIcon(settings, active) {
  const theme = themeFor(settings);
  const accent = theme.accent;
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
        frameFor(settings),
      )}
    </svg>
  `);
}

function renderSwatchIcon(settings, step, currentColor) {
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
        frameFor(settings),
      )}
    </svg>
  `);
}

function renderFontTestIcon(settings) {
  const theme = themeFor(settings);
  const accent = theme.accent;
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
        frameFor(settings),
      )}
    </svg>
  `);
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
    disposeInstance(INSTANCES.get(item.context));
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
  frameFor,
  frameHighlight,
  clearInstanceTimeout,
  createSettingsStorage,
  createSettingsEventProcessor,
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
