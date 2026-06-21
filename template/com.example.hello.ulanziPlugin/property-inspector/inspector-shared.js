function collectSettings(fields) {
  return fields.reduce((result, field) => {
    const element = document.getElementById(field);
    if (!element) {
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
  function pushSettings() {
    $UD.sendParamFromPlugin(collectSettings(fields));
  }

  $UD.connect(actionUuid);

  $UD.onConnected(() => {
    document.querySelector('.uspi-wrapper').classList.remove('hidden');

    const form = document.getElementById('property-inspector');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      pushSettings();
    });

    form.addEventListener('input', () => {
      pushSettings();
    });

    bindThemeButtons(pushSettings);
  });

  $UD.onAdd((message) => {
    applySettings(fields, message.param || {});
  });

  $UD.onParamFromApp((message) => {
    applySettings(fields, message.param || {});
  });

  $UD.onParamFromPlugin((message) => {
    applySettings(fields, message.param || {});
  });
}
