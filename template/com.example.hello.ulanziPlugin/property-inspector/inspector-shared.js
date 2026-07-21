// 自动保存去抖：连续输入只在停顿后落一次盘；手动保存/按钮走 flush 立即提交。
const AUTOSAVE_DEBOUNCE_MS = 400;
// 框架保留控制参数：与 plugin/app.js 的 RESET_DEFAULTS_PARAM 一致，
// “恢复默认配置”按钮只发这个控制键，重置与回推由插件框架完成。
const RESET_DEFAULTS_PARAM = '__resetDefaults';
// PI 可能晚于宿主 add/paramFromApp 事件完成加载；连接后主动请求插件侧权威设置，
// 避免表单停留在 HTML 默认值并在后续 autosave/pagehide 时污染持久化。
const REQUEST_SETTINGS_PARAM = '__requestSettings';
// 保存/恢复默认的内联反馈展示时长。
const FEEDBACK_VISIBLE_MS = 1600;

let feedbackHideTimer = null;

// kind: 'saved' | 'reset'。页面需提供 #inspector-feedback 容器与
// #feedback-saved / #feedback-reset 两条文案；缺失时静默跳过。
function flashInspectorFeedback(kind) {
  const container = document.getElementById('inspector-feedback');
  if (!container) {
    return;
  }
  ['saved', 'reset'].forEach((name) => {
    const item = document.getElementById(`feedback-${name}`);
    if (item) {
      item.hidden = name !== kind;
    }
  });
  container.hidden = false;
  if (feedbackHideTimer) {
    clearTimeout(feedbackHideTimer);
  }
  feedbackHideTimer = setTimeout(() => {
    feedbackHideTimer = null;
    container.hidden = true;
  }, FEEDBACK_VISIBLE_MS);
}

function bindResetDefaults(sendReset) {
  const button = document.getElementById('resetDefaults');
  if (!button) {
    return;
  }
  button.addEventListener('click', () => {
    sendReset();
    flashInspectorFeedback('reset');
  });
}

function debounce(fn, wait) {
  let timer = null;
  let pendingArgs = null;
  const debounced = (...args) => {
    if (timer) {
      clearTimeout(timer);
    }
    pendingArgs = args;
    timer = setTimeout(() => {
      timer = null;
      const argsToSend = pendingArgs;
      pendingArgs = null;
      fn(...argsToSend);
    }, wait);
  };
  debounced.flush = () => {
    if (!timer) {
      return false;
    }
    clearTimeout(timer);
    timer = null;
    const argsToSend = pendingArgs;
    pendingArgs = null;
    fn(...argsToSend);
    return true;
  };
  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pendingArgs = null;
  };
  debounced.pending = () => timer !== null;
  return debounced;
}

// checkbox 默认映射 'true'/'false'；可用 data-on / data-off 声明自定义值对
// （如安全边框范围：选中 optimal、未选中 max），共享层不做字段名特判。
function collectSettings(fields) {
  return fields.reduce((result, field) => {
    const element = document.getElementById(field);
    if (!element) {
      return result;
    }
    if (element.type === 'checkbox') {
      result[field] = element.checked
        ? (element.dataset.on ?? 'true')
        : (element.dataset.off ?? 'false');
      return result;
    }
    result[field] = element.value.trim();
    return result;
  }, {});
}

function applySettings(fields, settings = {}) {
  fields.forEach((field) => {
    const element = document.getElementById(field);
    if (!element || typeof settings[field] !== 'string') {
      return;
    }
    if (element.type === 'checkbox') {
      element.checked = settings[field] === (element.dataset.on ?? 'true');
      return;
    }
    element.value = settings[field];
  });
  syncThemeButtons();
}

