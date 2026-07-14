import UlanzideckApi from '../libs/node/ulanzideckApi.js';
import { log } from '../libs/node/utils.js';

const PLUGIN_UUID = '__PLUGIN_UUID__';

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
      title: '__PLUGIN_NAME__',
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
      title: '__PLUGIN_NAME__',
      subtitle: 'Palette',
      color: '#8b5cf6',
      theme: 'signal',
    },
    createState: () => ({ step: 0 }),
    onRun: (instance) => {
      instance.step = (instance.step + 1) % SWATCH_COLORS.length;
      instance.settings.color = SWATCH_COLORS[instance.step];
    },
    render: (instance) => renderSwatchIcon(instance.settings, instance.step),
  },
  fontprobe: {
    defaults: {
      title: '__PLUGIN_NAME__',
      subtitle: 'Font Test',
      color: '#d4d4d8',
      theme: 'mono',
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

// ---- 框架隔离层：单进程内按实例隔离异常与定时器（见 docs/development-rules.md §4）----

function reportActionError(instance, phase, error) {
  const actionKey = instance ? actionKeyFromUuid(instance.actionUuid) : 'unknown';
  log(`action error [${actionKey}] phase=${phase}`, error?.stack || error);
  if (instance && INSTANCES.has(instance.context)) {
    instance.lastError = { phase, message: String(error?.message || error), at: Date.now() };
    renderErrorState(instance);
  }
}

function guardAction(instance, phase, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      result.catch((error) => reportActionError(instance, phase, error));
    }
    return result;
  } catch (error) {
    reportActionError(instance, phase, error);
    return undefined;
  }
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

function setInstanceTimeout(instance, slot, fn, ms) {
  clearInstanceTimeout(instance, slot);
  if (!instance.timers) {
    instance.timers = new Map();
  }
  const handle = setTimeout(() => {
    instance.timers?.delete(slot);
    guardAction(instance, `timer:${slot}`, fn);
  }, ms);
  instance.timers.set(slot, handle);
}

function hasInstanceTimeout(instance, slot) {
  return Boolean(instance?.timers?.has(slot));
}

function clearInstanceTimeout(instance, slot) {
  const handle = instance?.timers?.get(slot);
  if (handle) {
    clearTimeout(handle);
    instance.timers.delete(slot);
  }
}

function disposeInstance(instance) {
  if (!instance?.timers) {
    return;
  }
  for (const handle of instance.timers.values()) {
    clearTimeout(handle);
  }
  instance.timers.clear();
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

function themeFor(settings) {
  return THEMES[normalizeTheme(settings.theme, 'mint')];
}

function normalizeSettings(actionUuid, settings = {}) {
  const config = configFromUuid(actionUuid);
  const defaults = config.defaults;
  return {
    title: normalizeText(settings.title, defaults.title, 14),
    subtitle: normalizeText(settings.subtitle, defaults.subtitle, 18),
    color: normalizeColor(settings.color, defaults.color),
    theme: normalizeTheme(settings.theme, defaults.theme),
  };
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

function renderSwatchIcon(settings, step) {
  const theme = themeFor(settings);
  const accent = normalizeColor(settings.color, theme.accent);
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

function ensureInstance(context, incomingSettings = {}) {
  let instance = INSTANCES.get(context);
  const actionUuid = actionFromContext(context);
  const config = configFromUuid(actionUuid);

  if (!instance) {
    let initialState = {};
    try {
      initialState = config.createState() || {};
    } catch (error) {
      log(`action error [${actionKeyFromUuid(actionUuid)}] phase=createState`, error?.stack || error);
    }
    instance = {
      context,
      actionUuid,
      settings: normalizeSettings(actionUuid, incomingSettings),
      active: true,
      ...initialState,
    };
    INSTANCES.set(context, instance);
  } else if (incomingSettings && Object.keys(incomingSettings).length > 0) {
    instance.settings = normalizeSettings(actionUuid, { ...instance.settings, ...incomingSettings });
  }

  renderInstance(instance);
  return instance;
}

$UD.connect(PLUGIN_UUID);

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
  ensureInstance(message.context, message.param || {});
}));

$UD.onParamFromApp(safeHandler('paramFromApp', (message) => {
  ensureInstance(message.context, message.param || {});
}));

$UD.onParamFromPlugin(safeHandler('paramFromPlugin', (message) => {
  ensureInstance(message.context, message.param || {});
}));

$UD.onRun(safeHandler('run', (message) => {
  const instance = ensureInstance(message.context, message.param || {});
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

process.on('unhandledRejection', (reason) => {
  log('unhandledRejection (isolated)', reason?.stack || reason);
});

process.on('uncaughtException', (error) => {
  log('uncaughtException (isolated, process kept alive)', error?.stack || error);
});
