// 自动保存去抖：连续输入只在停顿后落一次盘；手动保存/按钮走 flush 立即提交。
const AUTOSAVE_DEBOUNCE_MS = 400;

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

function collectSettings(fields) {
  return fields.reduce((result, field) => {
    const element = document.getElementById(field);
    if (!element) {
      return result;
    }
    if (element.type === 'checkbox') {
      result[field] = element.checked ? 'true' : 'false';
      return result;
    }
    result[field] = field === 'color' ? element.value : element.value.trim();
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
      element.checked = settings[field] === 'true';
      return;
    }
    element.value = settings[field];
  });
  syncThemeButtons();
}

function syncThemeButtons() {
  const themeInput = document.getElementById('theme');
  if (!themeInput) {
    return;
  }
  document.querySelectorAll('[data-theme-value]').forEach((button) => {
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

  document.querySelectorAll('[data-theme-value]').forEach((button) => {
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
    });

    form.addEventListener('input', () => {
      autosave();
    });

    bindThemeButtons(commitSettings);
    window.addEventListener('pagehide', () => {
      autosave.flush();
      autosave.cancel();
    });
  }

  $UD.connect(actionUuid);

  $UD.onConnected(() => {
    document.querySelector('.uspi-wrapper').classList.remove('hidden');
    bindUiOnce();
  });

  function apply(message) {
    currentContext = message.context || currentContext;
    applySettings(fields, message.param || {});
  }

  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
}
