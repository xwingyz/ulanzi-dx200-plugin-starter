const SYSTEMSTATUS_FIELDS = [
  'metric1',
  'metric2',
  'metric3',
  'pollSec',
  'lhmUrl',
  'theme',
  'frameSize',
  'showFrame',
];

const SYSTEMSTATUS_METRICS = [
  ['cpu', 'CPU 占用'],
  ['ram', 'RAM 占用'],
  ['gpu', 'GPU 占用'],
  ['temperature', 'CPU 温度'],
  ['upload', '上传网速'],
  ['download', '下载网速'],
];

function populateMetricSelects() {
  for (const id of ['metric1', 'metric2', 'metric3']) {
    const select = document.getElementById(id);
    select.replaceChildren();
    if (id !== 'metric1') {
      select.add(new Option('不显示', 'none'));
    }
    for (const [value, label] of SYSTEMSTATUS_METRICS) {
      select.add(new Option(label, value));
    }
  }
}

function updateMetricAvailability() {
  const selects = ['metric1', 'metric2', 'metric3'].map((id) => document.getElementById(id));
  if (selects[1].value === 'none') {
    selects[2].value = 'none';
  }
  selects[2].disabled = selects[1].value === 'none';
  const chosen = new Set(selects.map((select) => select.value).filter((value) => value && value !== 'none'));
  for (const select of selects) {
    for (const option of select.options) {
      option.disabled = option.value !== select.value && option.value !== 'none' && chosen.has(option.value);
    }
  }
}

function initSystemStatusInspector() {
  let currentContext = '';
  let uiBound = false;

  populateMetricSelects();

  function pushSettings() {
    $UD.sendParamFromPlugin(collectSettings(SYSTEMSTATUS_FIELDS), currentContext);
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
    form.addEventListener('input', (event) => {
      if (event.target.matches('select')) {
        updateMetricAvailability();
      }
      autosave();
    });
    bindThemeButtons(commitSettings);
    bindResetDefaults(() => {
      autosave.cancel();
      $UD.sendParamFromPlugin({ [RESET_DEFAULTS_PARAM]: 'true' }, currentContext);
    });
    window.addEventListener('pagehide', () => {
      autosave.flush();
      autosave.cancel();
    });
  }

  $UD.connect('com.ulanzi.ulanzistudio.lexutility.systemstatus');
  $UD.onConnected(() => {
    document.querySelector('.uspi-wrapper').classList.remove('hidden');
    bindUiOnce();
  });

  function apply(message) {
    currentContext = message.context || currentContext;
    applySettings(SYSTEMSTATUS_FIELDS, message.param || {});
    updateMetricAvailability();
  }

  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
}

initSystemStatusInspector();
