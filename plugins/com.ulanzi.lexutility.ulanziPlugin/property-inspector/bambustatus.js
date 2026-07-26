const BAMBUSTATUS_FIELDS = withLanguageField(['printerName', 'printerIp', 'serialNumber', 'accessCode', 'theme', 'frameSize', 'showFrame']);
const BAMBUSTATUS_DISCOVERY_FIELDS = ['printerName', 'printerIp', 'serialNumber', 'accessCode'];
const BAMBUSTATUS_SCAN_PARAM = '__bambustatusScan';
const BAMBUSTATUS_SCAN_RESULT_PARAM = '__bambustatusDiscovery';
const BAMBUSTATUS_DIAG_PARAM = '__bambustatusDiag';

function initBambuStatusInspector() {
  let currentContext = '';
  let uiBound = false;
  let lastStatus = { key: 'Incomplete settings are discovered and saved automatically. You can rescan at any time.', kind: '', replacements: {} };
  const autosave = debounce(() => {
    $UD.sendParamFromPlugin(collectSettings(BAMBUSTATUS_FIELDS), currentContext);
  }, AUTOSAVE_DEBOUNCE_MS);

  function commitSettings() {
    if (!autosave.flush()) {
      $UD.sendParamFromPlugin(collectSettings(BAMBUSTATUS_FIELDS), currentContext);
    }
  }

  function showScanStatus(text, kind = '') {
    const element = document.getElementById('scanStatus');
    element.textContent = text;
    element.className = `scan-status ${kind}`.trim();
  }

  function showLocalizedScanStatus(key, kind = '', replacements = {}) {
    lastStatus = { key, kind, replacements };
    let text = $UD.t(key);
    Object.entries(replacements).forEach(([token, value]) => {
      text = text.replace(token, String(value));
    });
    showScanStatus(text, kind);
  }

  function bindUiOnce() {
    if (uiBound) return;
    uiBound = true;
    const form = document.getElementById('property-inspector');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      commitSettings();
      flashInspectorFeedback('saved');
    });
    form.addEventListener('input', () => autosave());
    bindThemeButtons(commitSettings);
    bindLanguageSelection(commitSettings, () => showLocalizedScanStatus(lastStatus.key, lastStatus.kind, lastStatus.replacements));
    document.getElementById('scanPrinter').addEventListener('click', () => {
      showLocalizedScanStatus('Reading Bambu Studio settings and scanning the local network…');
      $UD.sendParamFromPlugin({
        [BAMBUSTATUS_SCAN_PARAM]: collectSettings(['printerName', 'printerIp', 'serialNumber', 'accessCode']),
      }, currentContext);
    });
    bindResetDefaults(() => {
      autosave.cancel();
      $UD.sendParamFromPlugin({ [RESET_DEFAULTS_PARAM]: 'true' }, currentContext);
    });
    window.addEventListener('pagehide', () => {
      autosave.flush();
      autosave.cancel();
    });
  }

  function apply(message) {
    currentContext = message.context || currentContext;
    const param = message.param || {};
    const result = param[BAMBUSTATUS_SCAN_RESULT_PARAM];
    if (result) {
      applySettings(BAMBUSTATUS_DISCOVERY_FIELDS, result.settings || {});
      if (result.status === 'found') {
        showLocalizedScanStatus(
          result.model ? 'Found %s and saved it automatically. You can continue editing.' : 'Found a printer and saved it automatically. You can continue editing.',
          'ok',
          result.model ? { '%s': result.model } : {},
        );
      } else if (result.status === 'partial') {
        showLocalizedScanStatus('Discovered information was saved. Complete the remaining settings.', 'warn');
      } else {
        showLocalizedScanStatus('No available printer was found. Check the local network or enter settings manually.', 'warn');
      }
      return;
    }
    const diagnostic = param[BAMBUSTATUS_DIAG_PARAM];
    if (diagnostic) {
      const statusKeys = {
        online: 'Live printer status received.',
        incompatible: 'The current printer mode does not expose local status.',
        offline: 'Printer connection is offline.',
      };
      showLocalizedScanStatus(statusKeys[diagnostic.state] || 'Status updated.', diagnostic.state === 'online' ? 'ok' : 'warn');
      return;
    }
    applySettings(BAMBUSTATUS_FIELDS, param);
    void afterLanguageSelection(() => showLocalizedScanStatus(lastStatus.key, lastStatus.kind, lastStatus.replacements));
  }

  $UD.connect('com.ulanzi.ulanzistudio.lexutility.bambustatus');
  $UD.onConnected(() => {
    document.querySelector('.uspi-wrapper').classList.remove('hidden');
    bindUiOnce();
    $UD.sendParamFromPlugin({ [REQUEST_SETTINGS_PARAM]: 'true' }, currentContext);
  });
  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
}

initBambuStatusInspector();