// 主题色卡数据：五段按角色依次为 背景(canvas) / 填充(panel) / 边框(low) /
// 强调(accent) / 文字(text)，必须与 plugin/app.js 的 THEMES 同步，
// 一致性由 npm test 校验锁定。新增主题只改 THEMES 与这里；Pomowave
// 的阶段色由 theme token 派生，不再另维护静态色板或逐页色卡 CSS。
const THEME_SWATCHES = {
  mint: ['#07111f', '#0f172a', '#64748b', '#14b8a6', '#e2e8f0'],
  ember: ['#1a0d08', '#2a140c', '#9a3412', '#f97316', '#fff7ed'],
  mono: ['#09090b', '#18181b', '#52525b', '#d4d4d8', '#fafafa'],
  signal: ['#06111f', '#0b1730', '#1d4ed8', '#60a5fa', '#eff6ff'],
  neon: ['#0d0221', '#1b0f3b', '#6d28d9', '#e879f9', '#f3e8ff'],
  ice: ['#051820', '#0b2a38', '#0e7490', '#67e8f9', '#ecfeff'],
  sunset: ['#1f0910', '#38121f', '#9f1239', '#fb7185', '#fff1f2'],
  forest: ['#04150c', '#0d2b1a', '#166534', '#4ade80', '#ecfdf5'],
  sand: ['#f6f1e7', '#fffcf5', '#d6c7ab', '#b45309', '#292524'],
};

let themeChipButtons = [];

// 色卡按 THEME_SWATCHES 动态生成，页面只保留空的 .theme-row 容器。
function renderThemeChips() {
  const container = document.querySelector('.theme-row');
  const themeInput = document.getElementById('theme');
  if (!container || !themeInput) {
    themeChipButtons = [];
    return;
  }
  themeChipButtons = Object.entries(THEME_SWATCHES).map(([name, swatch]) => {
    const [background, fill, border, accent, text] = swatch;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-chip';
    button.dataset.themeValue = name;
    button.setAttribute('aria-label', name);
    const strip = document.createElement('span');
    strip.style.background = `linear-gradient(90deg, ${background} 0 20%, ${fill} 20% 40%, ${border} 40% 60%, ${accent} 60% 80%, ${text} 80% 100%)`;
    button.appendChild(strip);
    container.appendChild(button);
    return button;
  });
}

function syncThemeButtons() {
  const themeInput = document.getElementById('theme');
  if (!themeInput) {
    return;
  }
  themeChipButtons.forEach((button) => {
    const isActive = button.dataset.themeValue === themeInput.value;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function bindThemeButtons(pushSettings) {
  const themeInput = document.getElementById('theme');
  if (!themeInput) {
    return;
  }

  renderThemeChips();
  themeChipButtons.forEach((button) => {
    button.addEventListener('click', () => {
      themeInput.value = button.dataset.themeValue || '';
      syncThemeButtons();
      pushSettings();
    });
  });

  syncThemeButtons();
}

function initInspector(actionUuid, fields) {
  let currentContext = '';
  let uiBound = false;

  function pushSettings() {
    $UD.sendParamFromPlugin(collectSettings(fields), currentContext);
  }
  const autosave = debounce(pushSettings, AUTOSAVE_DEBOUNCE_MS);

  function commitSettings() {
    if (!autosave.flush()) {
      pushSettings();
    }
  }

  function bindUiOnce() {
    if (uiBound) {
      return;
    }
    uiBound = true;

    const form = document.getElementById('property-inspector');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      commitSettings();
      flashInspectorFeedback('saved');
    });

    form.addEventListener('input', () => {
      autosave();
    });

    bindThemeButtons(commitSettings);
    bindResetDefaults(() => {
      // 丢弃未提交的编辑尾值，避免恢复默认后又被旧输入覆盖。
      autosave.cancel();
      $UD.sendParamFromPlugin({ [RESET_DEFAULTS_PARAM]: 'true' }, currentContext);
    });
    window.addEventListener('pagehide', () => {
      autosave.flush();
      autosave.cancel();
    });
  }

  $UD.connect(actionUuid);

  $UD.onConnected(() => {
    document.querySelector('.uspi-wrapper').classList.remove('hidden');
    bindUiOnce();
    $UD.sendParamFromPlugin({ [REQUEST_SETTINGS_PARAM]: 'true' }, currentContext);
  });

  function apply(message) {
    currentContext = message.context || currentContext;
    applySettings(fields, message.param || {});
  }

  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
}
