const LATENCY_FIELDS = [
  'url',
  'intervalSec',
  'warnMs',
  'timeoutMs',
  'color',
  'theme',
  'graphMode',
  'backgroundStyle',
];

function syncModeButtons() {
  const graphInput = document.getElementById('graphMode');
  const bgInput = document.getElementById('backgroundStyle');

  document.querySelectorAll('[data-graph-mode]').forEach((button) => {
    const active = button.dataset.graphMode === graphInput.value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  document.querySelectorAll('[data-bg-style]').forEach((button) => {
    const active = button.dataset.bgStyle === bgInput.value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function initLatencyInspector() {
  let currentContext = '';

  function pushSettings() {
    $UD.sendParamFromPlugin(collectSettings(LATENCY_FIELDS), currentContext);
  }

  $UD.connect('com.ulanzi.ulanzistudio.lexutility.latency');

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

    document.querySelectorAll('[data-graph-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        document.getElementById('graphMode').value = button.dataset.graphMode || 'bars';
        syncModeButtons();
        pushSettings();
      });
    });

    document.querySelectorAll('[data-bg-style]').forEach((button) => {
      button.addEventListener('click', () => {
        document.getElementById('backgroundStyle').value = button.dataset.bgStyle || 'gradient';
        syncModeButtons();
        pushSettings();
      });
    });

    syncModeButtons();
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
