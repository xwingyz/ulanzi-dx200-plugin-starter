const LATENCY_FIELDS = [
  'url',
  'intervalSec',
  'warnMs',
  'timeoutMs',
  'sslWarnDays',
  'theme',
  'frameSize',
  'showFrame',
  'graphMode',
];

function syncModeButtons() {
  const graphInput = document.getElementById('graphMode');

  document.querySelectorAll('[data-graph-mode]').forEach((button) => {
    const active = button.dataset.graphMode === graphInput.value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function initLatencyInspector() {
  let currentContext = '';
  let uiBound = false;

  function pushSettings() {
    $UD.sendParamFromPlugin(collectSettings(LATENCY_FIELDS), currentContext);
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

    document.querySelectorAll('[data-graph-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        document.getElementById('graphMode').value = button.dataset.graphMode || 'bars';
        syncModeButtons();
        commitSettings();
      });
    });

    bindResetDefaults(() => {
      autosave.cancel();
      $UD.sendParamFromPlugin({ [RESET_DEFAULTS_PARAM]: 'true' }, currentContext);
    });
    window.addEventListener('pagehide', () => {
      autosave.flush();
      autosave.cancel();
    });
    syncModeButtons();
  }

  $UD.connect('com.ulanzi.ulanzistudio.lexutility.latency');

  $UD.onConnected(() => {
    document.querySelector('.uspi-wrapper').classList.remove('hidden');
    bindUiOnce();
  });

  function apply(message) {
    currentContext = message.context || currentContext;
    applySettings(LATENCY_FIELDS, message.param || {});
    syncModeButtons();
  }

  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
}

initLatencyInspector();
